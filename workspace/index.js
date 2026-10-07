'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const v = require('./validation');
const domain = require('./domain');
const files = require('./files');
const { check, WorkspaceError } = require('./errors');
const { acquireLock } = require('./lock');
const { migrate } = require('./migrations');
const { APPLICATION_ID, SCHEMA_VERSION } = require('./schema');
const { WorkspaceStore } = require('./store');
const attachments = require('./attachments');

Object.assign(WorkspaceStore.prototype, attachments.methods);
Object.assign(WorkspaceStore.prototype, require('./notebook').methods);
Object.assign(WorkspaceStore.prototype, require('./folders').methods);

async function connect(options, create) {
  v.object(options, create ? ['directory', 'name', 'preferences'] : ['directory'], 'workspace options');
  const directory = files.validateLocation(options.directory);
  const name = create ? v.text(options.name ?? 'My workspace', 'workspace name', 200) : null;
  const preferences = create ? domain.preferences(options.preferences ?? {}) : null;
  if (create) {
    check(!fs.existsSync(directory), 'ALREADY_EXISTS', 'Workspace directory already exists');
    fs.mkdirSync(directory, { mode: 0o700 });
    files.flushDirectory(path.dirname(directory));
  } else check(fs.existsSync(directory), 'NOT_FOUND', 'Workspace directory does not exist');
  const release = acquireLock(directory);
  let db;
  try {
    const databaseFile = path.join(directory, 'workspace.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) files.inspect(databaseFile + suffix);
    const manifestFile = path.join(directory, 'workspace.json');
    const hasManifest = files.inspect(manifestFile);
    let manifest = null;
    if (hasManifest) {
      check(fs.statSync(manifestFile).size < 16384, 'INVALID_WORKSPACE', 'Workspace manifest is too large');
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
      catch { throw new WorkspaceError('INVALID_WORKSPACE', 'Workspace manifest is invalid'); }
      check(manifest && manifest.formatVersion === 1, 'NEWER_SCHEMA', 'Unsupported workspace manifest format');
      check(Number.isSafeInteger(manifest.schemaVersion) && manifest.schemaVersion >= 1, 'INVALID_WORKSPACE', 'Invalid manifest schema version');
      check(manifest.schemaVersion <= SCHEMA_VERSION, 'NEWER_SCHEMA', 'Workspace manifest requires a newer application');
    }
    db = new Database(databaseFile, { fileMustExist: !create, timeout: 5000 });
    const version = db.pragma('user_version', { simple: true });
    check(version <= SCHEMA_VERSION, 'NEWER_SCHEMA', 'Workspace requires a newer application');
    if (!create) {
      check(db.pragma('application_id', { simple: true }) === APPLICATION_ID && version > 0, 'INVALID_WORKSPACE', 'Not an initialized FocusBae workspace');
      check(db.pragma('quick_check', { simple: true }) === 'ok', 'INVALID_WORKSPACE', 'Workspace integrity check failed; existing files were kept');
      const identity = db.prepare('SELECT id, actor_id FROM workspaces').get();
      check(identity && (!manifest || (manifest.workspaceId === identity.id && manifest.localActorId === identity.actor_id)), 'INVALID_WORKSPACE', 'Workspace manifest identity mismatch');
    }
    files.privateDirectory(directory);
    for (const folder of ['attachments', 'attachments/.staging', 'attachments/.recovery', 'capture-spool', 'backups']) {
      const target = path.join(directory, folder); files.inspect(target, true); files.privateDirectory(target);
    }
    fs.chmodSync(databaseFile, 0o600);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('fullfsync = ON');
    await migrate(db, path.join(directory, 'backups'));
    if (create) db.transaction(() => {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO workspaces(id, actor_id, name, preferences_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(randomUUID(), randomUUID(), name, v.stableJson(preferences), now, now);
      db.pragma(`application_id = ${APPLICATION_ID}`);
    }).immediate();
    const store = new WorkspaceStore(db, directory, release);
    const expectedManifest = { formatVersion: 1, workspaceId: store._identity.id, localActorId: store._identity.localActorId, schemaVersion: SCHEMA_VERSION };
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) files.atomicJson(manifestFile, expectedManifest);
    for (const suffix of ['-wal', '-shm']) if (files.inspect(databaseFile + suffix)) fs.chmodSync(databaseFile + suffix, 0o600);
    attachments.reconcile(store);
    store._recoverJobs();
    require('../recording/recovery').recover(store);
    files.flushDirectory(directory);
    return store;
  } catch (error) {
    try { if (db?.open) db.close(); } finally { release(); }
    throw error;
  }
}

module.exports = { createWorkspace: (options) => connect(options, true), openWorkspace: (options) => connect(options, false), WorkspaceError };
