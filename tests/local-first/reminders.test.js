"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { randomUUID } = require("node:crypto");
const { fixture, mutation, scope } = require("./helpers.cjs");
const { due, snooze, ReminderService } = require("../../workspace/reminders");
const { openWorkspace } = require("../../workspace");
const { migrate } = require("../../workspace/migrations");
const { MIGRATIONS, APPLICATION_ID } = require("../../workspace/schema");

test("due reminders are local, timezone-aware, scoped and snoozable", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const overdue = store.createAction(mutation(store), {
    title: "Send yesterday's draft",
    dueDate: "2026-09-13",
  });
  const today = store.createAction(mutation(store), {
    title: "Review today's plan",
    dueDate: "2026-09-14",
  });
  store.createAction(mutation(store), {
    title: "Wait for Asha",
    owner: { kind: "person", id: randomUUID() },
    dueDate: "2026-09-13",
  });
  store.createAction(mutation(store), {
    title: "Future work",
    dueDate: "2026-09-15",
  });

  const now = new Date("2026-09-14T04:30:00.000Z");
  const result = due(store, workspaceId, now);
  assert.equal(result.overdue, 1);
  assert.equal(result.today, 1);
  assert.deepEqual(new Set(result.items.map((item) => item.id)), new Set([overdue.id, today.id]));

  snooze(store, mutation(store), today.id, "2099-01-01T00:00:00.000Z");
  assert.equal(due(store, workspaceId, now).items.find((item) => item.id === today.id).snoozedUntil, "2099-01-01T00:00:00.000Z");
  assert.throws(
    () => snooze(store, mutation(store), randomUUID(), "2099-01-01T00:00:00.000Z"),
    { code: "NOT_FOUND" },
  );
  assert.equal(store.get(scope(store), "action", overdue.id).revision, 1);
});

test("notification service requires opt-in and rate-limits each action by local day", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const action = store.createAction(mutation(store), {
    title: "Prepare the review",
    dueDate: "2026-09-14",
  });
  let current = new Date("2026-09-14T04:30:00.000Z");
  const sent = [];
  const catalog = {
    store,
    active: () => store.getWorkspace(scope(store)),
    serialize: async (operation) => operation(),
  };
  const service = new ReminderService({
    catalog,
    notify: async (notification) => sent.push(notification),
    now: () => current,
  });

  assert.deepEqual(await service.check(), []);
  store.updateWorkspace(mutation(store, 1), {
    preferences: { notificationsEnabled: true, reminderHour: 9 },
  });
  assert.equal((await service.check()).length, 1);
  assert.equal(sent.length, 1);
  assert.equal((await service.check()).length, 0);
  assert.equal(sent.length, 1);

  current = new Date("2026-09-15T04:30:00.000Z");
  assert.equal((await service.check()).length, 1);
  assert.equal(sent.length, 2);
  assert.equal(store.get(scope(store), "action", action.id).revision, 1);
});

test("schema-v1 workspaces migrate reminder state without changing old preferences", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-reminder-migration-"));
  const directory = path.join(root, "workspace");
  fs.mkdirSync(directory);
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const db = new Database(path.join(directory, "workspace.sqlite"));
  await migrate(db, path.join(directory, "backups"), [MIGRATIONS[0]]);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workspaces VALUES (1,?,?,?,?,1,?,?)").run(
    workspaceId,
    actorId,
    "Old workspace",
    JSON.stringify({
      timezone: "Asia/Kolkata",
      theme: "dark",
      defaultKeepAudio: false,
    }),
    now,
    now,
  );
  db.pragma(`application_id = ${APPLICATION_ID}`);
  db.close();
  fs.writeFileSync(
    path.join(directory, "workspace.json"),
    JSON.stringify({
      formatVersion: 1,
      workspaceId,
      localActorId: actorId,
      schemaVersion: 1,
    }),
  );
  const store = await openWorkspace({ directory });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  // The constant, not a literal: this asserts the migration ran, not which one is last.
  assert.equal(
    store.getWorkspace({ workspaceId }).schemaVersion,
    require("../../workspace/schema").SCHEMA_VERSION,
  );
  assert.equal(
    store.getWorkspace({ workspaceId }).preferences.notificationsEnabled,
    false,
  );
  assert.equal(
    store._db.prepare("SELECT count(*) AS count FROM action_reminders").get()
      .count,
    0,
  );
  // One backup taken before the upgrade, named for the version it ended on.
  assert.ok(
    fs
      .readdirSync(path.join(directory, "backups"))
      .some((name) =>
        name.startsWith(
          `schema-1-to-${require("../../workspace/schema").SCHEMA_VERSION}-`,
        ),
      ),
  );
});
