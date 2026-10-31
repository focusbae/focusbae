"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { RecordingService } = require("../../recording/service");
const { Spool, CHUNK_BYTES } = require("../../recording/spool");
const { PlaybackService } = require("../../recording/playback");
const { wavHeader } = require("../../recording/diarize");
const { isSupported } = require("../../meeting-capture/audio-sources");
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(fn) {
  for (let n = 0; n < 100; n++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out");
}
function tone(seconds = 5) {
  const pcm = Buffer.alloc(Math.round(seconds * 32000));
  for (let n = 0; n < pcm.length / 2; n++)
    pcm.writeInt16LE(Math.round(Math.sin(n * 0.07) * 8000), n * 2);
  return pcm;
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-recording-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const sources = {};
  let ready = false;
  let engineCalls = 0;
  const service = new RecordingService({
    catalog,
    capabilities: () => ({ microphone: { ok: true }, system: { ok: true } }),
    model: () => ({ ready, model: "fixture" }),
    createSource: (kind) => {
      const source = new EventEmitter();
      source.stops = 0;
      source.start = async () => {
        source.emit("audio", tone(0.1));
      };
      source.stop = async () => {
        source.stops++;
      };
      sources[kind] = source;
      return source;
    },
    createEngine: () => ({
      load: async () => {},
      dispose: async () => {},
      transcribe: async () => {
        engineCalls++;
        return { content: "Synthetic spoken words" };
      },
    }),
    ...options,
  });
  catalog.busy = () => service.busy();
  t.after(async () => {
    await service.close();
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = (changes = {}) => ({
    context: {
      workspaceId: catalog.store.identity.id,
      clientRequestId: randomUUID(),
    },
    purpose: "personal",
    sourceMode: "microphone",
    language: "english",
    consent: true,
    destination: { kind: "standalone" },
    ...changes,
  });
  return {
    catalog,
    service,
    sources,
    input,
    root,
    modelReady: () => {
      ready = true;
    },
    calls: () => engineCalls,
  };
}
test("opt-in retained capture survives transcription and restart; deleting audio preserves completed text", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.start(f.input({ keepAudio: "true" })), { code: "INVALID_INPUT" });
  f.modelReady();
  const record = f.service.start(f.input({ keepAudio: true }));
  await turn();
  f.sources.microphone.emit("audio", tone(5));
  await f.service.stop(record.id);
  await until(() => !f.service.busy());
  let detail = f.service.detail(record.workspaceId, record.id);
  assert.equal(detail.recording.keepAudio, true);
  assert.equal(detail.recording.transcriptionState, "complete");
  assert.equal(detail.audio.state, "retained");
  assert.equal(detail.audio.overdue, false);
  assert.ok(detail.transcript.length);
  const text = detail.transcript.map((segment) => segment.text);
  await f.catalog.close(); await f.catalog.initialize();
  const playback = new PlaybackService(f.catalog, f.service);
  const scope = { workspaceId: record.workspaceId, id: record.id };
  assert.ok(playback.info(scope).bytes > 0);
  assert.ok(playback.read({ ...scope, startMs: 0, durationMs: 5000, source: "all" }).samples.some((n) => n !== 0));
  f.service.discard(record.id);
  await f.catalog.close(); await f.catalog.initialize();
  detail = f.service.detail(record.workspaceId, record.id);
  assert.equal(detail.audio.state, "deleted");
  assert.equal(detail.audio.bytes, 0);
  assert.equal(detail.recording.transcriptionState, "complete");
  assert.deepEqual(detail.transcript.map((segment) => segment.text), text);
  assert.throws(() => playback.info(scope), { code: "NO_AUDIO" });
});

test("WAV import enters the normal local transcription, playback and storage lifecycle", async (t) => {
  const f = await fixture(t), file = path.join(f.root, "spoken.wav"), pcm = tone(1);
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]));
  const original = fs.readFileSync(file);
  f.modelReady();
  const record = await f.service.importWav({
    context: { workspaceId: f.catalog.activeId, clientRequestId: randomUUID() },
    purpose: "conversation", language: "english", keepAudio: true, consent: true,
    destination: { kind: "standalone" },
  }, file);
  assert.equal(record.imported, true); assert.equal(record.sourceMode, "import");
  assert.equal(record.originalName, "spoken.wav");
  await until(() => !f.service.busy());
  const detail = f.service.detail(record.workspaceId, record.id);
  assert.equal(detail.recording.state, "captured");
  assert.equal(detail.recording.transcriptionState, "complete");
  assert.equal(detail.transcript[0].source, "import");
  assert.equal(detail.audio.state, "retained");
  assert.deepEqual(fs.readFileSync(file), original);
  const storage = f.service.storage(record.workspaceId);
  assert.equal(storage.retainedCount, 1); assert.equal(storage.temporaryCount, 0);
  assert.ok(storage.retainedBytes > 0); assert.equal(storage.totalBytes, storage.retainedBytes);
  const temporary = await f.service.importWav({
    context: { workspaceId: f.catalog.activeId, clientRequestId: randomUUID() },
    purpose: "personal", language: "english", keepAudio: false, consent: true,
    destination: { kind: "standalone" },
  }, file);
  await until(() => !f.service.busy());
  assert.equal(f.service.detail(temporary.workspaceId, temporary.id).audio.state,
    "removed-after-transcription");
  assert.deepEqual(fs.readFileSync(file), original);
});

test("bounded playback aligns independent sources, preserves silence, and rejects unsafe access", async (t) => {
  const f = await fixture(t), store = f.catalog.store;
  const ctx = () => ({ workspaceId: store.identity.id, clientRequestId: randomUUID() });
  const record = store.createRecording(ctx(), { keepAudio: true, sourceMode: "both", metadata: { localCaptureVersion: 1 } });
  const spool = new Spool(store, record.id).create(record, "english");
  const pcm = Buffer.alloc(32000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(16384, i);
  spool.append({ source: "microphone", sequence: 0, startMs: 0, pcm });
  spool.append({ source: "system", sequence: 0, startMs: 1000, pcm });
  const playback = new PlaybackService(f.catalog, f.service);
  const scope = { workspaceId: store.identity.id, id: record.id };
  const info = playback.info(scope);
  assert.equal(info.durationMs, 2000);
  assert.deepEqual(info.sources, ["microphone", "system"]);
  const mixed = playback.read({ ...scope, source: "all", startMs: 500, durationMs: 1000 });
  assert.equal(mixed.samples.length, 16000);
  assert.ok(mixed.samples.every((sample) => sample === 0.5));
  const mic = playback.read({ ...scope, source: "microphone", startMs: 500, durationMs: 1000 });
  assert.equal(mic.samples[7999], 0.5); assert.equal(mic.samples[8000], 0);
  assert.throws(() => playback.read({ ...scope, source: "all", startMs: 0, durationMs: 5001 }), { code: "INVALID_INPUT" });
  assert.throws(() => playback.info({ ...scope, path: "/etc/passwd" }), { code: "INVALID_INPUT" });
  assert.throws(() => playback.info({ ...scope, workspaceId: randomUUID() }), { code: "SCOPE_MISMATCH" });
  playback.info(scope);
  fs.unlinkSync(path.join(spool.directory, "system-000000.pcm"));
  assert.throws(() => playback.read({ ...scope, source: "all", startMs: 1000, durationMs: 1000 }), { code: "SPOOL_MISSING" });
  assert.throws(() => playback.info(scope), { code: "SPOOL_CORRUPT" });
});

test("restart completes default-off cleanup at the transcript commit boundary and keeps opted-in audio", async (t) => {
  const f = await fixture(t), store = f.catalog.store;
  const ids = [];
  for (const keepAudio of [false, true]) {
    const context = { workspaceId: store.identity.id, clientRequestId: randomUUID() };
    const record = store.createRecording(context, { keepAudio, metadata: { localCaptureVersion: 1 } });
    const spool = new Spool(store, record.id).create(record, "english");
    spool.append({ source: "microphone", sequence: 0, startMs: 0, pcm: tone(1) });
    store.updateRecording({ ...context, clientRequestId: randomUUID(), expectedRevision: record.revision }, record.id,
      { state: "interrupted", endedAt: new Date().toISOString(), transcriptionState: "complete" });
    ids.push(record.id);
  }
  await f.catalog.close(); await f.catalog.initialize();
  assert.equal(new Spool(f.catalog.store, ids[0]).open().scan().bytes, 0);
  assert.equal(new Spool(f.catalog.store, ids[1]).open().scan().bytes, 32000);
  const playback = new PlaybackService(f.catalog, f.service);
  assert.throws(() => playback.info({ workspaceId: store.identity.id, id: ids[0] }), { code: "NO_AUDIO" });
});

test("capture is account-free, lazy, consent-gated and retry-idempotent with a durable daily-note link", async (t) => {
  const f = await fixture(t);
  const { service, catalog, input, sources } = f;
  assert.deepEqual(sources, {});
  assert.equal(service.snapshot().model.ready, false);
  assert.throws(() => service.start(input({ consent: false })), {
    code: "CONSENT_REQUIRED",
  });
  assert.deepEqual(sources, {});
  const request = input({ destination: { kind: "today" } });
  const record = service.start(request);
  await turn();
  assert.equal(service.snapshot().active.state, "recording");
  assert.equal(service.start(request).id, record.id);
  assert.equal(Object.keys(sources).length, 1);
  sources.microphone.emit("audio", tone());
  const detail = service.detail(record.workspaceId, record.id);
  assert.ok(detail.noteId);
  assert.equal(detail.audio.bytes, CHUNK_BYTES);
  await assert.rejects(catalog.create({ name: "Busy" }), {
    code: "WORKSPACE_BUSY",
  });
  const first = service.stop(record.id),
    second = service.stop(record.id);
  assert.equal(first, second);
  await first;
  assert.equal(sources.microphone.stops, 1);
  assert.equal(f.calls(), 0);
  assert.equal(
    service.detail(record.workspaceId, record.id).recording.transcriptionState,
    "queued",
  );
  assert.equal((await service.stop(record.id)).state, "captured");
  assert.equal(service.start(request).state, "captured");
  await assert.rejects(service.retry(record.id), { code: "MODEL_MISSING" });
});
test("a source that fails to start keeps its cause on the recording", async (t) => {
  const f = await fixture(t, {
    startTimeout: 50,
    createSource: (kind) => {
      const s = new EventEmitter();
      s.start = async () => {
        if (kind === "system") throw Object.assign(new Error("spawn ENOTDIR"), { code: "ENOTDIR" });
        s.emit("audio", tone());
      };
      s.stop = async () => {};
      return s;
    },
  });
  const record = f.service.start(f.input({ sourceMode: "both" }));
  await until(() => !f.service.active);
  const store = f.service.catalog.scoped(record.workspaceId);
  const saved = store.get({ workspaceId: record.workspaceId }, "recording", record.id);
  assert.match(saved.metadata.reason, /could not start/, "the person still sees the plain reason");
  assert.equal(saved.metadata.startError, "spawn ENOTDIR", "the technical cause is kept for diagnosis");
});
test("the system audio helper is launched from outside the app archive", () => {
  const { audioteeBinary } = require("../../meeting-capture/audio-sources");
  const packaged = "/Applications/FocusBae.app/Contents/Resources/app.asar/node_modules/audiotee/bin/audiotee";
  assert.equal(audioteeBinary(packaged),
    "/Applications/FocusBae.app/Contents/Resources/app.asar.unpacked/node_modules/audiotee/bin/audiotee");
  const dev = "/Users/me/montiorApp-ui/node_modules/audiotee/bin/audiotee";
  assert.equal(audioteeBinary(dev), dev, "development paths are left alone");
  assert.ok(require("node:fs").existsSync(audioteeBinary()), "the default path points at a real binary");
});
test("all selected sources must supply audio; denial never silently downgrades both to microphone", async (t) => {
  const sources = {};
  const f = await fixture(t, {
    startTimeout: 20,
    createSource: (kind) => {
      const s = new EventEmitter();
      sources[kind] = s;
      s.start = async () => {
        if (kind === "microphone") s.emit("audio", tone());
      };
      s.stop = async () => {
        s.stopped = true;
      };
      return s;
    },
  });
  const record = f.service.start(f.input({ sourceMode: "both" }));
  await until(() => !f.service.active);
  const detail = f.service.detail(record.workspaceId, record.id);
  assert.equal(detail.recording.state, "interrupted");
  assert.match(detail.recording.reason, /could not start/);
  assert.equal(detail.audio.bytes, CHUNK_BYTES);
  assert.ok(sources.microphone.stopped && sources.system.stopped);
});
test("successful local transcription commits source-labelled unknown speakers before deleting temporary chunks", async (t) => {
  const f = await fixture(t);
  const record = f.service.start(f.input({ sourceMode: "both" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  f.sources.system.emit("audio", tone());
  await f.service.stop(record.id);
  f.modelReady();
  await f.service.retry(record.id);
  const task = f.service.processing;
  await task.promise;
  const detail = f.service.detail(record.workspaceId, record.id);
  assert.equal(detail.recording.transcriptionState, "complete");
  assert.equal(detail.audio.state, "removed-after-transcription");
  assert.deepEqual(detail.transcript.map((segment) => segment.source).sort(), [
    "microphone",
    "system",
  ]);
  for (const segment of f.catalog.store.list(
    { workspaceId: record.workspaceId },
    "transcript",
    { recordingId: record.id },
  ))
    assert.equal(segment.speakerId, null);
  assert.equal(
    new Spool(f.catalog.store, record.id).open().scan().chunks.length,
    0,
  );
});
test("completed local transcription feeds grounded action proposals into review", async (t) => {
  const f = await fixture(t, {
    createEngine: () => ({
      load: async () => {},
      dispose: async () => {},
      transcribe: async () => ({ content: "I will send the signed proposal Friday." }),
    }),
  });
  const record = f.service.start(f.input({ purpose: "conversation" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(record.id);
  f.modelReady();
  await f.service.retry(record.id);
  await f.service.processing.promise;

  const [action] = f.catalog.store.list(
    { workspaceId: record.workspaceId },
    "action",
  );
  assert.equal(action.status, "proposed");
  assert.equal(action.origin, "local-rule");
  assert.equal(action.owner.kind, "unknown");
  assert.equal(action.evidence[0].quote, "I will send the signed proposal Friday.");
  assert.deepEqual(
    f.catalog.store.get({ workspaceId: record.workspaceId }, "recording", record.id).metadata.actionExtraction,
    { proposed: 1, attributed: 0, restated: 0, limited: false, method: "local-rule" },
  );
});
test("an on-device extractor is preferred and its failure is visible without losing the transcript", async (t) => {
  const engine = () => ({
    load: async () => {},
    dispose: async () => {},
    transcribe: async () => ({ content: "Sure. I'll send the signed proposal Friday." }),
  });
  let fail = false;
  const extractor = {
    extract: async ({ segments }) => {
      if (fail) throw Object.assign(new Error("bad"), { code: "MODEL_INVALID" });
      return [{ segmentId: segments[0].id, quote: "I'll send the signed proposal Friday", owner: "unknown" }];
    },
  };
  const f = await fixture(t, { createEngine: engine, extractor });
  const record = f.service.start(f.input({ purpose: "conversation" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(record.id);
  f.modelReady();
  await f.service.retry(record.id);
  await f.service.processing.promise;
  const scopeOf = { workspaceId: record.workspaceId };
  const [action] = f.catalog.store.list(scopeOf, "action");
  assert.equal(action.origin, "local-model");
  assert.equal(action.status, "proposed");
  const done = f.catalog.store.get(scopeOf, "recording", record.id);
  assert.equal(done.aiState, "complete");
  assert.deepEqual(done.metadata.actionExtraction, { proposed: 1, attributed: 0, restated: 0, limited: false, method: "local-model" });

  fail = true;
  const second = f.service.start(f.input({ purpose: "conversation" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(second.id);
  // The speech model is ready now, so stopping starts processing by itself.
  if (!f.service.processing) await f.service.retry(second.id);
  await f.service.processing.promise;
  const failed = f.catalog.store.get(scopeOf, "recording", second.id);
  assert.equal(failed.transcriptionState, "complete");
  assert.equal(failed.aiState, "failed");
  assert.deepEqual(failed.metadata.actionExtraction, { proposed: 0, failed: true, reason: "MODEL_INVALID" });
});
test("processing attaches detected speakers before the spool is purged, and survives their failure", async (t) => {
  let fail = false;
  let sawAudio = false;
  const diarizer = {
    ready: () => true,
    diarize: async (file) => {
      sawAudio = fs.statSync(file).size > 44;
      if (fail) throw Object.assign(new Error("bad"), { code: "MODEL_INVALID" });
      return [{ speaker: "S1", startMs: 0, endMs: 60000 }];
    },
  };
  const f = await fixture(t, { diarizer });
  const scopeOf = { workspaceId: f.catalog.store.identity.id };
  const record = f.service.start(f.input({ purpose: "conversation" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(record.id);
  f.modelReady();
  await f.service.retry(record.id);
  await f.service.processing.promise;
  assert.equal(sawAudio, true);
  const done = f.catalog.store.get(scopeOf, "recording", record.id);
  assert.equal(done.metadata.diarization.status, "complete");
  const [speaker] = f.catalog.store.list(scopeOf, "speaker", { recordingId: record.id });
  assert.equal(speaker.label, "Speaker 1 · Microphone");
  const segments = f.catalog.store.list(scopeOf, "transcript", { recordingId: record.id });
  assert.ok(segments.length > 0 && segments.every((s) => s.speakerId === speaker.id));

  fail = true;
  const second = f.service.start(f.input({ purpose: "conversation" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(second.id);
  if (!f.service.processing) await f.service.retry(second.id);
  await f.service.processing.promise;
  const failed = f.catalog.store.get(scopeOf, "recording", second.id);
  assert.equal(failed.transcriptionState, "complete");
  assert.deepEqual(failed.metadata.diarization, { status: "failed", reason: "MODEL_INVALID" });
});
test("identifying a speaker re-attributes suggestions and respects scope and processing", async (t) => {
  const diarizer = {
    ready: () => true,
    diarize: async () => [{ speaker: "S1", startMs: 0, endMs: 60000 }],
  };
  const f = await fixture(t, {
    diarizer,
    createEngine: () => ({
      load: async () => {},
      dispose: async () => {},
      transcribe: async () => ({ content: "I will send the signed proposal Friday." }),
    }),
  });
  const scopeOf = { workspaceId: f.catalog.store.identity.id };
  const record = f.service.start(f.input({ purpose: "conversation" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(record.id);
  f.modelReady();
  await f.service.retry(record.id);
  await f.service.processing.promise;
  const [speaker] = f.service.detail(record.workspaceId, record.id).speakers;
  assert.equal(speaker.display, "Speaker 1 · Microphone");
  let [action] = f.catalog.store.list(scopeOf, "action");
  assert.equal(action.owner.kind, "unknown");

  const other = f.catalog.store.createRecording(
    { ...scopeOf, clientRequestId: randomUUID() },
    { purpose: "conversation" },
  );
  await assert.rejects(
    f.service.identifySpeaker(record.workspaceId, other.id, speaker.id, { kind: "self" }),
    { code: "SCOPE_MISMATCH" },
  );
  f.service.processing = { id: record.id };
  await assert.rejects(
    f.service.identifySpeaker(record.workspaceId, record.id, speaker.id, { kind: "self" }),
    { code: "WORKSPACE_BUSY" },
  );
  f.service.processing = null;

  const result = await f.service.identifySpeaker(record.workspaceId, record.id, speaker.id, { kind: "self" });
  assert.equal(result.speaker.identity.kind, "self");
  assert.equal(result.attribution.attributed, 1);
  [action] = f.catalog.store.list(scopeOf, "action");
  assert.equal(action.owner.kind, "self");
  const detail = f.service.detail(record.workspaceId, record.id);
  assert.equal(detail.speakers[0].display, "You");
  assert.ok(detail.transcript.every((line) => line.speaker === "You"));
});
test("worker failure preserves committed transcript segments and retry does not duplicate them", async (t) => {
  let calls = 0,
    fail = true;
  const f = await fixture(t, {
    createEngine: () => ({
      load: async () => {},
      dispose: async () => {},
      transcribe: async () => {
        if (++calls === 2 && fail) throw new Error("worker exited");
        return { content: "Recoverable transcript" };
      },
    }),
  });
  const r = f.service.start(f.input({ sourceMode: "both" }));
  await turn();
  f.sources.microphone.emit("audio", tone());
  f.sources.system.emit("audio", tone());
  await f.service.stop(r.id);
  f.modelReady();
  await f.service.retry(r.id);
  await f.service.processing.promise;
  let detail = f.service.detail(r.workspaceId, r.id);
  assert.equal(detail.recording.transcriptionState, "failed");
  assert.equal(detail.total, 1);
  assert.equal(detail.audio.state, "temporary");
  fail = false;
  await f.service.retry(r.id);
  await f.service.processing.promise;
  detail = f.service.detail(r.workspaceId, r.id);
  assert.equal(detail.total, 2);
  assert.equal(calls, 3);
  assert.equal(detail.recording.transcriptionState, "complete");
});
const deadSource = () => {
  const source = new EventEmitter();
  source.start = async () => { throw new Error("device gone"); };
  source.stop = async () => {};
  return source;
};
test("source loss, sleep and storage failure stop sources while retaining durable audio", async (t) => {
  for (const reason of ["source", "sleep", "disk"]) {
    const f = await fixture(t, { recoveryDelays: [0, 0, 0] });
    const r = f.service.start(f.input());
    await turn();
    f.sources.microphone.emit("audio", tone());
    if (reason === "source") f.service.createSource = deadSource;
    if (reason === "disk") {
      f.service.active.spool.append = () => {
        throw Object.assign(new Error("full"), { code: "ENOSPC" });
      };
      f.sources.microphone.emit("audio", tone());
    } else if (reason === "source")
      f.sources.microphone.emit("error", new Error("device unplugged"));
    else await f.service.stop(r.id, "sleep");
    await until(() => !f.service.active);
    assert.equal(
      f.service.detail(r.workspaceId, r.id).recording.state,
      "interrupted",
    );
    assert.ok(f.sources.microphone.stops);
    assert.equal(
      new Spool(f.catalog.store, r.id).open().scan().bytes,
      reason === "disk" ? CHUNK_BYTES : CHUNK_BYTES + 3200,
    );
    f.sources.microphone.emit("error", new Error("late exit"));
  }
});
test("complete chunk orphaned before manifest commit is recovered; corruption is reported without deletion", async (t) => {
  const f = await fixture(t);
  const r = f.service.start(f.input());
  await turn();
  f.sources.microphone.emit("audio", tone());
  const spool = f.service.active.spool;
  spool.save({ bytes: 0, chunks: 0, durationMs: 0 });
  clearInterval(f.service.active.timer);
  f.service.active.accepting = false;
  f.service.active = null;
  await f.catalog.close();
  await f.catalog.initialize();
  let detail = f.service.detail(r.workspaceId, r.id);
  assert.equal(detail.recording.state, "interrupted");
  assert.equal(detail.audio.bytes, CHUNK_BYTES);
  const recovered = new Spool(f.catalog.store, r.id).open();
  const name = recovered.scan().chunks[0].name;
  const file = path.join(recovered.directory, name);
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.match(recovered.scan().issues.join(), /Unreadable/);
  assert.ok(fs.existsSync(file));
  f.modelReady();
  await f.service.retry(r.id);
  await f.service.processing.promise;
  detail = f.service.detail(r.workspaceId, r.id);
  assert.equal(detail.recording.transcriptionState, "failed");
  assert.equal(detail.audio.state, "temporary");
});
test("explicit discard persists a tombstone and does not erase transcript text", async (t) => {
  const f = await fixture(t);
  const r = f.service.start(f.input());
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(r.id);
  f.catalog.store.createTranscript(
    { workspaceId: r.workspaceId, clientRequestId: randomUUID() },
    {
      recordingId: r.id,
      source: "microphone",
      startMs: 0,
      endMs: 500,
      text: "Keep text",
      speakerId: null,
    },
  );
  f.service.discard(r.id);
  assert.equal(f.service.detail(r.workspaceId, r.id).total, 1);
  assert.equal(f.service.detail(r.workspaceId, r.id).audio.state, "deleted");
  assert.equal(new Spool(f.catalog.store, r.id).open().scan().bytes, 0);
  await assert.rejects(f.service.retry(r.id), { code: "INVALID_INPUT" });
});
test("capabilities enforce the CoreAudio tap minimum without launching any helper", () => {
  assert.equal(
    isSupported({ platform: "darwin", release: "23.1.0" }).ok,
    false,
  );
  assert.equal(isSupported({ platform: "darwin", release: "23.2.0" }).ok, true);
  assert.equal(isSupported({ platform: "darwin", release: "24.0.0" }).ok, true);
  assert.equal(isSupported({ platform: "linux", release: "25.0.0" }).ok, false);
});
test("SIGKILL preserves acknowledged audio and reopens interrupted without starting capture or inference", async (t) => {
  const f = await fixture(t);
  await f.catalog.close();
  const child = require("node:child_process").fork(
    path.join(__dirname, "crash-worker.cjs"),
    [path.join(f.root, "workspaces")],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "";
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exit;
  });
  const message = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error(output)));
  });
  assert.equal(message.error, undefined);
  assert.equal(message.bytes, CHUNK_BYTES);
  child.kill("SIGKILL");
  assert.equal((await exit).signal, "SIGKILL");
  await f.catalog.initialize();
  const detail = f.service.detail(
    message.record.workspaceId,
    message.record.id,
  );
  assert.equal(detail.recording.state, "interrupted");
  assert.equal(detail.audio.bytes, CHUNK_BYTES);
  assert.equal(f.service.busy(), false);
  assert.deepEqual(f.sources, {});
  assert.equal(
    f.catalog.store._db.pragma("integrity_check", { simple: true }),
    "ok",
  );
});
test("cancellation clears worker ownership and preserves audio for retry", async (t) => {
  let rejectInference, began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const f = await fixture(t, {
    createEngine: () => ({
      load: async () => {},
      transcribe: async () => {
        began();
        return new Promise((_resolve, reject) => {
          rejectInference = reject;
        });
      },
      dispose: async () => rejectInference?.(new Error("worker killed")),
    }),
  });
  const r = f.service.start(f.input());
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(r.id);
  f.modelReady();
  await f.service.retry(r.id);
  await started;
  await f.service.cancel(r.id);
  assert.equal(f.service.busy(), false);
  const detail = f.service.detail(r.workspaceId, r.id);
  assert.equal(detail.recording.transcriptionState, "cancelled");
  assert.equal(detail.audio.state, "temporary");
});
test("failed audio deletion remains visibly pending and restart finishes cleanup", async (t) => {
  const f = await fixture(t);
  const r = f.service.start(f.input());
  await turn();
  f.sources.microphone.emit("audio", tone());
  await f.service.stop(r.id);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  try {
    assert.throws(() => f.service.discard(r.id), { code: "EACCES" });
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(
    f.service.detail(r.workspaceId, r.id).audio.state,
    "cleanup-pending",
  );
  const scratch = path.join(
    new Spool(f.catalog.store, r.id).open().directory,
    "scratch",
  );
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, "focusbae-utt-deadbeef.wav"), "private");
  await f.catalog.close();
  await f.catalog.initialize();
  assert.equal(f.service.detail(r.workspaceId, r.id).audio.state, "deleted");
  assert.equal(new Spool(f.catalog.store, r.id).open().scan().bytes, 0);
  assert.equal(
    f.service.detail(r.workspaceId, r.id).recording.transcriptionState,
    "cancelled",
  );
  assert.equal(
    fs.existsSync(path.join(scratch, "focusbae-utt-deadbeef.wav")),
    false,
  );
});
test("spool rejects path substitution, missing sequences and incomplete commits", async (t) => {
  const f = await fixture(t);
  const r = f.service.start(f.input());
  await turn();
  await f.service.stop(r.id);
  const spool = new Spool(f.catalog.store, r.id).open();
  spool.append({
    source: "microphone",
    sequence: 3,
    startMs: 15000,
    pcm: tone(),
  });
  fs.writeFileSync(
    path.join(spool.directory, "microphone-000004.pcm.part"),
    "partial",
  );
  assert.match(spool.scan().issues.join(), /Gap/);
  assert.match(spool.scan().issues.join(), /uncommitted/);
  const real = path.join(spool.directory, "microphone-000000.pcm");
  const link = path.join(spool.directory, "system-000000.pcm");
  fs.symlinkSync(real, link);
  assert.throws(() => spool.read("system-000000.pcm"), { code: "UNSAFE_PATH" });
});

test("a source that fails mid-recording is reopened; audio resumes at recording time and the gap is declared", async (t) => {
  let now = 0;
  const f = await fixture(t, { clock: () => now, recoveryDelays: [0, 0, 0] });
  f.modelReady();
  const r = f.service.start(f.input({ keepAudio: true }));
  await turn();
  now = 5000;
  f.sources.microphone.emit("audio", tone(5));
  const first = f.sources.microphone;
  // AirPods connect at 6 s; the new microphone delivers audio from 8 s.
  now = 8000;
  first.emit("error", new Error("default input changed"));
  await until(() => f.sources.microphone !== first && !f.service.active.recovering.microphone);
  assert.equal(first.stops, 1);
  first.emit("error", new Error("late error from the replaced source"));
  first.emit("audio", tone(1));
  await turn();
  assert.equal(f.service.active.recoveries, 1, "a replaced source cannot trigger recovery again");
  now = 13000;
  f.sources.microphone.emit("audio", tone(5));
  assert.deepEqual(f.service.active.gaps, [{ source: "microphone", fromMs: 5100, toMs: 7900, reason: "device-change" }]);
  await f.service.stop(r.id);
  await until(() => !f.service.busy());
  const detail = f.service.detail(r.workspaceId, r.id);
  assert.equal(detail.recording.state, "captured");
  assert.equal(detail.recording.reason, null);
  assert.deepEqual(detail.recording.issues, []);
  assert.equal(detail.recording.gaps.length, 1);
  assert.equal(detail.recording.transcriptionState, "complete", "a declared gap is not damage");
  const scan = new Spool(f.catalog.store, r.id).open().scan();
  assert.deepEqual(scan.issues, []);
  const resumed = scan.chunks.filter((chunk) => chunk.source === "microphone").map((chunk) => chunk.startMs);
  assert.deepEqual(resumed, [0, 5000, 7900, 12900]);
});

test("a source that stops supplying audio is reopened instead of ending the recording", async (t) => {
  let now = 0;
  const f = await fixture(t, { clock: () => now, recoveryDelays: [0, 0, 0] });
  const r = f.service.start(f.input({ sourceMode: "both" }));
  await turn();
  const stalled = f.sources.system;
  now = 3000;
  f.sources.microphone.emit("audio", tone(0.1));
  now = 6000;
  f.sources.microphone.emit("audio", tone(0.1));
  await until(() => f.sources.system !== stalled);
  await until(() => !f.service.active.recovering.system);
  assert.equal(f.service.current(f.service.active).state, "recording");
  assert.equal(f.service.active.gaps[0].source, "system");
  await f.service.stop(r.id);
  assert.equal(f.service.detail(r.workspaceId, r.id).recording.state, "captured");
});

test("recovery gives up after its bounded attempts and keeps the audio", async (t) => {
  const f = await fixture(t, { recoveryDelays: [0, 0, 0], maxRecoveries: 20 });
  const r = f.service.start(f.input());
  await turn();
  f.sources.microphone.emit("audio", tone());
  let attempts = 0;
  f.service.createSource = () => (attempts++, deadSource());
  f.sources.microphone.emit("error", new Error("unplugged"));
  await until(() => !f.service.active);
  assert.equal(attempts, 3);
  const detail = f.service.detail(r.workspaceId, r.id);
  assert.equal(detail.recording.state, "interrupted");
  assert.match(detail.recording.reason, /stopped supplying audio/);
});

test("the chosen microphone is opened by name, and a failing one falls back to the built-in microphone and stays there", async (t) => {
  let now = 0;
  const f = await fixture(t, { clock: () => now, recoveryDelays: [0, 0, 0] });
  const opened = [];
  const create = f.service.createSource;
  let failing = 0;
  f.service.createSource = (kind, options) => {
    opened.push(options);
    return failing-- > 0 ? deadSource() : create(kind);
  };
  assert.throws(() => f.service.start(f.input({ microphone: 5 })), { code: "INVALID_INPUT" });
  const r = f.service.start(f.input({ microphone: "AirPods Pro" }));
  await turn();
  assert.deepEqual(opened, [{ prefer: "AirPods Pro" }]);
  f.sources.microphone.emit("device", "AirPods Pro");
  now = 5000;
  f.sources.microphone.emit("audio", tone(5));
  // The headset stops; it fails twice more, so the third try is the Mac's own.
  failing = 2;
  f.sources.microphone.emit("error", new Error("headset gone"));
  await until(() => opened.length === 4 && !f.service.active.recovering.microphone);
  assert.deepEqual(opened.slice(1), [{ prefer: "AirPods Pro" }, { prefer: "AirPods Pro" }, { fallback: true }]);
  f.sources.microphone.emit("device", "MacBook Air Microphone (Built-in)");
  f.sources.microphone.emit("error", new Error("default input changed again"));
  await until(() => opened.length === 5 && !f.service.active.recovering.microphone);
  assert.deepEqual(opened[4], { fallback: true }, "stays on the built-in microphone");
  await f.service.stop(r.id);
  assert.deepEqual(f.service.detail(r.workspaceId, r.id).recording.microphones,
    ["AirPods Pro", "MacBook Air Microphone (Built-in)"]);
});

test("a microphone that never delivers audio at the start is retried once as the built-in microphone", async (t) => {
  const f = await fixture(t, { startTimeout: 50 });
  const opened = [];
  const create = f.service.createSource;
  f.service.createSource = (kind, options) => {
    opened.push(options);
    if (options.fallback) return create(kind);
    const silent = new EventEmitter();
    silent.start = async () => {};
    silent.stop = async () => { silent.stops = (silent.stops ?? 0) + 1; };
    return silent;
  };
  const r = f.service.start(f.input());
  await until(() => f.service.active && f.service.current(f.service.active).state === "recording");
  assert.deepEqual(opened, [{ prefer: null }, { fallback: true }]);
  await f.service.stop(r.id);
  assert.equal(f.service.detail(r.workspaceId, r.id).recording.state, "captured");
});

test("a recording chosen for cloud transcription uses Deepgram while allowed, and this Mac once it is not", async (t) => {
  const { LocalPolicy } = require("../../privacy/local-policy");
  const policy = new LocalPolicy();
  policy.setTeamConnected(true);
  let allowed = false;
  const sent = [];
  const cloud = {
    policy,
    token: async () => ({ accessToken: "short-lived", expiresAt: new Date(Date.now() + 600000).toISOString() }),
    fetchImpl: async (url, init) => {
      sent.push(init.headers.authorization);
      return { ok: true, status: 200, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: "Words from Deepgram" }] }] } }) };
    },
  };
  const f = await fixture(t, { cloudSpeech: () => (allowed ? cloud : null), cloudAI: () => null });
  assert.throws(() => f.service.start(f.input({ processing: "cloud" })), { code: "CLOUD_UNAVAILABLE" });

  allowed = true; // no on-device model is needed for the cloud
  const record = f.service.start(f.input({ processing: "cloud" }));
  await turn();
  f.sources.microphone.emit("audio", tone(5));
  await f.service.stop(record.id);
  await until(() => !f.service.busy());
  const detail = f.service.detail(record.workspaceId, record.id);
  assert.equal(detail.recording.processing, "cloud");
  assert.equal(detail.recording.transcriptionState, "complete");
  assert.ok(detail.transcript.every((s) => s.text === "Words from Deepgram"));
  assert.ok(sent.length > 0 && sent.every((h) => h === "Bearer short-lived"));
  assert.equal(f.calls(), 0, "the on-device engine was not used");

  f.modelReady();
  const sentBefore = sent.length;
  const later = f.service.start(f.input({ processing: "cloud" }));
  await turn();
  f.sources.microphone.emit("audio", tone(5));
  allowed = false; // signed out, Strict Local, or the admin lowered the level meanwhile
  await f.service.stop(later.id);
  await until(() => !f.service.busy());
  const fallback = f.service.detail(later.workspaceId, later.id);
  assert.match(fallback.recording.processingNote, /wasn't available, so this Mac/);
  assert.ok(f.calls() > 0, "transcribed on this Mac instead");
  assert.equal(sent.length, sentBefore, "and nothing more went to Deepgram");
});

test("cloud AI (level 2) finds commitments in the transcript text, and this Mac takes over if it fails", async (t) => {
  const asked = [];
  let fail = false;
  const cloudAI = {
    origin: "cloud-model",
    extract: async ({ owner, segments }) => {
      asked.push({ owner, count: segments.length });
      if (fail) throw Object.assign(new Error("Cloud AI is unavailable"), { code: "REMOTE" });
      return [{ segmentId: segments[0].id, quote: "I will send the deck on Friday", owner: "unknown", person: "" }];
    },
  };
  const f = await fixture(t, { cloudAI: () => cloudAI, createEngine: () => ({
    load: async () => {}, dispose: async () => {},
    transcribe: async () => ({ content: "I will send the deck on Friday." }),
  }) });
  f.modelReady();
  const run = async () => {
    const record = f.service.start(f.input({ processing: "cloud-ai", purpose: "conversation" }));
    await turn();
    f.sources.microphone.emit("audio", tone(5));
    await f.service.stop(record.id);
    await until(() => !f.service.busy());
    return f.service.detail(record.workspaceId, record.id);
  };
  const detail = await run();
  assert.equal(detail.recording.processing, "cloud-ai");
  assert.ok(asked.length >= 1, "the transcript text went to the cloud extractor");
  const store = f.catalog.store;
  const origins = store._db.prepare("SELECT json_extract(data_json, '$.origin') AS origin FROM actions").all().map((r) => r.origin);
  assert.ok(origins.includes("cloud-model"), `suggestions are marked as cloud: ${origins}`);
  assert.equal(detail.recording.processingNote, null);

  fail = true;
  const fallback = await run();
  assert.match(fallback.recording.processingNote, /Cloud AI didn't finish, so this Mac found the commitments/);
  assert.equal(fallback.recording.aiState, "complete");
});

test("Share with: a recording keeps the team chosen for it, Only me by default", async (t) => {
  const targets = { privateSpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", options: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "private", name: "My notes" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "custom", name: "Sales" },
  ] };
  const f = await fixture(t, { teamSpaces: () => targets });
  f.modelReady();
  const plain = f.service.start(f.input());
  assert.equal(plain.shareWith, null, "Only me unless chosen");
  await f.service.stop(plain.id);
  await until(() => !f.service.busy());
  assert.throws(() => f.service.start(f.input({ shareWith: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })), /can't share with that team/);
  const sales = f.service.start(f.input({ shareWith: targets.options[1].id }));
  assert.equal(sales.shareWith, targets.options[1].id);
  await f.service.stop(sales.id);
  await until(() => !f.service.busy());
  const moved = f.service.setShareWith(plain.workspaceId, plain.id, targets.privateSpaceId);
  assert.equal(moved.shareWith, null, "My notes is stored as Only me");
  assert.equal(f.service.setShareWith(plain.workspaceId, plain.id, targets.options[1].id).shareWith, targets.options[1].id);
});

test("Share with is refused outside team workspaces", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.start(f.input({ shareWith: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })), /can't share with that team/);
});
