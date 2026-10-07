"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { LocalPolicy: Policy } = require("../../privacy/local-policy");
const {
  registerWorkspaceIPC,
  DOCUMENT,
  publicError,
} = require("../../workspace/ipc");
async function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-shell-unit-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"), options);
  await catalog.initialize();
  t.after(async () => {
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return catalog;
}
test("fresh account-free catalog and revision-acknowledged settings survive restart", async (t) => {
  const catalog = await fixture(t);
  const first = catalog.active();
  assert.equal(first.name, "My workspace");
  assert.equal(first.location, undefined);
  assert.equal(first.preferences.welcomeDismissed, false);
  catalog.update(
    {
      workspaceId: first.id,
      clientRequestId: randomUUID(),
      expectedRevision: first.revision,
    },
    { name: "Personal", preferences: { theme: "dark", welcomeDismissed: true } },
  );
  const second = await catalog.create({ name: "Work" });
  assert.equal(second.preferences.welcomeDismissed, false);
  assert.notEqual(second.localActorId, first.localActorId);
  await catalog.close();
  await catalog.initialize();
  assert.equal(catalog.active().id, second.id);
  await catalog.open({ workspaceId: first.id });
  assert.equal(catalog.active().name, "Personal");
  assert.equal(catalog.active().preferences.theme, "dark");
  assert.equal(catalog.active().preferences.welcomeDismissed, true);
});
test("workspace switching is blocked during capture and old scope cannot retarget", async (t) => {
  let busy = false;
  const catalog = await fixture(t, { busy: () => busy });
  const first = catalog.active();
  const second = await catalog.create({ name: "Second" });
  busy = true;
  await assert.rejects(catalog.open({ workspaceId: first.id }), {
    code: "WORKSPACE_BUSY",
  });
  await assert.rejects(catalog.create({ name: "Third" }), {
    code: "WORKSPACE_BUSY",
  });
  assert.equal(catalog.active().id, second.id);
  assert.throws(() => catalog.scoped(first.id), { code: "SCOPE_MISMATCH" });
  await assert.rejects(catalog.open({ workspaceId: randomUUID() }), {
    code: "WORKSPACE_BUSY",
  });
});
test("failed switch preserves active store; malformed catalog never creates replacement", async (t) => {
  const catalog = await fixture(t);
  const first = catalog.active();
  const second = await catalog.create({ name: "Second" });
  const entry = catalog.entries.find((item) => item.id === first.id);
  fs.renameSync(
    path.join(catalog.root, entry.directory),
    path.join(catalog.root, "held-original"),
  );
  await assert.rejects(catalog.open({ workspaceId: first.id }));
  assert.equal(catalog.active().id, second.id);
  await catalog.close();
  fs.writeFileSync(catalog.file, "{bad");
  await assert.rejects(catalog.initialize());
  assert.equal(fs.readFileSync(catalog.file, "utf8"), "{bad");
});
test("IPC rejects hostile sender, subframe, unknown fields, stale revision and cross-workspace reads", async (t) => {
  const catalog = await fixture(t);
  const frame = { url: DOCUMENT };
  const contents = { mainFrame: frame, send() {} };
  const win = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map();
  const policy = new Policy();
  const remove = registerWorkspaceIPC({
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      removeHandler: (name) => handlers.delete(name),
    },
    catalog,
    getWindow: () => win,
    ready: async () => {},
    privacy: { policy, setStrict: async (value) => policy.setStrict(value) },
  });
  t.after(remove);
  const call = (method, value, sender = event) =>
    handlers.get(`workspace:${method}`)(sender, value);
  assert.equal((await call("bootstrap")).ok, true);
  assert.equal(
    (await call("bootstrap", {}, {})).error.code,
    "PERMISSION_DENIED",
  );
  assert.equal(
    (await call("bootstrap", {}, { ...event, senderFrame: { url: DOCUMENT } }))
      .error.code,
    "PERMISSION_DENIED",
  );
  frame.url = "file:///tmp/hostile.html";
  assert.equal((await call("bootstrap")).error.code, "PERMISSION_DENIED");
  frame.url = DOCUMENT;
  assert.equal(
    (await call("bootstrap", { sql: "DROP TABLE notes" })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await call("workspace.create", { name: "No", directory: "/tmp/escape" }))
      .error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await call("notes.list", { workspaceId: randomUUID() })).error.code,
    "SCOPE_MISMATCH",
  );
  const first = catalog.active();
  assert.equal(
    (await call("notes.list", { workspaceId: first.id, limit: 1001 })).error
      .code,
    "INVALID_INPUT",
  );
  const context = {
    workspaceId: first.id,
    clientRequestId: randomUUID(),
    expectedRevision: first.revision,
  };
  assert.equal(
    (await call("workspace.update", { context, changes: { name: "Saved" } }))
      .ok,
    true,
  );
  assert.equal(
    (
      await call("workspace.update", {
        context: { ...context, clientRequestId: randomUUID() },
        changes: { name: "Stale" },
      })
    ).error.code,
    "REVISION_CONFLICT",
  );
  assert.equal(
    (await call("privacy.setStrict", { enabled: "yes" })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(catalog.active().name, "Saved");
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(policy.listenerCount("change"), 0);
});
test("queue preserves mutation order and close drains acknowledged work", async (t) => {
  const catalog = await fixture(t);
  const order = [];
  const first = catalog.serialize(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(1);
  });
  const second = catalog.serialize(() => {
    order.push(2);
  });
  assert.equal(catalog.pending, 2);
  await catalog.close();
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(catalog.pending, 0);
});
test("internal filesystem and database errors do not expose paths or SQL", () => {
  const result = publicError(
    Object.assign(new Error("/Users/private/token.enc.json SELECT secret"), {
      code: "SQLITE_CANTOPEN",
    }),
  );
  assert.equal(result.error.code, "UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /Users|SELECT|token/);
});
