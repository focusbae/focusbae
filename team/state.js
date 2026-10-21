"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

// Sync state for one team workspace, kept beside (not inside) its workspace database
// so personal workspaces are never migrated and older app versions ignore it. The
// file existing is what makes a local workspace a team workspace.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  server_workspace_id TEXT NOT NULL,
  account_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  me_person_id TEXT,
  processing_level_max INTEGER NOT NULL DEFAULT 1,
  cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'removed')),
  last_synced_at TEXT,
  last_error TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS team_roots (space_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE IF NOT EXISTS folders_sent (id TEXT PRIMARY KEY, sent_hash TEXT NOT NULL, server_version INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, role TEXT) STRICT;
CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, is_member INTEGER NOT NULL) STRICT;
-- The shared ledger as last seen on the server, including teammates' commitments.
CREATE TABLE IF NOT EXISTS commitments (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT;
-- What this Mac last sent for each of its own actions, so unchanged ones are not resent.
CREATE TABLE IF NOT EXISTS shared (action_id TEXT PRIMARY KEY, sent_hash TEXT NOT NULL, server_version INTEGER) STRICT;
-- Notes: which team each note on this Mac belongs to (absent = My notes), what was
-- last sent, which attachment versions are uploaded, and teammates' notes as last seen.
CREATE TABLE IF NOT EXISTS note_spaces (note_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS notes_sent (note_id TEXT PRIMARY KEY, sent_hash TEXT NOT NULL, server_version INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS attachments_sent (attachment_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, content_hash TEXT NOT NULL, uploaded INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS remote_notes (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json))) STRICT;
-- Who the team sees as owing an action and who it is owed to, chosen on this Mac.
-- Absent = the default (the action's own owner; the one other named person, if any).
CREATE TABLE IF NOT EXISTS mappings (
  action_id TEXT PRIMARY KEY,
  owner_person_id TEXT,
  counterparty_person_id TEXT,
  updated_at TEXT NOT NULL
) STRICT;
`;

class TeamState {
  static file(directory) {
    return path.join(directory, "team.sqlite");
  }
  static exists(directory) {
    return fs.existsSync(TeamState.file(directory));
  }
  static create(directory, binding) {
    const state = new TeamState(directory, true);
    state.db.prepare(`INSERT INTO binding (singleton, server_workspace_id, account_user_id, name, role)
      VALUES (1, ?, ?, ?, ?)`).run(binding.serverWorkspaceId, binding.accountUserId, binding.name, binding.role ?? null);
    return state;
  }
  constructor(directory, create = false) {
    const file = TeamState.file(directory);
    if (!create && !fs.existsSync(file)) throw Object.assign(new Error("Not a team workspace"), { code: "NOT_FOUND" });
    this.db = new Database(file, { timeout: 5000 });
    fs.chmodSync(file, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }
  binding() {
    const row = this.db.prepare("SELECT * FROM binding").get();
    return row && {
      serverWorkspaceId: row.server_workspace_id, accountUserId: row.account_user_id, name: row.name,
      role: row.role, mePersonId: row.me_person_id, processingLevelMax: row.processing_level_max,
      cursor: row.cursor, status: row.status, lastSyncedAt: row.last_synced_at, lastError: row.last_error,
    };
  }
  recordError(message) {
    this.db.prepare("UPDATE binding SET last_error = ?").run(message);
  }
  // Applies one pull atomically: directory tables are replaced, changed commitments
  // upserted, and anything no longer visible removed.
  applyPull(pull) {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE binding SET name = ?, role = ?, me_person_id = ?, processing_level_max = ?, cursor = ?,
        last_synced_at = ?, last_error = NULL, status = 'active'`)
        .run(pull.workspace.name, pull.workspace.role, pull.me?.personId ?? null, pull.workspace.processingLevelMax,
          pull.cursor, new Date().toISOString());
      this.db.prepare("DELETE FROM spaces").run();
      const space = this.db.prepare("INSERT INTO spaces VALUES (?, ?, ?, ?)");
      for (const s of pull.spaces) space.run(s.id, s.kind, s.name, s.role ?? null);
      this.db.prepare("DELETE FROM people").run();
      const person = this.db.prepare("INSERT INTO people VALUES (?, ?, ?, ?)");
      for (const p of pull.people) person.run(p.id, p.name, p.email ?? null, p.isMember ? 1 : 0);
      const upsert = this.db.prepare(`INSERT INTO commitments VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, data_json = excluded.data_json`);
      for (const c of pull.commitments) upsert.run(c.id, c.version, JSON.stringify(c));
      const visible = new Set(pull.visibleCommitmentIds);
      const drop = this.db.prepare("DELETE FROM commitments WHERE id = ?");
      for (const { id } of this.db.prepare("SELECT id FROM commitments").all()) if (!visible.has(id)) drop.run(id);
      const note = this.db.prepare(`INSERT INTO remote_notes VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, data_json = excluded.data_json`);
      for (const n of pull.notes ?? []) note.run(n.id, n.version, JSON.stringify(n));
      const visibleNotes = new Set(pull.visibleNoteIds ?? []);
      const dropNote = this.db.prepare("DELETE FROM remote_notes WHERE id = ?");
      for (const { id } of this.db.prepare("SELECT id FROM remote_notes").all()) if (!visibleNotes.has(id)) dropNote.run(id);
    })();
  }
  // Removed from the workspace: keep the binding as a marker, forget everything synced.
  markRemoved() {
    this.db.transaction(() => {
      for (const table of ["spaces", "people", "commitments", "shared", "mappings", "note_spaces", "notes_sent", "attachments_sent", "remote_notes"]) this.db.prepare(`DELETE FROM ${table}`).run();
      this.db.prepare("UPDATE binding SET status = 'removed', cursor = 0").run();
    })();
  }
  roots() { return this.db.prepare("SELECT space_id AS spaceId, folder_id AS folderId FROM team_roots").all(); }
  rootForSpace(id) { return this.db.prepare("SELECT folder_id FROM team_roots WHERE space_id = ?").get(id)?.folder_id ?? null; }
  setRoot(space, folder) { this.db.prepare("INSERT INTO team_roots VALUES (?, ?)").run(space, folder); }
  folderSent(id) { return this.db.prepare("SELECT sent_hash AS hash, server_version AS version FROM folders_sent WHERE id = ?").get(id) ?? null; }
  markFolderSent(id, hash, version) { this.db.prepare("INSERT INTO folders_sent VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET sent_hash=excluded.sent_hash, server_version=excluded.server_version").run(id, hash, version); }
  forgetFolderSent(id) { this.db.prepare("DELETE FROM folders_sent WHERE id = ?").run(id); }
  sentFolderIds() { return this.db.prepare("SELECT id FROM folders_sent").all().map((r) => r.id); }
  commitments() {
    return this.db.prepare("SELECT data_json FROM commitments").all().map((row) => JSON.parse(row.data_json));
  }
  commitment(id) {
    const row = this.db.prepare("SELECT data_json FROM commitments WHERE id = ?").get(id);
    return row ? JSON.parse(row.data_json) : null;
  }
  spaces() { return this.db.prepare("SELECT * FROM spaces ORDER BY name").all(); }
  people() { return this.db.prepare("SELECT id, name, email, is_member AS isMember FROM people ORDER BY name").all(); }
  sent(actionId) {
    return this.db.prepare("SELECT sent_hash AS hash, server_version AS version FROM shared WHERE action_id = ?").get(actionId) ?? null;
  }
  markSent(actionId, hash, version) {
    this.db.prepare(`INSERT INTO shared VALUES (?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET sent_hash = excluded.sent_hash, server_version = excluded.server_version`)
      .run(actionId, hash, version ?? null);
  }
  forgetSent(actionId) { this.db.prepare("DELETE FROM shared WHERE action_id = ?").run(actionId); }
  mapping(actionId) {
    const row = this.db.prepare("SELECT owner_person_id AS ownerPersonId, counterparty_person_id AS counterpartyPersonId FROM mappings WHERE action_id = ?").get(actionId);
    return row ?? null;
  }
  setMapping(actionId, mapping) {
    const people = new Set(this.people().map((p) => p.id));
    for (const id of [mapping.ownerPersonId, mapping.counterpartyPersonId])
      if (id !== null && !people.has(id)) throw Object.assign(new Error("Unknown person"), { code: "INVALID_INPUT" });
    this.db.prepare(`INSERT INTO mappings VALUES (?, ?, ?, ?) ON CONFLICT(action_id) DO UPDATE SET
      owner_person_id = excluded.owner_person_id, counterparty_person_id = excluded.counterparty_person_id, updated_at = excluded.updated_at`)
      .run(actionId, mapping.ownerPersonId, mapping.counterpartyPersonId, new Date().toISOString());
  }
  // My notes: the private space this account has in the workspace.
  privateSpaceId() {
    return this.db.prepare("SELECT id FROM spaces WHERE kind = 'private'").get()?.id ?? null;
  }
  noteSpace(noteId) {
    return this.db.prepare("SELECT space_id AS spaceId FROM note_spaces WHERE note_id = ?").get(noteId)?.spaceId ?? null;
  }
  setNoteSpace(noteId, spaceId) {
    if (spaceId === null) return this.db.prepare("DELETE FROM note_spaces WHERE note_id = ?").run(noteId);
    const space = this.db.prepare("SELECT kind, role FROM spaces WHERE id = ?").get(spaceId);
    if (!space || space.role !== "editor") throw Object.assign(new Error("You can't add notes to that team"), { code: "INVALID_INPUT" });
    this.db.prepare(`INSERT INTO note_spaces VALUES (?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET
      space_id = excluded.space_id, updated_at = excluded.updated_at`).run(noteId, spaceId, new Date().toISOString());
  }
  noteSent(noteId) {
    return this.db.prepare("SELECT sent_hash AS hash, server_version AS version FROM notes_sent WHERE note_id = ?").get(noteId) ?? null;
  }
  markNoteSent(noteId, hash, version) {
    this.db.prepare(`INSERT INTO notes_sent VALUES (?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET
      sent_hash = excluded.sent_hash, server_version = excluded.server_version`).run(noteId, hash, version ?? null);
  }
  forgetNoteSent(noteId) {
    this.db.prepare("DELETE FROM notes_sent WHERE note_id = ?").run(noteId);
    this.db.prepare("DELETE FROM attachments_sent WHERE note_id = ?").run(noteId);
  }
  sentNoteIds() { return this.db.prepare("SELECT note_id FROM notes_sent").all().map((row) => row.note_id); }
  attachmentSent(attachmentId) {
    return this.db.prepare("SELECT content_hash AS contentHash, uploaded FROM attachments_sent WHERE attachment_id = ?").get(attachmentId) ?? null;
  }
  markAttachmentSent(attachmentId, noteId, contentHash, uploaded) {
    this.db.prepare(`INSERT INTO attachments_sent VALUES (?, ?, ?, ?) ON CONFLICT(attachment_id) DO UPDATE SET
      content_hash = excluded.content_hash, uploaded = excluded.uploaded`).run(attachmentId, noteId, contentHash, uploaded ? 1 : 0);
  }
  remoteNotes() {
    return this.db.prepare("SELECT data_json FROM remote_notes").all().map((row) => JSON.parse(row.data_json));
  }
  sharedIds() { return this.db.prepare("SELECT action_id FROM shared").all().map((row) => row.action_id); }
  close() { if (this.db.open) this.db.close(); }
}

module.exports = { TeamState };
