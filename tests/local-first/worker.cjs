'use strict';

const fs = require('node:fs');
const path = require('node:path');
const [mode, directory] = process.argv.slice(2);
const hold = (store) => setInterval(() => { void store.identity; }, 1000);

async function main() {
  if (mode === 'network') {
    const denied = () => { throw new Error('NETWORK_ATTEMPT'); };
    global.fetch = denied;
    for (const module of ['node:http', 'node:https']) for (const method of ['request', 'get']) require(module)[method] = denied;
    require('node:net').Socket.prototype.connect = denied;
    require('node:dgram').createSocket = denied;
    require('node:dns').lookup = denied;
  }
  if (mode === 'migration-crash') {
    const Database = require('better-sqlite3');
    const { migrate } = require('../../workspace/migrations');
    const db = new Database(path.join(directory, 'migration.sqlite'));
    db.function('crash', () => { process.kill(process.pid, 'SIGKILL'); });
    await migrate(db, path.join(directory, 'backups'), [
      { version: 1, name: 'base', sql: 'CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT);' },
      { version: 2, name: 'interrupted', sql: "INSERT INTO sample VALUES (2, 'uncommitted'); SELECT crash();" },
    ]);
    throw new Error('Crash did not occur');
  }
  const { openWorkspace } = require('../../workspace');
  const { mutation, scope, document } = require('./helpers.cjs');
  const store = await openWorkspace({ directory });
  if (mode === 'note-uncommitted') {
    const original = store._save.bind(store);
    store._save = (kind, record) => {
      const result = original(kind, record);
      if (kind === 'note') process.kill(process.pid, 'SIGKILL');
      return result;
    };
    store.createNote(mutation(store), { title: 'Never acknowledged' });
    throw new Error('Crash did not occur');
  }
  if (mode === 'hold') { process.send({ ready: true }); hold(store); return; }
  if (mode === 'note-crash') {
    const ctx = mutation(store);
    const note = store.createNote(ctx, { title: 'Acknowledged', content: document('Durable synthetic edit') });
    process.send({ note, ctx }); hold(store); return;
  }
  if (mode === 'attachment-crash') {
    const note = store.createNote(mutation(store), { title: 'Attachment owner' });
    const original = fs.renameSync;
    fs.renameSync = (source, destination) => {
      original(source, destination);
      if (String(destination).endsWith('.blob')) process.kill(process.pid, 'SIGKILL');
    };
    store.putAttachment(mutation(store), { noteId: note.id, displayName: 'crash.txt' }, Buffer.from('recoverable bytes'));
    throw new Error('Crash did not occur');
  }
  if (mode === 'network') {
    const note = store.createNote(mutation(store), { title: 'Network denied', content: document('Offline content') });
    store.createAction(mutation(store), { title: 'Offline follow-up' });
    store.putAttachment(mutation(store), { noteId: note.id, displayName: 'local.txt' }, Buffer.from('local'));
    if (store.search(scope(store), 'Offline').length !== 2) throw new Error('Missing offline results');
    store.close(); process.send({ success: true }); return;
  }
  throw new Error('Unknown worker mode');
}

main().catch((error) => { if (process.send) process.send({ error: error.code ?? error.message }); process.exitCode = 1; });
