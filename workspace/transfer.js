"use strict";
// Moving one recording to another workspace on this Mac: a client call recorded into
// the wrong company's workspace (TEAM_PLAN §6.6). Every recording belongs to exactly
// one workspace, so this is a move, never a copy: the recording, its speakers,
// transcript, commitments, reminders, files and kept audio arrive in the target with
// the same ids, and then leave the source entirely, search index included.
//
// The target is written first and the source cleared second. If clearing the source
// fails, the target copy is removed again, so the recording is never in both places
// and never in neither. Files are copied before either database changes.
const fs = require("node:fs");
const path = require("node:path");
const files = require("./files");
const { check } = require("./errors");

const TERMINAL = new Set(["captured", "interrupted", "failed"]);

function rows(store, table, column, ids) {
  if (!ids.length) return [];
  return store._db.prepare(`SELECT id FROM ${table} WHERE ${column} IN (${ids.map(() => "?").join(",")})`)
    .all(...ids).map((row) => row.id);
}

// Everything that belongs to the recording, as stored records.
function collect(store, recordingId) {
  const recording = store._raw("recording", recordingId);
  check(recording && !recording.deletedAt, "NOT_FOUND", "Recording does not exist");
  const raw = (kind) => (id) => store._raw(kind, id);
  const speakers = rows(store, "speakers", "recording_id", [recordingId]).map(raw("speaker"));
  const segments = rows(store, "transcript_segments", "recording_id", [recordingId]).map(raw("transcript"));
  const segmentIds = new Set(segments.map((s) => s.id));
  // Commitments quoted from this conversation go with it; ones written in notes stay.
  const actions = store._db.prepare("SELECT id FROM actions").all().map((row) => store._raw("action", row.id))
    .filter((a) => a.evidence?.some((e) => (e.sourceKind ?? "transcript") === "transcript" && segmentIds.has(e.segmentId)));
  const actionIds = actions.map((a) => a.id);
  const reminders = actionIds.length
    ? store._db.prepare(`SELECT * FROM action_reminders WHERE action_id IN (${actionIds.map(() => "?").join(",")})`).all(...actionIds)
    : [];
  const attachments = rows(store, "attachments", "recording_id", [recordingId]).map(raw("attachment"));
  const links = rows(store, "note_recordings", "recording_id", [recordingId]);
  return { recording, speakers, segments, actions, reminders, attachments, links };
}

// What stops a move, in words the person can act on. `shared` lists the action ids the
// source's team already holds.
function blockers(bundle, shared) {
  const reasons = [];
  if (!TERMINAL.has(bundle.recording.state)) reasons.push("Stop the recording first.");
  else if (["queued", "running"].includes(bundle.recording.transcriptionState)) reasons.push("Wait for transcription to finish.");
  const sharedCount = bundle.actions.filter((a) => shared.has(a.id)).length;
  if (sharedCount) reasons.push(`${sharedCount} ${sharedCount === 1 ? "commitment" : "commitments"} from it ${sharedCount === 1 ? "is" : "are"} already shared with this workspace's team. Withdraw ${sharedCount === 1 ? "it" : "them"} first.`);
  return reasons;
}

function spoolDirectory(store, recordingId) {
  return path.dirname(files.managedPath(store._directory, `capture-spool/${recordingId}/manifest.json`));
}

function copyFiles(source, target, bundle) {
  const from = spoolDirectory(source, bundle.recording.id);
  const to = spoolDirectory(target, bundle.recording.id);
  check(!fs.existsSync(to), "CONFLICT", "The other workspace already has audio for this recording");
  if (fs.existsSync(from)) {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true });
    const manifest = path.join(to, "manifest.json");
    if (fs.existsSync(manifest)) {
      files.atomicJson(manifest, { ...JSON.parse(fs.readFileSync(manifest, "utf8")), workspaceId: target.identity.id });
    }
    files.flushDirectory(path.dirname(to));
  }
  for (const file of bundle.attachments) {
    const destination = files.managedPath(target._directory, file.relativePath);
    if (!fs.existsSync(destination)) fs.copyFileSync(files.managedPath(source._directory, file.relativePath), destination, fs.constants.COPYFILE_EXCL);
  }
  return () => {
    fs.rmSync(to, { recursive: true, force: true });
    for (const file of bundle.attachments) fs.rmSync(files.managedPath(target._directory, file.relativePath), { force: true });
  };
}

function write(target, bundle) {
  const workspaceId = target.identity.id;
  const moved = new Set(bundle.actions.map((a) => a.id));
  const kinds = [["recording", [bundle.recording]], ["speaker", bundle.speakers], ["transcript", bundle.segments],
    ["attachment", bundle.attachments], ["action", bundle.actions]];
  target._db.transaction(() => {
    for (const [kind, records] of kinds) for (const record of records) {
      check(!target._raw(kind, record.id), "CONFLICT", "The other workspace already has this recording");
      // A restatement of a commitment that stays behind starts a new chain here.
      const next = { ...record, workspaceId, ...(kind === "action" && record.restatementOf && !moved.has(record.restatementOf) ? { restatementOf: null } : {}) };
      target._save(kind, next);
    }
    const reminder = target._db.prepare("INSERT INTO action_reminders VALUES (?, ?, ?, ?, ?)");
    for (const r of bundle.reminders) reminder.run(r.action_id, workspaceId, r.snoozed_until, r.last_notified_at, r.updated_at);
  })();
}

function unwrite(target, bundle) {
  target._db.transaction(() => clear(target, bundle))();
}

// Removes the records from a store: no tombstones, no search entries, no remembered
// mutation results, so nothing of the conversation stays where it was recorded.
function clear(store, bundle) {
  const del = (table, ids) => ids.length && store._db.prepare(`DELETE FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  const actionIds = bundle.actions.map((a) => a.id);
  if (actionIds.length) {
    const marks = actionIds.map(() => "?").join(",");
    // Commitments that stay behind no longer point into the moved conversation.
    for (const { id } of store._db.prepare(`SELECT id FROM actions WHERE json_extract(data_json, '$.restatementOf') IN (${marks}) AND id NOT IN (${marks})`).all(...actionIds, ...actionIds)) {
      const old = store._raw("action", id);
      store._save("action", { ...old, restatementOf: null });
    }
    store._db.prepare(`DELETE FROM action_reminders WHERE action_id IN (${marks})`).run(...actionIds);
  }
  del("actions", actionIds);
  del("note_recordings", bundle.links ?? []);
  del("attachments", bundle.attachments.map((a) => a.id));
  del("transcript_segments", bundle.segments.map((s) => s.id));
  del("speakers", bundle.speakers.map((s) => s.id));
  del("recordings", [bundle.recording.id]);
  const entities = [["recording", [bundle.recording.id]], ["transcript", bundle.segments.map((s) => s.id)], ["action", actionIds],
    ["speaker", bundle.speakers.map((s) => s.id)]];
  for (const [kind, ids] of entities) for (const id of ids) {
    store._db.prepare("DELETE FROM search_documents WHERE entity_kind = ? AND entity_id = ?").run(kind, id);
    store._db.prepare("DELETE FROM source_revisions WHERE entity_kind = ? AND entity_id = ?").run(kind, id);
    store._db.prepare("DELETE FROM mutation_requests WHERE json_extract(result_json, '$.id') = ?").run(id);
  }
}

// `shared`: ids of the source workspace's actions its team already holds.
function moveRecording({ source, target, recordingId, shared = new Set() }) {
  check(source.identity.id !== target.identity.id, "INVALID_INPUT", "Choose another workspace");
  const bundle = collect(source, recordingId);
  const reasons = blockers(bundle, shared);
  check(!reasons.length, "MOVE_BLOCKED", reasons.join(" "));
  const removeCopies = copyFiles(source, target, bundle);
  try {
    write(target, bundle);
  } catch (error) {
    removeCopies();
    throw error;
  }
  try {
    source._db.transaction(() => clear(source, bundle))();
  } catch (error) {
    unwrite(target, { ...bundle, links: [] });
    removeCopies();
    throw error;
  }
  fs.rmSync(spoolDirectory(source, recordingId), { recursive: true, force: true });
  for (const file of bundle.attachments) fs.rmSync(files.managedPath(source._directory, file.relativePath), { force: true });
  return { recordingId, actions: bundle.actions.length, accepted: bundle.actions.filter((a) => a.status !== "proposed" && a.status !== "dropped").length };
}

module.exports = { moveRecording, collect, blockers };
