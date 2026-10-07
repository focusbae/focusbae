'use strict';

const base = `
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))`;

const MIGRATIONS = [{ version: 1, name: 'local_workspace', sql: `
CREATE TABLE workspaces (
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton = 1),
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE notes (
  ${base},
  note_kind TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.kind')) STORED NOT NULL CHECK(note_kind IN ('note','daily','meeting')),
  title TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.title')) STORED NOT NULL,
  plain_text TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.plainText')) STORED NOT NULL,
  daily_date TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.dailyDate')) STORED,
  CHECK((note_kind = 'daily' AND daily_date IS NOT NULL) OR (note_kind != 'daily' AND daily_date IS NULL)),
  CHECK(json_extract(data_json, '$.contentSchemaVersion') = 1)
) STRICT;
CREATE UNIQUE INDEX one_daily_note ON notes(workspace_id, daily_date) WHERE deleted_at IS NULL AND note_kind = 'daily';
CREATE TABLE recordings (
  ${base},
  purpose TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.purpose')) STORED NOT NULL CHECK(purpose IN ('conversation','personal','learning')),
  source_mode TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.sourceMode')) STORED NOT NULL CHECK(source_mode IN ('microphone','system','both')),
  state TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.state')) STORED NOT NULL CHECK(state IN ('preparing','recording','stopping','captured','interrupted','failed'))
) STRICT;
CREATE TABLE speakers (
  ${base},
  recording_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.recordingId')) STORED NOT NULL,
  FOREIGN KEY(recording_id, workspace_id) REFERENCES recordings(id, workspace_id)
) STRICT;
CREATE UNIQUE INDEX speaker_recording_scope ON speakers(id, recording_id, workspace_id);
CREATE TABLE transcript_segments (
  ${base},
  recording_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.recordingId')) STORED NOT NULL,
  speaker_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.speakerId')) STORED,
  source TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.source')) STORED NOT NULL CHECK(source IN ('microphone','system','import')),
  start_ms INTEGER GENERATED ALWAYS AS (json_extract(data_json, '$.startMs')) STORED NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER GENERATED ALWAYS AS (json_extract(data_json, '$.endMs')) STORED NOT NULL CHECK(end_ms >= start_ms),
  text TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.text')) STORED NOT NULL,
  FOREIGN KEY(recording_id, workspace_id) REFERENCES recordings(id, workspace_id),
  FOREIGN KEY(speaker_id, recording_id, workspace_id) REFERENCES speakers(id, recording_id, workspace_id)
) STRICT;
CREATE INDEX segments_by_recording ON transcript_segments(recording_id, start_ms);
CREATE TABLE note_recordings (
  ${base},
  note_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.noteId')) STORED NOT NULL,
  recording_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.recordingId')) STORED NOT NULL,
  FOREIGN KEY(note_id, workspace_id) REFERENCES notes(id, workspace_id),
  FOREIGN KEY(recording_id, workspace_id) REFERENCES recordings(id, workspace_id)
) STRICT;
CREATE UNIQUE INDEX one_primary_destination ON note_recordings(recording_id) WHERE deleted_at IS NULL;
CREATE TABLE actions (
  ${base},
  status TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.status')) STORED NOT NULL CHECK(status IN ('proposed','accepted','deferred','done','dropped')),
  owner_kind TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.owner.kind')) STORED NOT NULL CHECK(owner_kind IN ('self','person','unknown')),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.owner.id')) STORED,
  CHECK((owner_kind = 'unknown' AND owner_id IS NULL) OR (owner_kind != 'unknown' AND owner_id IS NOT NULL))
) STRICT;
CREATE INDEX actions_by_status ON actions(status) WHERE deleted_at IS NULL;
CREATE TABLE jobs (
  ${base},
  state TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.state')) STORED NOT NULL CHECK(state IN ('queued','running','complete','failed','cancelled')),
  idempotency_key TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.idempotencyKey')) STORED NOT NULL UNIQUE
) STRICT;
CREATE INDEX jobs_by_state ON jobs(state, created_at);
CREATE TABLE artifacts (
  ${base},
  artifact_kind TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.kind')) STORED NOT NULL CHECK(artifact_kind IN ('summary','decisions','outline','questions')),
  job_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.jobId')) STORED NOT NULL,
  FOREIGN KEY(job_id, workspace_id) REFERENCES jobs(id, workspace_id)
) STRICT;
CREATE TABLE attachments (
  ${base},
  relative_path TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.relativePath')) STORED NOT NULL UNIQUE,
  note_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.noteId')) STORED,
  recording_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.recordingId')) STORED,
  FOREIGN KEY(note_id, workspace_id) REFERENCES notes(id, workspace_id),
  FOREIGN KEY(recording_id, workspace_id) REFERENCES recordings(id, workspace_id)
) STRICT;
CREATE TABLE legacy_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_system TEXT NOT NULL,
  source_account_id TEXT,
  entity_kind TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  import_version INTEGER NOT NULL,
  import_hash TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX unique_legacy_mapping ON legacy_mappings(source_system, coalesce(source_account_id, ''), entity_kind, remote_id);
CREATE TABLE mutation_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE source_revisions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('note','transcript')),
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plain_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(entity_kind, entity_id, revision)
) STRICT;
CREATE TABLE file_journal (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  operation TEXT NOT NULL CHECK(operation IN ('create','delete')),
  relative_path TEXT NOT NULL,
  temporary_path TEXT,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE search_documents (
  rowid INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('note','transcript','action')),
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(entity_kind, entity_id)
) STRICT;
CREATE VIRTUAL TABLE search_fts USING fts5(title, body, content='search_documents', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER search_insert AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_fts(rowid, title, body) VALUES(new.rowid, new.title, new.body);
END;
CREATE TRIGGER search_delete AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER search_update AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body) VALUES(new.rowid, new.title, new.body);
END;
` + ['notes', 'recordings', 'speakers', 'transcript_segments', 'note_recordings', 'actions', 'jobs', 'artifacts', 'attachments']
  .map((table) => `CREATE UNIQUE INDEX ${table}_scope ON ${table}(id, workspace_id);`).join('\n') }, {
  version: 2,
  name: 'local_action_reminders',
  sql: `
CREATE TABLE action_reminders (
  action_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  snoozed_until TEXT,
  last_notified_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(action_id, workspace_id),
  FOREIGN KEY(action_id, workspace_id) REFERENCES actions(id, workspace_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX reminders_by_workspace ON action_reminders(workspace_id, snoozed_until);
`,
}, {
  version: 3,
  name: 'note_links',
  sql: `
CREATE TABLE note_links (
  workspace_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_label TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('note','person')),
  target_id TEXT,
  PRIMARY KEY(workspace_id, note_id, target_key),
  FOREIGN KEY(note_id, workspace_id) REFERENCES notes(id, workspace_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX note_links_target ON note_links(workspace_id, target_kind, target_id);
CREATE INDEX note_links_key ON note_links(workspace_id, target_key);
`,
}, {
  version: 4,
  name: 'note_folders',
  sql: `
CREATE TABLE folders (
  ${base},
  name TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.name')) STORED NOT NULL,
  parent_id TEXT GENERATED ALWAYS AS (json_extract(data_json, '$.parentId')) STORED,
  FOREIGN KEY(parent_id, workspace_id) REFERENCES folders(id, workspace_id)
) STRICT;
CREATE UNIQUE INDEX folders_scope ON folders(id, workspace_id);
CREATE UNIQUE INDEX one_folder_name ON folders(workspace_id, coalesce(parent_id, ''), name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX notes_by_folder ON notes(workspace_id, json_extract(data_json, '$.folderId')) WHERE deleted_at IS NULL;
`,
}, {
  version: 5,
  name: 'note_attachment_content',
  // A compatibility fence: older editors must not open and strip attachment nodes.
  // The v1 content grammar is extended; no canonical records need rewriting.
  sql: `CREATE INDEX attachments_by_note ON attachments(workspace_id, note_id) WHERE deleted_at IS NULL;`,
}];

module.exports = { MIGRATIONS, SCHEMA_VERSION: MIGRATIONS.at(-1).version, APPLICATION_ID: 0x46425753 };
