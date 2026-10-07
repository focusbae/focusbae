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

test("action IPC provides scoped local CRUD, lifecycle views and source evidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-actions-ipc-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const frame = { url: DOCUMENT };
  const sent = [];
  const contents = {
    mainFrame: frame,
    send: (...args) => sent.push(args),
  };
  let win = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map();
  let confirmDelete = false;
  const remove = registerWorkspaceIPC({
    catalog,
    getWindow: () => win,
    ready: async () => {},
    privacy: { policy: new Policy() },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => handlers.delete(name),
    },
    dialog: {
      showMessageBox: async () => ({ response: confirmDelete ? 1 : 0 }),
    },
  });
  t.after(async () => {
    remove();
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = catalog.active().id;
  const context = (expectedRevision) => ({
    workspaceId,
    clientRequestId: randomUUID(),
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  const call = (name, input) => handlers.get(`workspace:${name}`)(event, input);

  const self = await call("actions.create", {
    context: context(),
    action: {
      title: "Prepare local pilot",
      owner: { kind: "self", id: null },
      ownerLabel: null,
      dueDate: "2026-09-20",
      priority: "high",
    },
  });
  assert.equal(self.ok, true);
  assert.equal(self.value.status, "accepted");
  assert.equal(self.value.owner.kind, "self");

  const personId = randomUUID();
  const changed = await call("actions.update", {
    context: context(1),
    id: self.value.id,
    changes: {
      title: "Prepare enterprise pilot",
      owner: { kind: "person", id: personId },
      ownerLabel: "Asha",
      dueDate: null,
      priority: "urgent",
    },
  });
  assert.equal(changed.value.ownerLabel, "Asha");
  assert.equal(changed.value.revision, 2);
  const waiting = await call("actions.browse", {
    workspaceId,
    view: "waiting",
    offset: 0,
    limit: 50,
  });
  assert.equal(waiting.value.total, 1);
  assert.equal(waiting.value.items[0].dueDate, null);
  assert.equal(waiting.value.counts.mine, 0);

  const deferred = await call("actions.transition", {
    context: context(2),
    id: self.value.id,
    status: "deferred",
  });
  assert.equal(deferred.value.status, "deferred");
  const done = await call("actions.transition", {
    context: context(3),
    id: self.value.id,
    status: "done",
  });
  assert.ok(done.value.completedAt);
  assert.equal(
    (
      await call("actions.transition", {
        context: context(4),
        id: self.value.id,
        status: "accepted",
      })
    ).error.code,
    "REOPEN_REQUIRED",
  );
  const reopened = await call("actions.transition", {
    context: context(4),
    id: self.value.id,
    status: "accepted",
    reopen: true,
  });
  assert.equal(reopened.value.completedAt, null);

  const store = catalog.store;
  const recording = store.createRecording(context(), {});
  const segment = store.createTranscript(context(), {
    recordingId: recording.id,
    source: "system",
    startMs: 62000,
    endMs: 65000,
    text: "Asha will send the security review Friday",
  });
  const quote = "Asha will send the security review Friday";
  const proposed = store.proposeAction(context(), {
    title: "Send the security review",
    evidence: [
      {
        segmentId: segment.id,
        revision: segment.revision,
        quote,
        startOffset: 0,
        endOffset: quote.length,
      },
    ],
  });
  const detail = await call("actions.get", {
    workspaceId,
    id: proposed.id,
  });
  assert.equal(detail.value.evidence[0].recordingId, recording.id);
  assert.equal(detail.value.evidence[0].segmentStartMs, 62000);
  assert.equal(detail.value.evidence[0].current, true);
  assert.equal(detail.value.evidence[0].available, true);
  assert.equal(detail.value.evidence[0].quote, quote);

  store.updateTranscript(context(1), segment.id, {
    text: "The security review changed",
  });
  assert.equal(
    (
      await call("actions.transition", {
        context: context(1),
        id: proposed.id,
        status: "accepted",
      })
    ).error.code,
    "STALE_SOURCE",
  );
  assert.equal(
    (await call("actions.browse", { workspaceId, view: "invalid" })).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (
      await call("actions.update", {
        context: context(reopened.value.revision),
        id: reopened.value.id,
        changes: { path: "/tmp/escape" },
      })
    ).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (
      await call("actions.update", {
        context: context(reopened.value.revision),
        id: reopened.value.id,
        changes: {},
      })
    ).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (
      await call("actions.get", {
        workspaceId: randomUUID(),
        id: proposed.id,
      })
    ).error.code,
    "SCOPE_MISMATCH",
  );

  const kept = await call("actions.delete", {
    context: context(proposed.revision),
    id: proposed.id,
  });
  assert.equal(kept.value.deleted, false);
  confirmDelete = true;
  const deleted = await call("actions.delete", {
    context: context(proposed.revision),
    id: proposed.id,
  });
  assert.equal(deleted.value.deleted, true);
  assert.equal(
    (await call("actions.get", { workspaceId, id: proposed.id })).error.code,
    "NOT_FOUND",
  );
  assert.equal(
    store.get({ workspaceId }, "recording", recording.id).id,
    recording.id,
  );
  assert.equal(
    store.get({ workspaceId }, "transcript", segment.id).id,
    segment.id,
  );
  assert.ok(
    sent.some(
      ([name, value]) =>
        name === "workspace:event" && value.type === "action.created",
    ),
  );

  win = null;
  assert.equal(
    (
      await handlers.get("workspace:actions.browse")(event, {
        workspaceId,
        view: "mine",
      })
    ).error.code,
    "PERMISSION_DENIED",
  );
});
