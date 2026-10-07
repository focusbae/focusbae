"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load, matches, score } = require("../../qualification/extraction/score");

const meeting = {
  id: "m",
  source: "synthetic",
  segments: [
    { id: "s1", text: "Sure. I will send the deck by Friday." },
    { id: "s2", text: "Priya will review it." },
  ],
  commitments: [
    { segmentId: "s1", quote: "I will send the deck by Friday", owner: "self" },
    { segmentId: "s2", quote: "Priya will review it", owner: "other" },
  ],
};

test("matching requires the same segment and overlapping quotes", () => {
  const expected = meeting.commitments[0];
  assert.equal(matches({ segmentId: "s1", quote: "I will send the deck by Friday." }, expected), true);
  assert.equal(matches({ segmentId: "s1", quote: "Sure. I will send the deck by Friday." }, expected), true);
  assert.equal(matches({ segmentId: "s2", quote: "I will send the deck by Friday" }, expected), false);
  assert.equal(matches({ segmentId: "s1", quote: "" }, expected), false);
});

test("scoring separates detection from ownership and never double-counts", async () => {
  const result = await score([meeting], async () => [
    { segmentId: "s1", quote: "I will send the deck by Friday.", owner: "self" },
    { segmentId: "s1", quote: "I will send the deck by Friday.", owner: "self" },
    { segmentId: "s2", quote: "Priya will review it.", owner: "unknown" },
  ]);
  assert.equal(result.truePositive, 2);
  assert.equal(result.predicted, 3);
  assert.equal(result.precision, 2 / 3);
  assert.equal(result.recall, 1);
  assert.equal(result.ownerAccuracy, 1 / 2);
  assert.equal(result.endToEnd, 1 / 2);
  assert.deepEqual(result.meetings[0].falsePositives, ["I will send the deck by Friday."]);
});

test("gold files are rejected when a label is not grounded in its segment", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-gold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = structuredClone(meeting);
  bad.commitments[1].quote = "Priya will rewrite it";
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify(bad));
  assert.throws(() => load(dir), /not found verbatim/);
  bad.commitments[1] = { segmentId: "s2", quote: "Priya will review it", owner: "priya" };
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify(bad));
  assert.throws(() => load(dir), /invalid owner/);
});

test("the committed synthetic gold set loads", () => {
  const meetings = load(path.join(__dirname, "../../qualification/extraction/gold"));
  assert.ok(meetings.length >= 3);
  assert.ok(meetings.every((m) => m.source === "synthetic"));
});
