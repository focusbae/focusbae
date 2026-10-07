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
test("notebook IPC scopes mutations and sources, bounds documents, and owns file selection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-notebook-ipc-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const frame = { url: DOCUMENT };
  const contents = { mainFrame: frame, send() {} };
  let win = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map();
  let picker;
  const remove = registerWorkspaceIPC({
    catalog,
    getWindow: () => win,
    ready: async () => {},
    privacy: { policy: new Policy() },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => handlers.delete(name),
    },
    dialog: { showOpenDialog: async () => picker() },
  });
  t.after(async () => {
    remove();
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = catalog.active().id;
  const context = (revision) => ({
    workspaceId,
    clientRequestId: randomUUID(),
    ...(revision ? { expectedRevision: revision } : {}),
  });
  const call = (name, input) => handlers.get(`workspace:${name}`)(event, input);
  const created = await call("notes.create", {
    context: context(),
    note: {
      title: "Local",
      content: { type: "doc", content: [{ type: "paragraph" }] },
    },
  });
  assert.equal(created.ok, true);
  const id = created.value.id;
  const changed = await call("notes.update", {
    context: context(1),
    id,
    changes: { pinned: true, title: "Revised" },
  });
  assert.equal(changed.value.revision, 2);
  assert.equal(
    (
      await call("notes.update", {
        context: context(1),
        id,
        changes: { title: "Stale" },
      })
    ).error.code,
    "REVISION_CONFLICT",
  );
  assert.equal(
    (
      await call("notes.update", {
        context: context(2),
        id,
        changes: { metadata: { path: "/tmp/escape" } },
      })
    ).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await call("notes.get", { workspaceId: randomUUID(), id })).error.code,
    "SCOPE_MISMATCH",
  );
  assert.equal(
    (await call("documents.import", { workspaceId, path: "/tmp/escape" })).error
      .code,
    "INVALID_INPUT",
  );
  assert.equal(
    (
      await call("documents.convert", {
        workspaceId,
        html: "a".repeat(3 * 1024 * 1024),
      })
    ).error.code,
    "INVALID_INPUT",
  );
  const store = catalog.store;
  const recording = store.createRecording(context(), {});
  const segment = store.createTranscript(context(), {
    recordingId: recording.id,
    source: "system",
    startMs: 60000,
    endMs: 61000,
    text: "Transcript shoreline",
  });
  const action = store.createAction(context(), { title: "Visit shoreline" });
  assert.equal(
    (await call("search.query", { workspaceId, query: "shoreline" })).value
      .length,
    2,
  );
  const source = (
    await call("search.source", {
      workspaceId,
      kind: "transcript",
      id: segment.id,
    })
  ).value;
  assert.equal(source.startMs, 60000);
  assert.equal(source.text, "Transcript shoreline");
  assert.equal(
    (
      await call("search.source", {
        workspaceId,
        kind: "action",
        id: action.id,
      })
    ).value.status,
    "accepted",
  );
  store.delete(context(recording.revision), "recording", recording.id);
  assert.equal(
    (
      await call("search.source", {
        workspaceId,
        kind: "transcript",
        id: segment.id,
      })
    ).error.code,
    "NOT_FOUND",
  );
  const file = path.join(root, "note.txt");
  fs.writeFileSync(file, "Native picker source");
  picker = () => ({ canceled: false, filePaths: [file] });
  assert.equal(
    (await call("documents.import", { workspaceId })).value.items.length,
    1,
  );
  picker = () => {
    win = null;
    return { canceled: false, filePaths: [file] };
  };
  assert.equal(
    (await call("documents.import", { workspaceId })).error.code,
    "PERMISSION_DENIED",
  );
});

test("link channels stay inside the workspace and bound the label they resolve", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-links-ipc-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const frame = { url: DOCUMENT };
  const contents = { mainFrame: frame, send() {} };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map();
  const remove = registerWorkspaceIPC({
    catalog,
    getWindow: () => ({ isDestroyed: () => false, webContents: contents }),
    ready: async () => {},
    privacy: { policy: new Policy() },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => handlers.delete(name),
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  });
  t.after(async () => {
    remove();
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = catalog.active().id;
  const call = (name, input) => handlers.get(`workspace:${name}`)(event, input);
  const paragraph = (text) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const target = (
    await call("notes.create", {
      context: { workspaceId, clientRequestId: randomUUID() },
      note: { title: "Pricing", content: paragraph("Numbers.") },
    })
  ).value;
  const source = (
    await call("notes.create", {
      context: { workspaceId, clientRequestId: randomUUID() },
      note: { title: "Call", content: paragraph("Send [[Pricing]] and [[Missing]].") },
    })
  ).value;
  const links = (await call("notes.links", { workspaceId, id: source.id })).value;
  assert.deepEqual(
    links.outgoing.map((link) => [link.label, link.resolved]),
    [["Missing", false], ["Pricing", true]],
  );
  assert.deepEqual(
    (await call("notes.links", { workspaceId, id: target.id })).value.backlinks.map(
      (link) => link.title,
    ),
    ["Call"],
  );
  assert.deepEqual((await call("notes.resolveLink", { workspaceId, label: "pricing " })).value, {
    kind: "note",
    id: target.id,
  });
  assert.equal(
    (await call("notes.resolveLink", { workspaceId, label: "Missing" })).value.id,
    null,
  );
  assert.equal(
    (await call("notes.resolveLink", { workspaceId, label: "a".repeat(201) })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await call("notes.resolveLink", { workspaceId: randomUUID(), label: "Pricing" })).error.code,
    "SCOPE_MISMATCH",
  );
  assert.deepEqual(
    (await call("notes.linkTargets", { workspaceId, query: "pric" })).value,
    [{ kind: "note", id: target.id, label: "Pricing" }],
  );
  assert.equal(
    (await call("notes.linkTargets", { workspaceId, limit: 1 })).value.length,
    1,
  );
  for (const bad of [
    { workspaceId, limit: 0 },
    { workspaceId, limit: 50 },
    { workspaceId, query: "a".repeat(201) },
    { workspaceId, unknown: true },
  ])
    assert.equal(
      (await call("notes.linkTargets", bad)).error.code,
      "INVALID_INPUT",
      JSON.stringify(bad),
    );
  assert.equal(
    (await call("notes.linkTargets", { workspaceId: randomUUID() })).error.code,
    "SCOPE_MISMATCH",
  );
  // Commitments written on a page, proposed through the same channel guards.
  const written = (
    await call("notes.create", {
      context: { workspaceId, clientRequestId: randomUUID() },
      note: {
        title: "Corridor chat",
        content: paragraph("Raghav will draft the budget by Friday."),
      },
    })
  ).value;
  const found = (await call("notes.findCommitments", { workspaceId, id: written.id })).value;
  assert.equal(found.proposed, 1);
  assert.equal(found.method, "local-rule", "no model wired in this test, so the rules stand in");
  const proposals = (await call("actions.browse", { workspaceId, view: "review" })).value;
  assert.equal(proposals.items.length, 1);
  assert.equal(proposals.items[0].status, "proposed");
  assert.equal(
    (await call("notes.findCommitments", { workspaceId, id: written.id })).value.proposed,
    0,
  );
  assert.equal(
    (await call("notes.findCommitments", { workspaceId, id: randomUUID() })).error.code,
    "NOT_FOUND",
  );
  assert.equal(
    (await call("notes.findCommitments", { workspaceId: randomUUID(), id: written.id })).error.code,
    "SCOPE_MISMATCH",
  );
  // Rewriting is refused outright when this Mac has no on-device model, rather
  // than falling back to something weaker on the user's own words.
  assert.equal(
    (await call("notes.rewrite", { workspaceId, style: "tidy", text: "Some writing." })).error
      .code,
    "REWRITE_UNAVAILABLE",
  );
  assert.equal(
    (await call("notes.rewrite", { workspaceId: randomUUID(), style: "tidy", text: "x" })).error
      .code,
    "SCOPE_MISMATCH",
  );
  assert.equal(
    (await call("notes.rewrite", { workspaceId, style: "tidy" })).error.code,
    "INVALID_INPUT",
  );
  const graph = (await call("notes.graph", { workspaceId })).value;
  assert.ok(
    graph.edges.some((edge) => edge.from === source.id && edge.to === target.id),
  );
  assert.equal(
    (await call("notes.graph", { workspaceId: randomUUID() })).error.code,
    "SCOPE_MISMATCH",
  );
});

