"use strict";
// Commitments written on a page rather than spoken in a meeting. The same rules
// apply: grounded in the page's own words, proposed and never accepted, and the
// page itself is never rewritten.
const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation, scope } = require("./helpers.cjs");
const {
  extractNoteActions,
  extractNoteActionsLocal,
  pieces,
} = require("../../workspace/note-extraction");
const actions = require("../../workspace/actions");
const people = require("../../workspace/people");
const graph = require("../../workspace/graph");

const page = (text) => ({
  type: "doc",
  content: text
    .split("\n")
    .map((line) => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })),
});
const write = (store, title, text) =>
  store.createNote(mutation(store), { title, content: page(text) });
const listActions = (store) =>
  store.list(scope(store), "action").sort((a, b) => a.title.localeCompare(b.title));

test("a page you typed proposes the commitments on it, owned the way it reads", async (t) => {
  const { store } = await fixture(t);
  const note = write(
    store,
    "Call with Priya",
    [
      "Priya will send the signed contract on Monday.",
      "I will send her the pricing sheet tomorrow.",
      "Thanks so much for your time.",
      "The market will grow next year.",
    ].join("\n"),
  );
  const result = extractNoteActionsLocal(store, note.id);
  // Three, not two: the sentence rules cannot tell "the market will grow" from a
  // promise, and over-propose on the Macs that have no on-device model. The model
  // path drops it — see the grounding test below. Both only ever propose.
  assert.equal(result.proposed, 3);
  const [pricing, contract] = listActions(store);
  assert.equal(contract.title, "Priya will send the signed contract on Monday");
  assert.equal(contract.owner.kind, "person");
  assert.equal(contract.ownerLabel, "Priya");
  // First person on a page you wrote is you — unlike a transcript, where it is
  // whoever was speaking.
  assert.equal(pricing.title, "I will send her the pricing sheet tomorrow");
  assert.equal(pricing.owner.kind, "self");
  for (const action of [pricing, contract]) {
    assert.equal(action.status, "proposed", "nothing is accepted on your behalf");
    assert.equal(action.evidence[0].sourceKind, "note");
    assert.equal(action.evidence[0].segmentId, note.id);
    assert.equal(
      note.plainText.slice(action.evidence[0].startOffset, action.evidence[0].endOffset),
      action.evidence[0].quote,
      "the quote is where the evidence says it is",
    );
  }
  // Courtesy is never a promise, on either path.
  assert.equal(
    listActions(store).some((action) => /Thanks/.test(action.title)),
    false,
  );
  // The page is untouched.
  assert.deepEqual(store.get(scope(store), "note", note.id).content, note.content);
  assert.equal(store.get(scope(store), "note", note.id).revision, note.revision);
});

test("reading a page twice does not propose the same sentence twice, or undo a rejection", async (t) => {
  const { store } = await fixture(t);
  const note = write(store, "Standup", "I will update the deck before Thursday.");
  assert.equal(extractNoteActionsLocal(store, note.id).proposed, 1);
  assert.equal(
    extractNoteActionsLocal(store, note.id).proposed,
    0,
    "the same words do not come back",
  );
  const [action] = listActions(store);
  store.delete(mutation(store, action.revision), "action", action.id);
  assert.equal(
    extractNoteActionsLocal(store, note.id).proposed,
    0,
    "a proposal you rejected is not resurrected by reading the page again",
  );
  // Editing the page around it still does not duplicate the untouched sentence.
  const edited = store.updateNote(mutation(store, note.revision), note.id, {
    content: page("Some new context.\nI will update the deck before Thursday."),
  });
  const after = extractNoteActionsLocal(store, edited.id);
  assert.equal(after.proposed, 0);
  assert.equal(after.read, 1);
});

test("a commitment written on a page reaches People, Actions and the graph", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const note = write(store, "Corridor chat", "Raghav will draft the budget by Friday.");
  extractNoteActionsLocal(store, note.id);
  const [action] = listActions(store);
  const detail = actions.detail(store, workspaceId, action.id);
  assert.equal(detail.evidence[0].available, true);
  assert.equal(detail.evidence[0].current, true);
  assert.equal(detail.evidence[0].noteId, note.id);
  assert.equal(detail.evidence[0].noteTitle, "Corridor chat");
  assert.equal(detail.evidence[0].recordingId, null);
  const person = people.list(store, workspaceId).items.find((item) => item.name === "Raghav");
  assert.ok(person, "a promise written down still makes a person");
  assert.equal(person.review, 1, "it waits for you to accept it");
  const accepted = store.transitionAction(mutation(store, action.revision), action.id, {
    status: "accepted",
  });
  assert.equal(
    people.list(store, workspaceId).items.find((item) => item.name === "Raghav").theyOwe,
    1,
  );
  // The graph shows where it came from.
  const drawn = graph.build(store, workspaceId);
  assert.ok(
    drawn.edges.some((edge) => edge.from === note.id && edge.to === accepted.id),
    "the page that proposed it is joined to it",
  );
});

test("evidence follows the page it was quoted from", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const note = write(store, "Notes", "I will book the room tomorrow.");
  extractNoteActionsLocal(store, note.id);
  const [action] = listActions(store);
  assert.equal(store.get(scope(store), "action", action.id).sourceState, "current");
  const edited = store.updateNote(mutation(store, note.revision), note.id, {
    content: page("I will book the big room tomorrow."),
  });
  assert.equal(
    store.get(scope(store), "action", action.id).sourceState,
    "stale",
    "editing the page marks what was quoted from it as stale",
  );
  const trashed = store.delete(mutation(store, edited.revision), "note", note.id);
  assert.equal(store.get(scope(store), "action", action.id).sourceState, "deleted");
  assert.equal(
    actions.detail(store, workspaceId, action.id).evidence[0].available,
    false,
  );
  store.restore(mutation(store, trashed.revision), "note", note.id);
  assert.equal(store.get(scope(store), "action", action.id).sourceState, "stale");
});

test("the model path grounds every quote in the page before proposing it", async (t) => {
  const { store } = await fixture(t);
  const note = write(
    store,
    "Vendor",
    [
      "Priya will send the signed contract on Monday.",
      "I owe her the pricing sheet.",
      "The market will grow next year.",
    ].join("\n"),
  );
  const asked = [];
  const runtime = {
    extract: async (request) => {
      asked.push(request);
      // What Apple's model actually returns: promises only, no predictions.
      return [
        { segmentId: request.segments[0].id, quote: "will send the signed contract on Monday", owner: "other", person: "Priya" },
        { segmentId: request.segments[1].id, quote: "I owe her the pricing sheet", owner: "self", person: "" },
        { segmentId: request.segments[1].id, quote: "a sentence the model invented", owner: "self", person: "" },
        { segmentId: "p99", quote: "I owe her the pricing sheet", owner: "self", person: "" },
      ];
    },
  };
  const result = await extractNoteActions(store, note.id, runtime);
  assert.equal(result.method, "local-model");
  assert.equal(result.proposed, 2, "invented quotes and unknown pieces are dropped");
  assert.equal(
    listActions(store).some((action) => /market/.test(action.title)),
    false,
    "a prediction the model did not return is not proposed by the model path",
  );
  assert.equal(asked[0].owner, "You", "the page's author is the account owner");
  const [owed, contract] = listActions(store);
  assert.equal(contract.owner.kind, "person");
  assert.equal(contract.ownerLabel, "Priya");
  assert.equal(owed.owner.kind, "self");
  for (const action of [owed, contract])
    assert.equal(
      note.plainText.slice(action.evidence[0].startOffset, action.evidence[0].endOffset),
      action.evidence[0].quote,
    );
});

test("the model reads outside the queue, and a page edited meanwhile keeps its quotes", async (t) => {
  // The on-device model took 10-80 s on an 8 GB Mac. Holding the workspace queue
  // for that long froze the page list and the open page behind it.
  const { store } = await fixture(t);
  const note = write(store, "Call notes", "Priya will confirm the budget by Thursday.");
  let queued = 0;
  let inQueue = false;
  const serialize = async (fn) => {
    queued++;
    inQueue = true;
    try { return await fn(); } finally { inQueue = false; }
  };
  const runtime = {
    extract: async (request) => {
      assert.equal(inQueue, false, "the model is never called while holding the queue");
      // The person keeps typing while the model reads: a line lands above the promise.
      const current = store.get(scope(store), "note", note.id);
      store.updateNote(mutation(store, current.revision), note.id, {
        content: page("Added while it was reading.\nPriya will confirm the budget by Thursday."),
      });
      return [{ segmentId: request.segments[0].id, quote: "will confirm the budget by Thursday", owner: "other", person: "Priya" }];
    },
  };
  const result = await extractNoteActions(store, note.id, runtime, serialize);
  assert.equal(queued, 2, "only reading the page and writing the proposals are queued");
  assert.equal(result.proposed, 1);
  const [action] = listActions(store);
  const text = store.get(scope(store), "note", note.id).plainText;
  assert.equal(
    text.slice(action.evidence[0].startOffset, action.evidence[0].endOffset),
    action.evidence[0].quote,
    "the evidence points at the sentence where it now sits",
  );
});

test("a Mac without the on-device model falls back to the sentence rules", async (t) => {
  const { store } = await fixture(t);
  const note = write(store, "Page", "I will send the invoice on Friday.");
  const missing = {
    extract: async () => {
      throw Object.assign(new Error("not installed"), { code: "MODEL_MISSING" });
    },
  };
  const result = await extractNoteActions(store, note.id, missing);
  assert.equal(result.method, "local-rule");
  assert.equal(result.proposed, 1);
  // Any other failure is not silently swallowed.
  const broken = {
    extract: async () => {
      throw Object.assign(new Error("helper crashed"), { code: "FAILED" });
    },
  };
  await assert.rejects(() => extractNoteActions(store, note.id, broken), /helper crashed/);
});

test("an empty page proposes nothing and a long page is read in pieces", async (t) => {
  const { store } = await fixture(t);
  const empty = write(store, "Empty", "");
  assert.deepEqual(extractNoteActionsLocal(store, empty.id), {
    proposed: 0,
    read: 0,
    method: "local-rule",
  });
  const long = `${"Context that is merely long. ".repeat(600)}\nI will send the report on Monday.`;
  const parts = pieces(long);
  assert.ok(parts.length > 1, "a page longer than the model's context is split");
  assert.ok(
    parts.every((part) => long.slice(part.offset, part.offset + part.text.length) === part.text),
    "every piece remembers exactly where it came from",
  );
  const note = write(store, "Long", long);
  assert.equal(extractNoteActionsLocal(store, note.id).proposed, 1);
});
