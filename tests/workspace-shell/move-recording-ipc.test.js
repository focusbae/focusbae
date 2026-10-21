"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { registerWorkspaceIPC, DOCUMENT } = require("../../workspace/ipc");
const { LocalPolicy: Policy } = require("../../privacy/local-policy");

test("a finished recording moves to another workspace after confirmation, and only then", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-move-ipc-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const frame = { url: DOCUMENT };
  const contents = { mainFrame: frame, send: () => {} };
  const win = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map();
  let answer = 0;
  const prompts = [];
  const remove = registerWorkspaceIPC({
    catalog, getWindow: () => win, ready: async () => {}, privacy: { policy: new Policy() },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    dialog: { showMessageBox: async (_, options) => { prompts.push(options); return { response: answer }; } },
  });
  t.after(async () => { remove(); await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (name, input) => handlers.get(`workspace:${name}`)(event, input);

  const acme = catalog.active().id;
  const globex = (await catalog.create({ name: "Globex" })).id;
  await catalog.open({ workspaceId: acme });
  const store = catalog.store;
  const ctx = (revision) => ({ workspaceId: acme, clientRequestId: randomUUID(), ...(revision ? { expectedRevision: revision } : {}) });
  let recording = store.createRecording(ctx(), { purpose: "conversation", title: "Globex call" });
  for (const state of ["recording", "stopping"]) recording = store.updateRecording(ctx(recording.revision), recording.id, { state });
  recording = store.updateRecording(ctx(recording.revision), recording.id, { state: "captured", endedAt: new Date().toISOString(), transcriptionState: "complete" });

  const live = store.createRecording(ctx(), { purpose: "conversation" });
  const refused = await call("capture.move", { workspaceId: acme, id: live.id, targetWorkspaceId: globex });
  assert.deepEqual([refused.ok, refused.error.code, refused.error.message], [false, "MOVE_BLOCKED", "Stop the recording first."]);

  const cancelled = await call("capture.move", { workspaceId: acme, id: recording.id, targetWorkspaceId: globex });
  assert.equal(cancelled.value, false);
  assert.match(prompts.at(-1).message, /Move "Globex call" to Globex\?/);
  assert.ok(store._raw("recording", recording.id), "cancel keeps it here");

  answer = 1;
  const moved = await call("capture.move", { workspaceId: acme, id: recording.id, targetWorkspaceId: globex });
  assert.equal(moved.value, true);
  assert.equal(store._raw("recording", recording.id), undefined);
  await catalog.open({ workspaceId: globex });
  assert.equal(catalog.store.get({ workspaceId: globex }, "recording", recording.id).title, "Globex call");
});
