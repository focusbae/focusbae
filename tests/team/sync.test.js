"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation } = require("../local-first/helpers.cjs");
const { TeamState } = require("../../team/state");
const sync = require("../../team/sync");
const { LocalPolicy } = require("../../privacy/local-policy");

const SERVER_WS = "11111111-1111-4111-8111-111111111111";

// An in-memory stand-in for the team service's database functions, enough to check
// what the Mac sends and how it applies what comes back.
class FakeServer {
  constructor() { this.rows = new Map(); this.seq = 0; this.calls = []; this.removed = false; this.forbidEdit = new Set(); }
  async rpc(name, args) {
    this.calls.push(name);
    const forbidden = () => Object.assign(new Error("not allowed"), { code: "FORBIDDEN" });
    if (this.removed) throw forbidden();
    if (name === "share_commitment") {
      if (this.forbidEdit.has(args.p_id)) throw forbidden();
      const old = this.rows.get(args.p_id);
      const row = { id: args.p_id, ...args.p_input, version: (old?.version ?? 0) + 1, seq: ++this.seq, deleted: false };
      this.rows.set(row.id, row);
      return { version: row.version };
    }
    if (name === "set_commitment_status") {
      const row = this.rows.get(args.p_id);
      Object.assign(row, { status: args.p_status, version: row.version + 1, seq: ++this.seq });
      return { version: row.version };
    }
    if (name === "unshare_commitment") {
      Object.assign(this.rows.get(args.p_id), { deleted: true, seq: ++this.seq });
      return null;
    }
    if (name === "pull_changes") {
      const live = [...this.rows.values()].filter((r) => !r.deleted);
      return {
        cursor: this.seq,
        workspace: { name: "Acme", role: "member", processingLevelMax: 1 },
        me: { personId: "me" },
        spaces: [{ id: "s1", kind: "everyone", name: "Acme", role: "editor" }],
        people: [{ id: "me", name: "Me", isMember: true }],
        commitments: live.filter((r) => r.seq > args.p_since).map((r) => ({ id: r.id, title: r.title, status: r.status, version: r.version })),
        visibleCommitmentIds: live.map((r) => r.id),
      };
    }
    throw new Error(`unexpected ${name}`);
  }
  // A teammate (or the web) changes status.
  teammateSets(id, status) {
    const row = this.rows.get(id);
    Object.assign(row, { status, version: row.version + 1, seq: ++this.seq });
  }
}

async function round(store, state, server) {
  const work = sync.plan(store, state);
  const result = await sync.exchange(server, state, work);
  return { work, outcome: sync.apply(store, state, result) };
}

async function setup(t) {
  const { store, directory } = await fixture(t);
  const state = TeamState.create(directory, { serverWorkspaceId: SERVER_WS, accountUserId: "u1", name: "Acme" });
  t.after(() => state.close());
  return { store, state, server: new FakeServer() };
}

const accepted = (store, title) => store.createAction(mutation(store), { title });

test("shares accepted actions once, and resends only after a change", async (t) => {
  const { store, state, server } = await setup(t);
  const action = accepted(store, "Send the deck");
  await round(store, state, server);
  await round(store, state, server);
  assert.deepEqual(server.calls.filter((c) => c === "share_commitment").length, 1);
  assert.equal(server.rows.get(action.id).owner.self, true);
  assert.equal(state.commitments().length, 1);
  store.updateAction(mutation(store, action.revision), action.id, { title: "Send the revised deck" });
  await round(store, state, server);
  assert.equal(server.rows.get(action.id).title, "Send the revised deck");
});

test("withdraws an action from the team when it is deleted here", async (t) => {
  const { store, state, server } = await setup(t);
  const action = accepted(store, "Book the venue");
  await round(store, state, server);
  store.delete(mutation(store, store.get({ workspaceId: store.identity.id }, "action", action.id).revision), "action", action.id);
  await round(store, state, server);
  assert.equal(server.rows.get(action.id).deleted, true);
  assert.equal(state.commitments().length, 0);
  assert.equal(state.sent(action.id), null);
});

test("applies a teammate's status change to this Mac's action, including done → deferred", async (t) => {
  const { store, state, server } = await setup(t);
  const action = accepted(store, "Write the migration");
  await round(store, state, server);
  server.teammateSets(action.id, "done");
  const { outcome } = await round(store, state, server);
  assert.equal(outcome.applied, 1);
  const ws = { workspaceId: store.identity.id };
  assert.equal(store.get(ws, "action", action.id).status, "done");
  server.teammateSets(action.id, "deferred");
  await round(store, state, server);
  assert.equal(store.get(ws, "action", action.id).status, "deferred");
  const before = server.calls.length;
  await round(store, state, server);
  assert.equal(server.calls.slice(before).includes("share_commitment"), false, "applying a remote change must not echo it back");
});

test("falls back to a status-only update when the team no longer lets this Mac edit", async (t) => {
  const { store, state, server } = await setup(t);
  const action = accepted(store, "Send Priya the spec");
  await round(store, state, server);
  server.forbidEdit.add(action.id);
  const ws = { workspaceId: store.identity.id };
  store.transitionAction(mutation(store, store.get(ws, "action", action.id).revision), action.id, { status: "done" });
  await round(store, state, server);
  assert.equal(server.rows.get(action.id).status, "done");
});

test("forgets the synced copy when removed from the workspace, keeping local work", async (t) => {
  const { store, state, server } = await setup(t);
  const action = accepted(store, "Prepare the report");
  await round(store, state, server);
  server.removed = true;
  const { outcome } = await round(store, state, server);
  assert.equal(outcome.removed, true);
  assert.equal(state.binding().status, "removed");
  assert.equal(state.commitments().length, 0);
  assert.equal(store.get({ workspaceId: store.identity.id }, "action", action.id).title, "Prepare the report");
});

test("the team purpose is off until an account is connected, and Strict Local blocks it", () => {
  const policy = new LocalPolicy();
  assert.equal(policy.allows("team"), false);
  assert.throws(() => policy.assert("team"), /Permission denied/);
  policy.setTeamConnected(true);
  assert.equal(policy.allows("team"), true);
  const ticket = policy.ticket();
  policy.setStrict(true);
  assert.equal(policy.allows("team"), false);
  assert.throws(() => policy.assert("team", ticket), /Permission denied/);
  policy.setStrict(false);
  assert.equal(policy.allows("team"), true, "the connection survives leaving Strict Local");
});
