"use strict";
// The workspace as a graph. Nodes are the things the ledger already tracks; edges
// are the relationships already stored, not a second set of data to maintain:
//
//   note  -> note    a [[wikilink]]
//   note  -> person  a [[wikilink]] that resolves to someone
//   note  -> recording  a capture saved into that note
//   person -> action  an action they own
//   recording -> action  the conversation an action was quoted from
//
// A generic note graph would be decoration. This one shows why things are connected:
// who a conversation involved, and what came out of it.
const links = require("./links");
const people = require("./people");

const MAX_NODES = 600;

function build(store, workspaceId) {
  store.getWorkspace({ workspaceId });
  const nodes = new Map();
  const edges = [];
  const add = (kind, id, label, extra = {}) => {
    if (!id || nodes.has(id)) return id;
    nodes.set(id, { id, kind, label: label || "Untitled", ...extra });
    return id;
  };
  const join = (from, to, kind) => {
    if (from && to && nodes.has(from) && nodes.has(to)) edges.push({ from, to, kind });
  };
  const rows = (table, where = "") =>
    store._db
      .prepare(`SELECT id, data_json FROM ${table} WHERE workspace_id=? AND deleted_at IS NULL${where}`)
      .all(workspaceId)
      .map((row) => ({ id: row.id, ...JSON.parse(row.data_json) }));

  const byTitle = new Map();
  for (const note of rows("notes")) {
    add("note", note.id, note.title, { noteKind: note.kind });
    if (note.title) byTitle.set(links.key(note.title), note.id);
  }
  for (const recording of rows("recordings"))
    add("recording", recording.id, new Date(recording.startedAt).toISOString().slice(0, 10), {
      purpose: recording.purpose,
    });
  for (const person of people.list(store, workspaceId).items)
    add("person", person.id, person.name, { theyOwe: person.theyOwe, youOwe: person.youOwe });
  const actions = rows("actions");
  for (const action of actions)
    add("action", action.id, action.title.slice(0, 80), { status: action.status });

  // Links are repaired as pages appear, so target_id is normally set; matching on
  // title as well keeps rows written before that repair existed drawn correctly.
  for (const row of store._db
    .prepare("SELECT note_id, target_kind, target_id, target_key FROM note_links WHERE workspace_id=?")
    .all(workspaceId)) {
    const target = row.target_id ?? (row.target_kind === "note" ? byTitle.get(row.target_key) : null);
    join(row.note_id, target, row.target_kind === "person" ? "mentions" : "links");
  }

  for (const link of rows("note_recordings")) join(link.noteId, link.recordingId, "captured");

  const segmentRecording = new Map(
    store._db
      .prepare("SELECT id, recording_id FROM transcript_segments WHERE workspace_id=? AND deleted_at IS NULL")
      .all(workspaceId)
      .map((row) => [row.id, row.recording_id]),
  );
  for (const action of actions) {
    const evidence = action.evidence?.[0];
    // Where the commitment came from: the conversation it was said in, or the page
    // it was written on.
    if (evidence?.sourceKind === "note") join(evidence.segmentId, action.id, "proposed");
    else join(segmentRecording.get(evidence?.segmentId), action.id, "proposed");
    if (action.owner?.kind === "person" && action.owner.id) join(action.owner.id, action.id, "owns");
  }

  // An action nobody owns and nothing proposed has no place in a picture of
  // relationships; dropping it is not truncation, so it is not reported as such.
  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const drawable = [...nodes.values()].filter(
    (node) => connected.has(node.id) || node.kind !== "action",
  );
  const kept = drawable.slice(0, MAX_NODES);
  const ids = new Set(kept.map((node) => node.id));
  return {
    nodes: kept,
    edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    truncated: drawable.length > kept.length,
  };
}

module.exports = { build };
