"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ModelManager } = require("../../recording/model-manager");

test("model manager reports speech routes and gates setup while processing", async (t) => {
  const { SpeechRouter } = require("../../recording/speech");
  const source = () => Object.assign(new EventEmitter(), {
    status: "missing",
    started: 0,
    imported: [],
    ready() { return this.status === "ready"; },
    busy: () => false,
    verify() { return this.ready(); },
    state() { return { status: this.status, ready: this.ready() }; },
    download() { this.started++; this.status = "downloading"; this.emit("change"); return Promise.resolve(true); },
    importFrom(folder) { this.imported.push(folder); return Promise.resolve(true); },
    manifest: { name: "parakeet-tdt-0.6b-v3" },
  });
  const apple = Object.assign(new EventEmitter(), {
    locales: {},
    probes: 0,
    installs: [],
    supported: () => true,
    probed() { return this.probes > 0; },
    ready(locale) { return this.locales[locale] === "installed"; },
    async refresh() { this.probes++; this.locales = { "en-US": "installed", "hi-IN": "supported" }; },
    async install(locale) { this.installs.push(locale); },
    state() { return { supported: true, locales: this.locales }; },
  });
  const parakeet = source();
  const diarization = source();
  let inUse = false;
  let probes = 0;
  const manager = new ModelManager({
    speech: new SpeechRouter({ apple, parakeet }),
    inUse: () => inUse,
    extraction: { status: async () => (probes++, { available: true, reason: null }) },
    embedding: { status: async () => (probes++, { available: false, reason: "MODEL_MISSING" }) },
    diarization,
  });
  t.after(() => manager.close());
  let snapshot = manager.snapshot();
  assert.equal(snapshot.speech.ready, false);
  assert.equal(snapshot.embedding.status, "checking");
  assert.equal(probes + apple.probes, 0, "snapshots never launch helpers");

  snapshot = await manager.refresh();
  assert.equal(apple.probes, 1);
  assert.equal(probes, 2);
  assert.deepEqual(snapshot.speech.languages, {
    english: { ready: true, engine: "apple-speech" },
    hindi: { ready: false, engine: null },
    mixed: { ready: false, engine: null },
  });
  assert.equal(snapshot.generation.engine, "apple-foundation-models");
  assert.equal(snapshot.embedding.status, "unavailable");

  let changes = 0;
  manager.on("change", () => changes++);
  manager.start("parakeet");
  manager.start("speakers");
  assert.equal(parakeet.started + diarization.started, 2);
  assert.equal(changes, 2);
  manager.importModel("parakeet", "/models/parakeet");
  assert.deepEqual(parakeet.imported, ["/models/parakeet"]);
  manager.installLanguage("hi-IN");
  assert.deepEqual(apple.installs, ["hi-IN"]);
  assert.throws(() => manager.start("whisper"), { code: "MODEL_INCOMPATIBLE" });

  parakeet.status = "ready";
  assert.equal(manager.snapshot().speech.languages.english.engine, "parakeet");

  inUse = true;
  for (const call of [() => manager.start("parakeet"), () => manager.importModel("speakers", "/x"), () => manager.installLanguage("hi-IN")])
    assert.throws(call, { code: "WORKSPACE_BUSY" });
});
