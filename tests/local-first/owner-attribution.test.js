"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation, scope } = require("./helpers.cjs");
const { resolveOwner, extractActions } = require("../../workspace/action-extraction");

const self = { role: "self", name: null };
const priya = { role: "other", name: "Priya" };
const anon = { role: "other", name: null };
const unknown = { role: "unknown", name: null };

test("owner resolution uses the known speaker, never the model's pronoun guess", () => {
  const r = (quote, speaker, modelOwner, modelPerson) => resolveOwner({ quote, speaker, modelOwner, modelPerson });
  // A named subject owns the work, whoever said it.
  assert.deepEqual(r("Raghav will own the migration script", self, "self"), { kind: "other", name: "Raghav" });
  assert.deepEqual(r("Priya is going to send the deck", priya), { kind: "other", name: "Priya", fromSpeaker: true });
  // First person belongs to the speaker.
  assert.deepEqual(r("I'll send the deck by Friday", self), { kind: "self", name: null });
  assert.deepEqual(r("I'm going to loop in Raghav", priya, "self"), { kind: "other", name: "Priya", fromSpeaker: true });
  assert.deepEqual(r("Leave that with me", anon), { kind: "other", name: null, fromSpeaker: true });
  assert.deepEqual(r("I'll book the venue", unknown, "other", "Someone"), { kind: "unknown", name: null });
  assert.deepEqual(r("We'll get the report over once legal signs off", self), { kind: "self", name: null });
  // Pronouns and generic words are not names.
  assert.deepEqual(r("We will ship on Friday", self), { kind: "self", name: null });
  assert.deepEqual(r("Someone will check the numbers", self, "unknown"), { kind: "unknown", name: null });
  // Without a first-person or named subject, the model decides, but "self" needs the owner as speaker.
  assert.deepEqual(r("Sure, will do", self, "self"), { kind: "self", name: null });
  assert.deepEqual(r("Sure, will do", priya, "self"), { kind: "unknown", name: null });
  assert.deepEqual(r("Handle the invoice by Monday", self, "other", " Tomas "), { kind: "other", name: "Tomas" });
  assert.deepEqual(r("Handle the invoice by Monday", self, "other", ""), { kind: "other", name: null });
});

test("speaker identity validation", async (t) => {
  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const speaker = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
  assert.deepEqual(speaker.identity, { kind: "unknown", id: null, label: null });
  const me = store.identifySpeaker(mutation(store, speaker.revision), speaker.id, { identity: { kind: "self" } });
  assert.deepEqual(me.identity, { kind: "self", id: store.identity.localActorId, label: null });
  assert.equal(me.label, "Speaker 1 · Microphone");
  assert.throws(() => store.identifySpeaker(mutation(store, me.revision), speaker.id, { identity: { kind: "person" } }), { code: "INVALID_INPUT" });
  assert.throws(() => store.identifySpeaker(mutation(store, me.revision), speaker.id, { identity: { kind: "person", label: "   " } }), { code: "INVALID_INPUT" });
  assert.throws(() => store.identifySpeaker(mutation(store, me.revision), speaker.id, { identity: { kind: "boss" } }), { code: "INVALID_INPUT" });
  assert.throws(() => store.identifySpeaker(mutation(store, speaker.revision), speaker.id, { identity: { kind: "unknown" } }), { code: "REVISION_CONFLICT" });
  const named = store.identifySpeaker(mutation(store, me.revision), speaker.id, { identity: { kind: "person", label: " Priya " } });
  assert.deepEqual(named.identity, { kind: "person", id: null, label: "Priya" });
});

async function meeting(t) {
  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const mic = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
  const other = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Mac audio" });
  const line = (speaker, startMs, text) =>
    store.createTranscript(mutation(store), {
      recordingId: recording.id, source: speaker === mic ? "microphone" : speaker ? "system" : "import",
      startMs, endMs: startMs + 1000, text, speakerId: speaker?.id ?? null,
    });
  line(mic, 0, "I will send the revised deck by Friday.");
  line(other, 2000, "I will review the contract terms tomorrow.");
  line(mic, 4000, "Raghav will own the migration script.");
  line(null, 6000, "I will book the venue.");
  const byQuote = () => Object.fromEntries(store.list(scope(store), "action").map((a) => [a.evidence[0].quote, a]));
  return { store, recording, mic, other, byQuote };
}

test("nobody is attributed to the account owner until a speaker is marked as them", async (t) => {
  const { store, recording, mic, other, byQuote } = await meeting(t);
  assert.equal((await extractActions(store, recording.id, null)).proposed, 4);
  for (const action of Object.values(byQuote())) {
    if (action.evidence[0].quote.startsWith("Raghav")) assert.equal(action.ownerLabel, "Raghav");
    else assert.equal(action.owner.kind, "unknown", action.evidence[0].quote);
    assert.equal(action.ownerSource, "auto");
  }

  store.identifySpeaker(mutation(store, mic.revision), mic.id, { identity: { kind: "self" } });
  const result = await extractActions(store, recording.id, null);
  assert.deepEqual({ proposed: result.proposed, attributed: result.attributed }, { proposed: 0, attributed: 2 });
  let actions = byQuote();
  assert.equal(actions["I will send the revised deck by Friday."].owner.kind, "self");
  const anonymous = actions["I will review the contract terms tomorrow."];
  assert.equal(anonymous.owner.kind, "person");
  assert.equal(anonymous.ownerLabel, "Speaker 1 · Mac audio");
  assert.equal(actions["I will book the venue."].owner.kind, "unknown", "unlabelled speech stays unknown");
  assert.equal(actions["Raghav will own the migration script."].ownerLabel, "Raghav");

  const current = store.get(scope(store), "speaker", other.id);
  store.identifySpeaker(mutation(store, current.revision), other.id, { identity: { kind: "person", label: "Priya" } });
  assert.equal((await extractActions(store, recording.id, null)).attributed, 1);
  actions = byQuote();
  assert.equal(actions["I will review the contract terms tomorrow."].ownerLabel, "Priya");
  // A rerun with nothing new changes nothing.
  assert.equal((await extractActions(store, recording.id, null)).attributed, 0);
});

test("people keep one id across recordings, and reviewed or edited owners are never overwritten", async (t) => {
  const { store, recording, mic, byQuote } = await meeting(t);
  await extractActions(store, recording.id, null);
  let actions = byQuote();
  const edited = actions["I will send the revised deck by Friday."];
  const accepted = actions["I will review the contract terms tomorrow."];
  const changed = store.updateAction(mutation(store, edited.revision), edited.id, {
    owner: { kind: "person", id: "0b8f3f53-7c2c-4d3e-9d1a-8a2b8e6a8e01" },
    ownerLabel: "Kavya",
  });
  assert.equal(changed.ownerSource, "user");
  // An edit that does not touch the owner keeps it automatic.
  const retitled = store.updateAction(mutation(store, actions["I will book the venue."].revision), actions["I will book the venue."].id, { title: "Book the venue" });
  assert.equal(retitled.ownerSource, "auto");
  store.transitionAction(mutation(store, accepted.revision), accepted.id, { status: "accepted" });

  store.identifySpeaker(mutation(store, mic.revision), mic.id, { identity: { kind: "self" } });
  await extractActions(store, recording.id, null);
  actions = byQuote();
  assert.equal(actions["I will send the revised deck by Friday."].ownerLabel, "Kavya");
  assert.equal(actions["I will review the contract terms tomorrow."].owner.kind, "unknown");
  assert.equal(actions["I will review the contract terms tomorrow."].status, "accepted");

  const second = store.createRecording(mutation(store), { purpose: "conversation" });
  store.createTranscript(mutation(store), {
    recordingId: second.id, source: "system", startMs: 0, endMs: 1000, text: "Raghav will send the budget.",
  });
  await extractActions(store, second.id, null);
  const ids = store.list(scope(store), "action").filter((a) => a.ownerLabel === "Raghav").map((a) => a.owner.id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("the model sees You and names once identified, and still cannot make others the owner", async (t) => {
  const { store, recording, mic, other } = await meeting(t);
  store.identifySpeaker(mutation(store, mic.revision), mic.id, { identity: { kind: "self" } });
  const current = store.get(scope(store), "speaker", other.id);
  store.identifySpeaker(mutation(store, current.revision), other.id, { identity: { kind: "person", label: "Priya" } });
  let request;
  const runtime = {
    extract: async (value) => {
      request = value;
      // A model that wrongly claims everything for the account owner.
      return value.segments.map((segment) => ({ segmentId: segment.id, quote: segment.text, owner: "self", person: "" }));
    },
  };
  await extractActions(store, recording.id, runtime);
  assert.equal(request.owner, "You");
  assert.deepEqual(request.segments.map((s) => s.speaker), ["You", "Priya", "You", null]);
  const owners = Object.fromEntries(store.list(scope(store), "action").map((a) => [a.evidence[0].quote, a.owner.kind === "person" ? a.ownerLabel : a.owner.kind]));
  assert.deepEqual(owners, {
    "I will send the revised deck by Friday": "self",
    "I will review the contract terms tomorrow": "Priya",
    "Raghav will own the migration script": "Raghav",
    "I will book the venue": "unknown",
  });
});

test("reruns recognise shifted quotes, keep deletions, and attribute what the model skipped", async (t) => {
  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const me = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Mac audio" });
  const them = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 2 · Mac audio" });
  const line = (speaker, startMs, text) =>
    store.createTranscript(mutation(store), { recordingId: recording.id, source: "system", startMs, endMs: startMs + 1000, text, speakerId: speaker.id });
  const promise = line(me, 0, "Sure, I'll send the deck by Friday.");
  const other = line(them, 2000, "Okay. Let me check the contract terms.");
  const dropped = line(them, 4000, "Then I'll book the room.");
  let answer = [
    { segmentId: promise.id, quote: "I'll send the deck by Friday", owner: "unknown", person: "" },
    { segmentId: other.id, quote: "Let me check the contract terms", owner: "unknown", person: "" },
    { segmentId: dropped.id, quote: "I'll book the room", owner: "unknown", person: "" },
  ];
  const runtime = { extract: async () => answer };
  assert.equal((await extractActions(store, recording.id, runtime)).proposed, 3);
  const titled = () => Object.fromEntries(store.list(scope(store), "action").map((a) => [a.title, a]));
  const room = titled()["I'll book the room"];
  store.delete(mutation(store, room.revision), "action", room.id);

  store.identifySpeaker(mutation(store, me.revision), me.id, { identity: { kind: "self" } });
  // The model now quotes wider spans, and skips the contract line entirely.
  answer = [
    { segmentId: promise.id, quote: "Sure, I'll send the deck by Friday", owner: "self", person: "" },
    { segmentId: dropped.id, quote: "Then I'll book the room", owner: "other", person: "" },
  ];
  const result = await extractActions(store, recording.id, runtime);
  assert.deepEqual({ proposed: result.proposed, attributed: result.attributed }, { proposed: 0, attributed: 2 });
  const actions = titled();
  assert.deepEqual(Object.keys(actions).sort(), ["I'll send the deck by Friday", "Let me check the contract terms"]);
  assert.equal(actions["I'll send the deck by Friday"].owner.kind, "self");
  assert.equal(actions["Let me check the contract terms"].ownerLabel, "Speaker 2 · Mac audio");
});
