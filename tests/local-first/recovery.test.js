'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const Database = require('better-sqlite3');
const { fixture, document, mutation, scope } = require('./helpers.cjs');
const { openWorkspace } = require('../../workspace');
const { migrate } = require('../../workspace/migrations');

function worker(t, mode, directory) {
  const child = fork(path.join(__dirname, 'worker.cjs'), [mode, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stderr.on('data', (bytes) => { output += bytes; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const message = new Promise((resolve, reject) => {
    child.once('message', (value) => value.error ? reject(new Error(value.error)) : resolve(value));
    child.once('exit', () => reject(new Error(`Worker exited before response: ${output}`)));
    child.once('error', reject);
  });
  message.catch(() => {});
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  return { child, message, exited };
}

test('SIGKILL after a save ACK preserves the record, its indexing job and retry response', async (t) => {
  const f = await fixture(t); f.store.close();
  const child = worker(t, 'note-crash', f.directory);
  const { note, ctx } = await child.message;
  await assert.rejects(openWorkspace({ directory: f.directory }), { code: 'WORKSPACE_BUSY' });
  child.child.kill('SIGKILL'); assert.equal((await child.exited).signal, 'SIGKILL');
  const next = await f.reopen();
  assert.deepEqual(next.get(scope(next), 'note', note.id), note);
  assert.deepEqual(next.createNote(ctx, { title: 'Acknowledged', content: document('Durable synthetic edit') }), note);
  assert.equal(next.list(scope(next), 'job').filter((job) => job.inputRevisions[0].id === note.id).length, 1);
  assert.equal(next._db.pragma('integrity_check', { simple: true }), 'ok');
});

test('SIGKILL after attachment rename quarantines bytes without a partial DB reference', async (t) => {
  const f = await fixture(t); f.store.close();
  const child = worker(t, 'attachment-crash', f.directory);
  assert.equal((await child.exited).signal, 'SIGKILL');
  const next = await f.reopen();
  assert.equal(next.list(scope(next), 'attachment').length, 0);
  assert.equal(next.list(scope(next), 'note').length, 1);
  const report = next.recoveryReport.find((entry) => entry.code === 'ORPHAN_QUARANTINED');
  assert.ok(report);
  assert.equal(fs.readFileSync(path.join(f.directory, 'attachments/.recovery', report.file), 'utf8'), 'recoverable bytes');
  assert.equal(next._db.prepare('SELECT count(*) AS n FROM file_journal').get().n, 0);
  next.close(); const again = await f.reopen();
  assert.equal(again.recoveryReport.length, 0);
  assert.equal(fs.readdirSync(path.join(f.directory, 'attachments/.recovery')).length, 1);
});

test('SIGKILL before transaction commit leaves neither a note nor its indexing job', async (t) => {
  const f = await fixture(t); f.store.close();
  const child = worker(t, 'note-uncommitted', f.directory);
  assert.equal((await child.exited).signal, 'SIGKILL');
  const next = await f.reopen();
  assert.deepEqual(next.list(scope(next), 'note'), []);
  assert.deepEqual(next.list(scope(next), 'job'), []);
  assert.equal(next._db.prepare('SELECT count(*) AS n FROM mutation_requests').get().n, 0);
});

test('real SQLite page exhaustion rolls back the edit, indexing job and acknowledgment', async (t) => {
  const { store: s } = await fixture(t);
  const note = s.createNote(mutation(s), { title: 'Previously saved' });
  const count = s.list(scope(s), 'job').length;
  const ctx = mutation(s, 1);
  const pages = s._db.pragma('page_count', { simple: true });
  s._db.pragma(`max_page_count = ${pages}`);
  assert.throws(() => s.updateNote(ctx, note.id, { content: document('x'.repeat(300000)) }), { code: 'DISK_FULL' });
  assert.equal(s.get(scope(s), 'note', note.id).revision, 1);
  assert.equal(s.list(scope(s), 'job').length, count);
  assert.equal(s._db.prepare('SELECT * FROM mutation_requests WHERE request_id=?').get(ctx.clientRequestId), undefined);
  s._db.pragma('max_page_count = 1000000');
  assert.equal(s.updateNote(ctx, note.id, { content: document('x'.repeat(300000)) }).revision, 2);
});

test('disk-full attachment write leaves a recoverable journal, never a saved attachment', async (t) => {
  const f = await fixture(t); const s = f.store;
  const note = s.createNote(mutation(s), {});
  const original = fs.writeSync;
  fs.writeSync = () => { throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }); };
  try { assert.throws(() => s.putAttachment(mutation(s), { noteId: note.id, displayName: 'full.txt' }, Buffer.from('payload')), { code: 'ENOSPC' }); }
  finally { fs.writeSync = original; }
  assert.equal(s.list(scope(s), 'attachment').length, 0);
  assert.equal(s._db.prepare('SELECT count(*) AS n FROM file_journal').get().n, 1);
  s.close(); const next = await f.reopen();
  assert.equal(next._db.prepare('SELECT count(*) AS n FROM file_journal').get().n, 0);
  assert.ok(next.get(scope(next), 'note', note.id));
});

test('attachment deletion ACK survives cleanup failure and restart finishes cleanup', async (t) => {
  const f = await fixture(t); const s = f.store;
  const note = s.createNote(mutation(s), {});
  const ctx = mutation(s); const input = { noteId: note.id, displayName: 'delete.txt' }; const bytes = Buffer.from('delete');
  const attachment = s.putAttachment(ctx, input, bytes);
  assert.deepEqual(s.putAttachment(ctx, input, bytes), attachment);
  assert.throws(() => s.putAttachment(ctx, input, Buffer.from('different')), { code: 'IDEMPOTENCY_CONFLICT' });
  const original = fs.unlinkSync;
  const deleteCtx = mutation(s, 1); let deleted;
  fs.unlinkSync = () => { throw Object.assign(new Error('Synthetic denied unlink'), { code: 'EACCES' }); };
  try { deleted = s.deleteAttachment(deleteCtx, attachment.id); }
  finally { fs.unlinkSync = original; }
  assert.ok(deleted.deletedAt);
  assert.throws(() => s.readAttachment(scope(s), attachment.id), { code: 'NOT_FOUND' });
  assert.ok(fs.existsSync(path.join(f.directory, attachment.relativePath)));
  s.close(); const next = await f.reopen();
  assert.equal(fs.existsSync(path.join(f.directory, attachment.relativePath)), false);
  assert.deepEqual(next.deleteAttachment(deleteCtx, attachment.id), deleted);
});

test('missing/corrupt attachments are reported without deleting notes or capture spools', async (t) => {
  const f = await fixture(t); const s = f.store;
  const note = s.createNote(mutation(s), { title: 'Keep this' });
  const missing = s.putAttachment(mutation(s), { noteId: note.id, displayName: 'missing' }, Buffer.from('one'));
  const corrupt = s.putAttachment(mutation(s), { noteId: note.id, displayName: 'corrupt' }, Buffer.from('two'));
  fs.unlinkSync(path.join(f.directory, missing.relativePath));
  fs.writeFileSync(path.join(f.directory, corrupt.relativePath), 'bad');
  const spool = path.join(f.directory, 'capture-spool', 'active.pcm'); fs.writeFileSync(spool, 'active');
  s.close(); const next = await f.reopen();
  assert.deepEqual(next.recoveryReport.map((entry) => entry.code).sort(), ['ATTACHMENT_CORRUPT', 'ATTACHMENT_MISSING']);
  assert.throws(() => next.readAttachment(scope(next), corrupt.id), { code: 'ATTACHMENT_CORRUPT' });
  assert.equal(next.get(scope(next), 'note', note.id).title, 'Keep this');
  assert.equal(fs.readFileSync(spool, 'utf8'), 'active');
});

test('migration backups include committed WAL; failing upgrades roll back all pending versions', async (t) => {
  const f = await fixture(t);
  const db = new Database(path.join(f.root, 'migration.sqlite')); t.after(() => db.close());
  db.pragma('journal_mode = WAL');
  const base = { version: 1, name: 'base', sql: 'CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT);' };
  await migrate(db, path.join(f.root, 'backups'), [base]);
  db.prepare('INSERT INTO sample VALUES (1, ?)').run('committed WAL');
  const second = { version: 2, name: 'second', sql: 'ALTER TABLE sample ADD COLUMN flag INTEGER DEFAULT 0;' };
  await assert.rejects(migrate(db, path.join(f.root, 'backups'), [base, second, { version: 3, name: 'bad', sql: 'THIS IS NOT SQL;' }]));
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.deepEqual(db.prepare('SELECT * FROM sample').get(), { id: 1, value: 'committed WAL' });
  const backupPath = await migrate(db, path.join(f.root, 'backups'), [base, second]);
  const backup = new Database(backupPath, { readonly: true });
  try { assert.equal(backup.pragma('user_version', { simple: true }), 1); assert.equal(backup.prepare('SELECT value FROM sample').get().value, 'committed WAL'); }
  finally { backup.close(); }
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  await assert.rejects(migrate(db, path.join(f.root, 'backups'), [{ ...base, sql: base.sql + ' ' }, second]), { code: 'MIGRATION_MISMATCH' });
});

test('SIGKILL inside a migration preserves the prior schema and committed data', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'migration.sqlite');
  const db = new Database(file);
  await migrate(db, path.join(f.root, 'backups'), [{ version: 1, name: 'base', sql: 'CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT);' }]);
  db.prepare('INSERT INTO sample VALUES (1, ?)').run('before upgrade'); db.close();
  const child = worker(t, 'migration-crash', f.root);
  assert.equal((await child.exited).signal, 'SIGKILL');
  const next = new Database(file);
  try { assert.equal(next.pragma('user_version', { simple: true }), 1); assert.deepEqual(next.prepare('SELECT * FROM sample').all(), [{ id: 1, value: 'before upgrade' }]); }
  finally { next.close(); }
});

test('newer schema is refused without changing canonical database or manifest', async (t) => {
  const f = await fixture(t); f.store.close();
  const file = path.join(f.directory, 'workspace.sqlite');
  const db = new Database(file); db.pragma('user_version = 999'); db.close();
  const before = fs.readFileSync(file); const manifest = fs.readFileSync(path.join(f.directory, 'workspace.json'));
  await assert.rejects(f.reopen(), { code: 'NEWER_SCHEMA' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'workspace.json')), manifest);
});

test('storage opens, saves and searches when Node network APIs are denied before import', async (t) => {
  const f = await fixture(t); f.store.close();
  const child = worker(t, 'network', f.directory);
  assert.deepEqual(await child.message, { success: true });
  assert.equal((await child.exited).code, 0);
});
