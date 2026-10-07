"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation, scope } = require("./helpers.cjs");
const restatements = require("../../workspace/restatements");
const { extractActions } = require("../../workspace/action-extraction");
const actions = require("../../workspace/actions");

test("similarity counts the same promise with a moved deadline, not a different promise", () => {
  const score = (a, b) => restatements.similarity(a, b);
  // The commonest restatement: same work, new date.
  assert.equal(score("I will send the deck by Friday", "I will send the deck on Monday").score, 1);
  assert.equal(score("I will confirm the pilot group Wednesday", "I will confirm the pilot group next week").score, 1);
  assert.ok(score("Raghav will own the migration script", "Raghav will own the migration script this sprint").score >= 0.6);
  // Different commitments must stay separate.
  assert.ok(score("I will send the deck by Friday", "I will send the pricing sheet by Friday").shared < restatements.MIN_SHARED);
  assert.ok(score("I will book the venue", "I will cancel the venue").shared < restatements.MIN_SHARED);
  assert.ok(score("I will send the deck", "I will review the contract").score < restatements.MIN_SCORE);
  // Time words carry no weight at all.
  assert.deepEqual([...restatements.significantWords("I will send it by Friday next week")], ["send"]);
  assert.deepEqual(restatements.similarity("", "anything"), { score: 0, shared: 0 });
});

async function meeting(t, store, texts, { speakerName = null } = {}) {
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  let speakerId = null;
  if (speakerName !== null) {
    const speaker = store.createSpeaker(mutation(store), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
    store.identifySpeaker(mutation(store, speaker.revision), speaker.id, {
      identity: speakerName === "self" ? { kind: "self" } : { kind: "person", label: speakerName },
    });
    speakerId = speaker.id;
  }
  let at = 0;
  for (const text of texts)
    store.createTranscript(mutation(store), {
      recordingId: recording.id, source: "microphone", startMs: (at += 2000), endMs: at + 1000, text, speakerId,
    });
  const result = await extractActions(store, recording.id, null);
  return { recording, result };
}

test("promising the same thing again links to the first promise and counts it", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const first = await meeting(t, store, ["I will send the onboarding deck by Friday."], { speakerName: "self" });
  assert.equal(first.result.proposed, 1);
  assert.equal(first.result.restated, 0);
  const original = store.list(scope(store), "action")[0];
  assert.equal(original.restatementOf, null);

  const second = await meeting(t, store, ["I will send the onboarding deck on Monday."], { speakerName: "self" });
  assert.deepEqual({ proposed: second.result.proposed, restated: second.result.restated }, { proposed: 1, restated: 1 });
  const again = store.list(scope(store), "action").find((action) => action.id !== original.id);
  assert.equal(again.restatementOf, original.id);

  const third = await meeting(t, store, ["I will send the onboarding deck this week, promise."], { speakerName: "self" });
  assert.equal(third.result.restated, 1);
  const last = store.list(scope(store), "action").find((a) => ![original.id, again.id].includes(a.id));
  assert.equal(last.restatementOf, original.id, "every restatement points at the first promise");

  const chain = restatements.chain(store, workspaceId, last.id);
  assert.equal(chain.count, 3);
  assert.equal(chain.first, original.createdAt);
  assert.deepEqual(chain.items.map((item) => item.current), [false, false, true]);
  assert.equal(restatements.chain(store, workspaceId, original.id).count, 3, "the count is the same from either end");
  // Exposed to the UI through the action detail.
  assert.equal(actions.detail(store, workspaceId, last.id).restatements.count, 3);
  assert.equal(actions.detail(store, workspaceId, last.id).action.restatementOf, original.id);
});

test("a settled promise, a different owner, or the same conversation do not restate", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  await meeting(t, store, ["I will send the onboarding deck by Friday."], { speakerName: "self" });
  const original = store.list(scope(store), "action")[0];
  store.transitionAction(mutation(store, original.revision), original.id, { status: "accepted" });
  store.transitionAction(mutation(store, original.revision + 1), original.id, { status: "done" });

  // Promising it again after it was done is a new commitment, not a restatement.
  const after = await meeting(t, store, ["I will send the onboarding deck again next week."], { speakerName: "self" });
  assert.equal(after.result.restated, 0);
  assert.equal(store.list(scope(store), "action").find((a) => a.id !== original.id).restatementOf, null);

  // Someone else promising the same work is their own commitment.
  const theirs = await meeting(t, store, ["I will send the onboarding deck by Thursday."], { speakerName: "Priya" });
  assert.equal(theirs.result.restated, 0);

  // Said twice inside one conversation: still one commitment, no chain.
  const { store: other } = await fixture(t);
  const twice = await meeting(t, other, [
    "I will send the onboarding deck by Friday.",
    "Again, I will send the onboarding deck by Friday.",
  ], { speakerName: "self" });
  assert.equal(twice.result.restated, 0);
  assert.ok(other.list(scope(other), "action").every((action) => action.restatementOf === null));
});

test("deleting the first promise leaves later ones standing", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  await meeting(t, store, ["I will send the onboarding deck by Friday."], { speakerName: "self" });
  const original = store.list(scope(store), "action")[0];
  await meeting(t, store, ["I will send the onboarding deck on Monday."], { speakerName: "self" });
  const again = store.list(scope(store), "action").find((action) => action.id !== original.id);
  store.delete(mutation(store, original.revision), "action", original.id);

  // The deleted original is still the root of the chain, but is not counted.
  const chain = restatements.chain(store, workspaceId, again.id);
  assert.equal(chain.count, 1);
  assert.deepEqual(chain.items.map((item) => item.id), [again.id]);
  // A further promise attaches to the surviving one rather than the deleted root.
  const third = await meeting(t, store, ["I will send the onboarding deck tomorrow."], { speakerName: "self" });
  assert.equal(third.result.restated, 1);
  const last = store.list(scope(store), "action").find((a) => ![original.id, again.id].includes(a.id));
  assert.equal(last.restatementOf, again.id);
  assert.equal(restatements.chain(store, workspaceId, last.id).count, 2);
});
