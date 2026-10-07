"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { LineHelper, HelperEngine, AppleSpeech, SpeechRouter } = require("../../recording/speech");
const { LocalPolicy: Policy } = require("../../privacy/local-policy");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-speech-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake helper written in Node so tests do not need the Swift binaries.
function fakeHelper(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}
const SERVE = `
const fs = require("fs");
const mode = process.argv[2];
if (mode === "--missing") { console.log(JSON.stringify({ ok: false, code: "ASSET_MISSING" })); process.exit(3); }
console.log(JSON.stringify({ ok: true }));
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, wav } = JSON.parse(line);
  if (mode === "--crash") process.exit(9);
  if (mode === "--hang") return;
  const bytes = fs.statSync(wav).size;
  const header = fs.readFileSync(wav).subarray(0, 4).toString();
  console.log(JSON.stringify(bytes > 100 ? { id, ok: true, text: header + " " + bytes } : { id, ok: false, code: "FAILED" }));
});`;

test("helper engine writes private temporary WAVs, maps replies, and cleans up", async (t) => {
  const dir = tempDir(t);
  const binary = fakeHelper(dir, "serve", SERVE);
  const engine = new HelperEngine({ binary, args: ["--ok"], directory: dir, engine: "fake", model: "fake-1" });
  await engine.load();
  const first = engine.transcribe({ pcm: Buffer.alloc(3200) });
  const second = engine.transcribe({ pcm: Buffer.alloc(6400) });
  assert.deepEqual(await Promise.all([first, second]), [{ content: "RIFF 3244" }, { content: "RIFF 6444" }]);
  await assert.rejects(engine.transcribe({ pcm: Buffer.alloc(20) }), { code: "TRANSCRIPTION_FAILED" });
  await assert.rejects(engine.transcribe({ pcm: Buffer.alloc(3) }), { code: "INVALID_AUDIO" });
  assert.deepEqual(fs.readdirSync(path.join(dir, "scratch")), []);
  assert.equal(fs.statSync(path.join(dir, "scratch")).mode & 0o777, 0o700);
  await engine.dispose();
  await engine.dispose();
  await assert.rejects(engine.transcribe({ pcm: Buffer.alloc(3200) }), { code: "WORKER_EXIT" });
});

test("helper start failures, crashes and timeouts become typed errors", async (t) => {
  const dir = tempDir(t);
  const binary = fakeHelper(dir, "serve", SERVE);
  await assert.rejects(new LineHelper(binary, ["--missing"]).start(), { code: "MODEL_MISSING" });
  await assert.rejects(new LineHelper(path.join(dir, "absent"), []).start(), { code: "MODEL_MISSING" });

  const crash = new LineHelper(binary, ["--crash"]);
  await crash.start();
  await assert.rejects(crash.request({ wav: binary }), { code: "WORKER_EXIT" });

  const hang = new LineHelper(binary, ["--hang"], { timeoutMs: 200 });
  await hang.start();
  await assert.rejects(hang.request({ wav: binary }), { code: "WORKER_TIMEOUT" });
  await hang.dispose();
});

class FakeApple extends EventEmitter {
  constructor(locales = {}, supported = true) {
    super();
    this.locales = locales;
    this.isSupported = supported;
    this.probes = 0;
  }
  supported() { return this.isSupported; }
  probed() { return this.probes > 0; }
  ready(locale) { return this.isSupported && this.locales[locale] === "installed"; }
  async refresh() { this.probes++; }
  state() { return { supported: this.isSupported, locales: this.locales }; }
  engine(locale) { return { engine: "apple-speech", locale }; }
}
const fakeParakeet = (ready) => Object.assign(new EventEmitter(), {
  ready: () => ready,
  manifest: { name: "parakeet-tdt-0.6b-v3" },
  engine: () => ({ engine: "parakeet" }),
});

test("routing: Parakeet for English when installed, Apple otherwise, no Whisper", async () => {
  const apple = new FakeApple({ "en-US": "installed", "hi-IN": "supported" });
  let router = new SpeechRouter({ apple, parakeet: fakeParakeet(true) });
  assert.equal(router.choose("english").engine, "parakeet");
  assert.equal(router.choose("hindi"), null, "Hindi needs its Apple language asset");
  assert.equal(router.createEngine({ language: "english", directory: "/x" }).engine, "parakeet");
  assert.throws(() => router.createEngine({ language: "mixed", directory: "/x" }), { code: "MODEL_MISSING" });

  apple.locales["hi-IN"] = "installed";
  router = new SpeechRouter({ apple, parakeet: fakeParakeet(false) });
  assert.deepEqual(router.choose("english"), { engine: "apple-speech", model: "apple-en-US", locale: "en-US" });
  assert.equal(router.createEngine({ language: "mixed", directory: "/x" }).locale, "hi-IN");
  assert.deepEqual(router.state("hindi").languages, {
    english: { ready: true, engine: "apple-speech" },
    hindi: { ready: true, engine: "apple-speech" },
    mixed: { ready: true, engine: "apple-speech" },
  });

  // Before macOS 26 only Parakeet English is possible.
  const old = new SpeechRouter({ apple: new FakeApple({}, false), parakeet: fakeParakeet(true) });
  assert.equal(old.choose("english").engine, "parakeet");
  assert.equal(old.choose("hindi"), null);
  assert.throws(() => old.choose("french"), { code: "INVALID_INPUT" });

  // Probing happens once, on demand, and never for unsupported systems.
  const lazy = new FakeApple({});
  const router2 = new SpeechRouter({ apple: lazy, parakeet: fakeParakeet(false) });
  router2.state();
  assert.equal(lazy.probes, 0);
  await router2.prepare();
  await router2.prepare();
  assert.equal(lazy.probes, 1);
  const unsupported = new FakeApple({}, false);
  await new SpeechRouter({ apple: unsupported, parakeet: fakeParakeet(false) }).prepare();
  assert.equal(unsupported.probes, 0);
});

test("Apple language install requires model permission and reports real state", async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, "log");
  const binary = fakeHelper(dir, "apple", `
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
const installed = fs.existsSync(${JSON.stringify(path.join(dir, "hi"))});
if (process.argv[2] === "--status") console.log(JSON.stringify({ ok: true, locales: { "en-US": "installed", "hi-IN": installed ? "installed" : "supported" } }));
else if (process.argv[2] === "--install") { fs.writeFileSync(${JSON.stringify(path.join(dir, "hi"))}, ""); console.log(JSON.stringify({ ok: true })); }`);
  const strict = new Policy({ strict: true });
  const denied = new AppleSpeech({ binary, release: () => "25.0.0", network: { assert: (p) => strict.assert(p) } });
  assert.equal(denied.supported(), true);
  assert.equal(denied.ready("en-US"), false, "unknown until probed");
  await denied.refresh();
  assert.equal(denied.ready("en-US"), true);
  assert.equal(denied.ready("hi-IN"), false);
  await assert.rejects(denied.install("hi-IN"), { code: "POLICY_DENIED" });
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /--install/);
  await assert.rejects(denied.install("fr-FR"), { code: "INVALID_INPUT" });

  const open = new Policy();
  open.authorize("models");
  const allowed = new AppleSpeech({ binary, release: () => "25.0.0", network: { assert: (p) => open.assert(p) } });
  const state = await allowed.install("hi-IN");
  assert.equal(state.locales["hi-IN"], "installed");
  assert.equal(allowed.ready("hi-IN"), true);

  const tahoeOnly = new AppleSpeech({ binary, release: () => "24.6.0" });
  assert.equal(tahoeOnly.supported(), false);
  await assert.rejects(tahoeOnly.install("hi-IN"), { code: "MODEL_INCOMPATIBLE" });
});
