"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation, scope } = require("./helpers.cjs");
const {
  candidates,
  extractRecordingActions,
  extractRecordingActionsLocal,
  extractActions,
  locate,
} = require("../../workspace/action-extraction");
const { ExtractionRuntime, batches } = require("../../local-ai/extraction-runtime");
const { WorkspaceError } = require("../../workspace/errors");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class FakeRuntime {
  constructor(respond) {
    this.respond = respond;
    this.requests = [];
  }
  async extract(request) {
    this.requests.push(request);
    return this.respond(request);
  }
}

async function recordingWith(store, text, purpose = "conversation") {
  const recording = store.createRecording(mutation(store), { purpose });
  const segment = store.createTranscript(mutation(store), {
    recordingId: recording.id,
    source: "microphone",
    startMs: 0,
    endMs: 5000,
    text,
  });
  return { recording, segment };
}

test("local extraction creates review-only proposals with exact transcript evidence", async (t) => {
  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const text = "We discussed pricing. I will send the revised proposal Friday. We will not publish it yet.";
  const segment = store.createTranscript(mutation(store), {
    recordingId: recording.id,
    source: "microphone",
    startMs: 0,
    endMs: 5000,
    text,
  });

  assert.equal(candidates(segment).length, 1);
  assert.equal(extractRecordingActions(store, recording.id).proposed, 1);
  assert.equal(extractRecordingActions(store, recording.id).proposed, 0);
  const [action] = store.list(scope(store), "action");
  assert.equal(action.status, "proposed");
  assert.equal(action.origin, "local-rule");
  assert.equal(action.owner.kind, "unknown");
  assert.equal(action.evidence[0].quote, "I will send the revised proposal Friday.");
  assert.equal(
    text.slice(action.evidence[0].startOffset, action.evidence[0].endOffset),
    action.evidence[0].quote,
  );
});

test("learning recordings do not infer personal commitments", async (t) => {
  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "learning" });
  store.createTranscript(mutation(store), {
    recordingId: recording.id,
    source: "import",
    startMs: 0,
    endMs: 1000,
    text: "You should review chapter four.",
  });
  assert.deepEqual(extractRecordingActions(store, recording.id), {
    proposed: 0,
    attributed: 0,
    restated: 0,
    skipped: "learning",
  });
  assert.equal(store.list(scope(store), "action").length, 0);
});

test("proposal cap remains stable across idempotent reruns", async (t) => {
  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  store.createTranscript(mutation(store), {
    recordingId: recording.id,
    source: "system",
    startMs: 0,
    endMs: 1000,
    text: Array.from({ length: 21 }, (_, index) => `We will complete task ${index}.`).join(" "),
  });
  assert.deepEqual(extractRecordingActions(store, recording.id), {
    proposed: 20,
    attributed: 0,
    restated: 0,
    limited: true,
    limit: 20,
  });
  assert.deepEqual(extractRecordingActions(store, recording.id), {
    proposed: 0,
    attributed: 0,
    restated: 0,
    limited: true,
    limit: 20,
  });
  assert.equal(store.list(scope(store), "action").length, 20);
});

test("model extraction stores grounded, review-only proposals with exact offsets", async (t) => {
  const { store } = await fixture(t);
  const text = "Thanks. I'll send you the revised deck by Friday. It will probably rain.";
  const { recording, segment } = await recordingWith(store, text);
  const runtime = new FakeRuntime(({ segments }) => [
    { segmentId: segments[0].id, quote: "i'll send you the revised deck by friday.", owner: "self" },
    { segmentId: segments[0].id, quote: "a sentence the model invented", owner: "other" },
    { segmentId: "not-a-segment", quote: "Thanks", owner: "unknown" },
  ]);
  const result = await extractRecordingActionsLocal(store, recording.id, runtime);
  assert.deepEqual(result, { proposed: 1, attributed: 0, restated: 0, limited: false, method: "local-model" });
  // Audio source is never sent as a speaker identity.
  assert.equal(runtime.requests[0].segments[0].speaker, null);
  const [action] = store.list(scope(store), "action");
  assert.equal(action.origin, "local-model");
  assert.equal(action.status, "proposed");
  assert.equal(action.owner.kind, "unknown");
  assert.equal(action.evidence[0].segmentId, segment.id);
  assert.equal(action.evidence[0].quote, "I'll send you the revised deck by Friday");
  assert.equal(text.slice(action.evidence[0].startOffset, action.evidence[0].endOffset), action.evidence[0].quote);
  assert.deepEqual(await extractRecordingActionsLocal(store, recording.id, runtime), {
    proposed: 0,
    attributed: 0,
    restated: 0,
    limited: false,
    method: "local-model",
  });
  assert.equal(store.list(scope(store), "action").length, 1);
});

test("model extraction skips learning recordings without calling the model", async (t) => {
  const { store } = await fixture(t);
  const { recording } = await recordingWith(store, "The lecturer will publish slides.", "learning");
  const runtime = new FakeRuntime(() => assert.fail("model must not run"));
  assert.deepEqual(await extractActions(store, recording.id, runtime), {
    proposed: 0,
    attributed: 0,
    restated: 0,
    skipped: "learning",
    method: "local-model",
  });
});

test("missing model falls back to rules; other model failures surface", async (t) => {
  const { store } = await fixture(t);
  const { recording } = await recordingWith(store, "I will send the notes today.");
  const missing = new FakeRuntime(() => {
    throw new WorkspaceError("MODEL_MISSING", "unavailable");
  });
  const result = await extractActions(store, recording.id, missing);
  assert.equal(result.method, "local-rule");
  assert.equal(result.proposed, 1);
  const broken = new FakeRuntime(() => {
    throw new WorkspaceError("MODEL_INVALID", "bad output");
  });
  await assert.rejects(extractActions(store, recording.id, broken), { code: "MODEL_INVALID" });
  assert.equal((await extractActions(store, recording.id, null)).method, "local-rule");
});

test("quote location tolerates case and trailing punctuation only", () => {
  assert.deepEqual(locate("Sure. I will send it.", "i will send it."), {
    start: 6,
    end: 20,
    quote: "I will send it",
  });
  assert.equal(locate("Sure. I will send it.", "I shall send it"), null);
  assert.equal(locate("Sure.", "   "), null);
});

test("runtime chunks long transcripts and maps helper failures", async (t) => {
  const segments = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, speaker: null, text: "x".repeat(900) }));
  const groups = batches(segments, 3000);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flat().map((s) => s.id), segments.map((s) => s.id));
  assert.ok(groups.every((g) => g.reduce((n, s) => n + s.text.length + 40, 0) <= 3000));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const ok = new ExtractionRuntime({
    binary: script("ok", `echo '{"ok":true,"commitments":[{"segmentId":"s1","quote":"q","owner":"self","person":""}]}'`),
    chunkChars: 3000,
  });
  const found = await ok.extract({ owner: "Me", segments });
  assert.equal(found.length, groups.length);
  const unavailable = new ExtractionRuntime({
    binary: script("na", `echo '{"ok":false,"code":"UNAVAILABLE"}'; exit 1`),
  });
  await assert.rejects(unavailable.extract({ owner: "Me", segments }), { code: "MODEL_MISSING" });
  const absent = new ExtractionRuntime({ binary: path.join(dir, "absent") });
  await assert.rejects(absent.extract({ owner: "Me", segments }), { code: "MODEL_MISSING" });
  const invalid = new ExtractionRuntime({
    binary: script("bad", `echo '{"ok":true,"commitments":[{"segmentId":1}]}'`),
  });
  await assert.rejects(invalid.extract({ owner: "Me", segments }), { code: "MODEL_INVALID" });
  const slow = new ExtractionRuntime({ binary: script("slow", "sleep 5"), timeoutMs: 100 });
  await assert.rejects(slow.extract({ owner: "Me", segments: segments.slice(0, 1) }), { code: "MODEL_TIMEOUT" });
});

test("an answer too long for the model's context splits the batch instead of losing it", async (t) => {
  // Apple's model refuses once input plus answer pass 4,096 tokens; the helper
  // reports it as a context-size failure after doing the work.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, "calls");
  const helper = path.join(dir, "helper");
  fs.writeFileSync(helper, `#!/bin/sh
input=$(cat)
echo x >> "${calls}"
count=$(printf '%s' "$input" | grep -o '"id"' | wc -l | tr -d ' ')
if [ "$count" -gt 1 ]; then echo '{"ok":false,"code":"FAILED","error":"Content contains 4098 tokens, which exceeds the maximum allowed context size of 4096."}'; exit 1; fi
echo '{"ok":true,"commitments":[{"segmentId":"s","quote":"q","owner":"self","person":""}]}'
`, { mode: 0o755 });
  const segments = ["a", "b", "c", "d"].map((id) => ({ id, speaker: "You", text: "I will send it." }));
  const runtime = new ExtractionRuntime({ binary: helper, chunkChars: 3000 });
  const found = await runtime.extract({ owner: "You", segments });
  assert.equal(found.length, 4, "every segment is still read");
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 7, "4 -> 2+2 -> 1+1+1+1");
  const always = path.join(dir, "always");
  fs.writeFileSync(always, `#!/bin/sh
cat >/dev/null
echo '{"ok":false,"code":"FAILED","error":"exceeds the maximum allowed context size of 4096."}'; exit 1
`, { mode: 0o755 });
  await assert.rejects(
    new ExtractionRuntime({ binary: always }).extract({ owner: "You", segments: segments.slice(0, 1) }),
    { code: "MODEL_CONTEXT" },
    "one segment that cannot fit is reported, not retried forever",
  );
});

test("speaker echo does not become a second commitment", async (t) => {
  // Timings and wording taken from a real stand-up recorded on speakers rather than
  // headphones: the far side came out of the Mac and back in through the microphone,
  // so every remote utterance was transcribed twice, 0.1-1.2s apart.
  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "conversation", sourceMode: "both" });
  const line = (source, startMs, endMs, text) =>
    store.createTranscript(mutation(store), { recordingId: recording.id, source, startMs, endMs, text });
  const mine = line("microphone", 60815, 64655, "I need to send you a performance report of the application.");
  const micEcho = line("microphone", 66275, 72975, "Totally. Once you send that report over, I can take a pass and sanity check anything that looks off.");
  const systemReal = line("system", 67509, 72949, "Totally. Once you send that report over, I can take a pass and sanity check anything that looks off.");
  // The two engines heard one word differently.
  const micNote = line("microphone", 73735, 78155, "And if the voice note test surfaces any weird behavior, just drop me a note.");
  const systemNode = line("system", 73849, 78229, "And if the voice node test surfaces any weird behavior, just drop me a note.");

  const quotes = new Map([
    [mine.id, "I need to send you a performance report of the application"],
    [micEcho.id, "Totally. Once you send that report over, I can take a pass and sanity check anything that looks off"],
    [systemReal.id, "Totally. Once you send that report over, I can take a pass and sanity check anything that looks off"],
    [micNote.id, "And if the voice note test surfaces any weird behavior, just drop me a note"],
    [systemNode.id, "And if the voice node test surfaces any weird behavior, just drop me a note"],
  ]);
  const runtime = {
    extract: async ({ segments }) =>
      segments.map((segment) => ({ segmentId: segment.id, quote: quotes.get(segment.id), owner: "unknown", person: "" })),
  };
  const result = await extractRecordingActionsLocal(store, recording.id, runtime);
  assert.equal(result.proposed, 3, "five transcript lines, three real commitments");
  const titles = store.list(scope(store), "action").map((action) => action.title);
  assert.equal(titles.filter((title) => title.startsWith("Totally.")).length, 1);
  assert.equal(titles.filter((title) => title.startsWith("And if the voice")).length, 1);
  assert.ok(titles.some((title) => title.startsWith("I need to send you")));

  // Speech that merely overlaps in time is still its own commitment.
  const other = store.createRecording(mutation(store), { purpose: "conversation", sourceMode: "both" });
  const a = store.createTranscript(mutation(store), {
    recordingId: other.id, source: "microphone", startMs: 1000, endMs: 5000, text: "I will send the invoice today.",
  });
  const b = store.createTranscript(mutation(store), {
    recordingId: other.id, source: "system", startMs: 1200, endMs: 4800, text: "I will book the venue for the offsite.",
  });
  const second = await extractRecordingActionsLocal(store, other.id, {
    extract: async () => [
      { segmentId: a.id, quote: "I will send the invoice today", owner: "unknown", person: "" },
      { segmentId: b.id, quote: "I will book the venue for the offsite", owner: "unknown", person: "" },
    ],
  });
  assert.equal(second.proposed, 2, "different words overlapping in time are two commitments");
});

test("politeness is not a commitment", async (t) => {
  // Quotes the on-device model actually proposed from a real stand-up.
  const { looksConversational } = require("../../workspace/action-extraction");
  for (const quote of [
    "Sure, I'll review that PR",
    "Also, from my side, I need to test the AI agent, the fix that I deployed yesterday",
    "Totally. Once you send that report over, I can take a pass and sanity check anything that looks off",
    "I need to send you a performance report of the application",
    "Raghav will own the migration script",
  ])
    assert.equal(looksConversational(quote), false, quote);
  for (const quote of ["Anytime", "Okay. Bye-bye", "Sounds good. Talk later.", "Yeah, okay, got it", "Perfect.", "Hello, let's start"])
    assert.equal(looksConversational(quote), true, quote);

  const { store } = await fixture(t);
  const recording = store.createRecording(mutation(store), { purpose: "conversation" });
  const line = (startMs, text) =>
    store.createTranscript(mutation(store), { recordingId: recording.id, source: "microphone", startMs, endMs: startMs + 2000, text });
  const real = line(0, "Sure, I'll review that PR.");
  const bye = line(4000, "Anytime. Okay. Bye-bye.");
  const runtime = {
    extract: async () => [
      { segmentId: real.id, quote: "Sure, I'll review that PR", owner: "unknown", person: "" },
      { segmentId: bye.id, quote: "Anytime", owner: "unknown", person: "" },
      { segmentId: bye.id, quote: "Okay. Bye-bye", owner: "unknown", person: "" },
    ],
  };
  assert.equal((await extractRecordingActionsLocal(store, recording.id, runtime)).proposed, 1);
  assert.deepEqual(
    store.list(scope(store), "action").map((action) => action.title),
    ["Sure, I'll review that PR"],
  );
});
