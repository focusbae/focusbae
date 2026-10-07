'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { WorkspaceError } = require('./errors');
const { inspect, flushDirectory } = require('./files');

function acquireLock(directory) {
  // A separate SQLite EXCLUSIVE transaction provides OS-released process locking.
  // Never unlink this file: doing so can create two independent lock inodes.
  const file = path.join(directory, 'workspace-lock.sqlite');
  inspect(file);
  inspect(`${file}-journal`);
  const db = new Database(file, { timeout: 0 });
  try {
    fs.chmodSync(file, 0o600);
    db.pragma('journal_mode = DELETE');
    db.exec('BEGIN EXCLUSIVE');
    flushDirectory(directory);
    return () => { if (db.open) db.close(); };
  } catch (error) {
    db.close();
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') throw new WorkspaceError('WORKSPACE_BUSY', 'Workspace is open in another process');
    throw error;
  }
}

module.exports = { acquireLock };
