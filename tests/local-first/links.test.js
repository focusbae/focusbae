"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, document, mutation, scope } = require("./helpers.cjs");
const links = require("../../workspace/links");
const graph = require("../../workspace/graph");
const portable = require("../../workspace/portable");
const { extractActions } = require("../../workspace/action-extraction");

const note = (store, title, text) =>
  store.createNote(mutation(store), { title, content: document(text) });

test("wikilinks are parsed from a note's text, deduped, and aliases kept out of the target", () => {
  assert.deepEqual(
    links.parse(
      document("Spoke to [[Priya]] about the [[Q3 launch|launch]] and [[  priya  ]] again."),
    ),
    ["Priya", "Q3 launch"],
    "the same target twice is one link; a target is trimmed and matched case-insensitively",
  );
  assert.deepEqual(links.parse(document("A [[]] and a [[bad\nlink]] and [[a[b]]")), []);
  assert.deepEqual(links.parseText("plain [[markdown link]]"), ["markdown link"]);
});

test("backlinks appear on save, are claimed by a page created later, and survive a rename", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const standup = note(store, "Standup", "Ask [[Roadmap]] owner, ping [[Nobody yet]].");
  const outgoing = (id = standup.id) =>
    links.forNote(store, workspaceId, id).outgoing;
  const roadmapLink = () => outgoing().find((link) => link.label === "Roadmap");
  // Nothing it points at exists yet.
  assert.deepEqual(
    outgoing().map((link) => [link.label, link.resolved]),
    [["Nobody yet", false], ["Roadmap", false]],
  );
  const roadmap = note(store, "Roadmap", "Q3 plan.");
  assert.deepEqual(
    links.forNote(store, workspaceId, roadmap.id).backlinks.map((link) => link.title),
    ["Standup"],
    "a page created after the link still collects the backlink",
  );
  assert.deepEqual(
    roadmapLink(),
    { label: "Roadmap", kind: "note", id: roadmap.id, resolved: true },
    "the new page claims the link without the note that wrote it being touched",
  );
  const trashed = store.delete(mutation(store, roadmap.revision), "note", roadmap.id);
  assert.equal(
    roadmapLink().resolved,
    false,
    "a trashed target releases the links pointing at it, so following one is not a dead end",
  );
  const restored = store.restore(mutation(store, trashed.revision), "note", roadmap.id);
  assert.equal(roadmapLink().id, restored.id, "restoring it claims them back");
  const renamed = store.updateNote(
    mutation(store, store.get(scope(store), "note", roadmap.id).revision),
    roadmap.id,
    { title: "Roadmap 2026" },
  );
  assert.deepEqual(
    links.forNote(store, workspaceId, renamed.id).backlinks.map((link) => link.title),
    ["Standup"],
    "a link points at the page, not at the title it had when written",
  );
  assert.equal(roadmapLink().id, renamed.id);
  const deletedSource = store.delete(
    mutation(store, store.get(scope(store), "note", standup.id).revision),
    "note",
    standup.id,
  );
  assert.deepEqual(
    links.forNote(store, workspaceId, renamed.id).backlinks,
    [],
    "a trashed page links to nothing",
  );
  assert.ok(deletedSource.deletedAt);
});

test("a wikilink resolves to a person the workspace already knows", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const speaker = store.createSpeaker(mutation(store), {
    recordingId: recording.id,
    label: "Speaker 1 · Mac audio",
  });
  store.createTranscript(mutation(store), {
    recordingId: recording.id,
    source: "system",
    startMs: 1000,
    endMs: 4000,
    text: "I will review the contract tomorrow.",
    speakerId: speaker.id,
  });
  store.identifySpeaker(mutation(store, speaker.revision), speaker.id, {
    identity: { kind: "person", label: "Priya" },
  });
  await extractActions(store, recording.id, null);
  const page = note(store, "Contract", "Waiting on [[priya]].");
  const [link] = links.forNote(store, workspaceId, page.id).outgoing;
  assert.equal(link.kind, "person");
  assert.equal(link.resolved, true);
  assert.equal(link.id, links.resolve(store, workspaceId, "Priya").id);
});

test("the graph joins notes, people and what came out of a conversation", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const speaker = store.createSpeaker(mutation(store), {
    recordingId: recording.id,
    label: "Speaker 1 · Mac audio",
  });
  store.createTranscript(mutation(store), {
    recordingId: recording.id,
    source: "system",
    startMs: 1000,
    endMs: 4000,
    text: "I will send the signed contract on Monday.",
    speakerId: speaker.id,
  });
  store.identifySpeaker(mutation(store, speaker.revision), speaker.id, {
    identity: { kind: "person", label: "Priya" },
  });
  await extractActions(store, recording.id, null);
  const brief = note(store, "Vendor brief", "Background for the call.");
  // Written before the target page exists: the graph resolves it by title anyway.
  const plan = note(store, "Plan", "See [[Vendor brief]] and [[Priya]] and [[Later page]].");
  const later = note(store, "Later page", "Filled in afterwards.");
  const result = graph.build(store, workspaceId);
  const kinds = result.nodes.reduce((all, node) => {
    all[node.kind] = (all[node.kind] ?? 0) + 1;
    return all;
  }, {});
  assert.equal(kinds.note, 3);
  assert.equal(kinds.person, 1);
  assert.equal(kinds.recording, 1);
  assert.equal(kinds.action, 1);
  const edge = (from, to) => result.edges.some((item) => item.from === from && item.to === to);
  assert.ok(edge(plan.id, brief.id), "note to note");
  assert.ok(edge(plan.id, later.id), "a link written before its page existed still joins");
  const priya = result.nodes.find((node) => node.kind === "person");
  const action = result.nodes.find((node) => node.kind === "action");
  assert.ok(edge(plan.id, priya.id), "note to person");
  assert.ok(edge(priya.id, action.id), "person owns the action they promised");
  assert.ok(edge(recording.id, action.id), "the conversation the action was quoted from");
  assert.equal(result.truncated, false);
});

test("an exported note keeps its wikilinks readable in another vault", () => {
  assert.equal(
    portable
      .markdown(
        document("Ping [[Priya]] about the [[Q3 launch|launch]] & *nothing* else_here"),
      )
      .trim(),
    "Ping [[Priya]] about the [[Q3 launch|launch]] & \\*nothing\\* else\\_here",
  );
});

test("a half-typed link is offered pages and people, closest match first", async (t) => {
  const { store } = await fixture(t);
  const workspaceId = store.identity.id;
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const speaker = store.createSpeaker(mutation(store), {
    recordingId: recording.id,
    label: "Speaker 1 · Mac audio",
  });
  store.createTranscript(mutation(store), {
    recordingId: recording.id,
    source: "system",
    startMs: 1000,
    endMs: 4000,
    text: "I will send the pricing sheet on Monday.",
    speakerId: speaker.id,
  });
  store.identifySpeaker(mutation(store, speaker.revision), speaker.id, {
    identity: { kind: "person", label: "Pritam" },
  });
  await extractActions(store, recording.id, null);
  for (const title of ["Pricing sheet", "Pricing notes", "Old pricing", "Vendor call"])
    note(store, title, "Body.");
  note(store, "", "An untitled page cannot be linked to.");

  const labels = (query) =>
    links.suggest(store, workspaceId, query).map((item) => item.label);
  assert.deepEqual(
    labels("pric"),
    ["Pricing notes", "Pricing sheet", "Old pricing"],
    "titles starting with what was typed come before titles merely containing it",
  );
  assert.deepEqual(labels("prit"), ["Pritam"], "people are linkable by name");
  assert.deepEqual(labels("nothing here"), []);
  assert.equal(
    links.suggest(store, workspaceId, "pric", 1).length,
    1,
    "the list is bounded by what the caller asks for",
  );
  assert.equal(
    labels("").includes(""),
    false,
    "an untitled page is never offered as a target",
  );
  // Nothing typed yet: recent pages, and the people you have something with.
  const empty = links.suggest(store, workspaceId, "");
  assert.ok(empty.some((item) => item.kind === "note"));
  assert.ok(
    empty.some((item) => item.kind === "person" && item.label === "Pritam"),
    "people are not crowded out by pages when nothing is typed",
  );
  assert.equal(empty[0].label, "Vendor call", "the page touched last comes first");
  // What a suggestion names is what resolving it finds.
  const [first] = links.suggest(store, workspaceId, "pricing s");
  assert.deepEqual(links.resolve(store, workspaceId, first.label), {
    kind: "note",
    id: first.id,
  });
});

