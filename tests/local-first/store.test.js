'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture, document, mutation, scope } = require('./helpers.cjs');
const { createWorkspace, openWorkspace } = require('../../workspace');

test('account-independent records, FTS and retry acknowledgments survive restart', async (t) => {
  const f = await fixture(t); const s = f.store;
  const ctx = mutation(s);
  const note = s.createNote(ctx, { title: 'Launch', content: document('Prepare the pilot') });
  const recording = s.createRecording(mutation(s), { sourceMode: 'both' });
  const segment = s.createTranscript(mutation(s), { recordingId: recording.id, source: 'microphone', startMs: 0, endMs: 1000, text: 'Send the draft' });
  assert.equal(segment.speakerId, null);
  const action = s.createAction(mutation(s), { title: 'Send pilot invite' });
  assert.equal(action.status, 'accepted'); assert.equal(action.owner.id, s.identity.localActorId);
  const attachment = s.putAttachment(mutation(s), { noteId: note.id, displayName: '../draft.txt' }, Buffer.from('synthetic attachment'));
  const identity = s.identity;
  s.close(); const next = await f.reopen();
  assert.deepEqual(next.identity, identity);
  for (const [kind, record] of [['note', note], ['recording', recording], ['transcript', segment]]) assert.deepEqual(next.get(scope(next), kind, record.id), record);
  assert.equal(next.get(scope(next), 'action', action.id).status, 'accepted');
  assert.equal(next.readAttachment(scope(next), attachment.id).toString(), 'synthetic attachment');
  assert.deepEqual(next.createNote(ctx, { title: 'Launch', content: document('Prepare the pilot') }), note);
  assert.equal(next.search(scope(next), 'pilot').length, 2);
  assert.ok(next.list(scope(next), 'job').length >= 3);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.directory, 'workspace.sqlite')).mode & 0o777, 0o600);
});

test('mutations enforce scope, request identity and optimistic revisions atomically', async (t) => {
  const { store: s } = await fixture(t);
  const ctx = mutation(s); const note = s.createNote(ctx, { title: 'One' });
  assert.throws(() => s.createNote(ctx, { title: 'Different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => s.get({ workspaceId: randomUUID() }, 'note', note.id), { code: 'SCOPE_MISMATCH' });
  assert.throws(() => s.get(scope(s), 'constructor', note.id), { code: 'INVALID_INPUT' });
  assert.throws(() => s.updateNote(mutation(s), note.id, { title: 'Bad' }), { code: 'REVISION_REQUIRED' });
  const updateCtx = mutation(s, 1); const updated = s.updateNote(updateCtx, note.id, { title: 'Two' });
  const count = s.list(scope(s), 'job').length;
  assert.throws(() => s.updateNote(mutation(s, 1), note.id, { title: 'Lost edit' }), { code: 'REVISION_CONFLICT' });
  assert.equal(s.list(scope(s), 'job').length, count);
  assert.deepEqual(s.updateNote(updateCtx, note.id, { title: 'Two' }), updated);
  assert.equal(s.get(scope(s), 'note', note.id).revision, 2);
});

test('daily uniqueness, validated content, foreign keys and restore conflicts', async (t) => {
  const { store: s } = await fixture(t);
  const note = s.createNote(mutation(s), { kind: 'daily', dailyDate: '2026-09-10' });
  assert.equal(note.timezone, 'Asia/Kolkata');
  assert.throws(() => s.createNote(mutation(s), { kind: 'daily', dailyDate: '2026-09-10' }), { code: 'CONFLICT' });
  s.delete(mutation(s, 1), 'note', note.id);
  s.createNote(mutation(s), { kind: 'daily', dailyDate: '2026-09-10' });
  assert.throws(() => s.restore(mutation(s, 2), 'note', note.id), { code: 'CONFLICT' });
  for (const input of [{ kind: 'daily', dailyDate: '2026-02-30' }, { extra: true }, { metadata: { value: NaN } }, { content: { type: 'html' } }, { contentSchemaVersion: 2 }]) assert.throws(() => s.createNote(mutation(s), input));
  const unsafe = document('link'); unsafe.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }];
  assert.throws(() => s.createNote(mutation(s), { content: unsafe }), { code: 'INVALID_INPUT' });
  assert.throws(() => s.createTranscript(mutation(s), { recordingId: randomUUID(), source: 'microphone', text: 'orphan', startMs: 0, endMs: 1 }), { code: 'NOT_FOUND' });
  assert.deepEqual(s._db.pragma('foreign_key_check'), []);
});

test('FTS is immediate, literal, deletable and rebuildable from canonical records', async (t) => {
  const { store: s } = await fixture(t);
  const note = s.createNote(mutation(s), { title: 'Budget', content: document('Launch estimate') });
  assert.equal(s.search(scope(s), 'estimate')[0].id, note.id);
  s.updateNote(mutation(s, 1), note.id, { content: document('Revised projection') });
  assert.equal(s.search(scope(s), 'estimate').length, 0);
  assert.equal(s.search(scope(s), '"projection"*')[0].id, note.id);
  assert.deepEqual(s.search(scope(s), '" OR --'), []);
  s._db.prepare('DELETE FROM search_documents').run();
  assert.equal(s.search(scope(s), 'projection').length, 0);
  assert.equal(s.rebuildSearch(mutation(s)).documents, 1);
  assert.equal(s.search(scope(s), 'projection')[0].id, note.id);
  s.delete(mutation(s, 2), 'note', note.id);
  assert.equal(s.search(scope(s), 'projection').length, 0);
  s.restore(mutation(s, 3), 'note', note.id);
  assert.equal(s.search(scope(s), 'projection')[0].id, note.id);
  assert.equal(s._db.prepare('SELECT count(*) AS n FROM source_revisions WHERE entity_id=?').get(note.id).n, 4);
});

test('action proposals preserve quotes, require review and explicit reopening', async (t) => {
  const { store: s } = await fixture(t);
  const recording = s.createRecording(mutation(s), {});
  const segment = s.createTranscript(mutation(s), { recordingId: recording.id, source: 'system', startMs: 0, endMs: 1, text: 'Send draft today' });
  const evidence = [{ segmentId: segment.id, revision: 1, quote: 'Send draft', startOffset: 0, endOffset: 10 }];
  const proposed = s.proposeAction(mutation(s), { title: 'Send draft', evidence });
  assert.equal(proposed.status, 'proposed'); assert.equal(proposed.owner.kind, 'unknown');
  assert.throws(() => s.proposeAction(mutation(s), { title: 'Bad', evidence: [{ ...evidence[0], quote: 'invented' }] }), { code: 'INVALID_EVIDENCE' });
  const accepted = s.transitionAction(mutation(s, 1), proposed.id, { status: 'accepted' });
  assert.ok(accepted.acceptedAt);
  s.updateTranscript(mutation(s, 1), segment.id, { text: 'Send revised draft today' });
  assert.equal(s.get(scope(s), 'action', proposed.id).sourceState, 'stale');
  const changed = s.updateAction(mutation(s, 2), proposed.id, { title: 'Reviewed title', dueDate: '2026-09-11' });
  // Evidence written without a source kind is a transcript quote, as it always was.
  assert.deepEqual(changed.evidence, [{ ...evidence[0], sourceKind: 'transcript' }]);
  assert.equal(changed.status, 'accepted');
  s.transitionAction(mutation(s, 3), proposed.id, { status: 'done' });
  assert.throws(() => s.transitionAction(mutation(s, 4), proposed.id, { status: 'accepted' }), { code: 'REOPEN_REQUIRED' });
  assert.equal(s.transitionAction(mutation(s, 4), proposed.id, { status: 'accepted', reopen: true }).completedAt, null);
  s.delete(mutation(s, 1), 'recording', recording.id);
  assert.equal(s.get(scope(s), 'action', proposed.id).sourceState, 'deleted');
  assert.deepEqual(s.list(scope(s), 'transcript'), []);
  assert.equal(s.search(scope(s), 'revised draft today').length, 0);
  s.restore(mutation(s, 2), 'recording', recording.id);
  assert.equal(s.list(scope(s), 'transcript').length, 1);
});

test('person ownership keeps a local display label and clears it when reassigned to self', async (t) => {
  const { store: s } = await fixture(t);
  const personId = require('node:crypto').randomUUID();
  const action = s.createAction(mutation(s), { title: 'Wait for review', owner: { kind: 'person', id: personId }, ownerLabel: 'Asha' });
  assert.equal(action.ownerLabel, 'Asha');
  const changed = s.updateAction(mutation(s, 1), action.id, { owner: { kind: 'self', id: null } });
  assert.equal(changed.owner.kind, 'self'); assert.equal(changed.ownerLabel, null);
});

test('stale proposals cannot be accepted; microphone source is not speaker identity', async (t) => {
  const { store: s } = await fixture(t);
  const recording = s.createRecording(mutation(s), {});
  const other = s.createRecording(mutation(s), {});
  const speaker = s.createSpeaker(mutation(s), { recordingId: other.id, label: 'Speaker 1' });
  const input = { recordingId: recording.id, source: 'microphone', startMs: 0, endMs: 1, text: 'draft' };
  assert.throws(() => s.createTranscript(mutation(s), { ...input, speakerId: speaker.id }), { code: 'SCOPE_MISMATCH' });
  const segment = s.createTranscript(mutation(s), input);
  const proposed = s.proposeAction(mutation(s), { title: 'Draft', evidence: [{ segmentId: segment.id, revision: 1, quote: 'draft', startOffset: 0, endOffset: 5 }] });
  s.updateTranscript(mutation(s, 1), segment.id, { text: 'changed' });
  assert.throws(() => s.transitionAction(mutation(s, 1), proposed.id, { status: 'accepted' }), { code: 'STALE_SOURCE' });
});

test('jobs deduplicate, retain checkpoints, detect stale sources and recover running state', async (t) => {
  const f = await fixture(t); const s = f.store;
  const note = s.createNote(mutation(s), { title: 'Job source' });
  const input = { type: 'summarize', idempotencyKey: 'summary:1', inputRevisions: [{ kind: 'note', id: note.id, revision: 1 }] };
  const job = s.enqueueJob(mutation(s), input);
  assert.equal(s.enqueueJob(mutation(s), input).id, job.id);
  assert.throws(() => s.enqueueJob(mutation(s), { ...input, type: 'embed' }), { code: 'IDEMPOTENCY_CONFLICT' });
  s.transitionJob(mutation(s, 1), job.id, { state: 'running', checkpoint: { chunk: 3 } });
  s.close(); const next = await f.reopen();
  const recovered = next.get(scope(next), 'job', job.id);
  assert.equal(recovered.state, 'queued'); assert.equal(recovered.attempts, 1); assert.equal(recovered.checkpoint.chunk, 3);
  const running = next.transitionJob(mutation(next, recovered.revision), job.id, { state: 'running' });
  next.updateNote(mutation(next, 1), note.id, { title: 'Changed source' });
  assert.throws(() => next.transitionJob(mutation(next, running.revision), job.id, { state: 'complete' }), { code: 'STALE_SOURCE' });
  assert.equal(next.get(scope(next), 'job', job.id).state, 'running');
});

test('note destination is independent of recording lifetime', async (t) => {
  const { store: s } = await fixture(t);
  const note = s.createNote(mutation(s), {}); const second = s.createNote(mutation(s), {});
  const recording = s.createRecording(mutation(s), {});
  s.linkRecording(mutation(s), { noteId: note.id, recordingId: recording.id });
  assert.throws(() => s.linkRecording(mutation(s), { noteId: second.id, recordingId: recording.id }), { code: 'CONFLICT' });
  s.delete(mutation(s, 1), 'note', note.id);
  assert.equal(s.get(scope(s), 'recording', recording.id).state, 'preparing');
  assert.throws(() => s.updateRecording(mutation(s, 1), recording.id, { state: 'captured' }), { code: 'INVALID_TRANSITION' });
});

test('workspace locking, manifest checks and managed path safety', async (t) => {
  const f = await fixture(t);
  await assert.rejects(openWorkspace({ directory: f.directory }), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(createWorkspace({ directory: f.directory }), { code: 'ALREADY_EXISTS' });
  f.store.close();
  fs.symlinkSync(f.root, path.join(f.directory, 'attachments', 'unsafe'));
  const { managedPath } = require('../../workspace/files');
  assert.throws(() => managedPath(f.directory, 'attachments/unsafe/test'), { code: 'UNSAFE_PATH' });
  assert.throws(() => managedPath(f.directory, '../outside'), { code: 'UNSAFE_PATH' });
  const manifestPath = path.join(f.directory, 'workspace.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, workspaceId: randomUUID() }));
  await assert.rejects(f.reopen(), { code: 'INVALID_WORKSPACE' });
  fs.unlinkSync(manifestPath);
  const next = await f.reopen(); assert.equal(next.identity.id, manifest.workspaceId);
});

test('two real workspaces reject each other\'s entity and actor identifiers', async (t) => {
  const { store: a } = await fixture(t); const { store: b } = await fixture(t);
  const note = a.createNote(mutation(a), {});
  assert.throws(() => b.get(scope(b), 'note', note.id), { code: 'NOT_FOUND' });
  assert.throws(() => b.createAction(mutation(b), { title: 'Wrong self', owner: { kind: 'self', id: a.identity.localActorId } }), { code: 'SCOPE_MISMATCH' });
  assert.throws(() => b.putAttachment(mutation(b), { noteId: note.id, displayName: 'wrong' }, Buffer.from('wrong')), { code: 'NOT_FOUND' });
  assert.equal(b.list(scope(b), 'attachment').length, 0);
});

test('all action transitions enforce the defined lifecycle', async (t) => {
  const { store: s } = await fixture(t);
  const allowed = { proposed: ['accepted', 'dropped'], accepted: ['deferred', 'done', 'dropped'], deferred: ['accepted', 'done', 'dropped'], done: ['accepted'], dropped: ['accepted'] };
  const recording = s.createRecording(mutation(s), {});
  const segment = s.createTranscript(mutation(s), { recordingId: recording.id, source: 'import', text: 'draft', startMs: 0, endMs: 1 });
  const evidence = [{ segmentId: segment.id, revision: 1, quote: 'draft', startOffset: 0, endOffset: 5 }];
  for (const from of Object.keys(allowed)) for (const to of Object.keys(allowed)) {
    let action = from === 'proposed' ? s.proposeAction(mutation(s), { title: 'Draft', evidence }) : s.createAction(mutation(s), { title: 'Draft' });
    if (!['accepted', 'proposed'].includes(from)) action = s.transitionAction(mutation(s, action.revision), action.id, { status: from });
    const transition = () => s.transitionAction(mutation(s, action.revision), action.id, { status: to, reopen: true });
    if (allowed[from].includes(to)) assert.equal(transition().status, to);
    else assert.throws(transition, { code: 'INVALID_TRANSITION' }, `${from} -> ${to}`);
  }
});

test('workspace settings preserve actor identity and validate nested input', async (t) => {
  const f = await fixture(t); const s = f.store; const identity = s.identity;
  s.updateWorkspace(mutation(s, 1), { name: 'Renamed', preferences: { timezone: 'America/New_York', theme: 'dark' } });
  assert.throws(() => s.updateWorkspace(mutation(s, 2), { preferences: 'invalid' }), { code: 'INVALID_INPUT' });
  assert.throws(() => s.updateWorkspace(mutation(s, 2), { preferences: { welcomeDismissed: 'yes' } }), { code: 'INVALID_INPUT' });
  assert.equal(s.createNote(mutation(s), {}).timezone, 'America/New_York');
  assert.equal(s.createNote(mutation(s), { content: document(' ') }).plainText, ' ');
  s.close(); const next = await f.reopen();
  assert.deepEqual(next.identity, identity);
  assert.equal(next.getWorkspace(scope(next)).name, 'Renamed');
});

test('database foreign keys reject cross-recording speakers even below the service API', async (t) => {
  const { store: s } = await fixture(t);
  const first = s.createRecording(mutation(s), {}); const second = s.createRecording(mutation(s), {});
  const speaker = s.createSpeaker(mutation(s), { recordingId: second.id, label: 'Other speaker' });
  const transcript = s.createTranscript(mutation(s), { recordingId: first.id, source: 'system', text: 'word', startMs: 0, endMs: 1 });
  assert.throws(() => s._db.prepare("UPDATE transcript_segments SET data_json=json_set(data_json, '$.speakerId', ?) WHERE id=?").run(speaker.id, transcript.id), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  assert.deepEqual(s._db.pragma('foreign_key_check'), []);
});

test('recording revisions enqueue fresh transcript work; deleted sources cannot feed processing', async (t) => {
  const { store: s } = await fixture(t);
  const recording = s.createRecording(mutation(s), {});
  const transcript = s.createTranscript(mutation(s), { recordingId: recording.id, source: 'system', text: 'word', startMs: 0, endMs: 1 });
  s.updateRecording(mutation(s, 1), recording.id, { state: 'recording' });
  const jobs = s.list(scope(s), 'job');
  assert.equal(jobs.length, 2);
  assert.ok(jobs.some((job) => job.inputRevisions.some((ref) => ref.id === recording.id && ref.revision === 2)));
  s.delete(mutation(s, 2), 'recording', recording.id);
  assert.throws(() => s.enqueueJob(mutation(s), { type: 'summarize', idempotencyKey: 'deleted', inputRevisions: [
    { kind: 'transcript', id: transcript.id, revision: 1 }, { kind: 'recording', id: recording.id, revision: 3, deleted: true },
  ] }), { code: 'INVALID_INPUT' });
});

test('attachment metadata edits do not rewrite immutable bytes; retention preference is explicit', async (t) => {
  const { store: s } = await fixture(t);
  assert.equal(s.createRecording(mutation(s), {}).keepAudio, false);
  s.updateWorkspace(mutation(s, 1), { preferences: { defaultKeepAudio: true } });
  assert.equal(s.createRecording(mutation(s), {}).keepAudio, true);
  assert.equal(s.createRecording(mutation(s), { keepAudio: false }).keepAudio, false);
  const note = s.createNote(mutation(s), {});
  const attachment = s.putAttachment(mutation(s), { noteId: note.id, displayName: 'old' }, Buffer.from('immutable'));
  const edited = s.updateAttachment(mutation(s, 1), attachment.id, { displayName: 'renamed' });
  assert.equal(edited.relativePath, attachment.relativePath);
  assert.equal(edited.contentHash, attachment.contentHash);
  assert.equal(s.readAttachment(scope(s), attachment.id).toString(), 'immutable');
  assert.throws(() => s.updateAttachment(mutation(s, 2), attachment.id, { relativePath: '../escape' }), { code: 'INVALID_INPUT' });
});

test('known cloud locations and symlinked managed directories are rejected', async (t) => {
  const f = await fixture(t);
  const cloud = path.join(f.root, 'Dropbox'); fs.mkdirSync(cloud);
  await assert.rejects(createWorkspace({ directory: path.join(cloud, 'workspace') }), { code: 'UNSUPPORTED_LOCATION' });
  f.store.close();
  const attachments = path.join(f.directory, 'attachments');
  fs.renameSync(attachments, path.join(f.directory, 'original-attachments'));
  fs.symlinkSync(f.root, attachments);
  await assert.rejects(f.reopen(), { code: 'UNSAFE_PATH' });
});

test('small-note durable save timing diagnostic', async (t) => {
  const { performance } = require('node:perf_hooks');
  const { store: s } = await fixture(t);
  const elapsed = [];
  for (let index = 0; index < 40; index++) {
    const start = performance.now();
    s.createNote(mutation(s), { title: `Synthetic note ${index}`, content: document('Local durable note fixture. '.repeat(20)) });
    elapsed.push(performance.now() - start);
  }
  elapsed.sort((a, b) => a - b);
  t.diagnostic(`40 durable note commits including FTS and index jobs: median=${elapsed[19].toFixed(2)}ms p95=${elapsed[37].toFixed(2)}ms`);
  assert.equal(s.list(scope(s), 'note').length, 40);
  assert.equal(s.list(scope(s), 'job').length, 40);
});
