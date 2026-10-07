'use strict';

const v = require('./validation');
const { check } = require('./errors');
const { documentContent, EMPTY_DOCUMENT } = require('./content');

const ENTITY_TABLES = Object.freeze({ note: 'notes', recording: 'recordings', transcript: 'transcript_segments', action: 'actions', job: 'jobs', attachment: 'attachments', speaker: 'speakers', artifact: 'artifacts', link: 'note_recordings', folder: 'folders' });
const ACTION_TRANSITIONS = Object.freeze({ proposed: ['accepted', 'dropped'], accepted: ['deferred', 'done', 'dropped'], deferred: ['accepted', 'done', 'dropped'], done: ['accepted'], dropped: ['accepted'] });
const RECORDING_TRANSITIONS = Object.freeze({ preparing: ['recording', 'failed', 'interrupted'], recording: ['stopping', 'interrupted', 'failed'], stopping: ['captured', 'interrupted', 'failed'], captured: [], interrupted: [], failed: [] });

function preferences(value) {
  v.object(value, ['timezone', 'theme', 'defaultKeepAudio', 'notificationsEnabled', 'reminderHour', 'welcomeDismissed'], 'preferences');
  return {
    timezone: v.timezone(value.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    theme: v.choice(value.theme ?? 'system', ['system', 'light', 'dark'], 'theme'),
    defaultKeepAudio: v.boolean(value.defaultKeepAudio ?? false, 'defaultKeepAudio'),
    notificationsEnabled: v.boolean(value.notificationsEnabled ?? false, 'notificationsEnabled'),
    reminderHour: v.integer(value.reminderHour ?? 9, 'reminderHour', 0, 23),
    welcomeDismissed: v.boolean(value.welcomeDismissed ?? false, 'welcomeDismissed'),
  };
}

// A folder holds notes and other folders. Names are compared case-insensitively
// within one parent, and a folder never contains a note's content — moving one
// changes where a note is filed, never what it says.
function folder(input, old) {
  v.object(input, ['name', 'parentId'], 'folder');
  const value = { ...old, ...input };
  const name = v.text(value.name?.trim(), 'folder name', 200);
  check(!/[\/\\]/.test(name), 'INVALID_INPUT', 'A folder name cannot contain a slash');
  return { name, parentId: value.parentId == null ? null : v.uuid(value.parentId, 'parent folder id') };
}

function note(input, old, defaultTimezone) {
  v.object(input, old ? ['title', 'content', 'contentSchemaVersion', 'metadata', 'folderId'] : ['title', 'kind', 'content', 'contentSchemaVersion', 'metadata', 'dailyDate', 'timezone', 'folderId'], 'note');
  const value = { ...old, ...input };
  const kind = v.choice(value.kind ?? 'note', ['note', 'daily', 'meeting'], 'note kind');
  const dailyDate = kind === 'daily' ? v.date(value.dailyDate, 'dailyDate') : null;
  check(kind === 'daily' || value.dailyDate == null, 'INVALID_INPUT', 'Only daily notes have a dailyDate');
  return {
    kind, dailyDate,
    folderId: value.folderId == null ? null : v.uuid(value.folderId, 'folder id'),
    title: v.text(value.title ?? '', 'title', 500, true),
    timezone: v.timezone(value.timezone ?? defaultTimezone),
    ...documentContent(value.content ?? EMPTY_DOCUMENT, value.contentSchemaVersion ?? 1),
    metadata: v.json(value.metadata ?? {}),
  };
}

function recording(input, old, defaultTimezone) {
  v.object(input, old ? ['state', 'endedAt', 'transcriptionState', 'aiState', 'metadata', 'title'] : ['purpose', 'sourceMode', 'startedAt', 'timezone', 'keepAudio', 'calendarContext', 'consent', 'metadata', 'title'], 'recording');
  const value = { ...old, ...input };
  const state = value.state ?? 'preparing';
  if (old && state !== old.state) check(RECORDING_TRANSITIONS[old.state].includes(state), 'INVALID_TRANSITION', 'Invalid recording transition');
  const startedAt = v.instant(value.startedAt ?? new Date().toISOString(), 'startedAt');
  const endedAt = value.endedAt == null ? null : v.instant(value.endedAt, 'endedAt');
  check(!endedAt || endedAt >= startedAt, 'INVALID_INPUT', 'Recording ends before it starts');
  check(!['captured', 'interrupted', 'failed'].includes(state) || endedAt, 'INVALID_INPUT', 'A terminal recording needs an end time');
  return {
    // Empty means "not named": the app shows the purpose and time instead.
    title: v.text((value.title ?? '').trim(), 'recording name', 200, true),
    purpose: v.choice(value.purpose ?? 'conversation', ['conversation', 'personal', 'learning'], 'purpose'),
    sourceMode: v.choice(value.sourceMode ?? 'microphone', ['microphone', 'system', 'both'], 'sourceMode'),
    startedAt, endedAt, timezone: v.timezone(value.timezone ?? defaultTimezone), state,
    keepAudio: v.boolean(value.keepAudio ?? false, 'keepAudio'),
    transcriptionState: v.choice(value.transcriptionState ?? 'queued', ['queued', 'running', 'complete', 'failed', 'cancelled'], 'transcriptionState'),
    aiState: v.choice(value.aiState ?? 'queued', ['queued', 'running', 'complete', 'failed', 'cancelled'], 'aiState'),
    calendarContext: value.calendarContext == null ? null : v.json(value.calendarContext),
    consent: v.json(value.consent ?? {}), metadata: v.json(value.metadata ?? {}),
  };
}

function transcript(input, old) {
  v.object(input, old ? ['text', 'speakerId', 'confidence', 'provenance'] : ['recordingId', 'source', 'startMs', 'endMs', 'text', 'speakerId', 'confidence', 'provenance'], 'transcript');
  const value = { ...old, ...input };
  const startMs = v.integer(value.startMs, 'startMs');
  const endMs = v.integer(value.endMs, 'endMs', startMs);
  const text = v.text(value.text, 'transcript text', 100000);
  check(value.confidence == null || (typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1), 'INVALID_INPUT', 'Invalid confidence');
  return {
    recordingId: v.uuid(value.recordingId), source: v.choice(value.source, ['microphone', 'system', 'import'], 'source'),
    startMs, endMs, text, contentHash: v.hash(text),
    speakerId: value.speakerId == null ? null : v.uuid(value.speakerId),
    confidence: value.confidence ?? null, provenance: v.json(value.provenance ?? {}),
  };
}

function owner(value, actorId) {
  v.object(value, ['kind', 'id'], 'owner');
  const kind = v.choice(value.kind, ['self', 'person', 'unknown'], 'owner kind');
  if (kind === 'unknown') {
    check(value.id == null, 'INVALID_INPUT', 'Unknown owner cannot have an identity');
    return { kind, id: null };
  }
  if (kind === 'self') {
    check(value.id == null || value.id === actorId, 'SCOPE_MISMATCH', 'Self must refer to the local workspace actor');
    return { kind, id: actorId };
  }
  return { kind, id: v.uuid(value.id, 'person id') };
}

// Stored records have sorted keys, so owners are compared field by field.
function sameOwner(a, b) {
  return a.owner?.kind === b.owner?.kind && (a.owner?.id ?? null) === (b.owner?.id ?? null) &&
    (a.ownerLabel ?? null) === (b.ownerLabel ?? null);
}

// ownerSource records who set the owner: "auto" (speaker-based attribution of a
// suggestion) or "user". Automatic re-attribution may only change "auto" owners.
function action(input, old, actorId, timezone, origin = 'manual', attribution = false) {
  v.object(input, ['title', 'owner', 'ownerLabel', 'evidence', 'dueDate', 'dueAt', 'dueTimezone', 'priority', 'restatementOf'], 'action');
  const value = { ...old, ...input };
  const dueDate = value.dueDate == null ? null : v.date(value.dueDate, 'dueDate');
  const dueAt = value.dueAt == null ? null : v.instant(value.dueAt, 'dueAt');
  check(!(dueDate && dueAt), 'INVALID_INPUT', 'Use a date-only due date or an instant, not both');
  const evidence = value.evidence ?? [];
  check(Array.isArray(evidence) && evidence.length <= 100, 'INVALID_INPUT', 'Invalid action evidence');
  // segmentId names the source the quote was taken from: a transcript segment by
  // default, or a note when the commitment was written down rather than spoken.
  // The field keeps its name so stored actions need no migration.
  const normalizedEvidence = evidence.map((entry) => {
    v.object(entry, ['sourceKind', 'segmentId', 'revision', 'quote', 'startOffset', 'endOffset'], 'evidence');
    return {
      sourceKind: v.choice(entry.sourceKind ?? 'transcript', ['transcript', 'note'], 'evidence source'),
      segmentId: v.uuid(entry.segmentId), revision: v.integer(entry.revision, 'source revision', 1),
      quote: v.text(entry.quote, 'quote', 100000), startOffset: v.integer(entry.startOffset, 'startOffset'),
      endOffset: v.integer(entry.endOffset, 'endOffset', entry.startOffset + 1),
    };
  });
  if (origin !== 'manual' && !old) check(normalizedEvidence.length > 0, 'INVALID_INPUT', 'Proposals need source evidence');
  const normalizedOwner = owner(value.owner ?? { kind: origin === 'manual' ? 'self' : 'unknown' }, actorId);
  const ownerLabel = normalizedOwner.kind === 'person' ? v.text(value.ownerLabel ?? 'Someone else', 'owner label', 200) : null;
  const ownerChanged = !!old && !sameOwner(old, { owner: normalizedOwner, ownerLabel });
  const ownerSource = attribution
    ? 'auto'
    : ownerChanged
      ? 'user'
      : old?.ownerSource ?? (origin === 'manual' ? 'user' : 'auto');
  return {
    title: v.text(value.title, 'action title', 1000),
    owner: normalizedOwner,
    ownerLabel,
    ownerSource,
    evidence: normalizedEvidence, dueDate, dueAt,
    dueTimezone: dueDate || dueAt ? v.timezone(value.dueTimezone ?? timezone) : null,
    priority: v.choice(value.priority ?? 'medium', ['low', 'medium', 'high', 'urgent'], 'priority'),
    restatementOf: value.restatementOf == null ? null : v.uuid(value.restatementOf),
    status: old?.status ?? (origin === 'manual' ? 'accepted' : 'proposed'), origin: old?.origin ?? origin,
    acceptedAt: old?.acceptedAt ?? (origin === 'manual' && !old ? new Date().toISOString() : null),
    completedAt: old?.completedAt ?? null,
  };
}

// A detected speaker's identity: unknown, the account owner, or a named person.
function speakerIdentity(value, actorId) {
  v.object(value, ['kind', 'label'], 'speaker identity');
  const kind = v.choice(value.kind, ['unknown', 'self', 'person'], 'speaker identity');
  if (kind === 'self') return { kind, id: actorId, label: null };
  if (kind === 'unknown') return { kind, id: null, label: null };
  const label = v.text(value.label?.trim(), 'person name', 200);
  return { kind, id: null, label };
}

function refs(input) {
  check(Array.isArray(input) && input.length <= 1000, 'INVALID_INPUT', 'Invalid source references');
  return input.map((ref) => {
    v.object(ref, ['kind', 'id', 'revision', 'deleted'], 'source reference');
    return { kind: v.choice(ref.kind, ['note', 'recording', 'transcript', 'action'], 'source kind'), id: v.uuid(ref.id), revision: v.integer(ref.revision, 'source revision', 1), deleted: v.boolean(ref.deleted ?? false, 'source deleted') };
  });
}

function job(input) {
  v.object(input, ['type', 'inputRevisions', 'modelId', 'engineId', 'idempotencyKey', 'checkpoint'], 'job');
  const data = {
    type: v.choice(input.type, ['index.upsert', 'index.delete', 'transcribe', 'summarize', 'extract-actions', 'embed', 'rebuild-search'], 'job type'),
    inputRevisions: refs(input.inputRevisions ?? []),
    modelId: input.modelId == null ? null : v.text(input.modelId, 'modelId', 200),
    engineId: input.engineId == null ? null : v.text(input.engineId, 'engineId', 200),
    idempotencyKey: v.text(input.idempotencyKey, 'idempotencyKey', 500),
    state: 'queued', attempts: 0, error: null, checkpoint: v.json(input.checkpoint ?? {}),
  };
  return { ...data, requestHash: v.hash(v.stableJson(data)) };
}

module.exports = { sameOwner, speakerIdentity, folder, ENTITY_TABLES, ACTION_TRANSITIONS, preferences, note, recording, transcript, action, refs, job };
