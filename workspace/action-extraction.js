"use strict";

const { createHash, randomUUID } = require("node:crypto");

const COMMITMENT = /\b(?:i|we|you|he|she|they|[A-Z][a-z]+)\s+(?:will|shall|must|should|need(?:s)?\s+to|can\s+you)|\b(?:action\s+item|to-?do|follow\s+up)\b/i;
const NEGATED = /\b(?:will|shall|must|should|need(?:s)?\s+to)\s+not\b|\b(?:don't|doesn't|didn't|do not|does not|did not)\s+need\s+to\b/i;

function requestId(key) {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// store.list returns at most 1000 rows; long recordings have more segments.
function listAll(store, scope, kind, options = {}) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = store.list(scope, kind, { ...options, limit: 1000, offset });
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// Proposals are keyed by segment content, not revision: assigning a speaker bumps
// the revision without changing the words, and must not produce duplicates.
function candidates(segment) {
  const found = [];
  const sentences = segment.text.matchAll(/[^.!?\n]+(?:[.!?]+|$)/g);
  for (const match of sentences) {
    const leading = match[0].length - match[0].trimStart().length;
    const quote = match[0].trim();
    if (!quote || !COMMITMENT.test(quote) || NEGATED.test(quote)) continue;
    const startOffset = match.index + leading;
    found.push({
      title: quote.replace(/[.!?]+$/, "").slice(0, 1000),
      evidence: [{
        segmentId: segment.id,
        revision: segment.revision,
        quote,
        startOffset,
        endOffset: startOffset + quote.length,
      }],
    });
  }
  return found;
}

// Speaker roles for owner resolution. A detected speaker the user has not
// identified can only be treated as "someone else" once the user has said which
// speaker they are; until then nobody can be attributed to the account owner.
function speakerRoles(store, workspaceId, recordingId) {
  const speakers = listAll(store, { workspaceId }, "speaker", { recordingId });
  const hasSelf = speakers.some((speaker) => speaker.identity?.kind === "self");
  const roles = new Map();
  for (const speaker of speakers) {
    const identity = speaker.identity ?? { kind: "unknown" };
    roles.set(
      speaker.id,
      identity.kind === "self"
        ? { role: "self", name: null, display: "You" }
        : identity.kind === "person"
          ? { role: "other", name: identity.label, display: identity.label }
          : hasSelf
            ? { role: "other", name: null, display: speaker.label, anonymous: speaker }
            : { role: "unknown", name: null, display: speaker.label },
    );
  }
  const unlabelled = { role: "unknown", name: null, display: null };
  return { hasSelf, of: (segment) => roles.get(segment.speakerId) ?? unlabelled };
}

// Maps a resolved owner to the action's owner fields. Named people get a stable,
// workspace-wide id derived from their name; an unnamed detected speaker gets an
// id derived from that speaker, labelled with the speaker's label.
function actionOwner(resolved, speaker) {
  if (resolved.kind === "self") return { owner: { kind: "self", id: null }, ownerLabel: null };
  if (resolved.kind === "other" && resolved.name)
    return { owner: { kind: "person", id: require("./people").personId(resolved.name) }, ownerLabel: resolved.name };
  if (resolved.kind === "other" && resolved.fromSpeaker && speaker.anonymous)
    return { owner: { kind: "person", id: requestId(`speaker:${speaker.anonymous.id}`) }, ownerLabel: speaker.anonymous.label };
  return { owner: { kind: "unknown", id: null }, ownerLabel: null };
}

// Everything needed to spot a commitment promised again in an earlier conversation.
function restatementContext(store, workspaceId) {
  return {
    actions: listAll(store, { workspaceId }, "action"),
    segmentRecording: new Map(
      store._db
        .prepare("SELECT id, recording_id FROM transcript_segments WHERE workspace_id=? AND deleted_at IS NULL")
        .all(workspaceId)
        .map((row) => [row.id, row.recording_id]),
    ),
  };
}

// The same words heard on both sources. With speakers rather than headphones, the
// far side comes out of the Mac and back in through the microphone, so one
// utterance is transcribed twice, a fraction of a second apart, and would otherwise
// become two identical commitments. Measured on a real call: 4 of 15 segments were
// echoes, offset by 0.1-1.2s.
const segmentSpans = (segments) =>
  new Map(segments.map((segment) => [segment.id, { startMs: segment.startMs, endMs: segment.endMs, source: segment.source }]));

function echoOf(a, b, segments) {
  const left = segments.get(a);
  const right = segments.get(b);
  if (!left || !right || left.source === right.source) return false;
  const overlap = Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs);
  if (overlap <= 0) return false;
  const shorter = Math.min(left.endMs - left.startMs, right.endMs - right.startMs);
  return shorter > 0 && overlap / shorter >= 0.5;
}

// Near-identical wording, allowing for the two engines hearing it slightly
// differently ("voice note" / "voice node"). Measured on the real call: echo pairs
// scored 0.90-1.00, while different speech overlapping in time scored 0.29-0.38, so
// the threshold sits well inside that gap.
const ECHO_WORDS = 0.75;
function sameWords(a, b) {
  const { similarity } = require("./restatements");
  const normalize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
  if (normalize(a) === normalize(b)) return true;
  return similarity(a, b).score >= ECHO_WORDS;
}

// Suggestions already made for this recording, so a rerun can recognise the same
// commitment even when the model quotes a slightly different span of it. Deleted
// suggestions are included so that a deletion is never undone by a rerun.
function existingSuggestions(store, workspaceId, segments) {
  const ids = new Set(segments.map((segment) => segment.id));
  return listAll(store, { workspaceId }, "action", { includeDeleted: true }).filter(
    (action) => action.origin !== "manual" && action.evidence?.length && ids.has(action.evidence[0].segmentId),
  );
}

function attribute(store, workspaceId, action, input) {
  const updated = store.attributeAction(
    { workspaceId, clientRequestId: randomUUID(), expectedRevision: action.revision },
    action.id,
    { owner: input.owner, ownerLabel: input.ownerLabel },
  );
  return updated.revision !== action.revision ? "attributed" : "kept";
}

// Creates a proposal once. On later runs the same commitment -- the same request
// key, or an overlapping quote in the same segment -- only has its owner updated,
// and only while it is an untouched suggestion (store.attributeAction enforces that).
function proposeOrAttribute(store, context, input, origin, existing, restating, segments) {
  const evidence = input.evidence[0];
  const previous = store._db
    .prepare("SELECT result_json FROM mutation_requests WHERE request_id=?")
    .get(context.clientRequestId);
  const previousId = previous && JSON.parse(previous.result_json).id;
  const match = existing.find((action) => {
    if (action.id === previousId) return true;
    const other = action.evidence[0];
    if (other.segmentId === evidence.segmentId)
      return other.startOffset < evidence.endOffset && evidence.startOffset < other.endOffset;
    // The same commitment heard on the other source is not a second commitment.
    return (
      segments &&
      echoOf(other.segmentId, evidence.segmentId, segments) &&
      sameWords(other.quote, evidence.quote)
    );
  });
  if (match) {
    existing.matched.add(match.id);
    return match.deletedAt ? "gone" : attribute(store, context.workspaceId, match, input);
  }
  if (previous) return "gone";
  const restatementOf = restating
    ? require("./restatements").findRestated(store, context.workspaceId, { ...input, recordingId: restating.recordingId }, restating)
    : null;
  const created = store.proposeAction(context, restatementOf ? { ...input, restatementOf } : input, origin);
  if (restatementOf) restating.actions.push(created);
  existing.push(created);
  existing.matched.add(created.id);
  return "proposed";
}

// Suggestions the model did not return this time still get speaker-based owners.
function attributeUnmatched(store, workspaceId, existing, segments, speakers) {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  let attributed = 0;
  for (const action of existing) {
    if (existing.matched.has(action.id) || action.deletedAt) continue;
    const segment = byId.get(action.evidence[0].segmentId);
    if (!segment) continue;
    const speaker = speakers.of(segment);
    const resolved = resolveOwner({ quote: action.evidence[0].quote, speaker });
    if (attribute(store, workspaceId, action, actionOwner(resolved, speaker)) === "attributed") attributed++;
  }
  return attributed;
}

function extractRecordingActions(store, recordingId) {
  const workspaceId = store.identity.id;
  const recording = store.get({ workspaceId }, "recording", recordingId);
  if (recording.purpose === "learning") return { proposed: 0, attributed: 0, restated: 0, skipped: "learning" };
  const segments = listAll(store, { workspaceId }, "transcript", { recordingId });
  const speakers = speakerRoles(store, workspaceId, recordingId);
  const existing = Object.assign(existingSuggestions(store, workspaceId, segments), { matched: new Set() });
  const restating = { ...restatementContext(store, workspaceId), recordingId };
  const spans = segmentSpans(segments);
  let proposed = 0;
  let attributed = 0;
  let restated = 0;
  let considered = 0;
  for (const segment of segments) {
    for (const candidate of candidates(segment)) {
      if (considered >= 20) {
        attributed += attributeUnmatched(store, workspaceId, existing, segments, speakers);
        return { proposed, attributed, restated, limited: true, limit: 20 };
      }
      considered++;
      const key = `local-action-v2:${segment.id}:${segment.contentHash}:${candidate.evidence[0].startOffset}`;
      const context = { workspaceId, clientRequestId: requestId(key) };
      if (looksConversational(candidate.evidence[0].quote)) continue;
      const speaker = speakers.of(segment);
      const resolved = resolveOwner({ quote: candidate.evidence[0].quote, speaker });
      const outcome = proposeOrAttribute(
        store,
        context,
        { ...candidate, ...actionOwner(resolved, speaker), priority: "medium" },
        "local-rule",
        existing,
        restating,
        spans,
      );
      if (outcome === "proposed") {
        proposed++;
        if (existing.at(-1)?.restatementOf) restated++;
      }
      if (outcome === "attributed") attributed++;
    }
  }
  attributed += attributeUnmatched(store, workspaceId, existing, segments, speakers);
  return { proposed, attributed, restated, limited: false };
}

const MODEL_LIMIT = 100;

// Politeness is not a commitment. Grounding proves a quote was said, not that it
// promises anything, and on real speech the model proposed "Anytime" and "Okay.
// Bye-bye" as work to track. A quote made entirely of greetings, acknowledgements
// and filler carries no action, whoever said it.
const COURTESY = new Set([
  "hello", "hi", "hey", "morning", "afternoon", "evening", "goodbye", "bye", "byebye",
  "cheers", "thanks", "thank", "welcome", "anytime", "sure", "okay", "ok", "yeah",
  "yes", "yep", "no", "nope", "right", "alright", "good", "great", "perfect", "nice",
  "cool", "fine", "fair", "enough", "sounds", "sound", "got", "understood", "noted",
  "exactly", "totally", "absolutely", "definitely", "certainly", "course", "problem",
  "worries", "please", "sorry", "excuse", "congrats", "congratulations", "well",
  "done", "later", "soon", "talk", "speak", "see", "catch", "take", "care", "team",
  "everyone", "guys", "folks", "all", "side", "update", "start", "started", "end",
  "um", "uh", "hmm", "mm", "mmhmm", "ah", "oh", "so", "and", "but", "then", "now",
  "just", "really", "very", "much", "lot", "bit", "know", "think", "guess", "mean",
]);

function looksConversational(quote) {
  const { significantWords } = require("./restatements");
  const words = [...significantWords(quote)];
  // Nothing left once stopwords and dates are gone, or nothing but pleasantries.
  return words.length === 0 || words.every((word) => COURTESY.has(word));
}

// Who does the work, decided from the speaker we already know rather than from the
// model's pronoun reading, which confuses "I" said by another speaker with "you":
//   1. "<Name> will/is going to/can ..." -> that named person.
//   2. First person ("I'll", "let me", "we'll", "with me") -> whoever spoke it.
//   3. Otherwise the model's answer, but never "self" unless the owner spoke.
// speaker: { role: "self" | "other" | "unknown", name } for the segment's speaker.
const NAMED_SUBJECT = /^\s*([A-Z][a-z]+)\s+(?:will|shall|is going to|'ll|can|could|should|must|needs? to|has to|is to|owns?)\b/;
const FIRST_PERSON = /\b(?:i|i'll|i'm|i've|i'd|me|my|we|we'll|we're|we've|our|let's)\b/i;
const NOT_NAMES = new Set(["We", "You", "They", "He", "She", "It", "This", "That", "Someone", "Everyone", "Somebody"]);

function resolveOwner({ quote, speaker, modelOwner = "unknown", modelPerson = "" }) {
  const named = NAMED_SUBJECT.exec(quote)?.[1];
  if (named && !NOT_NAMES.has(named)) {
    if (speaker.role === "other" && speaker.name?.toLowerCase() === named.toLowerCase())
      return { kind: "other", name: speaker.name, fromSpeaker: true };
    return { kind: "other", name: named };
  }
  if (FIRST_PERSON.test(quote)) {
    if (speaker.role === "self") return { kind: "self", name: null };
    if (speaker.role === "other") return { kind: "other", name: speaker.name ?? null, fromSpeaker: true };
    return { kind: "unknown", name: null };
  }
  if (modelOwner === "self") return speaker.role === "self" ? { kind: "self", name: null } : { kind: "unknown", name: null };
  if (modelOwner === "other") return { kind: "other", name: modelPerson?.trim() || null };
  return { kind: "unknown", name: null };
}

// Locates a model quote in its segment. The helper already rejects quotes that
// are not verbatim modulo case/punctuation; offsets still need an exact span.
function locate(text, quote) {
  const target = quote.trim().replace(/[.!?,;:]+$/, "");
  if (!target) return null;
  const start = text.toLowerCase().indexOf(target.toLowerCase());
  return start < 0 ? null : { start, end: start + target.length, quote: text.slice(start, start + target.length) };
}

async function extractRecordingActionsLocal(store, recordingId, runtime) {
  const workspaceId = store.identity.id;
  const recording = store.get({ workspaceId }, "recording", recordingId);
  if (recording.purpose === "learning") return { proposed: 0, attributed: 0, restated: 0, skipped: "learning", method: "local-model" };
  const segments = listAll(store, { workspaceId }, "transcript", { recordingId });
  // The model sees "You" only for the speaker the user identified; otherwise the
  // account owner is unknown and resolveOwner never attributes work to them.
  const speakers = speakerRoles(store, workspaceId, recordingId);
  const found = await runtime.extract({
    owner: speakers.hasSelf ? "You" : "the account owner (not yet identified among the speakers)",
    segments: segments.map((segment) => ({
      id: segment.id,
      speaker: speakers.of(segment).display,
      text: segment.text,
    })),
  });
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const existing = Object.assign(existingSuggestions(store, workspaceId, segments), { matched: new Set() });
  const restating = { ...restatementContext(store, workspaceId), recordingId };
  const spans = segmentSpans(segments);
  let proposed = 0;
  let attributed = 0;
  let restated = 0;
  let considered = 0;
  for (const item of found) {
    const segment = byId.get(item.segmentId);
    const span = segment && locate(segment.text, item.quote);
    if (!span || looksConversational(span.quote)) continue;
    if (considered >= MODEL_LIMIT) {
      attributed += attributeUnmatched(store, workspaceId, existing, segments, speakers);
      return { proposed, attributed, restated, limited: true, limit: MODEL_LIMIT, method: "local-model" };
    }
    considered++;
    const key = `local-model-v1:${segment.id}:${segment.contentHash}:${span.start}`;
    const context = { workspaceId, clientRequestId: requestId(key) };
    const speaker = speakers.of(segment);
    const resolved = resolveOwner({ quote: span.quote, speaker, modelOwner: item.owner, modelPerson: item.person });
    const outcome = proposeOrAttribute(
      store,
      context,
      {
        title: span.quote.slice(0, 1000),
        evidence: [{ segmentId: segment.id, revision: segment.revision, quote: span.quote, startOffset: span.start, endOffset: span.end }],
        ...actionOwner(resolved, speaker),
        priority: "medium",
      },
      "local-model",
      existing,
      restating,
      spans,
    );
    if (outcome === "proposed") {
      proposed++;
      if (existing.at(-1)?.restatementOf) restated++;
    }
    if (outcome === "attributed") attributed++;
  }
  attributed += attributeUnmatched(store, workspaceId, existing, segments, speakers);
  return { proposed, attributed, restated, limited: false, method: "local-model" };
}

// Prefers the on-device model and falls back to the rule baseline when the model
// is not installed or not available on this Mac. Other model failures surface.
async function extractActions(store, recordingId, runtime) {
  if (runtime) {
    try {
      return await extractRecordingActionsLocal(store, recordingId, runtime);
    } catch (error) {
      if (error.code !== "MODEL_MISSING") throw error;
    }
  }
  return { ...extractRecordingActions(store, recordingId), method: "local-rule" };
}

module.exports = { looksConversational, actionOwner, echoOf, sameWords, segmentSpans, resolveOwner, listAll, candidates, extractRecordingActions, extractRecordingActionsLocal, extractActions, locate };
