'use strict';

const { randomUUID } = require('node:crypto');
const v = require('./validation');
const domain = require('./domain');
const { check, WorkspaceError } = require('./errors');
const { SCHEMA_VERSION } = require('./schema');

const BASE = ['id', 'workspaceId', 'revision', 'createdAt', 'updatedAt', 'deletedAt'];
const JSON_LIMIT = 8 * 1024 * 1024;
const JOB_TRANSITIONS = { queued: ['running', 'cancelled'], running: ['complete', 'failed', 'cancelled'], failed: ['queued'], cancelled: ['queued'], complete: [] };

function decode(row) {
  return row && { ...JSON.parse(row.data_json), id: row.id, workspaceId: row.workspace_id,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

class WorkspaceStore {
  constructor(db, directory, release) {
    this._db = db;
    this._directory = directory;
    this._release = release;
    this._closed = false;
    this.recoveryReport = [];
    const row = db.prepare('SELECT * FROM workspaces').get();
    check(row, 'INVALID_WORKSPACE', 'Workspace identity is missing');
    this._identity = { id: row.id, localActorId: row.actor_id };
  }

  get identity() { return { ...this._identity }; }

  _scope(ctx, mutation = false) {
    check(!this._closed, 'WORKSPACE_CLOSED', 'Workspace is closed');
    v.object(ctx, mutation ? ['workspaceId', 'clientRequestId', 'expectedRevision'] : ['workspaceId'], 'context');
    check(v.uuid(ctx.workspaceId) === this._identity.id, 'SCOPE_MISMATCH', 'Wrong workspace');
    if (mutation) {
      v.uuid(ctx.clientRequestId, 'clientRequestId');
      if (ctx.expectedRevision !== undefined) v.integer(ctx.expectedRevision, 'expectedRevision', 1);
    }
  }

  _table(kind) { return domain.ENTITY_TABLES[v.choice(kind, Object.keys(domain.ENTITY_TABLES), 'entity kind')]; }

  _raw(kind, id) {
    return decode(this._db.prepare(`SELECT * FROM ${this._table(kind)} WHERE id = ? AND workspace_id = ?`).get(v.uuid(id), this._identity.id));
  }

  _live(kind, id) {
    const record = this._raw(kind, id);
    check(record && !record.deletedAt, 'NOT_FOUND', 'Record does not exist');
    if (kind === 'transcript' || kind === 'speaker') this._live('recording', record.recordingId);
    return record;
  }

  _expected(ctx, record) {
    check(ctx.expectedRevision !== undefined, 'REVISION_REQUIRED', 'Expected revision is required');
    check(record.revision === ctx.expectedRevision, 'REVISION_CONFLICT', 'Record changed since it was read');
  }

  _request(ctx, operation, args) {
    this._scope(ctx, true);
    const fingerprint = v.hash(v.stableJson({ operation, args, expectedRevision: ctx.expectedRevision ?? null }, JSON_LIMIT));
    const previous = this._db.prepare('SELECT * FROM mutation_requests WHERE request_id = ?').get(ctx.clientRequestId);
    if (previous) check(previous.workspace_id === ctx.workspaceId && previous.operation === operation && previous.fingerprint === fingerprint,
      'IDEMPOTENCY_CONFLICT', 'Request identifier was used for a different mutation');
    return { fingerprint, previous };
  }

  _mutate(ctx, operation, args, fn) {
    this._scope(ctx, true);
    try {
      return this._db.transaction(() => {
        const { fingerprint, previous } = this._request(ctx, operation, args);
        if (previous) return JSON.parse(previous.result_json);
        const result = fn();
        const serialized = v.stableJson(result, JSON_LIMIT);
        this._db.prepare('INSERT INTO mutation_requests VALUES (?, ?, ?, ?, ?, ?)')
          .run(ctx.clientRequestId, ctx.workspaceId, operation, fingerprint, serialized, new Date().toISOString());
        return JSON.parse(serialized);
      }).immediate();
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) throw new WorkspaceError('CONFLICT', 'Mutation violates workspace integrity');
      if (error.code === 'SQLITE_FULL' || error.code === 'ENOSPC') throw new WorkspaceError('DISK_FULL', 'Local storage is full');
      throw error;
    }
  }

  _new(data) {
    const now = new Date().toISOString();
    return { ...data, id: randomUUID(), workspaceId: this._identity.id, revision: 1, createdAt: now, updatedAt: now, deletedAt: null };
  }

  _next(old, data) { return { ...old, ...data, revision: old.revision + 1, updatedAt: new Date().toISOString() }; }

  _save(kind, record) {
    if (kind === 'note' && !record.deletedAt) for (const id of require('./content').attachmentIds(record.content)) {
      check(this._live('attachment', id).noteId === record.id, 'SCOPE_MISMATCH', 'Attachment belongs to another note');
    }
    const data = Object.fromEntries(Object.entries(record).filter(([key]) => !BASE.includes(key)));
    this._db.prepare(`INSERT INTO ${this._table(kind)} (id, workspace_id, revision, created_at, updated_at, deleted_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
      updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, data_json=excluded.data_json`)
      .run(record.id, record.workspaceId, record.revision, record.createdAt, record.updatedAt, record.deletedAt, v.stableJson(data, JSON_LIMIT));
    if (kind === 'note') require('./links').index(this, record);
    if (['note', 'transcript', 'action'].includes(kind)) this._derive(kind, record);
    if (kind === 'recording') for (const row of this._db.prepare('SELECT * FROM transcript_segments WHERE recording_id = ?').all(record.id)) this._derive('transcript', decode(row));
    return record;
  }

  _derive(kind, record, enqueue = true) {
    const parent = kind === 'transcript' ? this._raw('recording', record.recordingId) : null;
    const deleted = !!record.deletedAt || (kind === 'transcript' && (!parent || !!parent.deletedAt));
    if (kind !== 'action') this._db.prepare('INSERT OR IGNORE INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.workspaceId, kind, record.id, record.revision, record.plainText ?? record.text, record.contentHash);
    if (deleted) this._db.prepare('DELETE FROM search_documents WHERE entity_kind = ? AND entity_id = ?').run(kind, record.id);
    else this._db.prepare(`INSERT INTO search_documents(workspace_id, entity_kind, entity_id, title, body) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_kind, entity_id) DO UPDATE SET title=excluded.title, body=excluded.body`)
      .run(record.workspaceId, kind, record.id, (kind === 'transcript' ? parent?.title : record.title) ?? '', record.plainText ?? record.text ?? '');
    if (enqueue) this._queue(domain.job({ type: deleted ? 'index.delete' : 'index.upsert',
      idempotencyKey: `index:${kind}:${record.id}:${record.revision}:${parent?.revision ?? 0}`,
      inputRevisions: [{ kind, id: record.id, revision: record.revision, deleted: !!record.deletedAt },
        ...(parent ? [{ kind: 'recording', id: parent.id, revision: parent.revision, deleted: !!parent.deletedAt }] : [])] }));
  }

  _queue(data) {
    const old = decode(this._db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(data.idempotencyKey));
    if (old) {
      check(old.requestHash === data.requestHash, 'IDEMPOTENCY_CONFLICT', 'Job key already refers to different work');
      return old;
    }
    return this._save('job', this._new(data));
  }

  _validateRefs(refs) {
    for (const ref of refs) {
      const current = this._raw(ref.kind, ref.id);
      check(current && current.revision === ref.revision && !!current.deletedAt === ref.deleted, 'STALE_SOURCE', 'Job source changed');
      if (ref.kind === 'transcript') {
        const parent = this._raw('recording', current.recordingId);
        const parentRef = refs.find((entry) => entry.kind === 'recording' && entry.id === current.recordingId);
        check(parent && (!parent.deletedAt || parentRef?.deleted), 'STALE_SOURCE', 'Recording source was deleted');
      }
    }
  }

  getWorkspace(ctx) {
    this._scope(ctx);
    const row = this._db.prepare('SELECT * FROM workspaces').get();
    return { ...this._identity, name: row.name, preferences: domain.preferences(JSON.parse(row.preferences_json)), revision: row.revision,
      schemaVersion: SCHEMA_VERSION, location: this._directory, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  updateWorkspace(ctx, input) {
    return this._mutate(ctx, 'workspace.update', input, () => {
      v.object(input, ['name', 'preferences'], 'workspace');
      const old = this.getWorkspace({ workspaceId: ctx.workspaceId });
      this._expected(ctx, old);
      if (input.preferences !== undefined) v.object(input.preferences, ['timezone', 'theme', 'defaultKeepAudio', 'notificationsEnabled', 'reminderHour', 'welcomeDismissed'], 'preferences');
      const name = v.text(input.name ?? old.name, 'workspace name', 200);
      const preferences = domain.preferences({ ...old.preferences, ...input.preferences });
      this._db.prepare('UPDATE workspaces SET name=?, preferences_json=?, revision=revision+1, updated_at=? WHERE id=?')
        .run(name, v.stableJson(preferences), new Date().toISOString(), ctx.workspaceId);
      return this.getWorkspace({ workspaceId: ctx.workspaceId });
    });
  }

  get(ctx, kind, id, options = {}) {
    this._scope(ctx);
    v.object(options, ['includeDeleted']);
    const includeDeleted = v.boolean(options.includeDeleted ?? false, 'includeDeleted');
    const record = includeDeleted ? this._raw(kind, id) : this._live(kind, id);
    check(record, 'NOT_FOUND', 'Record does not exist');
    return kind === 'action' ? { ...record, sourceState: this._evidenceState(record.evidence) } : record;
  }

  list(ctx, kind, options = {}) {
    this._scope(ctx);
    v.object(options, ['includeDeleted', 'limit', 'offset', 'recordingId']);
    const table = this._table(kind);
    const limit = v.integer(options.limit ?? 100, 'limit', 1, 1000);
    const offset = v.integer(options.offset ?? 0, 'offset');
    const includeDeleted = v.boolean(options.includeDeleted ?? false, 'includeDeleted');
    const params = [ctx.workspaceId];
    let where = includeDeleted ? '' : ' AND deleted_at IS NULL';
    if (!includeDeleted && ['transcript', 'speaker'].includes(kind)) where += ' AND recording_id IN (SELECT id FROM recordings WHERE deleted_at IS NULL)';
    if (options.recordingId !== undefined) {
      check(['transcript', 'speaker', 'link', 'attachment'].includes(kind), 'INVALID_INPUT', 'This entity has no recording filter');
      where += ' AND recording_id = ?'; params.push(v.uuid(options.recordingId));
    }
    const order = kind === 'transcript' ? 'start_ms, id' : 'created_at, id';
    return this._db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ?${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map((row) => {
        const record = decode(row);
        return kind === 'action' ? { ...record, sourceState: this._evidenceState(record.evidence) } : record;
      });
  }

  _create(ctx, kind, input, normalize) {
    return this._mutate(ctx, `${kind}.create`, input, () => this._save(kind, this._new(normalize(input))));
  }

  _update(ctx, kind, id, input, normalize) {
    return this._mutate(ctx, `${kind}.update`, { id, input }, () => {
      const old = this._live(kind, id); this._expected(ctx, old);
      return this._save(kind, this._next(old, normalize(input, old)));
    });
  }

  _timezone() { return JSON.parse(this._db.prepare('SELECT preferences_json FROM workspaces').get().preferences_json).timezone; }
  createNote(ctx, input) { return this._create(ctx, 'note', input, (data) => domain.note(data, null, this._timezone())); }
  updateNote(ctx, id, input) { return this._update(ctx, 'note', id, input, (data, old) => domain.note(data, old, this._timezone())); }
  createRecording(ctx, input) {
    return this._create(ctx, 'recording', input, (data) => {
      const record = domain.recording(data, null, this._timezone());
      if (data.keepAudio === undefined) record.keepAudio = JSON.parse(this._db.prepare('SELECT preferences_json FROM workspaces').get().preferences_json).defaultKeepAudio;
      return record;
    });
  }
  updateRecording(ctx, id, input) { return this._update(ctx, 'recording', id, input, (data, old) => domain.recording(data, old, this._timezone())); }

  _transcript(input, old) {
    const data = domain.transcript(input, old);
    this._live('recording', data.recordingId);
    if (data.speakerId) check(this._live('speaker', data.speakerId).recordingId === data.recordingId, 'SCOPE_MISMATCH', 'Speaker belongs to another recording');
    return data;
  }
  createTranscript(ctx, input) { return this._create(ctx, 'transcript', input, (data) => this._transcript(data)); }
  updateTranscript(ctx, id, input) { return this._update(ctx, 'transcript', id, input, (data, old) => this._transcript(data, old)); }

  createSpeaker(ctx, input) {
    return this._create(ctx, 'speaker', input, (data) => {
      v.object(data, ['recordingId', 'label']);
      this._live('recording', data.recordingId);
      return { recordingId: data.recordingId, label: v.text(data.label, 'speaker label', 200), identity: { kind: 'unknown', id: null, label: null } };
    });
  }

  identifySpeaker(ctx, id, input) {
    return this._update(ctx, 'speaker', id, input, (data, old) => {
      v.object(data, ['identity']);
      return { recordingId: old.recordingId, label: old.label, identity: domain.speakerIdentity(data.identity, this._identity.localActorId) };
    });
  }

  linkRecording(ctx, input) {
    return this._create(ctx, 'link', input, (data) => {
      v.object(data, ['noteId', 'recordingId']);
      this._live('note', data.noteId); this._live('recording', data.recordingId);
      return { noteId: data.noteId, recordingId: data.recordingId };
    });
  }

  // The words an action was quoted from, and whether they are still there. A note
  // stands on its own; a transcript segment also dies with its recording.
  _evidenceSource(entry) {
    return entry.sourceKind === 'note' ? this._raw('note', entry.segmentId) : this._raw('transcript', entry.segmentId);
  }

  _evidenceState(evidence) {
    if (!evidence.length) return 'none';
    let state = 'current';
    for (const entry of evidence) {
      const source = this._evidenceSource(entry);
      if (!source || source.deletedAt) return 'deleted';
      if (entry.sourceKind !== 'note' && this._raw('recording', source.recordingId)?.deletedAt) return 'deleted';
      if (source.revision !== entry.revision) state = 'stale';
    }
    return state;
  }

  _action(input, old, origin, attribution = false) {
    const data = domain.action(input, old, this._identity.localActorId, this._timezone(), origin, attribution);
    if (!old || Object.hasOwn(input, 'evidence')) for (const entry of data.evidence) {
      const note = entry.sourceKind === 'note';
      const source = this._live(note ? 'note' : 'transcript', entry.segmentId);
      const text = note ? source.plainText : source.text;
      check(source.revision === entry.revision, 'STALE_SOURCE', 'Evidence revision changed');
      check(entry.endOffset <= text.length && text.slice(entry.startOffset, entry.endOffset) === entry.quote,
        'INVALID_EVIDENCE', 'Evidence must exactly quote the source at its revision');
    }
    if (data.restatementOf) this._live('action', data.restatementOf);
    return data;
  }
  createAction(ctx, input) { return this._create(ctx, 'action', input, (data) => this._action(data, null, 'manual')); }
  proposeAction(ctx, input, origin = 'model') {
    return this._mutate(ctx, 'action.propose', input, () => this._save('action', this._new(this._action(input, null, origin))));
  }
  updateAction(ctx, id, input) { return this._update(ctx, 'action', id, input, (data, old) => this._action(data, old, old.origin)); }

  // Speaker-based owner for a suggestion. Applies only while the action is still a
  // proposal whose owner was set automatically; anything a person decided is kept.
  attributeAction(ctx, id, input) {
    return this._mutate(ctx, 'action.attribute', { id, input }, () => {
      v.object(input, ['owner', 'ownerLabel'], 'attribution');
      const old = this._live('action', id); this._expected(ctx, old);
      if (old.status !== 'proposed' || (old.ownerSource ?? 'auto') !== 'auto') return old;
      const data = this._action({ owner: input.owner, ownerLabel: input.ownerLabel ?? null }, old, old.origin, true);
      if (domain.sameOwner(old, data)) return old;
      return this._save('action', this._next(old, data));
    });
  }

  transitionAction(ctx, id, input) {
    return this._mutate(ctx, 'action.transition', { id, input }, () => {
      v.object(input, ['status', 'reopen']);
      const old = this._live('action', id); this._expected(ctx, old);
      const status = v.choice(input.status, Object.keys(domain.ACTION_TRANSITIONS), 'action status');
      const reopen = v.boolean(input.reopen ?? false, 'reopen');
      check(domain.ACTION_TRANSITIONS[old.status].includes(status), 'INVALID_TRANSITION', 'Invalid action transition');
      check(!['done', 'dropped'].includes(old.status) || reopen, 'REOPEN_REQUIRED', 'Reopening a terminal action must be explicit');
      if (old.status === 'proposed' && status === 'accepted') check(this._evidenceState(old.evidence) === 'current', 'STALE_SOURCE', 'Review changed source evidence before accepting');
      return this._save('action', this._next(old, { status,
        acceptedAt: old.acceptedAt ?? (status === 'accepted' ? new Date().toISOString() : null),
        completedAt: status === 'done' ? new Date().toISOString() : null }));
    });
  }

  _tombstone(ctx, kind, id, deleted) {
    v.choice(kind, ['note', 'recording', 'transcript', 'action', 'speaker', 'artifact', 'link'], 'deletable entity');
    return this._mutate(ctx, `${kind}.${deleted ? 'delete' : 'restore'}`, { id }, () => {
      const old = this._raw(kind, id); check(old, 'NOT_FOUND', 'Record does not exist'); this._expected(ctx, old);
      check(!old.metadata?.purgedAt, 'NOT_FOUND', 'Note was permanently deleted');
      check(!!old.deletedAt !== deleted, 'INVALID_TRANSITION', 'Record already has this deletion state');
      if (!deleted && ['transcript', 'speaker', 'link'].includes(kind)) this._live('recording', old.recordingId);
      if (!deleted && kind === 'link') this._live('note', old.noteId);
      const record = this._save(kind, this._next(old, { deletedAt: deleted ? new Date().toISOString() : null }));
      return record;
    });
  }
  delete(ctx, kind, id) { return this._tombstone(ctx, kind, id, true); }
  restore(ctx, kind, id) { return this._tombstone(ctx, kind, id, false); }

  purgeNote(ctx, id) {
    const record = this._mutate(ctx, 'note.purge', { id }, () => {
      const old = this._raw('note', id);
      check(old && old.deletedAt && !old.metadata?.purgedAt, 'INVALID_TRANSITION', 'Only notes in Trash can be permanently deleted');
      this._expected(ctx, old);
      const now = new Date().toISOString();
      for (const row of this._db.prepare('SELECT id FROM attachments WHERE note_id = ? AND deleted_at IS NULL').all(id)) {
        const attachment = this._raw('attachment', row.id);
        this._save('attachment', this._next(attachment, { deletedAt: now }));
        this._db.prepare('INSERT INTO file_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), ctx.workspaceId, 'delete', attachment.relativePath, null, attachment.contentHash, attachment.byteSize, now);
      }
      const saved = this._save('note', this._next(old, {
        ...require('./content').documentContent(require('./content').EMPTY_DOCUMENT), title: '', metadata: { purgedAt: now },
      }));
      this._db.prepare("DELETE FROM source_revisions WHERE entity_kind = 'note' AND entity_id = ?").run(id);
      this._db.prepare("DELETE FROM mutation_requests WHERE json_extract(result_json, '$.id') = ?").run(id);
      return saved;
    });
    require('./attachments').reconcile(this);
    return record;
  }

  enqueueJob(ctx, input) {
    return this._mutate(ctx, 'job.enqueue', input, () => {
      const data = domain.job(input);
      check(data.type === 'index.delete' || data.inputRevisions.every((ref) => !ref.deleted), 'INVALID_INPUT', 'Processing jobs need live sources');
      this._validateRefs(data.inputRevisions);
      return this._queue(data);
    });
  }

  transitionJob(ctx, id, input) {
    return this._mutate(ctx, 'job.transition', { id, input }, () => {
      v.object(input, ['state', 'checkpoint', 'error']);
      const old = this._live('job', id); this._expected(ctx, old);
      const state = v.choice(input.state, Object.keys(JOB_TRANSITIONS), 'job state');
      check(JOB_TRANSITIONS[old.state].includes(state), 'INVALID_TRANSITION', 'Invalid job transition');
      if (state === 'complete') this._validateRefs(old.inputRevisions);
      return this._save('job', this._next(old, { state, attempts: old.attempts + (state === 'running' ? 1 : 0),
        checkpoint: v.json(input.checkpoint ?? old.checkpoint), error: input.error == null ? null : v.json(input.error) }));
    });
  }

  _recoverJobs() {
    this._db.transaction(() => {
      for (const row of this._db.prepare("SELECT * FROM jobs WHERE state = 'running'").all()) {
        const job = decode(row);
        this._save('job', this._next(job, { state: 'queued', error: { code: 'INTERRUPTED' } }));
      }
    }).immediate();
  }

  search(ctx, query, options = {}) {
    this._scope(ctx); v.object(options, ['limit']);
    v.text(query, 'query', 2000, true);
    const limit = v.integer(options.limit ?? 50, 'limit', 1, 200);
    const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!tokens.length) return [];
    const expression = tokens.map((token) => `"${token}"`).join(' AND ');
    return this._db.prepare(`SELECT d.entity_kind AS kind, d.entity_id AS id, d.title, d.body, bm25(search_fts, 3.0, 1.0) AS rank
      FROM search_fts JOIN search_documents d ON d.rowid=search_fts.rowid
      WHERE search_fts MATCH ? AND d.workspace_id=? ORDER BY rank, d.entity_id LIMIT ?`).all(expression, ctx.workspaceId, limit);
  }

  rebuildSearch(ctx) {
    return this._mutate(ctx, 'search.rebuild', {}, () => {
      this._db.prepare('DELETE FROM search_documents').run();
      for (const kind of ['note', 'transcript', 'action']) for (const row of this._db.prepare(`SELECT * FROM ${this._table(kind)}`).all()) this._derive(kind, decode(row), false);
      this._db.prepare("INSERT INTO search_fts(search_fts) VALUES ('rebuild')").run();
      return { documents: this._db.prepare('SELECT count(*) AS count FROM search_documents').get().count };
    });
  }

  close() {
    if (this._closed) return;
    try { this._db.close(); } finally { this._release(); this._closed = true; }
  }
}

module.exports = { WorkspaceStore };
