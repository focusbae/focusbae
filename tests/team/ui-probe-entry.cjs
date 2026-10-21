"use strict";
// Test-only account identity. The team policy remains off, so no network traffic runs.
const { TeamAccount } = require('../../team/account');
TeamAccount.prototype.status = () => ({ connected: true, email: 'review@example.com', userId: '11111111-1111-4111-8111-111111111111' });
TeamAccount.prototype.select = async () => [{ role: 'admin', workspaces: { id: '55555555-5555-4555-8555-555555555555', name: 'Acme Studio' } }];
require('../workspace-shell/../../scripts/workspace-probe-entry.cjs');

global.workspaceProbe.seedTeam = () => {
      const { TeamState } = require('../../team/state');
      const { randomUUID } = require('node:crypto');
      const store = global.workspaceProbe.catalog.store;
      const workspaceId = store.identity.id;
      const state = TeamState.create(store._directory, { serverWorkspaceId: '55555555-5555-4555-8555-555555555555', accountUserId: '11111111-1111-4111-8111-111111111111', name: 'Acme Studio' });
      const privateId = '33333333-3333-4333-8333-333333333333';
      const engId = '44444444-4444-4444-8444-444444444444';
      state.applyPull({ cursor: 0, workspace: { name: 'Acme Studio', role: 'admin', processingLevelMax: 1 }, me: { personId: 'me' },
        spaces: [{ id: privateId, kind: 'private', name: 'My notes', role: 'editor' }, { id: engId, kind: 'custom', name: 'Engineering', role: 'editor' }],
        people: [], commitments: [], visibleCommitmentIds: [], notes: [], visibleNoteIds: [] });
      const folderTools = require('../../team/folders');
      folderTools.prepare(store, state);
      const root = state.rootForSpace(engId);
      const ctx = () => ({ workspaceId, clientRequestId: randomUUID() });
      const folder = store.createFolder(ctx(), { name: 'Client work', parentId: root });
      const note = store.createNote(ctx(), { title: 'Acme kickoff', folderId: folder.id,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Priya will share the revised plan on Thursday.' }] }] } });
      // A teammate's page, as team sync writes it.
      store._mirrorNote({ id: randomUUID(), title: 'Pricing decision', folderId: folder.id,
        team: { authorName: 'Priya', spaceName: 'Engineering', access: 'view' },
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We keep the annual discount at 20%.' }] }] } });
      store.createNote(ctx(), { title: 'Private thinking', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Only in My notes.' }] }] } });
      state.close();
      return { workspaceId, noteId: note.id, root, folder: folder.id };

};
global.workspaceProbe.seedManyFolders = () => {
  const { randomUUID } = require('node:crypto');
  const store = global.workspaceProbe.catalog.store;
  const root = store._folderRows(store.identity.id).find((folder) => folder.name === 'Engineering' && !folder.parentId);
  for (let index = 1; index <= 24; index++) store.createFolder({ workspaceId: store.identity.id, clientRequestId: randomUUID() }, { name: `Project ${index}`, parentId: root.id });
};
