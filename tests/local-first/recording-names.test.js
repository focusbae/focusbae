'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, mutation, scope } = require('./helpers.cjs');
const { detail: actionDetail } = require('../../workspace/actions');

function recorded(store) {
  const recording = store.createRecording(mutation(store), {});
  const segment = store.createTranscript(mutation(store), {
    recordingId: recording.id, source: 'system', startMs: 0, endMs: 4000,
    text: 'I will send the revised budget on Friday',
  });
  return { recording, segment };
}

test('a recording starts unnamed and keeps a name through later updates', async (t) => {
  const { store, reopen } = await fixture(t);
  const { recording } = recorded(store);
  assert.equal(recording.title, '', 'unnamed until someone names it');

  const named = store.updateRecording(mutation(store, recording.revision), recording.id, { title: '  Acme kickoff  ' });
  assert.equal(named.title, 'Acme kickoff', 'surrounding space is trimmed');

  // Transcription updates the same record in the background; the name must survive them.
  const later = store.updateRecording(mutation(store, named.revision), recording.id, { transcriptionState: 'running' });
  assert.equal(later.title, 'Acme kickoff');

  store.close();
  const next = await reopen();
  assert.equal(next.get(scope(next), 'recording', recording.id).title, 'Acme kickoff');

  const cleared = next.updateRecording(mutation(next, later.revision), recording.id, { title: '' });
  assert.equal(cleared.title, '', 'clearing the name returns to the default label');
  assert.throws(() => next.updateRecording(mutation(next, cleared.revision), recording.id, { title: 'x'.repeat(201) }),
    (error) => error.code === 'INVALID_INPUT');
});

test('searching a recording name finds what was said in it', async (t) => {
  const { store } = await fixture(t);
  const { recording, segment } = recorded(store);
  assert.equal(store.search(scope(store), 'Acme').length, 0);

  store.updateRecording(mutation(store, recording.revision), recording.id, { title: 'Acme kickoff' });
  const hits = store.search(scope(store), 'Acme');
  assert.deepEqual(hits.map((hit) => [hit.kind, hit.id, hit.title]), [['transcript', segment.id, 'Acme kickoff']]);
});

test('an action quoted from a named recording says which one', async (t) => {
  const { store } = await fixture(t);
  const { recording, segment } = recorded(store);
  const action = store.proposeAction(mutation(store), {
    title: 'Send the revised budget',
    evidence: [{ segmentId: segment.id, revision: segment.revision, quote: 'send the revised budget', startOffset: 7, endOffset: 30 }],
  });
  assert.equal(actionDetail(store, store.identity.id, action.id).evidence[0].recordingTitle, null);

  store.updateRecording(mutation(store, recording.revision), recording.id, { title: 'Budget call' });
  assert.equal(actionDetail(store, store.identity.id, action.id).evidence[0].recordingTitle, 'Budget call');
});
