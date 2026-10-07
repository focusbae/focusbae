"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { setImmediate: yieldIO } = require("node:timers/promises");
const Database = require("better-sqlite3");
const files = require("./files");
const archive = require("./backup-archive");
const { check } = require("./errors");
const v = require("./validation");
const { MIGRATIONS, APPLICATION_ID, SCHEMA_VERSION } = require("./schema");
const { migrate } = require("./migrations");
const { openWorkspace } = require("./index");
const { Spool } = require("../recording/spool");

const expected = new Map();
const schema = (db) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
async function inspectDatabase(file, manifest) {
  check(manifest.schemaVersion <= SCHEMA_VERSION, "NEWER_SCHEMA", "Backup requires a newer app");
  if (!expected.has(manifest.schemaVersion)) {
    const reference = new Database(":memory:");
    try {
      await migrate(reference, null, MIGRATIONS.slice(0, manifest.schemaVersion));
      expected.set(manifest.schemaVersion, JSON.stringify(schema(reference)));
    } finally { reference.close(); }
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    check(db.pragma("application_id", { simple: true }) === APPLICATION_ID &&
      db.pragma("user_version", { simple: true }) === manifest.schemaVersion,
    "INVALID_BACKUP", "Backup database version mismatch");
    // A checksum proves intact bytes, not trust. Reject additional SQL objects,
    // triggers and virtual modules before any workspace initialization executes.
    check(JSON.stringify(schema(db)) === expected.get(manifest.schemaVersion), "INVALID_BACKUP", "Unsupported database schema");
    check(db.pragma("integrity_check", { simple: true }) === "ok" && db.pragma("foreign_key_check").length === 0,
      "INVALID_BACKUP", "Backup database integrity check failed");
    const rows = db.prepare("SELECT * FROM workspaces").all();
    check(rows.length === 1 && rows[0].id === manifest.workspaceId && rows[0].actor_id === manifest.localActorId && rows[0].name === manifest.name,
      "INVALID_BACKUP", "Backup workspace identity mismatch");
    require("./domain").preferences(JSON.parse(rows[0].preferences_json));
    for (const table of schema(db).filter((item) => item.type === "table" && !item.name.startsWith("sqlite_"))) {
      const columns = db.pragma(`table_info("${table.name}")`);
      if (columns.some((column) => column.name === "workspace_id"))
        check(!db.prepare(`SELECT 1 FROM "${table.name}" WHERE workspace_id != ? LIMIT 1`).get(manifest.workspaceId), "INVALID_BACKUP", "Cross-workspace backup record");
    }
    check(db.prepare("SELECT count(*) AS n FROM file_journal").get().n === 0, "INVALID_BACKUP", "Unresolved managed-file writes");
    const migrations = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    check(migrations.length === manifest.schemaVersion && migrations.every((item, index) => item.version === index + 1 && item.checksum === v.hash(MIGRATIONS[index].sql)), "INVALID_BACKUP", "Invalid migration history");
    return rows[0];
  } finally { db.close(); }
}
async function validateMedia(db, directory, workspaceId) {
  const { documentContent, attachmentIds } = require("./content");
  for (const row of db.prepare("SELECT id,data_json FROM notes").iterate()) {
    const note = JSON.parse(row.data_json);
    documentContent(note.content, note.contentSchemaVersion);
    for (const id of attachmentIds(note.content)) {
      const attachment = db.prepare("SELECT note_id,deleted_at FROM attachments WHERE id=?").get(id);
      check(attachment && attachment.note_id === row.id && !attachment.deleted_at, "INVALID_BACKUP", "Invalid note attachment link");
    }
  }
  for (const row of db.prepare("SELECT data_json FROM attachments WHERE deleted_at IS NULL").iterate()) {
    const item = JSON.parse(row.data_json);
    if (item.previewId) {
      const preview = db.prepare("SELECT note_id,deleted_at FROM attachments WHERE id=?").get(item.previewId);
      check(preview && !preview.deleted_at && preview.note_id === item.noteId, "INVALID_BACKUP", "Invalid image preview link");
    }
    check(/^attachments\/[0-9a-f-]{36}-[0-9a-f]{64}\.blob$/.test(item.relativePath), "INVALID_BACKUP", "Invalid attachment reference");
    const file = files.managedPath(directory, item.relativePath);
    check(files.inspect(file) && fs.statSync(file).size === item.byteSize && files.fileHash(file) === item.contentHash,
      "INVALID_BACKUP", "Missing or damaged attachment");
    await yieldIO();
  }
  for (const row of db.prepare("SELECT id,data_json FROM recordings WHERE json_extract(data_json,'$.metadata.localCaptureVersion')=1").iterate()) {
    const record = JSON.parse(row.data_json);
    check(!["preparing", "recording", "stopping"].includes(record.state) && record.transcriptionState !== "running",
      "BACKUP_BUSY", "Capture or transcription is not settled");
    const spool = new Spool({ identity: { id: workspaceId }, _directory: directory }, row.id).open();
    const scan = spool.scan();
    check(!scan.issues.some((issue) => issue.startsWith("Unreadable")), "INVALID_BACKUP", "Damaged recording audio");
    if (!spool.manifest.purged && !spool.manifest.discarded)
      check(scan.bytes >= spool.manifest.bytes && scan.chunks.length >= spool.manifest.chunks, "INVALID_BACKUP", "Missing recording audio");
    await yieldIO();
  }
}
async function reidentify(directory, manifest, id, name) {
  const db = new Database(path.join(directory, "workspace.sqlite"));
  try {
    // The catalog key changes, while local actor/entity IDs keep ownership,
    // evidence, links and speaker identity intact inside the independent copy.
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      db.prepare("DELETE FROM mutation_requests").run(); // old retry receipts are not user content
      for (const table of schema(db).filter((item) => item.type === "table" && !item.name.startsWith("sqlite_"))) {
        if (db.pragma(`table_info("${table.name}")`).some((column) => column.name === "workspace_id"))
          db.prepare(`UPDATE "${table.name}" SET workspace_id = ? WHERE workspace_id = ?`).run(id, manifest.workspaceId);
      }
      db.prepare("UPDATE workspaces SET id=?, name=?, revision=revision+1, updated_at=? WHERE id=?").run(id, name, new Date().toISOString(), manifest.workspaceId);
    }).immediate();
    db.pragma("foreign_keys = ON");
    check(db.pragma("foreign_key_check").length === 0, "INVALID_BACKUP", "Restored references are invalid");
  } finally { db.close(); }
  for (const item of archive.walk(directory, "capture-spool")) {
    if (/^capture-spool\/[0-9a-f-]{36}\/manifest\.json$/.test(item.path)) {
      check(item.bytes < 65536, "INVALID_BACKUP", "Audio manifest exceeds limit");
      const value = JSON.parse(fs.readFileSync(item.file, "utf8"));
      check(value.workspaceId === manifest.workspaceId, "INVALID_BACKUP", "Wrong audio workspace");
      value.workspaceId = id; files.atomicJson(item.file, value);
    } else if (/^capture-spool\/[0-9a-f-]{36}\/(microphone|system|import)-\d{6}\.pcm$/.test(item.path)) {
      check(item.bytes <= 164096, "INVALID_BACKUP", "Audio chunk exceeds limit");
      const buffer = fs.readFileSync(item.file), length = buffer.readUInt32LE();
      check(length > 0 && length < 4096 && 4 + length < buffer.length, "INVALID_BACKUP", "Invalid audio header");
      const value = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      check(value.workspaceId === manifest.workspaceId, "INVALID_BACKUP", "Wrong audio workspace");
      value.workspaceId = id;
      const header = Buffer.from(JSON.stringify(value)), prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(header.length);
      const temp = `${item.file}.restore-tmp`;
      files.writeExclusive(temp, Buffer.concat([prefix, header, buffer.subarray(4 + length)]));
      fs.renameSync(temp, item.file);
      files.flushDirectory(path.dirname(item.file));
    }
    await yieldIO();
  }
  files.atomicJson(path.join(directory, "workspace.json"), { formatVersion: 1, workspaceId: id, localActorId: manifest.localActorId, schemaVersion: manifest.schemaVersion });
}

class BackupService extends EventEmitter {
  constructor(catalog) { super(); this.catalog = catalog; this.activity = null; }
  progress(phase) { this.activity = phase; this.emit("change", { phase }); }
  status(workspaceId) {
    const store = this.catalog.scoped(workspaceId);
    const file = path.join(store._directory, "backup-status.json");
    let lastBackup = null;
    if (files.inspect(file) && fs.statSync(file).size < 8192) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data.version === 1 && data.workspaceId === workspaceId && typeof data.createdAt === "string" && typeof data.fileName === "string" && Number.isSafeInteger(data.bytes))
          lastBackup = { createdAt: data.createdAt, fileName: data.fileName, bytes: data.bytes };
      } catch { /* A damaged status file must not prevent making a new backup. */ }
    }
    return { phase: this.activity, lastBackup };
  }
  guard() { check(!this.activity && !this.catalog.busy(), "BACKUP_BUSY", "Finish recording or processing first"); }
  async create(workspaceId, target) {
    this.guard(); const store = this.catalog.scoped(workspaceId);
    const parent = fs.realpathSync(path.dirname(target));
    target = path.join(parent, path.basename(target));
    check(!target.startsWith(fs.realpathSync(this.catalog.root) + path.sep) && target.endsWith(".focusbae-backup"), "INVALID_BACKUP", "Choose a backup outside live workspaces");
    files.inspect(target);
    const stage = fs.mkdtempSync(path.join(this.catalog.root, ".backup-"));
    const partial = path.join(parent, `.${path.basename(target)}.${randomUUID()}.partial`);
    try {
      this.progress("Creating a consistent snapshot…");
      const database = path.join(stage, "workspace.sqlite");
      await store._db.backup(database); fs.chmodSync(database, 0o600);
      const workspace = this.catalog.active();
      const metadata = { version: 1, schemaVersion: SCHEMA_VERSION, workspaceId, localActorId: workspace.localActorId, name: workspace.name, createdAt: new Date().toISOString() };
      await inspectDatabase(database, metadata);
      const snapshot = new Database(database, { readonly: true });
      try { await validateMedia(snapshot, store._directory, workspaceId); } finally { snapshot.close(); }
      const entries = [{ path: "workspace.sqlite", file: database, bytes: fs.statSync(database).size }, ...archive.walk(store._directory, "attachments"), ...archive.walk(store._directory, "capture-spool")];
      this.progress("Copying workspace and audio…");
      await archive.pack(partial, metadata, entries);
      this.progress("Verifying the backup…");
      await archive.verify(partial);
      files.inspect(target); fs.renameSync(partial, target); files.flushDirectory(parent);
      const result = { createdAt: metadata.createdAt, fileName: path.basename(target), bytes: fs.statSync(target).size };
      let statusSaved = true;
      try { files.atomicJson(path.join(store._directory, "backup-status.json"), { version: 1, workspaceId, ...result }); }
      catch { statusSaved = false; }
      return { ...result, statusSaved };
    } catch (error) {
      if (error.code === "ENOSPC") error.code = "DISK_FULL";
      throw error;
    } finally {
      this.progress(null);
      // Only this operation's exclusive temporary artifacts are removed.
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  async restore(file) {
    this.guard();
    check(this.catalog.entries.length < 100, "LIMIT_REACHED", "Workspace limit reached");
    const stage = fs.mkdtempSync(path.join(this.catalog.root, ".restore-"));
    const id = randomUUID(), directory = `workspace-${id}`, destination = path.join(this.catalog.root, directory);
    let published = false, renamed = false, candidate;
    try {
      this.progress("Validating and unpacking the backup…");
      const manifest = await archive.unpack(file, stage);
      const identity = await inspectDatabase(path.join(stage, "workspace.sqlite"), manifest);
      const db = new Database(path.join(stage, "workspace.sqlite"), { readonly: true });
      try { await validateMedia(db, stage, manifest.workspaceId); } finally { db.close(); }
      this.progress("Preparing an independent restored workspace…");
      const name = `${identity.name.slice(0, 189)} (restored)`;
      await reidentify(stage, manifest, id, name);
      candidate = await openWorkspace({ directory: stage });
      check(candidate.recoveryReport.every((item) => item.code === "ORPHAN_QUARANTINED"), "INVALID_BACKUP", "Restored workspace requires repair");
      await validateMedia(candidate._db, stage, id);
      candidate.close(); candidate = null;
      check(!fs.existsSync(destination), "INVALID_BACKUP", "Restore destination already exists");
      fs.renameSync(stage, destination); renamed = true; files.flushDirectory(this.catalog.root);
      const previous = this.catalog.entries;
      this.catalog.entries = [...previous, { id, directory, name }];
      try { this.catalog.persist(); } catch (error) {
        // Atomic rename may have succeeded before its directory flush failed.
        // Never delete a directory that the on-disk catalog already references.
        try { published = JSON.parse(fs.readFileSync(this.catalog.file, "utf8")).entries.some((entry) => entry.id === id); } catch { published = true; /* retain the copy if durability is uncertain */ }
        if (!published) this.catalog.entries = previous;
        throw error;
      }
      published = true; this.catalog.sequence++;
      return { id, name, sourceName: identity.name, backedUpAt: manifest.createdAt };
    } catch (error) {
      if (error.code === "ENOSPC") error.code = "DISK_FULL";
      if (error instanceof SyntaxError || error.code === "INVALID_INPUT" || error.code?.startsWith("SQLITE_")) error.code = "INVALID_BACKUP";
      throw error;
    } finally {
      this.progress(null);
      candidate?.close();
      if (!published) fs.rmSync(renamed ? destination : stage, { recursive: true, force: true });
    }
  }
}
module.exports = { BackupService, inspectDatabase };
