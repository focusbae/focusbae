"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation } = require("../local-first/helpers.cjs");
const { TeamState } = require("../../team/state");
const sync = require("../../team/sync");
const { LocalPolicy } = require("../../privacy/local-policy");

const SERVER_WS = "11111111-1111-4111-8111-111111111111";
// My notes, everyone, a team this person is in, and one they can only read.
const SPACES = [
  { id: "s0", kind: "private", name: "My notes", role: "editor" },
  { id: "s1", kind: "everyone", name: "Acme", role: "editor" },
  { id: "s2", kind: "custom", name: "Sales", role: "editor" },
  { id: "s3", kind: "custom", name: "Board", role: "viewer" },
];

// An in-memory stand-in for the team service's database functions, enough to check
// what the Mac sends and how it applies what comes back.
class FakeServer {
  constructor() { this.rows = new Map(); this.seq = 0; this.calls = []; this.removed = false; this.forbidEdit = new Set(); this.me = "me"; this.people = [{ id: "me", name: "Me", isMember: true }]; }
  async rpc(name, args) {
    this.calls.push(name);
    const forbidden = () => Object.assign(new Error("not allowed"), { code: "FORBIDDEN" });
    if (this.removed) throw forbidden();
    if (name === "share_commitment") {
      if (this.forbidEdit.has(args.p_id)) throw forbidden();
      const old = this.rows.get(args.p_id);
      if (old && args.p_version != null && args.p_version !== old.version)
        throw Object.assign(new Error("changed elsewhere"), { code: "VERSION_CONFLICT" });
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
        me: { personId: this.me },
        spaces: SPACES,
        people: this.people,
        commitments: live.filter((r) => r.seq > args.p_since).map((r) => ({ id: r.id, title: r.title, status: r.status, version: r.version,
          space_id: r.spaceId, owner_person_id: this.personOf(r.owner), rights: "edit" })),
        visibleCommitmentIds: live.map((r) => r.id),
      };
    }
    throw new Error(`unexpected ${name}`);
  }
  personOf(owner) {
    if (!owner) return null;
    if (owner.self) return this.me;
    return owner.personId ?? this.people.find((p) => p.name.toLowerCase() === owner.name?.toLowerCase())?.id ?? null;
  }
  // A teammate shares their own copy from their Mac.
  teammateShares(title, ownerPersonId) {
    const id = require("node:crypto").randomUUID();
    this.rows.set(id, { id, title, status: "accepted", owner: { personId: ownerPersonId }, spaceId: "s1", version: 1, seq: ++this.seq, deleted: false });
    return id;
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
  const server = new FakeServer();
  // The first pull says which space is My notes; nothing is shared before it.
  await round(store, state, server);
  return { store, state, server };
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

test("a stale copy never overwrites a teammate's change made before this Mac pulled", async (t) => {
  const { store, state, server } = await setup(t);
  const action = accepted(store, "Draft the proposal");
  await round(store, state, server);
  server.teammateSets(action.id, "done");
  // The Mac edits the title before it has pulled the teammate's change.
  const ws = { workspaceId: store.identity.id };
  store.updateAction(mutation(store, store.get(ws, "action", action.id).revision), action.id, { title: "Draft the client proposal" });
  await round(store, state, server);
  assert.equal(server.rows.get(action.id).status, "done", "the teammate's status survives");
  assert.equal(store.get(ws, "action", action.id).status, "done", "and reaches this Mac");
  await round(store, state, server);
  assert.equal(server.rows.get(action.id).title, "Draft the client proposal", "the title edit lands on the next round");
  assert.equal(server.rows.get(action.id).status, "done");
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

// A recorded call between this Mac's person and Priya, with one promise each way.
async function callWithPriya(store) {
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const mic = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
  const other = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Mac audio" });
  store.identifySpeaker(mutation(store, mic.revision), mic.id, { identity: { kind: "self" } });
  store.identifySpeaker(mutation(store, other.revision), other.id, { identity: { kind: "person", label: "Priya" } });
  const line = (speaker, startMs, text) => store.createTranscript(mutation(store), {
    recordingId: recording.id, source: speaker === mic ? "microphone" : "system", startMs, endMs: startMs + 1000, text, speakerId: speaker.id,
  });
  const mine = line(mic, 0, "I will send the revised deck by Friday.");
  const hers = line(other, 2000, "I will review the contract terms tomorrow.");
  const propose = (segment, owner, ownerLabel) => store.proposeAction(mutation(store), {
    title: segment.text.replace(/\.$/, ""), owner, ownerLabel,
    evidence: [{ segmentId: segment.id, revision: segment.revision, quote: segment.text, startOffset: 0, endOffset: segment.text.length }],
  });
  return {
    recording,
    mine: propose(mine, { kind: "self" }, null),
    hers: propose(hers, { kind: "person", id: "22222222-2222-4222-8222-222222222222" }, "Priya"),
  };
}

function teamDirectory(state, server = null) {
  const people = [{ id: "p-me", name: "Me", isMember: true }, { id: "p-priya", name: "priya", isMember: true }, { id: "p-raghav", name: "Raghav", isMember: true }];
  if (server) { server.people = people; server.me = "p-me"; }
  state.applyPull({
    cursor: 0, workspace: { name: "Acme", role: "member", processingLevelMax: 1 }, me: { personId: "p-me" },
    spaces: SPACES, commitments: [], visibleCommitmentIds: [], people,
  });
}

test("in a call with one other person, a promise is owed to them, and theirs is owed to you", async (t) => {
  const { store, state } = await setup(t);
  teamDirectory(state);
  const { mine, hers } = await callWithPriya(store);
  const ws = store.identity.id;
  assert.deepEqual(sync.payloadFor(store, ws, mine, state).owner, { self: true });
  assert.deepEqual(sync.payloadFor(store, ws, mine, state).counterparty, { personId: "p-priya" });
  assert.deepEqual(sync.payloadFor(store, ws, hers, state).owner, { personId: "p-priya" }, "names match the directory case-insensitively");
  assert.deepEqual(sync.payloadFor(store, ws, hers, state).counterparty, { personId: "p-me" });
  assert.equal(sync.payloadFor(store, ws, mine, state).quote, "I will send the revised deck by Friday.");
  assert.equal(sync.payloadFor(store, ws, mine, state).sourceTitle, "Conversation");
});

test("an explicit choice on this Mac wins, including choosing nobody, and is resent", async (t) => {
  const { store, state, server } = await setup(t);
  teamDirectory(state, server);
  const { mine } = await callWithPriya(store);
  const ws = { workspaceId: store.identity.id };
  store.transitionAction(mutation(store, mine.revision), mine.id, { status: "accepted" });
  await round(store, state, server);
  assert.deepEqual(server.rows.get(mine.id).counterparty, { personId: "p-priya" });
  state.setMapping(mine.id, { ownerPersonId: null, counterpartyPersonId: "p-raghav" });
  await round(store, state, server);
  assert.deepEqual(server.rows.get(mine.id).counterparty, { personId: "p-raghav" });
  state.setMapping(mine.id, { ownerPersonId: null, counterpartyPersonId: null });
  await round(store, state, server);
  assert.equal(server.rows.get(mine.id).counterparty, null);
  assert.throws(() => state.setMapping(mine.id, { ownerPersonId: "nobody", counterpartyPersonId: null }), /Unknown person/);
  assert.equal(store.get(ws, "action", mine.id).status, "accepted");
});

test("suggestions stay unshared until accepted", async (t) => {
  const { store, state, server } = await setup(t);
  teamDirectory(state);
  await callWithPriya(store);
  await round(store, state, server);
  assert.equal(server.calls.includes("share_commitment"), false);
});

test("nothing is shared before the first pull says which space is My notes", async (t) => {
  const { store, directory } = await fixture(t);
  const state = TeamState.create(directory, { serverWorkspaceId: SERVER_WS, accountUserId: "u1", name: "Acme" });
  t.after(() => state.close());
  accepted(store, "Send the deck");
  assert.equal(sync.plan(store, state).shares.length, 0);
});

test("action items go where their recording is shared: Only me keeps them in My notes", async (t) => {
  const { store, state, server } = await setup(t);
  teamDirectory(state, server);
  const { recording, mine } = await callWithPriya(store);
  const ws = { workspaceId: store.identity.id };
  store.transitionAction(mutation(store, mine.revision), mine.id, { status: "accepted" });
  await round(store, state, server);
  assert.equal(server.rows.get(mine.id).spaceId, "s0", "a recording shared with nobody keeps its items in My notes");
  const shareWith = (teamSpaceId) => {
    const current = store.get(ws, "recording", recording.id);
    store.updateRecording(mutation(store, current.revision), recording.id, { metadata: { ...current.metadata, teamSpaceId } });
  };
  shareWith("s2");
  await round(store, state, server);
  assert.equal(server.rows.get(mine.id).spaceId, "s2", "sharing the recording with Sales moves its item there");
  shareWith("s3");
  await round(store, state, server);
  assert.equal(server.rows.get(mine.id).spaceId, "s0", "a team this person can only read falls back to My notes");
  const manual = accepted(store, "Book the venue");
  await round(store, state, server);
  assert.equal(server.rows.get(manual.id).spaceId, "s0", "a typed action has no source and stays in My notes");
});

test("an action a teammate already shared waits for a decision instead of being shared twice", async (t) => {
  const { store, state, server } = await setup(t);
  teamDirectory(state, server);
  const theirs = server.teammateShares("Send the revised deck by Monday", "p-me");
  await round(store, state, server);
  const { mine } = await callWithPriya(store);
  store.transitionAction(mutation(store, mine.revision), mine.id, { status: "accepted" });
  await round(store, state, server);
  assert.equal(server.rows.has(mine.id), false, "held back");
  assert.deepEqual(state.duplicate(mine.id), { commitmentId: theirs, decision: "pending", sentStatus: null });
  state.setDuplicate(mine.id, theirs, "both");
  await round(store, state, server);
  assert.equal(server.rows.has(mine.id), true, "shared once the person chooses to share it too");
});

test("a linked action keeps its status in step with the teammate's copy, both ways", async (t) => {
  const { store, state, server } = await setup(t);
  teamDirectory(state, server);
  const theirs = server.teammateShares("Send the revised deck by Monday", "p-me");
  await round(store, state, server);
  const { mine } = await callWithPriya(store);
  const ws = { workspaceId: store.identity.id };
  store.transitionAction(mutation(store, mine.revision), mine.id, { status: "accepted" });
  await round(store, state, server);
  state.setDuplicate(mine.id, theirs, "theirs", "accepted");
  store.transitionAction(mutation(store, store.get(ws, "action", mine.id).revision), mine.id, { status: "done" });
  await round(store, state, server);
  assert.equal(server.rows.has(mine.id), false, "never shared as a second copy");
  assert.equal(server.rows.get(theirs).status, "done", "done here marks theirs done");
  server.teammateSets(theirs, "deferred");
  await round(store, state, server);
  assert.equal(store.get(ws, "action", mine.id).status, "deferred", "their change reaches the linked action");
  const before = server.calls.filter((c) => c === "set_commitment_status").length;
  await round(store, state, server);
  assert.equal(server.calls.filter((c) => c === "set_commitment_status").length, before, "following theirs is not echoed back");
});

test("a different owner or different words is not a duplicate", async (t) => {
  const { store, state, server } = await setup(t);
  teamDirectory(state, server);
  server.teammateShares("Send the revised deck by Monday", "p-raghav");
  server.teammateShares("Review the hiring plan", "p-me");
  await round(store, state, server);
  const { mine } = await callWithPriya(store);
  store.transitionAction(mutation(store, mine.revision), mine.id, { status: "accepted" });
  await round(store, state, server);
  assert.equal(server.rows.has(mine.id), true);
  assert.equal(state.duplicate(mine.id), null);
});
