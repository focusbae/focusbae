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

test("semantic IPC does not block saves and visibly falls back to lexical search", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-semantic-ipc-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const frame = { url: DOCUMENT };
  const contents = { mainFrame: frame, send: () => {} };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map();
  let release;
  const semantic = {
    status: async () => ({ available: true }),
    query: () => new Promise((resolve) => { release = resolve; }),
  };
  const remove = registerWorkspaceIPC({
    catalog,
    getWindow: () => ({ isDestroyed: () => false, webContents: contents }),
    ready: async () => {},
    privacy: { policy: new Policy() },
    semantic,
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => handlers.delete(name),
    },
    dialog: {},
  });
  t.after(async () => {
    remove();
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = catalog.active().id;
  const call = (name, input) => handlers.get(`workspace:${name}`)(event, input);
  catalog.store.createNote(
    { workspaceId, clientRequestId: randomUUID() },
    {
      title: "Infrastructure plan",
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "reduce costs" }] }],
      },
    },
  );

  const pending = call("search.hybrid", { workspaceId, query: "costs" });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const saved = await Promise.race([
    call("notes.create", {
      context: { workspaceId, clientRequestId: randomUUID() },
      note: { title: "Saved while indexing" },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("save queue blocked")), 250)),
  ]);
  assert.equal(saved.ok, true);
  release({ items: [], total: 0, mode: "hybrid", coverage: {} });
  assert.equal((await pending).ok, true);

  semantic.query = async () => {
    throw Object.assign(new Error("missing"), { code: "MODEL_MISSING" });
  };
  const fallback = await call("search.hybrid", { workspaceId, query: "costs" });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.value.mode, "lexical-fallback");
  assert.equal(fallback.value.items[0].title, "Infrastructure plan");
});
