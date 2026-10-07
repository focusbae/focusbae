"use strict";
// Local speech engines for the local-first pipeline (docs/benchmarks/speech.md, decision D-06):
//   English: Parakeet when the user downloaded it, otherwise Apple SpeechAnalyzer (en-US).
//   Hindi and mixed: Apple SpeechAnalyzer (hi-IN, Latin-script output).
// Apple requires macOS 26+. There is no Whisper fallback in this pipeline.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const files = require("../workspace/files");
const { check, WorkspaceError } = require("../workspace/errors");
const { wavHeader } = require("./diarize");
const { FluidModel, run, whilePermitted, BIN } = require("../local-ai/fluid-model");

const APPLE_BINARY = path
  .join(__dirname, "../meeting-capture/bin/focusbae-transcribe")
  .replace("app.asar/", "app.asar.unpacked/");
const LOCALES = { english: "en-US", hindi: "hi-IN", mixed: "hi-IN" };
const LANGUAGES = Object.keys(LOCALES);

// A helper process that answers one JSON request per stdin line. The first line it
// prints is readiness ({"ok":true}) or the reason it cannot start.
class LineHelper {
  constructor(binary, args, { timeoutMs = 120000, env } = {}) {
    Object.assign(this, { binary, args, timeoutMs, env });
    this.pending = new Map();
    this.buffer = "";
  }
  start() {
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = (error) => {
        for (const { reject: rejectPending, timer } of this.pending.values()) {
          clearTimeout(timer);
          rejectPending(error);
        }
        this.pending.clear();
        if (!ready) reject(error);
      };
      try {
        this.child = spawn(this.binary, this.args, { stdio: ["pipe", "pipe", "ignore"], env: this.env });
      } catch {
        reject(new WorkspaceError("MODEL_MISSING", "Speech engine is unavailable"));
        return;
      }
      this.exited = new Promise((done) => this.child.once("close", done));
      this.child.once("error", () => fail(new WorkspaceError("MODEL_MISSING", "Speech engine is unavailable")));
      this.child.once("close", () => fail(new WorkspaceError("WORKER_EXIT", "Speech engine stopped")));
      this.child.stdin.on("error", () => {});
      this.child.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString("utf8");
        if (this.buffer.length > 4 * 1024 * 1024) {
          this.child.kill("SIGKILL");
          return;
        }
        let index;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (!ready) {
            ready = true;
            if (message.ok) resolve();
            else {
              const code = ["ASSET_MISSING", "MODEL_MISSING", "UNSUPPORTED"].includes(message.code) ? "MODEL_MISSING" : "TRANSCRIPTION_FAILED";
              reject(new WorkspaceError(code, "Speech engine could not start"));
              this.child.kill();
            }
            continue;
          }
          const waiting = this.pending.get(message.id);
          if (!waiting) continue;
          this.pending.delete(message.id);
          clearTimeout(waiting.timer);
          message.ok
            ? waiting.resolve(message)
            : waiting.reject(new WorkspaceError("TRANSCRIPTION_FAILED", "Local speech processing failed. Saved audio is kept."));
        }
      });
    });
  }
  request(body) {
    check(this.child && this.child.exitCode === null, "WORKER_EXIT", "Speech engine stopped");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill("SIGKILL");
        reject(new WorkspaceError("WORKER_TIMEOUT", "Speech engine timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...body, id }) + "\n");
    });
  }
  async dispose() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    const force = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    await this.exited;
    clearTimeout(force);
  }
}

// Transcribes utterances by writing each to a private temporary WAV beside the
// spool, sending it to a helper, and deleting it.
class HelperEngine {
  constructor({ binary, args, directory, engine, model }) {
    Object.assign(this, { directory, engine, model });
    this.helper = new LineHelper(binary, args, { env: { HOME: os.homedir(), TMPDIR: os.tmpdir(), PATH: "/usr/bin:/bin" } });
  }
  async load() {
    this.scratch = path.join(this.directory, "scratch");
    files.privateDirectory(this.scratch);
    await this.helper.start();
  }
  async transcribe(utterance) {
    const pcm = Buffer.from(utterance.pcm);
    check(pcm.length > 0 && pcm.length <= 900000 && pcm.length % 2 === 0, "INVALID_AUDIO", "Invalid speech audio");
    const file = path.join(this.scratch, `${randomUUID()}.wav`);
    fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]), { mode: 0o600, flag: "wx" });
    try {
      const result = await this.helper.request({ wav: file });
      return { content: result.text ?? "" };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  dispose() {
    return this.helper.dispose();
  }
}

// Apple SpeechAnalyzer availability. Locale state is only known after a probe,
// which launches the helper, so probing happens on demand (settings, recording),
// never at app startup. Installing a language asset is an explicit user action.
class AppleSpeech extends EventEmitter {
  constructor({ binary = APPLE_BINARY, network = require("../privacy/local-network"), release = os.release } = {}) {
    super();
    Object.assign(this, { binary, network, release });
    this.locales = {};
    this.installing = null;
  }
  supported() {
    return process.platform === "darwin" && Number(this.release().split(".")[0]) >= 25 && fs.existsSync(this.binary);
  }
  ready(locale) {
    return this.supported() && this.locales[locale] === "installed";
  }
  probed() {
    return Object.keys(this.locales).length > 0;
  }
  async refresh() {
    if (!this.supported()) return this.state();
    try {
      const result = await run(this.binary, ["--status"], 30000);
      this.locales = result.locales ?? {};
    } catch {
      this.locales = {};
    }
    this.emit("change");
    return this.state();
  }
  async install(locale) {
    check(Object.values(LOCALES).includes(locale), "INVALID_INPUT", "Unsupported language");
    check(this.supported(), "MODEL_INCOMPATIBLE", "Apple speech requires macOS 26 or later");
    check(!this.installing, "WORKSPACE_BUSY", "A language is already being installed");
    this.network.assert("models");
    this.installing = locale;
    this.emit("change");
    const permission = whilePermitted(this.network, "models");
    try {
      await run(this.binary, ["--install", locale], 30 * 60 * 1000, permission);
    } finally {
      permission.release();
      this.installing = null;
      await this.refresh();
    }
    return this.state();
  }
  state() {
    return { supported: this.supported(), probed: this.probed(), locales: { ...this.locales }, installing: this.installing };
  }
  engine(locale, directory) {
    return new HelperEngine({ binary: this.binary, args: ["--serve", locale], directory, engine: "apple-speech", model: `apple-${locale}` });
  }
}

class ParakeetModel extends FluidModel {
  constructor({
    binary = path.join(BIN, "focusbae-asr"),
    root = path.join(os.homedir(), ".focusbae", "models", "asr"),
    manifest = require("../local-ai/fluid-helpers/manifests/parakeet-tdt-0.6b-v3.json"),
    ...options
  } = {}) {
    super({ binary, root, manifest, ...options });
  }
  engine(directory) {
    return new HelperEngine({
      binary: this.binary,
      args: ["serve", "--models", this.root],
      directory,
      engine: "parakeet",
      model: this.manifest.name,
    });
  }
}

class SpeechRouter {
  constructor({ apple = new AppleSpeech(), parakeet = new ParakeetModel() } = {}) {
    Object.assign(this, { apple, parakeet });
  }
  choose(language) {
    check(LANGUAGES.includes(language), "INVALID_INPUT", "Unsupported language");
    if (language === "english" && this.parakeet.ready()) return { engine: "parakeet", model: this.parakeet.manifest.name };
    const locale = LOCALES[language];
    if (this.apple.ready(locale)) return { engine: "apple-speech", model: `apple-${locale}`, locale };
    return null;
  }
  // Summary for status displays; never launches a helper.
  state(language = "english") {
    const languages = Object.fromEntries(
      LANGUAGES.map((name) => {
        const choice = this.choose(name);
        return [name, { ready: !!choice, engine: choice?.engine ?? null }];
      }),
    );
    const choice = this.choose(language);
    return { ready: !!choice, model: choice?.model ?? null, engine: choice?.engine ?? null, languages };
  }
  // Called before processing: probes Apple locale state if it has not been read yet.
  async prepare() {
    if (this.apple.supported() && !this.apple.probed()) await this.apple.refresh();
  }
  createEngine({ language, directory }) {
    const choice = this.choose(language);
    if (!choice)
      throw new WorkspaceError("MODEL_MISSING", "Transcription needs Apple speech (macOS 26) or the Parakeet download");
    return choice.engine === "parakeet" ? this.parakeet.engine(directory) : this.apple.engine(choice.locale, directory);
  }
}

module.exports = { LineHelper, HelperEngine, AppleSpeech, ParakeetModel, SpeechRouter, LOCALES };
