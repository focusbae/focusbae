"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const files = require("../workspace/files");
const { check, WorkspaceError } = require("../workspace/errors");

const BIN = path.join(__dirname, "bin").replace("app.asar/", "app.asar.unpacked/");

// Runs a helper command that prints one JSON object and exits. An aborted signal
// kills the helper and rejects with the signal's reason.
function run(binary, args, timeoutMs, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"] });
    const stdout = [];
    let size = 0;
    let settled = false;
    let finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new WorkspaceError("MODEL_TIMEOUT", "Local model timed out"));
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = finish;
    finish = (error, value) => {
      signal?.removeEventListener("abort", onAbort);
      done(error, value);
    };
    child.once("error", () => finish(new WorkspaceError("MODEL_MISSING", "Local model helper is unavailable")));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new WorkspaceError("MODEL_INVALID", "Local model response is too large"));
      } else stdout.push(chunk);
    });
    child.once("close", () => {
      if (settled) return;
      try {
        const lines = Buffer.concat(stdout).toString("utf8").trim().split("\n");
        const result = JSON.parse(lines.at(-1));
        if (!result.ok) {
          const code = ["MODEL_MISSING", "DOWNLOAD_FAILED", "ASSET_MISSING", "UNSUPPORTED", "INSTALL_FAILED"].includes(result.code)
            ? result.code
            : "MODEL_INVALID";
          throw new WorkspaceError(code, "Local model helper failed");
        }
        finish(null, result);
      } catch (error) {
        finish(error.code ? error : new WorkspaceError("MODEL_INVALID", "Local model response is invalid"));
      }
    });
  });
}

// Aborts while the models permission is withdrawn (revoked, or Strict Local on):
// a download in progress must stop, not finish in the background.
function whilePermitted(network, purpose) {
  const controller = new AbortController();
  const policy = network.policy?.();
  const check = () => {
    if (!network.allows?.(purpose) && !controller.signal.aborted)
      controller.abort(new WorkspaceError("POLICY_DENIED", "Model downloads are not permitted"));
  };
  policy?.on?.("change", check);
  return { signal: controller.signal, release: () => policy?.removeListener?.("change", check) };
}

// Verifies every pinned file by size and SHA-256. Extra, missing, changed or
// linked files are rejected, so a partial or tampered directory is never ready.
function verifyTree(directory, manifest) {
  check(files.inspect(directory, true), "MODEL_MISSING", `${manifest.title} is not installed`);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const seen = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(directory, full);
      check(!entry.isSymbolicLink(), "MODEL_INVALID", `${manifest.title} contains a link`);
      if (entry.isDirectory()) walk(full);
      else {
        const want = expected.get(relative);
        check(want && entry.isFile(), "MODEL_INVALID", `Unexpected ${manifest.title} file`);
        check(
          fs.statSync(full).size === want.bytes && files.fileHash(full) === want.sha256,
          "MODEL_INVALID",
          `${manifest.title} checksum does not match`,
        );
        seen.add(relative);
      }
    }
  };
  walk(directory);
  check(seen.size === expected.size, "MODEL_MISSING", `${manifest.title} is incomplete`);
  return true;
}

// A pinned multi-file model installed under <root>/<manifest.name>. Downloads and
// imports go to private staging and are published only when every file verifies.
class FluidModel extends EventEmitter {
  constructor({ manifest, binary, root, network = require("../privacy/local-network"), timeoutMs = 30 * 60 * 1000 }) {
    super();
    Object.assign(this, { manifest, binary: binary ?? path.join(BIN, "missing"), root, network, timeoutMs });
    this.status = "missing";
    this.error = null;
    this.job = null;
  }

  get modelDirectory() {
    return path.join(this.root, this.manifest.name);
  }

  available() {
    return process.platform === "darwin" && process.arch === "arm64" && fs.existsSync(this.binary);
  }

  verify() {
    if (!this.available()) {
      this.status = "unsupported";
    } else {
      try {
        verifyTree(this.modelDirectory, this.manifest);
        this.status = "ready";
        this.error = null;
      } catch (error) {
        this.status = error.code === "MODEL_MISSING" ? "missing" : "invalid";
        this.error = error.code === "MODEL_MISSING" ? null : error.code;
      }
    }
    this.emit("change");
    return this.status === "ready";
  }

  ready() {
    return this.status === "ready";
  }

  busy() {
    return !!this.job;
  }

  state() {
    return {
      status: this.status,
      ready: this.ready(),
      busy: this.busy(),
      error: this.error,
      model: this.manifest.name,
      title: this.manifest.title,
      license: this.manifest.license,
      bytes: this.manifest.bytes,
    };
  }

  _install(label, fill) {
    if (this.job) return this.job;
    check(this.available(), "MODEL_INCOMPATIBLE", `${this.manifest.title} requires Apple Silicon`);
    this.job = (async () => {
      this.status = label;
      this.error = null;
      this.emit("change");
      files.privateDirectory(this.root);
      const staging = fs.mkdtempSync(path.join(this.root, ".staging-"));
      try {
        const staged = await fill(staging);
        verifyTree(staged, this.manifest);
        fs.rmSync(this.modelDirectory, { recursive: true, force: true });
        fs.renameSync(staged, this.modelDirectory);
        files.flushDirectory(this.root);
      } catch (error) {
        this.status = "error";
        this.error = error.code ?? "INSTALL_FAILED";
        this.emit("change");
        throw error;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        this.job = null;
      }
      return this.verify();
    })();
    return this.job;
  }

  // The only networked path for this model; requires the models permission.
  download() {
    if (this.job) return this.job;
    this.network.assert("models");
    return this._install("downloading", async (staging) => {
      const permission = whilePermitted(this.network, "models");
      try {
        await run(this.binary, ["download", "--models", staging], this.timeoutMs, permission);
      } finally {
        permission.release();
      }
      return path.join(staging, this.manifest.name);
    });
  }

  // Offline install from a folder the user chose: the model folder itself or its parent.
  importFrom(source) {
    check(typeof source === "string" && path.isAbsolute(source), "INVALID_INPUT", "Choose a model folder");
    const candidate = path.basename(source) === this.manifest.name ? source : path.join(source, this.manifest.name);
    verifyTree(candidate, this.manifest);
    return this._install("importing", async (staging) => {
      const target = path.join(staging, this.manifest.name);
      fs.cpSync(candidate, target, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      return target;
    });
  }
}

module.exports = { FluidModel, run, verifyTree, whilePermitted, BIN };
