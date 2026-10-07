'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createWorkspace, openWorkspace } = require('../../workspace');

const document = (text) => ({ type: 'doc', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] });
const mutation = (store, revision) => ({ workspaceId: store.identity.id, clientRequestId: randomUUID(), ...(revision === undefined ? {} : { expectedRevision: revision }) });
const scope = (store) => ({ workspaceId: store.identity.id });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focusbae-lf01-'));
  const directory = path.join(root, 'workspace');
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = await createWorkspace({ directory, name: 'Synthetic workspace', preferences: { timezone: 'Asia/Kolkata' } });
  stores.push(store);
  return { root, directory, store, reopen: async () => { const next = await openWorkspace({ directory }); stores.push(next); return next; } };
}

module.exports = { document, mutation, scope, fixture };
