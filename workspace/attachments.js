'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const v = require('./validation');
const files = require('./files');
const { check } = require('./errors');

const MAX_BYTES = 100 * 1024 * 1024;
const BLOB = /^attachments\/[0-9a-f-]{36}-[0-9a-f]{64}\.blob$/;
const TEMP = /^attachments\/\.staging\/[0-9a-f-]{36}\.tmp$/;

function normalize(input) {
  v.object(input, ['displayName', 'mediaType', 'noteId', 'recordingId', 'previewId']);
  const data = { displayName: v.text(input.displayName, 'attachment name', 255),
    mediaType: v.text(input.mediaType ?? 'application/octet-stream', 'media type', 200),
    noteId: input.noteId == null ? null : v.uuid(input.noteId),
    recordingId: input.recordingId == null ? null : v.uuid(input.recordingId),
    ...(input.previewId ? { previewId: v.uuid(input.previewId) } : {}) };
  check(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(data.mediaType), 'INVALID_INPUT', 'Invalid media type');
  check(data.noteId || data.recordingId, 'INVALID_INPUT', 'An attachment needs a note or recording');
  return data;
}

function validateParents(store, data) {
  if (data.noteId) store._live('note', data.noteId);
  if (data.recordingId) store._live('recording', data.recordingId);
  if (data.previewId) {
    const preview = store._live('attachment', data.previewId);
    check(data.noteId && preview.noteId === data.noteId, 'SCOPE_MISMATCH', 'Preview belongs to another note');
    check(preview.mediaType === 'image/png' && !preview.previewId, 'INVALID_INPUT', 'Preview must be a standalone PNG attachment');
  }
}

function verify(store, record) {
  check(BLOB.test(record.relativePath), 'UNSAFE_PATH', 'Invalid attachment path');
  const file = files.managedPath(store._directory, record.relativePath);
  check(files.inspect(file), 'ATTACHMENT_MISSING', 'Attachment file is missing');
  check(fs.statSync(file).size === record.byteSize && files.fileHash(file) === record.contentHash,
    'ATTACHMENT_CORRUPT', 'Attachment failed integrity verification');
  return file;
}

function removeIntent(store, id) { store._db.prepare('DELETE FROM file_journal WHERE id = ?').run(id); }

function cleanupDelete(store, intent) {
  check(BLOB.test(intent.relative_path), 'UNSAFE_PATH', 'Invalid cleanup path');
  const row = store._db.prepare('SELECT deleted_at FROM attachments WHERE relative_path = ?').get(intent.relative_path);
  check(row?.deleted_at, 'INVALID_JOURNAL', 'File deletion needs a committed attachment tombstone');
  const file = files.managedPath(store._directory, intent.relative_path);
  if (files.inspect(file)) { fs.unlinkSync(file); files.flushDirectory(path.dirname(file)); }
  removeIntent(store, intent.id);
}

function quarantine(store, relative) {
  const file = files.managedPath(store._directory, relative);
  if (!files.inspect(file)) return;
  const destination = files.managedPath(store._directory, `attachments/.recovery/${randomUUID()}-${path.basename(file)}`);
  fs.renameSync(file, destination);
  files.flushDirectory(path.dirname(file));
  files.flushDirectory(path.dirname(destination));
  store.recoveryReport.push({ code: 'ORPHAN_QUARANTINED', file: path.basename(destination) });
}

function reconcile(store) {
  for (const intent of store._db.prepare('SELECT * FROM file_journal ORDER BY created_at, id').all()) {
    try {
      check(intent.workspace_id === store._identity.id && BLOB.test(intent.relative_path) &&
        (intent.temporary_path == null || TEMP.test(intent.temporary_path)), 'INVALID_JOURNAL', 'Invalid file journal entry');
      if (intent.operation === 'delete') cleanupDelete(store, intent);
      else {
        const row = store._db.prepare('SELECT id FROM attachments WHERE relative_path = ?').get(intent.relative_path);
        if (row) verify(store, store._raw('attachment', row.id));
        else quarantine(store, intent.relative_path);
        if (intent.temporary_path) quarantine(store, intent.temporary_path);
        removeIntent(store, intent.id);
      }
    } catch (error) { store.recoveryReport.push({ code: error.code ?? 'IO_ERROR', journalId: intent.id }); }
  }
  const referenced = new Set(store._db.prepare('SELECT relative_path FROM attachments').all().map((row) => row.relative_path));
  const pending = new Set(store._db.prepare('SELECT relative_path, temporary_path FROM file_journal').all().flatMap((row) => [row.relative_path, row.temporary_path]));
  for (const folder of ['attachments', 'attachments/.staging']) for (const name of fs.readdirSync(path.join(store._directory, folder))) {
    const relative = `${folder}/${name}`;
    if ((BLOB.test(relative) || TEMP.test(relative)) && !referenced.has(relative) && !pending.has(relative)) {
      try { quarantine(store, relative); }
      catch (error) { store.recoveryReport.push({ code: error.code ?? 'IO_ERROR', file: name }); }
    }
  }
  for (const row of store._db.prepare('SELECT id FROM attachments WHERE deleted_at IS NULL').all()) {
    try { verify(store, store._raw('attachment', row.id)); }
    catch (error) { store.recoveryReport.push({ code: error.code ?? 'IO_ERROR', attachmentId: row.id }); }
  }
}

const methods = {
  updateAttachment(ctx, id, input) {
    return this._update(ctx, 'attachment', id, input, (data, old) => {
      v.object(data, ['displayName', 'mediaType', 'noteId', 'recordingId', 'previewId']);
      const next = normalize({ displayName: old.displayName, mediaType: old.mediaType, noteId: old.noteId, recordingId: old.recordingId, previewId: old.previewId, ...data });
      check(next.noteId === old.noteId && next.recordingId === old.recordingId, 'SCOPE_MISMATCH', 'Attachments cannot be moved between parents');
      check(next.previewId !== id, 'INVALID_INPUT', 'An attachment cannot preview itself');
      validateParents(this, next);
      return next;
    });
  },

  putAttachment(ctx, input, bytes) {
    this._scope(ctx, true);
    const data = normalize(input);
    check(Buffer.isBuffer(bytes), 'INVALID_INPUT', 'Attachment must be a buffer');
    check(bytes.length <= MAX_BYTES, 'ATTACHMENT_TOO_LARGE', 'Choose a file smaller than 100 MB');
    const contentHash = v.hash(bytes);
    const args = { input, contentHash, byteSize: bytes.length };
    const { previous } = this._request(ctx, 'attachment.put', args);
    if (previous) return JSON.parse(previous.result_json);
    validateParents(this, data);
    const record = this._new({ ...data, contentHash, byteSize: bytes.length });
    record.relativePath = `attachments/${record.id}-${contentHash}.blob`;
    const temporaryPath = `attachments/.staging/${record.id}.tmp`;
    // File intent is durable before the first write. Metadata and its ACK commit only after the file is flushed.
    this._db.prepare('INSERT INTO file_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, ctx.workspaceId, 'create', record.relativePath, temporaryPath, contentHash, bytes.length, record.createdAt);
    const temporary = files.managedPath(this._directory, temporaryPath);
    const destination = files.managedPath(this._directory, record.relativePath);
    files.writeExclusive(temporary, bytes);
    fs.renameSync(temporary, destination);
    files.flushDirectory(path.dirname(temporary)); files.flushDirectory(path.dirname(destination));
    return this._mutate(ctx, 'attachment.put', args, () => {
      validateParents(this, data);
      this._save('attachment', record);
      removeIntent(this, record.id);
      return record;
    });
  },

  readAttachment(ctx, id) {
    this._scope(ctx);
    const record = this._live('attachment', id);
    validateParents(this, record);
    check(record.byteSize <= MAX_BYTES, 'INVALID_INPUT', 'Attachment exceeds the in-process read limit');
    return fs.readFileSync(verify(this, record));
  },

  deleteAttachment(ctx, id) {
    const record = this._mutate(ctx, 'attachment.delete', { id }, () => {
      const old = this._live('attachment', id); this._expected(ctx, old);
      const parent = old.noteId && this._raw('note', old.noteId);
      check(!this._db.prepare("SELECT 1 FROM attachments WHERE deleted_at IS NULL AND json_extract(data_json, '$.previewId') = ?").get(id),
        'ATTACHMENT_IN_USE', 'This file is used as an image preview');
      check(!parent || parent.deletedAt || !require('./content').attachmentIds(parent.content).some((ref) =>
        ref === id || this._raw('attachment', ref)?.previewId === id), 'ATTACHMENT_IN_USE', 'Remove the attachment from its note first');
      const deleted = this._save('attachment', this._next(old, { deletedAt: new Date().toISOString() }));
      this._db.prepare('INSERT INTO file_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), ctx.workspaceId, 'delete', old.relativePath, null, old.contentHash, old.byteSize, deleted.updatedAt);
      return deleted;
    });
    const intent = this._db.prepare("SELECT * FROM file_journal WHERE relative_path = ? AND operation = 'delete'").get(record.relativePath);
    if (intent) {
      try { cleanupDelete(this, intent); }
      catch (error) { this.recoveryReport.push({ code: error.code ?? 'IO_ERROR', journalId: intent.id }); }
    }
    return record;
  },
};

module.exports = { methods, reconcile, MAX_BYTES };
