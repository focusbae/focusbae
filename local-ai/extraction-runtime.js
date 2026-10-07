"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { check, WorkspaceError } = require("../workspace/errors");

// Apple's on-device model has a 4,096-token context shared by instructions, the
// output schema, the input AND the answer. A 6,000-character chunk dense with
// commitments made the answer overflow after ~80 s on an 8 GB M1 ("Content contains
// 4098 tokens, which exceeds the maximum allowed context size of 4096"), and the
// whole chunk was lost. ~1,800 characters answered in 8-15 s on the same Mac.
const CHUNK_CHARS = 1800;

function batches(segments, limit = CHUNK_CHARS) {
  const result = [];
  let current = [];
  let size = 0;
  for (const segment of segments) {
    const length = segment.text.length + 40;
    if (current.length && size + length > limit) {
      result.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += length;
  }
  if (current.length) result.push(current);
  return result;
}

class ExtractionRuntime {
  constructor({
    binary = path.join(__dirname, "bin", "focusbae-extract").replace("app.asar/", "app.asar.unpacked/"),
    timeoutMs = 120000,
    chunkChars = CHUNK_CHARS,
  } = {}) {
    Object.assign(this, { binary, timeoutMs, chunkChars });
  }

  // Reports whether Apple's on-device model can run now (installed helper, macOS 26+,
  // Apple Intelligence enabled). Never throws.
  status() {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.binary, ["--status"], { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve({ available: false, reason: "MODEL_MISSING" });
        return;
      }
      const out = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ available: false, reason: "MODEL_MISSING" });
      });
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.once("close", () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(Buffer.concat(out).toString("utf8"));
          resolve(result.ok ? { available: true, reason: null } : { available: false, reason: "UNAVAILABLE" });
        } catch {
          resolve({ available: false, reason: "UNAVAILABLE" });
        }
      });
    });
  }

  // Numbers are the facts a rewrite must not lose: an amount, a date, a room
  // number. Thousands separators may be added or dropped, nothing else.
  static numbers(text) {
    return (String(text).replace(/(\d)[,\u00a0 ](?=\d{3}(?!\d))/g, "$1").match(/\d+/g) ?? []).sort();
  }

  // Rewrites a passage with the same on-device model. The answer is prose, so it is
  // checked rather than schema-constrained: a rewrite that drops a number is
  // refused, because silently changing an amount is worse than not rewriting.
  async rewrite({ style, text }) {
    check(
      ["tidy", "proofread", "shorten"].includes(style),
      "INVALID_INPUT",
      "Unknown rewrite style",
    );
    check(
      typeof text === "string" && text.trim() && text.length <= 8000,
      "INVALID_INPUT",
      "Select between one character and 8000 to rewrite",
    );
    const answer = await this._run({ style, text }, ["--rewrite"], (result) => {
      check(typeof result.text === "string" && result.text.trim(), "MODEL_INVALID", "Empty rewrite");
      return result.text;
    });
    const before = ExtractionRuntime.numbers(text);
    const after = new Set(ExtractionRuntime.numbers(answer));
    check(
      before.every((value) => after.has(value)),
      "REWRITE_UNSAFE",
      "The rewrite dropped a number",
    );
    return answer;
  }

  _run(request, args = [], read = null) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ["pipe", "pipe", "ignore"] });
      const stdout = [];
      let size = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new WorkspaceError("MODEL_TIMEOUT", "Local extraction timed out"));
      }, this.timeoutMs);
      child.once("error", () =>
        finish(
          new WorkspaceError(
            args.includes("--rewrite") ? "REWRITE_UNAVAILABLE" : "MODEL_MISSING",
            "The on-device helper is unavailable",
          ),
        ),
      );
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          child.kill("SIGKILL");
          finish(new WorkspaceError("MODEL_INVALID", "Extraction response is too large"));
        } else stdout.push(chunk);
      });
      child.once("close", () => {
        if (settled) return;
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          if (!result.ok && /context size/i.test(String(result.error ?? "")))
            throw new WorkspaceError("MODEL_CONTEXT", "Too much text for the on-device model at once");
          if (!result.ok)
            throw new WorkspaceError(
              result.code !== "UNAVAILABLE"
                ? "MODEL_INVALID"
                : args.includes("--rewrite")
                  ? "REWRITE_UNAVAILABLE"
                  : "MODEL_MISSING",
              "The on-device helper could not answer",
            );
          if (read) return finish(null, read(result));
          check(
            Array.isArray(result.commitments) &&
              result.commitments.every(
                (item) =>
                  typeof item.segmentId === "string" &&
                  typeof item.quote === "string" &&
                  ["self", "other", "unknown"].includes(item.owner),
              ),
            "MODEL_INVALID",
            "Extraction response is invalid",
          );
          finish(null, result.commitments);
        } catch (error) {
          finish(error.code ? error : new WorkspaceError("MODEL_INVALID", "Extraction response is invalid"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }

  // `split`, when given, cuts one segment into smaller ones (new ids, the caller
  // keeps track of them); without it a lone segment that overflows surfaces.
  async extract({ owner, segments, split = null }) {
    check(Array.isArray(segments), "INVALID_INPUT", "Invalid extraction request");
    const found = [];
    for (const batch of batches(segments, this.chunkChars))
      found.push(...(await this._runFitting(owner, batch, split)));
    return found;
  }

  // It is the model's ANSWER that overflows: text dense with commitments can make
  // it list dozens of quotes. So a batch that overflows is halved and retried, and
  // a single segment is cut smaller by `split`, rather than losing everything in it.
  async _runFitting(owner, batch, split) {
    try {
      return await this._run({ owner, segments: batch });
    } catch (error) {
      if (error.code !== "MODEL_CONTEXT") throw error;
      if (batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        return [
          ...(await this._runFitting(owner, batch.slice(0, half), split)),
          ...(await this._runFitting(owner, batch.slice(half), split)),
        ];
      }
      const smaller = split?.(batch[0]);
      if (!smaller || smaller.length < 2) throw error;
      const found = [];
      for (const segment of smaller) found.push(...(await this._runFitting(owner, [segment], split)));
      return found;
    }
  }
}

module.exports = { ExtractionRuntime, batches, CHUNK_CHARS };
