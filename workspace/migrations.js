'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MIGRATIONS } = require('./schema');
const { hash } = require('./validation');
const { check } = require('./errors');
const files = require('./files');

async function migrate(db, backupDirectory, migrations = MIGRATIONS) {
  const current = db.pragma('user_version', { simple: true });
  const target = migrations.at(-1)?.version || 0;
  check(current <= target, 'NEWER_SCHEMA', 'This workspace requires a newer application');
  check(migrations.every((migration, index) => migration.version === index + 1), 'INVALID_MIGRATION', 'Migrations must be contiguous');
  if (current > 0) {
    const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    check(applied.length === current && applied.every((row) => migrations[row.version - 1] &&
      hash(migrations[row.version - 1].sql) === row.checksum), 'MIGRATION_MISMATCH', 'Workspace migration history does not match this application');
  }
  if (current === target) return null;
  let backup = null;
  if (current > 0) {
    files.privateDirectory(backupDirectory);
    backup = path.join(backupDirectory, `schema-${current}-to-${target}-${randomUUID()}.sqlite`);
    await db.backup(backup);
    fs.chmodSync(backup, 0o600);
    const fd = fs.openSync(backup, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    files.flushDirectory(backupDirectory);
  }
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    for (const migration of migrations.filter((item) => item.version > current)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(migration.version, migration.name, hash(migration.sql), new Date().toISOString());
      db.pragma(`user_version = ${migration.version}`);
    }
  }).immediate();
  return backup;
}

module.exports = { migrate };
