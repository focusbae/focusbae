"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const Database = require("better-sqlite3");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { BackupService } = require("../../workspace/backup");
const archive = require("../../workspace/backup-archive");
const { Spool } = require("../../recording/spool");
const { mutation, scope, document } = require("../local-first/helpers.cjs");
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-backup-test-"));
  let busy = false;
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"), { busy: () => busy });
  await catalog.initialize();
  t.after(async () => { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const service = new BackupService(catalog);
  return { root, catalog, service, file: path.join(root, "test.focusbae-backup"), busy: (value) => { busy = value; } };
}
function seed(s) {
  s._db.pragma("wal_autocheckpoint = 0");
  const note = s.createNote(mutation(s), { title: "Backup pilot", content: document("A preserved thought [[Next steps]]") });
  const next = s.createNote(mutation(s), { title: "Next steps" });
  const deleted = s.createNote(mutation(s), { title: "In Trash" });
  s.delete(mutation(s, deleted.revision), "note", deleted.id);
  const recording = s.createRecording(mutation(s), { keepAudio: true,
    metadata: { localCaptureVersion: 1, importedWavVersion: 1, originalName: "evidence.wav" } });
  const spool = new Spool(s, recording.id).create(recording, "english");
  spool.append({ source: "import", sequence: 0, startMs: 0, pcm: Buffer.alloc(32000, 3) });
  spool.save({ state: "interrupted" });
  s.updateRecording(mutation(s, recording.revision), recording.id, { state: "interrupted", endedAt: new Date().toISOString() });
  const transcript = s.createTranscript(mutation(s), { recordingId: recording.id, source: "import", startMs: 0, endMs: 1000, text: "Remember this conversation" });
  const action = s.createAction(mutation(s), { title: "Send the proposal" });
  const attachment = s.putAttachment(mutation(s), { noteId: note.id, displayName: "kept.txt" }, Buffer.from("attachment bytes"));
  return { note, next, deleted, recording, transcript, action, attachment };
}
test("full backup includes committed WAL, media, ownership and trash; restore is separate and durable", async (t) => {
  const f = await fixture(t), s = f.catalog.store, id = s.identity.id;
  const data = seed(s);
  const before = f.catalog.list();
  const result = await f.catalog.serialize(() => f.service.create(id, f.file));
  assert.ok(result.bytes > 32000); assert.equal(result.statusSaved, true);
  assert.equal(f.service.status(id).lastBackup.fileName, "test.focusbae-backup");
  const manifest = await archive.verify(f.file);
  assert.ok(manifest.files.some((item) => item.path.endsWith("import-000000.pcm")));
  assert.equal(manifest.files.some((item) => /search.sqlite|backup-status|clipboard|workspace-lock/.test(item.path)), false);
  s.updateNote(mutation(s, data.note.revision), data.note.id, { title: "Newer original" });
  const restored = await f.catalog.serialize(() => f.service.restore(f.file));
  assert.equal(f.catalog.activeId, id); assert.equal(f.catalog.store, s);
  assert.equal(f.catalog.list().length, before.length + 1); assert.notEqual(restored.id, id);
  assert.equal(s.get(scope(s), "note", data.note.id).title, "Newer original");
  await f.catalog.open({ workspaceId: restored.id });
  const copy = f.catalog.store;
  assert.equal(copy.get(scope(copy), "note", data.note.id).title, "Backup pilot");
  assert.equal(copy.get(scope(copy), "transcript", data.transcript.id).text, "Remember this conversation");
  assert.equal(copy.get(scope(copy), "action", data.action.id).owner.id, s.identity.localActorId);
  assert.equal(copy.readAttachment(scope(copy), data.attachment.id).toString(), "attachment bytes");
  assert.ok(copy._db.prepare("SELECT deleted_at FROM notes WHERE id=?").get(data.deleted.id).deleted_at);
  assert.equal(new Spool(copy, data.recording.id).open().read("import-000000.pcm").pcm.length, 32000);
  const player = new (require("../../recording/playback").PlaybackService)(f.catalog, {});
  assert.equal(player.info({ workspaceId: restored.id, id: data.recording.id }).durationMs, 1000);
  assert.equal(player.read({ workspaceId: restored.id, id: data.recording.id, source: "all", startMs: 500, durationMs: 500 }).samples.length, 8000);
  assert.ok(copy.search(scope(copy), "preserved").length);
  assert.equal(copy._db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(copy._db.pragma("foreign_key_check"), []);
  assert.equal(f.service.status(restored.id).lastBackup, null);
  await f.catalog.close(); await f.catalog.initialize();
  assert.equal(f.catalog.activeId, restored.id);
  await f.catalog.open({ workspaceId: id });
  assert.equal(f.service.status(id).lastBackup.fileName, result.fileName);
});
test("corrupt/truncated archives, busy captures and failed publication preserve the existing workspace", async (t) => {
  const f = await fixture(t), id = f.catalog.activeId;
  seed(f.catalog.store);
  await f.catalog.serialize(() => f.service.create(id, f.file));
  const original = fs.readFileSync(f.file), entries = f.catalog.list();
  f.busy(true);
  await assert.rejects(f.service.create(id, f.file), { code: "BACKUP_BUSY" });
  await assert.rejects(f.service.restore(f.file), { code: "BACKUP_BUSY" }); f.busy(false);
  assert.deepEqual(fs.readFileSync(f.file), original);
  const corrupt = path.join(f.root, "bad.focusbae-backup");
  for (const bytes of [original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from("trailing")])]) {
    fs.writeFileSync(corrupt, bytes); await assert.rejects(f.service.restore(corrupt), { code: "INVALID_BACKUP" });
  }
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  fs.writeFileSync(corrupt, changed); await assert.rejects(f.service.restore(corrupt), { code: "INVALID_BACKUP" });
  const persist = f.catalog.persist;
  f.catalog.persist = () => { throw new Error("Synthetic catalog failure"); };
  try { await assert.rejects(f.service.restore(f.file), /Synthetic catalog failure/); }
  finally { f.catalog.persist = persist; }
  assert.deepEqual(f.catalog.list(), entries); assert.equal(f.catalog.activeId, id);
  assert.equal(fs.readdirSync(f.catalog.root).some((name) => name.startsWith(".restore-")), false);
});
function rewriteManifest(bytes, change) {
  const start = archive.MAGIC.length + 36;
  const length = bytes.readUInt32LE(archive.MAGIC.length);
  const value = JSON.parse(bytes.subarray(start, start + length)); change(value);
  const raw = Buffer.from(JSON.stringify(value)), prefix = Buffer.alloc(4); prefix.writeUInt32LE(raw.length);
  return Buffer.concat([archive.MAGIC, prefix, createHash("sha256").update(raw).digest(), raw, bytes.subarray(start + length)]);
}
test("hostile paths, duplicate files, newer schemas and injected SQLite triggers are rejected", async (t) => {
  const f = await fixture(t), id = f.catalog.activeId; seed(f.catalog.store);
  await f.service.create(id, f.file);
  const original = fs.readFileSync(f.file), bad = path.join(f.root, "hostile.focusbae-backup");
  for (const change of [
    (m) => { m.files[1].path = "attachments/../../outside"; },
    (m) => { m.files[1].path = "/tmp/outside"; },
    (m) => { m.files[1].path = m.files[0].path; },
    (m) => { m.files[1].path = "attachments/../workspace.sqlite"; },
  ]) {
    fs.writeFileSync(bad, rewriteManifest(original, change));
    await assert.rejects(f.service.restore(bad), { code: "INVALID_BACKUP" });
  }
  fs.writeFileSync(bad, rewriteManifest(original, (m) => { m.schemaVersion = 999; }));
  await assert.rejects(f.service.restore(bad), { code: "NEWER_SCHEMA" });
  const stage = fs.mkdtempSync(path.join(f.root, "hostile-"));
  const manifest = await archive.unpack(f.file, stage);
  const db = new Database(path.join(stage, "workspace.sqlite"));
  db.exec("CREATE TRIGGER evil AFTER UPDATE ON workspaces BEGIN DELETE FROM notes; END"); db.close();
  const { files: _, ...metadata } = manifest;
  const entries = manifest.files.map((item) => ({ path: item.path, file: path.join(stage, item.path), bytes: fs.statSync(path.join(stage, item.path)).size }));
  const injected = path.join(f.root, "injected.focusbae-backup");
  await archive.pack(injected, metadata, entries);
  await assert.rejects(f.service.restore(injected), { code: "INVALID_BACKUP" });
  assert.equal(f.catalog.list().length, 1); assert.equal(f.catalog.activeId, id);
});
test("missing media, symlinks and output inside live workspaces never produce a successful backup", async (t) => {
  const f = await fixture(t), s = f.catalog.store, id = s.identity.id, data = seed(s);
  await assert.rejects(f.service.create(id, path.join(s._directory, "bad.focusbae-backup")), { code: "INVALID_BACKUP" });
  const link = path.join(s._directory, "attachments", "unsafe");
  fs.symlinkSync(f.file, link);
  await assert.rejects(f.service.create(id, f.file)); fs.unlinkSync(link);
  assert.equal(fs.existsSync(f.file), false);
  fs.unlinkSync(path.join(s._directory, data.attachment.relativePath));
  await assert.rejects(f.service.create(id, f.file), { code: "INVALID_BACKUP" });
  assert.equal(fs.existsSync(f.file), false); assert.equal(f.service.status(id).lastBackup, null);
});
test("disk-full writes preserve an earlier backup and its successful status", async (t) => {
  const f = await fixture(t), id = f.catalog.activeId; seed(f.catalog.store);
  await f.service.create(id, f.file);
  const original = fs.readFileSync(f.file), status = f.service.status(id).lastBackup;
  const write = fs.writeSync;
  fs.writeSync = () => { throw Object.assign(new Error("Synthetic disk full"), { code: "ENOSPC" }); };
  try { await assert.rejects(f.service.create(id, f.file), { code: "DISK_FULL" }); }
  finally { fs.writeSync = write; }
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(f.service.status(id).lastBackup, status);
  assert.equal(f.service.activity, null);
  assert.equal(fs.readdirSync(f.root).some((name) => name.endsWith(".partial")), false);
});
test("a catalog failure after publication does not remove the registered restored directory", async (t) => {
  const f = await fixture(t), id = f.catalog.activeId; seed(f.catalog.store);
  await f.service.create(id, f.file);
  const persist = f.catalog.persist;
  f.catalog.persist = function () { persist.call(this); throw new Error("Synthetic post-publication flush failure"); };
  try { await assert.rejects(f.service.restore(f.file), /Synthetic post-publication/); }
  finally { f.catalog.persist = persist; }
  assert.equal(f.catalog.activeId, id);
  const saved = JSON.parse(fs.readFileSync(f.catalog.file));
  assert.equal(saved.entries.length, 2);
  assert.ok(fs.existsSync(path.join(f.catalog.root, saved.entries[1].directory, "workspace.sqlite")));
  await f.catalog.close(); await f.catalog.initialize();
  await f.catalog.open({ workspaceId: saved.entries[1].id });
  assert.equal(f.catalog.store.search(scope(f.catalog.store), "preserved").length, 1);
});
test("missing committed recording chunks cannot be reported as a complete backup", async (t) => {
  const f = await fixture(t), s = f.catalog.store, data = seed(s);
  fs.unlinkSync(path.join(s._directory, "capture-spool", data.recording.id, "import-000000.pcm"));
  await assert.rejects(f.service.create(s.identity.id, f.file), { code: "INVALID_BACKUP" });
  assert.equal(fs.existsSync(f.file), false);
});
test("a version-one backup migrates only its separate restored copy", async (t) => {
  const f = await fixture(t); seed(f.catalog.store);
  await f.service.create(f.catalog.activeId, f.file);
  const stage = fs.mkdtempSync(path.join(f.root, "old-schema-"));
  const manifest = await archive.unpack(f.file, stage);
  const db = new Database(path.join(stage, "workspace.sqlite"));
  db.exec("DROP INDEX attachments_by_note; DROP INDEX notes_by_folder; DROP TABLE folders; DROP TABLE note_links; DROP TABLE action_reminders; DELETE FROM schema_migrations WHERE version > 1; PRAGMA user_version = 1;");
  db.close();
  const { files: _, ...metadata } = manifest; metadata.schemaVersion = 1;
  const old = path.join(f.root, "old.focusbae-backup");
  await archive.pack(old, metadata, manifest.files.map((item) => ({ path: item.path, file: path.join(stage, item.path), bytes: fs.statSync(path.join(stage, item.path)).size })));
  const before = fs.readFileSync(old);
  const restored = await f.service.restore(old);
  assert.deepEqual(fs.readFileSync(old), before);
  await f.catalog.open({ workspaceId: restored.id });
  assert.equal(f.catalog.store._db.pragma("user_version", { simple: true }), 5);
  assert.equal(fs.readdirSync(path.join(f.catalog.store._directory, "backups")).some((name) => name.startsWith("schema-1-to-5")), true);
});
test("SIGKILL during archive verification or restore preparation preserves the original and previous backup", async (t) => {
  const f = await fixture(t); seed(f.catalog.store);
  const id = f.catalog.activeId;
  await f.service.create(id, f.file);
  const archiveBefore = fs.readFileSync(f.file), catalogBefore = fs.readFileSync(f.catalog.file);
  await f.catalog.close();
  for (const method of ["create", "restore"]) {
    const child = require("node:child_process").spawn(process.execPath, [path.join(__dirname, "backup-worker.cjs"), f.catalog.root, f.file, method], { stdio: ["ignore", "ignore", "pipe"] });
    let output = ""; child.stderr.on("data", (value) => { output += value; });
    const result = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal })); });
    assert.equal(result.signal, "SIGKILL", output);
    assert.deepEqual(fs.readFileSync(f.file), archiveBefore);
    assert.deepEqual(fs.readFileSync(f.catalog.file), catalogBefore);
  }
  await f.catalog.initialize();
  assert.equal(f.catalog.activeId, id); assert.equal(f.catalog.entries.length, 1);
  assert.equal(f.catalog.store.search(scope(f.catalog.store), "preserved").length, 1);
});
