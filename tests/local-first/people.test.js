"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation, scope } = require("./helpers.cjs");
const people = require("../../workspace/people");
const { extractActions } = require("../../workspace/action-extraction");

async function workspace(t) {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const me = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
  const priya = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Mac audio" });
  const anon = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 2 · Mac audio" });
  let at = 0;
  const line = (speaker, text) =>
    store.createTranscript(mutation(store), {
      recordingId: recording.id, source: speaker === me ? "microphone" : "system",
      startMs: (at += 2000), endMs: at + 1000, text, speakerId: speaker.id,
    });
  line(me, "I will send the pricing sheet by Friday.");
  line(priya, "I will review the contract tomorrow.");
  line(anon, "I will book the room.");
  line(me, "Raghav will draft the budget.");
  store.identifySpeaker(mutation(store, me.revision), me.id, { identity: { kind: "self" } });
  store.identifySpeaker(mutation(store, priya.revision), priya.id, { identity: { kind: "person", label: "Priya" } });
  await extractActions(store, recording.id, null);
  const byTitle = () => Object.fromEntries(store.list(scope(store), "action").map((a) => [a.title, a]));
  const accept = (title) => {
    const action = byTitle()[title];
    return store.transitionAction(mutation(store, action.revision), action.id, { status: "accepted" });
  };
  return { store, workspaceId, recording, byTitle, accept };
}

test("people list what each person owes you and what you owe them", async (t) => {
  const { store, workspaceId, accept } = await workspace(t);
  let listing = people.list(store, workspaceId);
  assert.deepEqual(listing.items.map((p) => p.name), ["Priya", "Raghav"], "unnamed speakers are not people");
  const priyaSummary = listing.items.find((p) => p.name === "Priya");
  assert.deepEqual(
    { theyOwe: priyaSummary.theyOwe, youOwe: priyaSummary.youOwe, review: priyaSummary.review, recordings: priyaSummary.recordings },
    { theyOwe: 0, youOwe: 0, review: 2, recordings: 1 },
    "suggestions are counted for review until accepted",
  );
  assert.equal(priyaSummary.id, people.personId("priya"));

  accept("I will review the contract tomorrow");
  accept("I will send the pricing sheet by Friday");
  const detail = people.get(store, workspaceId, priyaSummary.id);
  assert.deepEqual(detail.theyOwe.map((a) => a.title), ["I will review the contract tomorrow"]);
  assert.equal(detail.theyOwe[0].view, "waiting");
  assert.equal(detail.theyOwe[0].quote, "I will review the contract tomorrow.");
  assert.deepEqual(detail.youOwe.map((a) => a.title), ["I will send the pricing sheet by Friday"], "shared recording links your promise to Priya");
  assert.equal(detail.youOwe[0].view, "mine");
  assert.deepEqual({ theyOwe: detail.person.theyOwe, youOwe: detail.person.youOwe, review: detail.person.review }, { theyOwe: 1, youOwe: 1, review: 0 });

  const raghav = people.list(store, workspaceId).items.find((p) => p.name === "Raghav");
  assert.equal(raghav.review, 1);
  assert.throws(() => people.get(store, workspaceId, "00000000-0000-4000-8000-000000000000"), { code: "NOT_FOUND" });
  assert.throws(() => people.get(store, workspaceId, "not-a-uuid"), { code: "INVALID_INPUT" });
});

test("mentions link your own actions, names merge across spelling, and completion moves items", async (t) => {
  const { store, workspaceId, byTitle, accept } = await workspace(t);
  accept("I will send the pricing sheet by Friday");
  const manual = store.createAction(mutation(store), {
    title: "Share the roadmap with priya before the offsite",
    owner: { kind: "self", id: null },
    priority: "medium",
  });
  const other = store.createAction(mutation(store), {
    title: "Chase the logo files",
    owner: { kind: "person", id: "0b8f3f53-7c2c-4d3e-9d1a-8a2b8e6a8e01" },
    ownerLabel: "  PRIYA ",
    priority: "low",
  });
  store.createAction(mutation(store), { title: "Email Priyanka about invoices", owner: { kind: "self", id: null }, priority: "low" });
  let detail = people.get(store, workspaceId, people.personId("Priya"));
  assert.deepEqual(detail.youOwe.map((a) => a.title).sort(), [
    "I will send the pricing sheet by Friday",
    "Share the roadmap with priya before the offsite",
  ], "whole-word mentions only; Priyanka is someone else");
  assert.deepEqual(detail.theyOwe.map((a) => a.title), ["Chase the logo files"], "manually entered names merge with the same person");

  store.transitionAction(mutation(store, manual.revision), manual.id, { status: "done" });
  detail = people.get(store, workspaceId, people.personId("Priya"));
  assert.deepEqual(detail.done.map((a) => a.title), ["Share the roadmap with priya before the offsite"]);
  assert.equal(detail.done[0].view, "completed");
  assert.equal(detail.youOwe.length, 1);

  store.delete(mutation(store, store.get(scope(store), "action", other.id).revision), "action", other.id);
  assert.equal(people.get(store, workspaceId, people.personId("Priya")).theyOwe.length, 0);
  assert.ok(byTitle());
});

test("deleted recordings stop linking, but the named person stays while they own actions", async (t) => {
  const { store, workspaceId, recording, accept } = await workspace(t);
  accept("I will send the pricing sheet by Friday");
  accept("I will review the contract tomorrow");
  store.delete(mutation(store, store.get(scope(store), "recording", recording.id).revision), "recording", recording.id);
  const detail = people.get(store, workspaceId, people.personId("Priya"));
  assert.equal(detail.person.recordings, 0);
  assert.deepEqual(detail.theyOwe.map((a) => a.title), ["I will review the contract tomorrow"]);
  assert.deepEqual(detail.youOwe, []);
});

test("prior context answers what you already owed these people, excluding this conversation", async (t) => {
  const { store, workspaceId, recording, accept } = await workspace(t);
  accept("I will send the pricing sheet by Friday");
  accept("I will review the contract tomorrow");
  // Everything open so far came out of this recording, so there is no prior context.
  assert.deepEqual(people.priorContext(store, workspaceId, recording.id), { items: [] });

  // Older commitments, from elsewhere.
  const mine = store.createAction(mutation(store), {
    title: "Send Priya the signed order form",
    owner: { kind: "self", id: null },
    dueDate: "2026-09-30",
    priority: "medium",
  });
  store.createAction(mutation(store), {
    title: "Share the security review",
    owner: { kind: "person", id: people.personId("Priya") },
    ownerLabel: "Priya",
    priority: "high",
  });
  store.createAction(mutation(store), {
    title: "Book the offsite venue",
    owner: { kind: "person", id: people.personId("Raghav") },
    ownerLabel: "Raghav",
    priority: "low",
  });

  const context = people.priorContext(store, workspaceId, recording.id);
  assert.deepEqual(context.items.map((person) => person.name), ["Priya"], "only people named in this recording");
  const [priya] = context.items;
  assert.deepEqual({ theyOwe: priya.theyOwe, youOwe: priya.youOwe }, { theyOwe: 1, youOwe: 1 });
  assert.deepEqual(priya.items.map((item) => [item.title, item.direction, item.view]), [
    ["Send Priya the signed order form", "youOwe", "mine"],
    ["Share the security review", "theyOwe", "waiting"],
  ]);
  assert.equal(priya.id, people.personId("Priya"));

  // Completing them empties the context again.
  const current = store.get(scope(store), "action", mine.id);
  store.transitionAction(mutation(store, current.revision), mine.id, { status: "done" });
  const left = people.priorContext(store, workspaceId, recording.id).items[0];
  assert.deepEqual({ theyOwe: left.theyOwe, youOwe: left.youOwe }, { theyOwe: 1, youOwe: 0 });
  assert.throws(() => people.priorContext(store, workspaceId, "nope"), { code: "INVALID_INPUT" });
});
