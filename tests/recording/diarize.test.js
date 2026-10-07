"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { Spool } = require("../../recording/spool");
const { diarizeRecording, writeSourceWav, assign } = require("../../recording/diarize");
const { DiarizationRuntime, verifyTree } = require("../../local-ai/diarization-runtime");
const { LocalPolicy: Policy } = require("../../privacy/local-policy");
const { extractActions } = require("../../workspace/action-extraction");

const scope = (store) => ({ workspaceId: store.identity.id });
const mutation = (store) => ({ ...scope(store), clientRequestId: require("node:crypto").randomUUID() });
const pcm = (ms, value = 1000) => {
  const buffer = Buffer.alloc(ms * 32);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
  return buffer;
};

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-diarize-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  t.after(() => catalog.close());
  const store = catalog.store;
  const recording = store.createRecording(mutation(store), { purpose: "conversation", sourceMode: "both" });
  const spool = new Spool(store, recording.id).create(recording, "english");
  return { root, store, recording, spool };
}

class FakeRuntime {
  constructor(turns, { ready = true } = {}) {
    this.turns = turns;
    this.isReady = ready;
    this.calls = [];
  }
  ready() {
    return this.isReady;
  }
  async diarize(file) {
    const bytes = fs.readFileSync(file);
    this.calls.push({ file, bytes: bytes.length, riff: bytes.subarray(0, 4).toString() });
    return typeof this.turns === "function" ? this.turns(this.calls.length) : this.turns;
  }
}

test("source audio is written as a WAV aligned to recording time, gaps filled with silence", async (t) => {
  const { spool, root } = await fixture(t);
  spool.append({ source: "system", sequence: 0, startMs: 0, pcm: pcm(1000) });
  spool.append({ source: "system", sequence: 1, startMs: 3000, pcm: pcm(500, 2000) });
  const file = path.join(root, "out.wav");
  const duration = writeSourceWav(spool, spool.scan().chunks, file);
  assert.equal(duration, 3500);
  const wav = fs.readFileSync(file);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 3500 * 32);
  assert.equal(wav.readInt16LE(44 + 500 * 32), 1000);
  assert.equal(wav.readInt16LE(44 + 2000 * 32), 0);
  assert.equal(wav.readInt16LE(44 + 3200 * 32), 2000);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("segments take the speaker with the most overlap; no overlap stays unassigned", () => {
  const result = assign(
    [
      { startMs: 0, endMs: 4000 },
      { startMs: 4000, endMs: 10000 },
      { startMs: 20000, endMs: 21000 },
    ],
    [
      { speaker: "A", startMs: 0, endMs: 5000 },
      { speaker: "B", startMs: 5000, endMs: 7000 },
      { speaker: "A", startMs: 7000, endMs: 8000 },
      { speaker: "B", startMs: 8000, endMs: 10000 },
    ],
  );
  assert.deepEqual(result.map((r) => r.speaker), ["A", "B", null]);
});

test("diarization labels speakers per source, assigns segments, and reruns idempotently", async (t) => {
  const { store, recording, spool } = await fixture(t);
  spool.append({ source: "system", sequence: 0, startMs: 0, pcm: pcm(5000) });
  spool.append({ source: "microphone", sequence: 0, startMs: 0, pcm: pcm(5000) });
  const make = (source, startMs, endMs, text) =>
    store.createTranscript(mutation(store), { recordingId: recording.id, source, startMs, endMs, text });
  const a = make("system", 0, 2000, "Priya will send the contract.");
  const b = make("system", 2500, 4800, "I'll review it tomorrow.");
  const c = make("microphone", 0, 1000, "Sounds good.");
  const runtime = new FakeRuntime([
    { speaker: "S1", startMs: 0, endMs: 2200 },
    { speaker: "S2", startMs: 2300, endMs: 5000 },
  ]);
  const first = await diarizeRecording({ store, recordingId: recording.id, spool, scan: spool.scan(), runtime });
  assert.equal(first.status, "complete");
  assert.equal(first.assigned, 3);
  assert.equal(runtime.calls.length, 2);
  assert.ok(runtime.calls.every((call) => call.riff === "RIFF"));
  // Temporary WAVs are removed.
  assert.deepEqual(fs.readdirSync(spool.directory).filter((n) => n.endsWith(".wav")), []);
  const speakers = store.list(scope(store), "speaker", { recordingId: recording.id });
  assert.deepEqual(speakers.map((s) => s.label).sort(), [
    "Speaker 1 · Mac audio",
    "Speaker 1 · Microphone",
    "Speaker 2 · Mac audio",
  ]);
  assert.ok(speakers.every((s) => s.identity.kind === "unknown"));
  const label = (segment) =>
    speakers.find((s) => s.id === store.get(scope(store), "transcript", segment.id).speakerId).label;
  assert.equal(label(a), "Speaker 1 · Mac audio");
  assert.equal(label(b), "Speaker 2 · Mac audio");
  assert.equal(label(c), "Speaker 1 · Microphone");

  const again = await diarizeRecording({ store, recordingId: recording.id, spool, scan: spool.scan(), runtime });
  assert.equal(again.assigned, 0);
  assert.equal(runtime.calls.length, 2, "already-assigned sources are not re-run");
  assert.equal(store.list(scope(store), "speaker", { recordingId: recording.id }).length, 3);
});

test("speaker assignment does not duplicate proposals made before it", async (t) => {
  const { store, recording, spool } = await fixture(t);
  spool.append({ source: "system", sequence: 0, startMs: 0, pcm: pcm(3000) });
  store.createTranscript(mutation(store), {
    recordingId: recording.id, source: "system", startMs: 0, endMs: 2000, text: "I will send the notes today.",
  });
  assert.equal((await extractActions(store, recording.id, null)).proposed, 1);
  const runtime = new FakeRuntime([{ speaker: "S1", startMs: 0, endMs: 3000 }]);
  await diarizeRecording({ store, recordingId: recording.id, spool, scan: spool.scan(), runtime });
  const result = await extractActions(store, recording.id, null);
  assert.equal(result.proposed, 0);
  assert.equal(store.list(scope(store), "action").length, 1);
});

test("the model sees anonymous speaker labels, never an owner", async (t) => {
  const { store, recording, spool } = await fixture(t);
  spool.append({ source: "system", sequence: 0, startMs: 0, pcm: pcm(3000) });
  store.createTranscript(mutation(store), {
    recordingId: recording.id, source: "system", startMs: 0, endMs: 2000, text: "I'll send it.",
  });
  await diarizeRecording({
    store, recordingId: recording.id, spool, scan: spool.scan(),
    runtime: new FakeRuntime([{ speaker: "S7", startMs: 0, endMs: 3000 }]),
  });
  let request;
  await extractActions(store, recording.id, { extract: async (r) => ((request = r), []) });
  assert.equal(request.segments[0].speaker, "Speaker 1 · Mac audio");
  assert.match(request.owner, /not yet identified/);
});

test("diarization is skipped without a ready model, for long sources, and on cancellation", async (t) => {
  const { store, recording, spool } = await fixture(t);
  spool.append({ source: "system", sequence: 0, startMs: 0, pcm: pcm(1000) });
  store.createTranscript(mutation(store), {
    recordingId: recording.id, source: "system", startMs: 0, endMs: 900, text: "Hello there.",
  });
  const scan = spool.scan();
  assert.deepEqual(
    await diarizeRecording({ store, recordingId: recording.id, spool, scan, runtime: new FakeRuntime([], { ready: false }) }),
    { status: "skipped", reason: "MODEL_MISSING" },
  );
  assert.deepEqual(await diarizeRecording({ store, recordingId: recording.id, spool, scan, runtime: null }), {
    status: "skipped",
    reason: "MODEL_MISSING",
  });
  const long = { chunks: scan.chunks.map((c) => ({ ...c, startMs: 3 * 60 * 60 * 1000 })) };
  const skipped = await diarizeRecording({ store, recordingId: recording.id, spool, scan: long, runtime: new FakeRuntime([]) });
  assert.deepEqual(skipped.sources.system, { status: "skipped", reason: "TOO_LONG" });
  await assert.rejects(
    diarizeRecording({
      store, recordingId: recording.id, spool, scan,
      runtime: new FakeRuntime([{ speaker: "S1", startMs: 0, endMs: 900 }]),
      isCancelled: () => true,
    }),
    { code: "CANCELLED" },
  );
  assert.equal(store.list(scope(store), "speaker", { recordingId: recording.id }).length, 0);
});

function modelFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-diar-model-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { "config.json": "{}", "A.mlmodelc/weights/weight.bin": "weights" };
  const manifest = {
    version: 1,
    name: "speaker-diarization",
    title: "fixture",
    license: "test",
    bytes: 0,
    files: Object.entries(files).map(([p, body]) => ({
      path: p,
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    })),
  };
  const write = (base) => {
    for (const [p, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(base, p)), { recursive: true });
      fs.writeFileSync(path.join(base, p), body);
    }
  };
  return { dir, manifest, write, files };
}

test("model verification rejects missing, tampered, extra and linked files", (t) => {
  const { dir, manifest, write } = modelFixture(t);
  const tree = path.join(dir, "tree");
  assert.throws(() => verifyTree(tree, manifest), { code: "MODEL_MISSING" });
  write(tree);
  assert.equal(verifyTree(tree, manifest), true);
  fs.writeFileSync(path.join(tree, "config.json"), "{ }");
  assert.throws(() => verifyTree(tree, manifest), { code: "MODEL_INVALID" });
  write(tree);
  fs.writeFileSync(path.join(tree, "extra.bin"), "x");
  assert.throws(() => verifyTree(tree, manifest), { code: "MODEL_INVALID" });
  fs.rmSync(path.join(tree, "extra.bin"));
  fs.rmSync(path.join(tree, "config.json"));
  assert.throws(() => verifyTree(tree, manifest), { code: "MODEL_MISSING" });
  fs.symlinkSync(path.join(dir, "elsewhere"), path.join(tree, "config.json"));
  assert.throws(() => verifyTree(tree, manifest), { code: "MODEL_INVALID" });
});

test("download needs model permission, publishes only verified files, and keeps no staging", async (t) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return t.skip("Apple Silicon only");
  const { dir, manifest, files } = modelFixture(t);
  const root = path.join(dir, "models");
  // A fake helper that "downloads" by writing the fixture files, or a bad file.
  const helper = (bad) => {
    const file = path.join(dir, bad ? "bad-helper" : "helper");
    const writes = Object.entries(files)
      .map(([p, body]) => `mkdir -p "$3/speaker-diarization/${path.dirname(p)}" && printf '%s' '${bad && p === "config.json" ? "tampered" : body}' > "$3/speaker-diarization/${p}"`)
      .join("\n");
    fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = download ] || exit 9\n${writes}\necho '{"ok":true}'\n`, { mode: 0o755 });
    return file;
  };
  const strict = new Policy({ strict: true });
  let runtime = new DiarizationRuntime({ binary: helper(false), root, manifest, network: { assert: (p) => strict.assert(p) } });
  assert.throws(() => runtime.download(), { code: /DENIED/ });
  assert.equal(fs.existsSync(root), false, "nothing is written when permission is denied");

  const allowed = new Policy();
  allowed.authorize("models");
  runtime = new DiarizationRuntime({ binary: helper(true), root, manifest, network: { assert: (p) => allowed.assert(p) } });
  await assert.rejects(runtime.download(), { code: "MODEL_INVALID" });
  assert.equal(runtime.state().status, "error");
  assert.equal(fs.existsSync(runtime.modelDirectory), false);
  assert.deepEqual(fs.readdirSync(root), []);

  runtime = new DiarizationRuntime({ binary: helper(false), root, manifest, network: { assert: (p) => allowed.assert(p) } });
  assert.equal(await runtime.download(), true);
  assert.equal(runtime.ready(), true);
  assert.deepEqual(fs.readdirSync(root), ["speaker-diarization"]);
  const fresh = new DiarizationRuntime({ binary: helper(false), root, manifest });
  assert.equal(fresh.verify(), true, "a restart re-verifies before use");
});

test("the far side heard on both sources is marked as one conversation", async (t) => {
  const { markEchoes } = require("../../recording/service");
  // Timings and wording from the second real stand-up.
  const segments = [
    { id: "a", source: "microphone", startMs: 9496, endMs: 12296, text: "Hello, let's start. What's your update?" },
    { id: "b", source: "microphone", startMs: 14116, endMs: 32576, text: "Hey team, quick update from my side. Yesterday I finished the pagination fix." },
    { id: "c", source: "system", startMs: 14228, endMs: 32600, text: "Hey team, quick update from my side. Yesterday I finished the pagination fix." },
    { id: "d", source: "microphone", startMs: 33676, endMs: 51556, text: "Sure, I'll review that PR." },
    { id: "e", source: "microphone", startMs: 57456, endMs: 57956, text: "Anytime." },
    { id: "f", source: "system", startMs: 57568, endMs: 58100, text: "Anytime." },
  ];
  const marked = markEchoes(segments);
  assert.deepEqual(
    marked.map((segment) => [segment.id, segment.echoOf]),
    [["a", null], ["b", "c"], ["c", null], ["d", null], ["e", "f"], ["f", null]],
  );
  // The user's own words are never treated as an echo, and nothing is removed.
  assert.equal(marked.length, segments.length);
  assert.equal(marked.filter((segment) => segment.echoOf).length, 2);

  // A microphone line carrying the user's own speech as well as the far side's is
  // not a pure echo and stays.
  const mixed = markEchoes([
    { id: "m", source: "microphone", startMs: 80175, endMs: 85915, text: "Sure, thank you Alex. That's all from my side. Bye-bye. Sounds good, talk later." },
    { id: "s", source: "system", startMs: 84669, endMs: 85989, text: "Sounds good, talk later." },
  ]);
  assert.deepEqual(mixed.map((segment) => segment.echoOf), [null, null]);

  // Different words overlapping in time are two people talking over each other.
  const crosstalk = markEchoes([
    { id: "x", source: "microphone", startMs: 1000, endMs: 5000, text: "I will send the invoice today." },
    { id: "y", source: "system", startMs: 1200, endMs: 4800, text: "I will book the venue for the offsite." },
  ]);
  assert.deepEqual(crosstalk.map((segment) => segment.echoOf), [null, null]);
});
