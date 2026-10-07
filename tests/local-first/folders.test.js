'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, mutation, scope, document } = require('./helpers.cjs');

const name = (store, folderName, parentId = null) =>
  store.createFolder(mutation(store), { name: folderName, parentId });

test('a folder holds notes, counts them, and reads back after a restart', async (t) => {
  const { store, reopen } = await fixture(t);
  const clients = name(store, 'Clients');
  const acme = name(store, 'Acme', clients.id);
  const loose = store.createNote(mutation(store), { title: 'Loose thought' });
  const filed = store.createNote(mutation(store), { title: 'Kickoff', folderId: acme.id, content: document('Agreed the scope') });

  const listing = store.folderList(scope(store));
  assert.deepEqual(listing.items.map((item) => item.path), ['Clients', 'Clients / Acme']);
  assert.equal(listing.items.find((item) => item.id === acme.id).notes, 1);
  assert.equal(listing.unfiled, 1, 'a note in no folder is still reachable');

  assert.deepEqual(
    store.notebookList(scope(store), { folderId: acme.id }).items.map((item) => item.title), ['Kickoff']);
  assert.deepEqual(
    store.notebookList(scope(store), { folderId: 'unfiled' }).items.map((item) => item.title), ['Loose thought']);
  assert.equal(store.notebookList(scope(store), {}).total, 2, 'the unfiltered list still shows everything');

  store.close();
  const next = await reopen();
  assert.equal(next.get(scope(next), 'note', filed.id).folderId, acme.id);
  assert.equal(next.folderList(scope(next)).items.length, 2);
});

test('moving a note changes only where it is filed', async (t) => {
  const { store } = await fixture(t);
  const drafts = name(store, 'Drafts');
  const note = store.createNote(mutation(store), { title: 'Pricing', content: document('Three tiers') });

  const moved = store.moveNote(mutation(store, note.revision), note.id, drafts.id);
  assert.equal(moved.folderId, drafts.id);
  assert.equal(moved.title, 'Pricing');
  assert.match(JSON.stringify(store.get(scope(store), 'note', note.id).content), /Three tiers/);

  const out = store.moveNote(mutation(store, moved.revision), note.id, null);
  assert.equal(out.folderId, null);
  assert.equal(store.folderList(scope(store)).unfiled, 1);

  assert.throws(() => store.moveNote(mutation(store, out.revision), note.id, '11111111-1111-4111-8111-111111111111'),
    (error) => error.code === 'NOT_FOUND', 'a note cannot be filed into a folder that does not exist');
});

test('deleting a folder keeps every note, moving its contents up to the parent', async (t) => {
  const { store } = await fixture(t);
  const clients = name(store, 'Clients');
  const acme = name(store, 'Acme', clients.id);
  const deep = name(store, 'Contracts', acme.id);
  const inside = store.createNote(mutation(store), { title: 'Renewal', folderId: acme.id });

  const result = store.deleteFolder(mutation(store, acme.revision), acme.id);
  assert.deepEqual({ notes: result.notes, folders: result.folders, movedTo: result.movedTo },
    { notes: 1, folders: 1, movedTo: clients.id });

  assert.equal(store.get(scope(store), 'note', inside.id).folderId, clients.id, 'the note survived its folder');
  const listing = store.folderList(scope(store));
  assert.deepEqual(listing.items.map((item) => item.path), ['Clients', 'Clients / Contracts']);
  assert.ok(!listing.items.some((item) => item.id === acme.id));

  // A top-level folder has no parent, so its notes become unfiled rather than lost.
  const top = store.folderList(scope(store)).items.find((item) => item.id === clients.id);
  store.deleteFolder(mutation(store, top.revision), clients.id);
  assert.equal(store.get(scope(store), 'note', inside.id).folderId, null);
  assert.equal(store.folderList(scope(store)).unfiled, 1);
});

test('renaming is free, but a folder cannot contain itself or repeat a sibling name', async (t) => {
  const { store } = await fixture(t);
  const clients = name(store, 'Clients');
  const acme = name(store, 'Acme', clients.id);
  const note = store.createNote(mutation(store), { title: 'Kickoff', folderId: acme.id });

  const renamed = store.updateFolder(mutation(store, clients.revision), clients.id, { name: 'Client work' });
  assert.equal(renamed.name, 'Client work');
  assert.equal(store.get(scope(store), 'note', note.id).folderId, acme.id, 'a rename does not touch the notes');
  assert.deepEqual(store.folderList(scope(store)).items.map((item) => item.path),
    ['Client work', 'Client work / Acme'], 'the path is derived, so children follow the rename');

  assert.throws(() => store.updateFolder(mutation(store, renamed.revision), clients.id, { parentId: clients.id }),
    (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => store.updateFolder(mutation(store, renamed.revision), clients.id, { parentId: acme.id }),
    (error) => error.code === 'INVALID_INPUT', 'a folder cannot move inside its own child');

  name(store, 'Archive');
  assert.throws(() => name(store, 'archive'),
    (error) => error.code === 'ALREADY_EXISTS', 'sibling names differing only in case collide');
  name(store, 'Archive', acme.id); // the same name under a different parent is fine
});

test('folder names are trimmed, slash-free, and nesting is bounded', async (t) => {
  const { store } = await fixture(t);
  assert.equal(name(store, '  Spaced  ').name, 'Spaced');
  for (const bad of ['', '   ', 'a/b', 'a\\b', 'x'.repeat(201)])
    assert.throws(() => name(store, bad), (error) => error.code === 'INVALID_INPUT', `rejected: ${JSON.stringify(bad)}`);

  let parent = null;
  for (let depth = 0; depth < 8; depth += 1) parent = name(store, `Level ${depth}`, parent?.id ?? null);
  assert.throws(() => name(store, 'Too deep', parent.id),
    (error) => error.code === 'LIMIT_REACHED', 'nesting stops at a depth a person can still read');
});
