"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, mutation, scope, document } = require("./helpers.cjs");
const { createWorkspace } = require("../../workspace");
const { moveRecording } = require("../../workspace/transfer");

// A finished conversation with a speaker, two lines, a suggestion and an accepted
// commitment (with a reminder), its kept audio, a file, and the note it was saved with.
async function conversation(store) {
  let recording = store.createRecording(mutation(store), { purpose: "conversation", title: "Globex call" });
  for (const state of ["recording", "stopping"]) recording = store.updateRecording(mutation(store, recording.revision), recording.id, { state });
  recording = store.updateRecording(mutation(store, recording.revision), recording.id, { state: "captured", endedAt: new Date().toISOString(), transcriptionState: "complete" });
  const speaker = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
  const lines = ["I'll send the signed SOW on Friday", "We keep the discount at 20 percent"].map((text, i) =>
    store.createTranscript(mutation(store), { recordingId: recording.id, source: "microphone", startMs: i * 2000, endMs: i * 2000 + 1000, text, speakerId: speaker.id }));
  const evidence = (segment) => [{ sourceKind: "transcript", segmentId: segment.id, revision: segment.revision, quote: segment.text, startOffset: 0, endOffset: segment.text.length }];
  const accepted = store.proposeAction(mutation(store), { title: "Send the signed SOW", evidence: evidence(lines[0]) });
  store.transitionAction(mutation(store, accepted.revision), accepted.id, { status: "accepted" });
  const suggestion = store.proposeAction(mutation(store), { title: "Keep the discount", evidence: evidence(lines[1]) });
  store._db.prepare("INSERT INTO action_reminders VALUES (?, ?, NULL, NULL, ?)").run(accepted.id, store.identity.id, new Date().toISOString());
  const note = store.createNote(mutation(store), { title: "Today", content: document("Calls") });
  store.linkRecording(mutation(store), { recordingId: recording.id, noteId: note.id });
  const audio = path.join(store._directory, "capture-spool", recording.id);
  fs.mkdirSync(audio, { recursive: true });
  fs.writeFileSync(path.join(audio, "manifest.json"), JSON.stringify({ version: 1, workspaceId: store.identity.id, recordingId: recording.id }));
  fs.writeFileSync(path.join(audio, "microphone-000001.pcm"), Buffer.alloc(320));
  const file = store.putAttachment(mutation(store), { recordingId: recording.id, displayName: "call.wav", mediaType: "audio/wav" }, Buffer.from("RIFFwav"));
  return { recording, speaker, lines, accepted, suggestion, note, file };
}

async function two(t) {
  const { store: source, root } = await fixture(t);
  const target = await createWorkspace({ directory: path.join(root, "globex"), name: "Globex", preferences: { timezone: "Asia/Kolkata" } });
  t.after(() => target.close());
  return { source, target };
}

test("a recording moves with its transcript, speakers, commitments, reminders, files and audio, and leaves nothing behind", async (t) => {
  const { source, target } = await two(t);
  const c = await conversation(source);
  const result = moveRecording({ source, target, recordingId: c.recording.id });
  assert.deepEqual(result, { recordingId: c.recording.id, actions: 2, accepted: 1 });

  assert.equal(target.get(scope(target), "recording", c.recording.id).title, "Globex call");
  assert.equal(target.list(scope(target), "transcript", { recordingId: c.recording.id }).length, 2);
  assert.equal(target.get(scope(target), "speaker", c.speaker.id).recordingId, c.recording.id);
  assert.equal(target.get(scope(target), "action", c.accepted.id).status, "accepted");
  assert.equal(target.get(scope(target), "action", c.suggestion.id).status, "proposed");
  assert.equal(target._db.prepare("SELECT count(*) AS n FROM action_reminders WHERE action_id = ?").get(c.accepted.id).n, 1);
  assert.deepEqual(target.readAttachment(scope(target), c.file.id), Buffer.from("RIFFwav"));
  const manifest = JSON.parse(fs.readFileSync(path.join(target._directory, "capture-spool", c.recording.id, "manifest.json"), "utf8"));
  assert.equal(manifest.workspaceId, target.identity.id, "the kept audio now belongs to the target");
  assert.ok(fs.existsSync(path.join(target._directory, "capture-spool", c.recording.id, "microphone-000001.pcm")));
  assert.equal(target._db.prepare("SELECT count(*) AS n FROM search_documents WHERE body LIKE '%signed SOW%'").get().n > 0, true, "searchable in the target");

  for (const [table, column] of [["recordings", "id"], ["transcript_segments", "recording_id"], ["speakers", "recording_id"], ["note_recordings", "recording_id"], ["attachments", "recording_id"]])
    assert.equal(source._db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(c.recording.id).n, 0, `${table} cleared`);
  assert.equal(source._db.prepare("SELECT count(*) AS n FROM actions").get().n, 0);
  assert.equal(source._db.prepare("SELECT count(*) AS n FROM search_documents WHERE body LIKE '%SOW%' OR title LIKE '%SOW%'").get().n, 0, "not findable where it was recorded");
  assert.equal(fs.existsSync(path.join(source._directory, "capture-spool", c.recording.id)), false);
  assert.equal(source.get(scope(source), "note", c.note.id).title, "Today", "the note it was saved with stays");
});

test("a move is refused while recording or transcribing, or once the team holds a commitment from it", async (t) => {
  const { source, target } = await two(t);
  const live = source.createRecording(mutation(source), { purpose: "conversation" });
  assert.throws(() => moveRecording({ source, target, recordingId: live.id }), /Stop the recording first/);
  const c = await conversation(source);
  assert.throws(() => moveRecording({ source, target, recordingId: c.recording.id, shared: new Set([c.accepted.id]) }),
    /1 commitment from it is already shared .* Withdraw it first/);
  assert.equal(source.get(scope(source), "recording", c.recording.id).id, c.recording.id, "nothing changed");
  assert.equal(target._db.prepare("SELECT count(*) AS n FROM recordings").get().n, 0);
  assert.equal(fs.existsSync(path.join(target._directory, "capture-spool", c.recording.id)), false);
});

test("if the source cannot be cleared, the target copy is removed again", async (t) => {
  const { source, target } = await two(t);
  const c = await conversation(source);
  const real = source._db.transaction.bind(source._db);
  source._db.transaction = () => () => { throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" }); };
  assert.throws(() => moveRecording({ source, target, recordingId: c.recording.id }), /disk full/);
  source._db.transaction = real;
  assert.equal(target._db.prepare("SELECT count(*) AS n FROM recordings").get().n, 0);
  assert.equal(target._db.prepare("SELECT count(*) AS n FROM actions").get().n, 0);
  assert.equal(fs.existsSync(path.join(target._directory, "capture-spool", c.recording.id)), false);
  assert.equal(source.get(scope(source), "recording", c.recording.id).id, c.recording.id, "the original is intact");
});
