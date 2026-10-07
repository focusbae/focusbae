const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// Synthetic schema only. Production workspace migrations belong to LF-01.
async function probeSqlite(directory) {
  const file = path.join(directory, 'probe.sqlite');
  const backupFile = path.join(directory, 'backup.sqlite');
  let db = new Database(file);
  const checks = [];
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('fullfsync = ON');
    db.pragma('foreign_keys = ON');
    db.pragma('wal_autocheckpoint = 0');
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    assert.equal(db.pragma('fullfsync', { simple: true }), 1);
    checks.push('WAL, synchronous FULL and fullfsync enabled');
    db.exec(`
      CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE actions(id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id));
      CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='rowid');
      CREATE TRIGGER notes_insert AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
      END;
    `);
    const insert = db.prepare('INSERT INTO notes VALUES (?, ?, ?)');
    db.transaction(() => insert.run('synthetic-note', 'Local proposal follow-up', 1)).immediate();
    assert.equal(db.prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?").get('proposal').n, 1);
    checks.push('Committed note is indexed by FTS5');
    assert.throws(() => db.transaction(() => {
      insert.run('rolled-back', 'Never committed', 1);
      throw new Error('Synthetic migration failure');
    })(), /Synthetic migration failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
    assert.throws(() => db.prepare('INSERT INTO actions VALUES (?, ?)').run('bad', 'missing'), /FOREIGN KEY/);
    checks.push('Transaction rollback and foreign-key enforcement');
    assert.equal(db.prepare('UPDATE notes SET revision = revision + 1 WHERE id = ? AND revision = ?').run('synthetic-note', 0).changes, 0);
    checks.push('Revision compare-and-swap rejects stale write');
    assert.ok(fs.statSync(`${file}-wal`).size > 0);
    await db.backup(backupFile);
    const backup = new Database(backupFile, { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(backup.prepare('SELECT body FROM notes').get().body, 'Local proposal follow-up');
      assert.equal(backup.prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?').get('proposal').n, 1);
    } finally { backup.close(); }
    checks.push('Online backup includes committed active-WAL data and FTS');
    db.close();
    db = new Database(file, { fileMustExist: true });
    assert.equal(db.prepare('SELECT revision FROM notes').get().revision, 1);
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')");
    assert.equal(db.prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?').get('proposal').n, 1);
    checks.push('Close/reopen persistence and derived FTS rebuild');
    return {
      binding: require('better-sqlite3/package.json').version,
      sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
      checks,
    };
  } finally {
    if (db.open) db.close();
  }
}

module.exports = { probeSqlite };
