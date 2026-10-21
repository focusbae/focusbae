"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { ACTION_TRANSITIONS } = require("../workspace/domain");

const folders = require("./folders");

const SHAREABLE = new Set(["accepted", "deferred", "done", "dropped"]);
const PAGE = 1000;
// The team service's storage limit per file; larger files stay on this Mac.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Bounds the memory one round holds for uploads; the rest go in later rounds.
const UPLOAD_BUDGET_BYTES = 120 * 1024 * 1024;
const WEB_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function listAll(store, workspaceId, kind) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = store.list({ workspaceId }, kind, { includeDeleted: true, limit: PAGE, offset });
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// Where an action's quote came from, in words a teammate can recognise.
function sourceOf(store, workspaceId, action) {
  const evidence = action.evidence?.[0];
  if (!evidence) return { sourceKind: "manual", sourceTitle: null, quote: null };
  try {
    if (evidence.sourceKind === "note") {
      const note = store.get({ workspaceId }, "note", evidence.segmentId, { includeDeleted: true });
      return { sourceKind: "note", sourceTitle: note.title || "Untitled page", quote: evidence.quote };
    }
    const segment = store.get({ workspaceId }, "transcript", evidence.segmentId, { includeDeleted: true });
    const recording = store.get({ workspaceId }, "recording", segment.recordingId, { includeDeleted: true });
    return { sourceKind: "recording", sourceTitle: recording.title || "Conversation", quote: evidence.quote };
  } catch {
    return { sourceKind: "manual", sourceTitle: null, quote: evidence.quote };
  }
}

// People in the conversation an action was quoted from, as the person named them.
function conversationPeople(store, workspaceId, action) {
  const evidence = action.evidence?.[0];
  if (!evidence || evidence.sourceKind === "note") return { named: [], selfSpoke: false };
  try {
    const segment = store.get({ workspaceId }, "transcript", evidence.segmentId, { includeDeleted: true });
    const speakers = store.list({ workspaceId }, "speaker", { recordingId: segment.recordingId, limit: 1000 });
    const named = [...new Set(speakers.filter((s) => s.identity?.kind === "person").map((s) => s.identity.label))];
    return { named, selfSpoke: speakers.some((s) => s.identity?.kind === "self") };
  } catch {
    return { named: [], selfSpoke: false };
  }
}

const byName = (people, label) => people.find((p) => p.name.toLowerCase() === String(label).trim().toLowerCase()) ?? null;

// Who the team sees as owing an action and who it is owed to. An explicit choice made
// on this Mac wins; otherwise the action's own owner, and an "owed to" only when the
// conversation makes it unambiguous (exactly one other identified person).
function sharedPeople(store, workspaceId, action, state) {
  const people = state?.people() ?? [];
  const me = state?.binding()?.mePersonId ?? null;
  const chosen = state?.mapping(action.id) ?? null;
  let owner = null;
  if (chosen?.ownerPersonId) owner = { personId: chosen.ownerPersonId };
  // "self" rather than this person's id, so learning that id on the first pull does
  // not change what was sent; the server resolves it to the same person.
  else if (action.owner?.kind === "self") owner = { self: true };
  else if (action.owner?.kind === "person" && action.ownerLabel) {
    const match = byName(people, action.ownerLabel);
    owner = match ? { personId: match.id } : { name: action.ownerLabel };
  }
  let counterparty = null;
  let suggested = false;
  if (chosen) counterparty = chosen.counterpartyPersonId ? { personId: chosen.counterpartyPersonId } : null;
  else {
    const { named, selfSpoke } = conversationPeople(store, workspaceId, action);
    const candidates = named.map((label) => byName(people, label)?.id).filter(Boolean);
    if (selfSpoke && me) candidates.push(me);
    const ownerId = owner?.self ? me : owner?.personId;
    const others = [...new Set(candidates)].filter((id) => id !== ownerId);
    if (others.length === 1) { counterparty = { personId: others[0] }; suggested = true; }
  }
  return { owner, counterparty, suggested, chosen: !!chosen };
}

// What a teammate sees of one local action. Audio, transcripts and notes stay here;
// only the commitment, its quote and where it was said are shared.
function payloadFor(store, workspaceId, action, state = null) {
  const { owner, counterparty } = sharedPeople(store, workspaceId, action, state);
  return {
    title: action.title,
    status: action.status,
    dueDate: action.dueDate ?? (action.dueAt ? action.dueAt.slice(0, 10) : null),
    owner,
    counterparty,
    ...sourceOf(store, workspaceId, action),
  };
}

const hashOf = (payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

// Phase 1, under the workspace lock: decide what to send.
function plan(store, state) {
  const folderWork = folders.plan(store, state);
  const workspaceId = store.identity.id;
  const shares = [];
  const unshares = [];
  const statusOnly = new Map();
  const localIds = new Set();
  for (const action of listAll(store, workspaceId, "action")) {
    localIds.add(action.id);
    const sent = state.sent(action.id);
    if (!action.deletedAt && SHAREABLE.has(action.status)) {
      const payload = payloadFor(store, workspaceId, action, state);
      const hash = hashOf(payload);
      if (!sent || sent.hash !== hash) shares.push({ id: action.id, payload, hash, version: sent?.version ?? null });
      statusOnly.set(action.id, action.status);
    } else if (sent) unshares.push(action.id);
  }
  // Shared before but gone from this workspace entirely (purged): withdraw it too.
  for (const id of state.sharedIds()) if (!localIds.has(id)) unshares.push(id);
  return { shares, unshares, statusOnly, ...folderWork, ...planNotes(store, state) };
}

// Notes go to My notes unless the person chose a team. Until the first pull says which
// space is My notes, notes wait; nothing is sent to a guessed place.
function planNotes(store, state) {
  const workspaceId = store.identity.id;
  const privateSpace = state.privateSpaceId();
  const notes = [];
  const noteSnapshots = {};
  const deletions = [];
  const uploads = [];
  let budget = UPLOAD_BUDGET_BYTES;
  if (!privateSpace) return { notes, deletions, uploads, noteSnapshots };
  const live = new Set();
  for (const note of listAll(store, workspaceId, "note")) {
    // Teammates' pages are copies of theirs; only their author sends them.
    if (note.team || note.deletedAt || note.metadata?.purgedAt) continue;
    live.add(note.id);
    const where = note.kind === "daily" ? { spaceId: privateSpace, folderId: null } : folders.location(store, state, note.folderId);
    if (!state.spaces().some((s) => s.id === where.spaceId && s.role === "editor")) continue;
    const payload = { ...where, title: note.title, content: note.content, text: note.plainText };
    noteSnapshots[note.id] = { folderId: note.folderId ?? null, title: note.title, content: note.content };
    const hash = hashOf(payload);
    const sent = state.noteSent(note.id);
    if (!sent || sent.hash !== hash) notes.push({ id: note.id, payload, hash, version: sent?.version ?? null });
    for (const attachmentId of require("../workspace/content").attachmentIds(note.content)) {
      const upload = planUpload(store, workspaceId, note.id, attachmentId, state, budget);
      if (upload) { uploads.push(upload); budget -= upload.bytes?.length ?? 0; }
    }
  }
  for (const id of state.sentNoteIds()) if (!live.has(id)) deletions.push(id);
  return { notes, deletions, uploads, noteSnapshots };
}

// One attachment to send, if it is new or changed since it was last sent. Browsers
// cannot show HEIC, so a photo with a PNG preview sends the preview.
function planUpload(store, workspaceId, noteId, attachmentId, state, budget) {
  let record;
  try { record = store.get({ workspaceId }, "attachment", attachmentId); } catch { return null; }
  const sent = state.attachmentSent(attachmentId);
  if (sent && sent.contentHash === record.contentHash) return null;
  const preview = record.previewId ? store.get({ workspaceId }, "attachment", record.previewId) : null;
  const source = preview && WEB_IMAGES.has(preview.mediaType) ? preview : record;
  const meta = { noteId, id: attachmentId, contentHash: record.contentHash, fileName: record.displayName,
    mimeType: source.mediaType, byteSize: source.byteSize };
  if (source.byteSize > MAX_UPLOAD_BYTES) return { ...meta, bytes: null };
  if (source.byteSize > budget) return null;
  return { ...meta, bytes: store.readAttachment({ workspaceId }, source.id) };
}

// Phase 2, network: push, then pull. Returns what phase 3 needs.
async function exchange(account, state, work) {
  const binding = state.binding();
  const ws = binding.serverWorkspaceId;
  const sent = [];
  const errors = [];
  for (const share of work.shares) {
    try {
      const row = await account.rpc("share_commitment", {
        p_workspace: ws, p_id: share.id, p_input: share.payload, p_version: share.version,
      });
      sent.push({ id: share.id, hash: share.hash, version: row.version });
    } catch (error) {
      if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error;
      // Someone changed it since this Mac last saw it: their change arrives with the
      // pull below and the next round resends on top of it.
      if (error.code === "VERSION_CONFLICT") continue;
      // The owner may only change status (e.g. after leaving the team): send just that.
      if (error.code === "FORBIDDEN" && share.version !== null) {
        try {
          const row = await account.rpc("set_commitment_status", { p_id: share.id, p_status: share.payload.status, p_version: null });
          sent.push({ id: share.id, hash: share.hash, version: row.version });
          continue;
        } catch (inner) { errors.push(inner.message); continue; }
      }
      errors.push(error.message);
    }
  }
  const withdrawn = [];
  for (const id of work.unshares) {
    try {
      await account.rpc("unshare_commitment", { p_id: id });
      withdrawn.push(id);
    } catch (error) {
      if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error;
      if (error.code === "FORBIDDEN") withdrawn.push(id); // no longer ours to withdraw
      else errors.push(error.message);
    }
  }
  const foldersSent = [], folderAliases = [], folderFailures = new Set();
  const aliases = new Map();
  for (const f of work.folders ?? []) {
    if (folderFailures.has(f.payload.parentId)) { folderFailures.add(f.id); continue; }
    try {
      const row = await account.rpc("save_folder", { p_workspace: ws, p_id: f.id, p_space: f.payload.spaceId,
        p_parent: aliases.get(f.payload.parentId) ?? f.payload.parentId, p_name: f.payload.name, p_version: f.version });
      foldersSent.push({ id: row.id, hash: f.hash, version: row.version });
      if (row.id !== f.id) { aliases.set(f.id, row.id); folderAliases.push({ from: f.id, to: row.id }); }
    } catch (error) {
      if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error;
      folderFailures.add(f.id);
      if (error.code !== "VERSION_CONFLICT") errors.push(error.message);
    }
  }
  for (const f of work.folderDeletions ?? []) {
    try { await account.rpc("delete_folder", { p_id: f.id, p_version: f.version }); }
    catch (error) {
      if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error;
      if (error.code !== "VERSION_CONFLICT") errors.push(error.message);
    }
  }
  const notesSent = [];
  const notesDeleted = [];
  const uploaded = [];
  const rethrow = (error) => { if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error; };
  for (const note of work.notes ?? []) {
    if (folderFailures.has(note.payload.folderId)) continue;
    try {
      const row = await account.rpc("upsert_note", {
        p_workspace: ws, p_id: note.id, p_space: note.payload.spaceId, p_title: note.payload.title,
        p_content: note.payload.content, p_text: note.payload.text, p_version: note.version,
        p_folder: aliases.get(note.payload.folderId) ?? note.payload.folderId ?? null,
      });
      notesSent.push({ id: note.id, hash: note.hash, version: row.version });
    } catch (error) {
      rethrow(error);
      if (error.code !== "VERSION_CONFLICT") errors.push(error.message);
    }
  }
  // Attachments only after their note exists on the server; storage checks the note.
  const sentNow = new Set(notesSent.map((n) => n.id));
  for (const upload of work.uploads ?? []) {
    if (!sentNow.has(upload.noteId) && !state.noteSent(upload.noteId)) continue;
    try {
      if (upload.bytes) await account.upload("note-attachments", `${ws}/${upload.noteId}/${upload.id}`, upload.bytes, upload.mimeType);
      await account.rpc("register_note_attachment", {
        p_note: upload.noteId, p_attachment: upload.id, p_file_name: upload.fileName, p_mime_type: upload.mimeType,
        p_byte_size: upload.byteSize, p_uploaded: !!upload.bytes,
      });
      uploaded.push(upload);
    } catch (error) {
      rethrow(error);
      errors.push(error.message);
    }
  }
  for (const id of work.deletions ?? []) {
    try {
      await account.rpc("delete_note", { p_id: id });
      notesDeleted.push(id);
    } catch (error) {
      rethrow(error);
      if (error.code === "FORBIDDEN") notesDeleted.push(id); else errors.push(error.message);
    }
  }
  const pushed = { sent, withdrawn, notesSent, notesDeleted, uploaded, errors, foldersSent, folderAliases, folderSnapshots: work.folderSnapshots, noteSnapshots: work.noteSnapshots };
  let pull;
  try {
    pull = await account.rpc("pull_changes", { p_workspace: ws, p_since: folderAliases.length ? 0 : binding.cursor });
  } catch (error) {
    if (error.code === "FORBIDDEN") return { ...pushed, removed: true };
    throw error;
  }
  const downloads = await downloadFiles(account, state, pull, errors);
  return { ...pushed, pull, downloads };
}

// Pages the team holds that this Mac did not write: teammates' pages, and this person's
// own pages written elsewhere (on the web, or handed to them when someone left). What
// was stored before plus this pull.
function pagesFromTeam(state, pull) {
  const me = state.binding().accountUserId;
  const visible = new Set(pull.visibleNoteIds ?? []);
  const pages = new Map(state.remoteNotes().map((n) => [n.id, n]));
  for (const n of pull.notes ?? []) pages.set(n.id, n);
  return [...pages.values()].filter((n) => visible.has(n.id) && n.authorId && (n.authorId !== me || !state.noteSent(n.id)));
}

// The files of teammates' pages that are not on this Mac yet, within this round's
// memory budget. A file that fails to arrive is asked for again next round.
async function downloadFiles(account, state, pull, errors) {
  const wanted = new Map();
  for (const page of pagesFromTeam(state, pull)) {
    let ids = [];
    try { ids = require("../workspace/content").attachmentIds(page.content); } catch { continue; }
    for (const id of ids) if (!state.attachmentMirrored(id)) wanted.set(`${page.id}/${id}`, { noteId: page.id, id });
  }
  const downloads = [];
  let budget = UPLOAD_BUDGET_BYTES;
  const noteIds = [...new Set([...wanted.values()].map((w) => w.noteId))];
  for (let i = 0; i < noteIds.length; i += 50) {
    try {
      const rows = await account.select(`note_attachments?select=note_id,attachment_id,file_name,mime_type,byte_size,uploaded&uploaded=eq.true&note_id=in.(${noteIds.slice(i, i + 50).join(",")})`);
      for (const row of rows) {
        if (!wanted.has(`${row.note_id}/${row.attachment_id}`) || row.byte_size > budget) continue;
        const bytes = await account.download("note-attachments", `${state.binding().serverWorkspaceId}/${row.note_id}/${row.attachment_id}`);
        if (!bytes) continue;
        budget -= bytes.length;
        downloads.push({ noteId: row.note_id, id: row.attachment_id, displayName: row.file_name, mediaType: row.mime_type, bytes });
      }
    } catch (error) {
      if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error;
      errors.push(error.message);
    }
  }
  return downloads;
}

// Teammates' pages become read-only copies on this Mac, under their team's heading and
// folder, so search, links and the graph include them. A page this person can no
// longer see is erased here, not moved to Trash.
function mirrorPages(store, state, result) {
  const people = new Map(state.people().map((p) => [p.id, p.name]));
  const spaces = new Map(state.spaces().map((s) => [s.id, s]));
  const files = new Map();
  for (const d of result.downloads ?? []) files.set(d.noteId, [...(files.get(d.noteId) ?? []), d]);
  const live = new Set();
  let changed = false, dropped = false;
  const me = state.binding().accountUserId;
  for (const remote of pagesFromTeam(state, result.pull)) {
    const local = store._raw("note", remote.id);
    if (local && !local.team) continue; // never overwrite a page of this person's own
    if (remote.authorId === me) {
      const outcome = adoptPage(store, state, remote, files.get(remote.id) ?? [], result.errors);
      if (outcome === "waiting") live.add(remote.id); // read-only until its files arrive
      if (outcome) changed = true;
      continue;
    }
    live.add(remote.id);
    const team = { authorPersonId: remote.authorPersonId ?? null, authorName: people.get(remote.authorPersonId) ?? null,
      spaceId: remote.spaceId, spaceName: spaces.get(remote.spaceId)?.name ?? null, access: remote.access ?? "view" };
    const seen = state.mirrored(remote.id);
    const arrived = files.get(remote.id) ?? [];
    if (seen?.version === remote.version && local && !local.metadata?.purgedAt && !arrived.length
      && local.team.authorName === team.authorName && local.team.spaceName === team.spaceName) continue;
    const filed = remote.folderId && state.folderSent(remote.folderId) && store._raw("folder", remote.folderId)?.deletedAt === null;
    const page = { id: remote.id, title: remote.title ?? "", content: remote.content, team,
      folderId: filed ? remote.folderId : state.rootForSpace(remote.spaceId) ?? folders.sharedRoot(store, state) };
    // One page this Mac cannot read (say, from a newer editor) must not stop the rest:
    // each page is its own savepoint, and a refused one is reported and retried.
    try {
      store._db.transaction(() => {
        let complete = store._mirrorNote(page);
        if (arrived.length) {
          for (const file of arrived) store._mirrorAttachment(remote.id, file, file.bytes);
          complete = store._mirrorNote(page);
        }
        for (const file of arrived) state.markAttachmentMirrored(file.id, remote.id);
        state.markMirrored(remote.id, remote.version, complete);
      })();
      changed = true;
    } catch (error) {
      if (!error.code || error.code.startsWith("SQLITE")) throw error;
      result.errors.push(`"${page.title || "Untitled page"}" could not be shown on this Mac: ${error.message}`);
    }
  }
  for (const id of state.mirroredIds()) if (!live.has(id)) {
    store._dropMirror(id);
    state.forgetMirrored(id);
    changed = dropped = true;
  }
  return { changed, dropped };
}

// Phase 3, under the workspace lock again: record what was sent, store the pull, and
// bring teammates' status changes to this Mac's own actions.
function apply(store, state, result) {
  for (const s of result.sent) state.markSent(s.id, s.hash, s.version);
  for (const id of result.withdrawn) state.forgetSent(id);
  for (const n of result.notesSent ?? []) state.markNoteSent(n.id, n.hash, n.version);
  for (const id of result.notesDeleted ?? []) state.forgetNoteSent(id);
  for (const u of result.uploaded ?? []) state.markAttachmentSent(u.id, u.noteId, u.contentHash, !!u.bytes);
  if (result.removed) {
    for (const id of state.mirroredIds()) store._dropMirror(id);
    state.markRemoved();
    return { removed: true, applied: 0, dropped: true };
  }
  // Space membership is needed before creating local team headings.
  state.applyPull(result.pull);
  const foldersChanged = folders.apply(store, state, result);
  let notesChanged = false;
  for (const remote of result.pull.notes ?? []) {
    const local = store._raw("note", remote.id);
    const sent = state.noteSent(remote.id);
    if (!local || local.deletedAt || !sent) continue;
    const snapshot = result.noteSnapshots?.[remote.id];
    if (remote.spaceId !== state.privateSpaceId() && !state.rootForSpace(remote.spaceId)) continue;
    const target = remote.folderId ?? state.rootForSpace(remote.spaceId) ?? null;
    // Reconcile server-side filing even after a rejected stale push, while preserving
    // any move the user made during this request.
    if (remote.version > sent.version && snapshot && (local.folderId ?? null) === snapshot.folderId && local.kind !== "daily") {
      if ((local.folderId ?? null) !== target && (!target || store._raw("folder", target))) {
        store.moveNote({ workspaceId: store.identity.id, clientRequestId: randomUUID(), expectedRevision: local.revision }, local.id, target);
        notesChanged = true;
      }
    }
    // Advance the version even when only sharing metadata changed. The next round
    // can send local writing on top of the latest server placement without looping.
    if (remote.version >= sent.version) {
      const current = store._raw("note", remote.id);
      const where = current.kind === "daily" ? { spaceId: state.privateSpaceId(), folderId: null } : folders.location(store, state, current.folderId);
      const agrees = current.title === remote.title && JSON.stringify(current.content) === JSON.stringify(remote.content)
        && where.spaceId === remote.spaceId && where.folderId === (remote.folderId ?? null);
      state.markNoteSent(remote.id, agrees ? hashOf({ ...where, title: current.title, content: current.content, text: current.plainText }) : "", remote.version);
    }
  }
  const mirrors = mirrorPages(store, state, result);
  const workspaceId = store.identity.id;
  let applied = 0;
  for (const remote of result.pull.commitments) {
    const sent = state.sent(remote.id);
    if (!sent || (sent.version !== null && remote.version <= sent.version)) continue;
    let local;
    try { local = store.get({ workspaceId }, "action", remote.id); } catch { continue; }
    // A finished action reopens before it can be deferred, so take the two steps the
    // local rules allow rather than leaving the Mac out of step with the team.
    const steps = ACTION_TRANSITIONS[local.status]?.includes(remote.status) ? [remote.status]
      : ["done", "dropped"].includes(local.status) && remote.status === "deferred" ? ["accepted", "deferred"] : [];
    for (const status of local.status === remote.status ? [] : steps) {
      local = store.transitionAction({ workspaceId, clientRequestId: randomUUID(), expectedRevision: local.revision }, remote.id, {
        status,
        ...(["done", "dropped"].includes(local.status) ? { reopen: true } : {}),
      });
    }
    if (steps.length && local.status === remote.status) applied++;
    // Record what the server now holds. If this Mac also changed something else
    // meanwhile (the title, the due date), leave it unsent so the next round sends it
    // on top of the teammate's change instead of dropping it.
    const payload = payloadFor(store, workspaceId, local, state);
    const inStep = payload.title === remote.title && payload.status === remote.status
      && (payload.dueDate ?? null) === (remote.due_date ?? null);
    state.markSent(remote.id, inStep ? hashOf(payload) : "", remote.version);
  }
  if (result.errors.length) state.recordError(result.errors[0]);
  return { removed: false, applied, notesChanged: notesChanged || foldersChanged || mirrors.changed, dropped: mirrors.dropped };
}

// This person's own page from elsewhere becomes an ordinary, editable page here, with
// the server's version recorded as sent so it is not pushed straight back. It waits
// until all its files are here: an edit to a page missing an image would remove that
// image for everyone.
function adoptPage(store, state, remote, arrived, errors) {
  try {
    return store._db.transaction(() => {
      const placement = { id: remote.id, title: remote.title ?? "", content: remote.content, team: null,
        folderId: remote.folderId && store._raw("folder", remote.folderId)?.deletedAt === null ? remote.folderId : state.rootForSpace(remote.spaceId) };
      // Files need their page to exist, so it is held read-only while they download.
      if (!store._raw("note", remote.id)) store._mirrorNote({ ...placement, team: { arriving: true } });
      for (const file of arrived) store._mirrorAttachment(remote.id, file, file.bytes);
      const ids = require("../workspace/content").attachmentIds(remote.content);
      if (ids.some((id) => !arrived.some((f) => f.id === id) && !state.attachmentMirrored(id))) {
        for (const file of arrived) state.markAttachmentMirrored(file.id, remote.id);
        state.markMirrored(remote.id, remote.version, false);
        return "waiting";
      }
      store._mirrorNote(placement);
      const note = store._raw("note", remote.id);
      const where = folders.location(store, state, note.folderId);
      state.markNoteSent(remote.id, hashOf({ ...where, title: note.title, content: note.content, text: note.plainText }), remote.version);
      state.forgetMirrored(remote.id);
      return "adopted";
    })();
  } catch (error) {
    if (!error.code || error.code.startsWith("SQLITE")) throw error;
    errors.push(`"${remote.title || "Untitled page"}" could not be added to this Mac: ${error.message}`);
    return store._raw("note", remote.id) ? "waiting" : null;
  }
}

// Cursor and mappings commit only after all local changes succeed. A failed local
// write therefore retries the same pull instead of skipping it forever. Files of
// erased pages are removed from disk once that commit has happened.
function applyAtomically(store, state, result) {
  const outcome = state.db.transaction(() => store._db.transaction(() => apply(store, state, result))())();
  if (outcome.dropped) require("../workspace/attachments").reconcile(store);
  return outcome;
}
module.exports = { plan, exchange, apply: applyAtomically, payloadFor, sharedPeople, hashOf };
