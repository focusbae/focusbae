"use strict";
// Commitments from a page you typed.
//
// Recordings already feed the ledger. A meeting you could not record — a phone
// call, a corridor conversation, anyone who said no to being recorded — does not,
// and that is the most common way a meeting actually gets captured: three lines
// written afterwards. This reads those lines and proposes the same actions a
// recording would, against the same people.
//
// The rules that make a proposal trustworthy do not change here:
//   - a quote must appear in the page verbatim, or it is dropped;
//   - nothing is accepted, only proposed;
//   - the page is never rewritten.
//
// What does change is who "I" means. In a transcript the speaker is whoever was
// talking; on a page you wrote, first person is you.
const {
  candidates,
  listAll,
  locate,
  looksConversational,
  resolveOwner,
  actionOwner,
} = require("./action-extraction");
const { createHash } = require("node:crypto");

// Apple's on-device model shares a small context between instructions, schema and
// answer, so a long page goes in paragraph-sized pieces.
// The same bound the runtime uses: a page piece must fit the model with its answer.
const { CHUNK_CHARS } = require("../local-ai/extraction-runtime");
const MODEL_LIMIT = 60;
const MIN_PIECE = 300;
const WRITER = { role: "self", name: null, anonymous: null };

function requestId(key) {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The page as pieces the model can read, each remembering where it came from so a
// quote can be placed back in the page exactly.
function pieces(text, limit = CHUNK_CHARS) {
  const found = [];
  const paragraph = /[^\n]+/g;
  for (const match of text.matchAll(paragraph)) {
    let offset = match.index;
    let rest = match[0];
    while (rest.length > limit) {
      // Split on a sentence end when there is one, so a commitment is not halved.
      const window = rest.slice(0, limit);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("—"));
      const size = cut > limit / 2 ? cut + 1 : limit;
      found.push({ offset, text: rest.slice(0, size) });
      offset += size;
      rest = rest.slice(size);
    }
    if (rest.trim()) found.push({ offset, text: rest });
  }
  return found.map((piece, index) => ({ ...piece, id: `p${index + 1}` }));
}

// One proposal for one sentence of one page, whatever else changes around it.
// Keyed on the words rather than the page's revision, so re-reading a page you
// have edited does not offer the same sentence again, and a proposal you deleted
// is not resurrected by a second look.
const keyFor = (noteId, quote) =>
  requestId(
    `note-commitment-v1:${noteId}:${quote.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim()}`,
  );

function alreadyProposed(store, workspaceId, noteId) {
  const quotes = new Set();
  for (const action of listAll(store, { workspaceId }, "action", { includeDeleted: true }))
    for (const entry of action.evidence ?? [])
      if (entry.sourceKind === "note" && entry.segmentId === noteId)
        quotes.add(keyFor(noteId, entry.quote));
  return quotes;
}

function propose(store, workspaceId, note, span, resolved, seen) {
  const key = keyFor(note.id, span.quote);
  if (seen.has(key)) return false;
  seen.add(key);
  store.proposeAction(
    { workspaceId, clientRequestId: key },
    {
      title: span.quote.replace(/[.!?]+$/, "").slice(0, 1000),
      evidence: [
        {
          sourceKind: "note",
          segmentId: note.id,
          revision: note.revision,
          quote: span.quote,
          startOffset: span.start,
          endOffset: span.end,
        },
      ],
      ...actionOwner(resolved, WRITER),
      priority: "medium",
    },
    "local-model",
  );
  return true;
}

// The baseline for Macs without Apple Intelligence: the same sentence rules the
// recording path falls back to, read over the page instead of a transcript.
function extractNoteActionsLocal(store, noteId) {
  const workspaceId = store.identity.id;
  const note = store.get({ workspaceId }, "note", noteId);
  const text = note.plainText ?? "";
  if (!text.trim()) return { proposed: 0, read: 0, method: "local-rule" };
  const seen = alreadyProposed(store, workspaceId, note.id);
  let proposed = 0;
  let read = 0;
  for (const found of candidates({ id: note.id, revision: note.revision, text })) {
    const [evidence] = found.evidence;
    if (looksConversational(evidence.quote)) continue;
    read++;
    const span = { quote: evidence.quote, start: evidence.startOffset, end: evidence.endOffset };
    const resolved = resolveOwner({ quote: span.quote, speaker: WRITER });
    if (propose(store, workspaceId, note, span, resolved, seen)) proposed++;
  }
  return { proposed, read, method: "local-rule" };
}

// The model takes seconds to minutes on a small Mac, so it runs outside the
// workspace queue: the page is read, then the proposals written, inside `serialize`,
// and nothing else in the app waits on the model meanwhile. Quotes are matched
// against the page as it is when they are written, so typing while it reads is safe.
async function extractNoteActionsModel(store, noteId, runtime, serialize = (fn) => fn()) {
  const before = await serialize(() => {
    const note = store.get({ workspaceId: store.identity.id }, "note", noteId);
    return note.plainText ?? "";
  });
  if (!before.trim()) return { proposed: 0, read: 0, method: "local-model" };
  const parts = pieces(before);
  if (!parts.length) return { proposed: 0, read: 0, method: "local-model" };
  const byId = new Map(parts.map((piece) => [piece.id, piece]));
  // A piece whose answer is too long for the model is cut in half, keeping each
  // half's offset into the page, down to a floor where a sentence still fits.
  const split = (segment) => {
    const piece = byId.get(segment.id);
    if (!piece || piece.text.length < MIN_PIECE) return null;
    return pieces(piece.text, Math.ceil(piece.text.length / 2)).map((half, index) => {
      const smaller = { id: `${piece.id}.${index + 1}`, offset: piece.offset + half.offset, text: half.text };
      byId.set(smaller.id, smaller);
      return { id: smaller.id, speaker: "You", text: smaller.text };
    });
  };
  const found = await runtime.extract({
    owner: "You",
    segments: parts.map((piece) => ({ id: piece.id, speaker: "You", text: piece.text })),
    split,
  });
  return serialize(() => {
    const workspaceId = store.identity.id;
    const note = store.get({ workspaceId }, "note", noteId);
    const text = note.plainText ?? "";
    const unchanged = text === before;
    const seen = alreadyProposed(store, workspaceId, note.id);
    let proposed = 0;
    let read = 0;
    for (const item of found) {
      const piece = byId.get(item.segmentId);
      const inPiece = piece && locate(piece.text, item.quote);
      // The helper checks the quote against the piece it was given; this checks it
      // against the page, which is what the evidence will point at.
      if (!inPiece || looksConversational(inPiece.quote)) continue;
      let span = {
        quote: inPiece.quote,
        start: piece.offset + inPiece.start,
        end: piece.offset + inPiece.end,
      };
      if (!unchanged) {
        // The page was edited while the model read it: find the sentence again.
        const moved = locate(text, inPiece.quote);
        if (!moved) continue;
        span = { quote: moved.quote, start: moved.start, end: moved.end };
      }
      if (text.slice(span.start, span.end) !== span.quote) continue;
      if (read >= MODEL_LIMIT)
        return { proposed, read, limited: true, limit: MODEL_LIMIT, method: "local-model" };
      read++;
      const resolved = resolveOwner({
        quote: span.quote,
        speaker: WRITER,
        modelOwner: item.owner,
        modelPerson: item.person,
      });
      if (propose(store, workspaceId, note, span, resolved, seen)) proposed++;
    }
    return { proposed, read, limited: false, method: "local-model" };
  });
}

// Prefers the on-device model, falls back to the sentence rules when it is not
// installed or this Mac cannot run it. Any other failure surfaces.
async function extractNoteActions(store, noteId, runtime, serialize = (fn) => fn()) {
  if (runtime) {
    try {
      return await extractNoteActionsModel(store, noteId, runtime, serialize);
    } catch (error) {
      if (error.code !== "MODEL_MISSING") throw error;
    }
  }
  return serialize(() => extractNoteActionsLocal(store, noteId));
}

module.exports = {
  extractNoteActions,
  extractNoteActionsLocal,
  extractNoteActionsModel,
  pieces,
  keyFor,
};
