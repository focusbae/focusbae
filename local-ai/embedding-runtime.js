"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { check, WorkspaceError } = require("../workspace/errors");

class EmbeddingRuntime {
  constructor({
    binary = path.join(__dirname, "bin", "focusbae-embed").replace("app.asar/", "app.asar.unpacked/"),
    timeoutMs = 30000,
  } = {}) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
  }

  embed(texts) {
    check(
      Array.isArray(texts) && texts.length > 0 && texts.length <= 128,
      "INVALID_INPUT",
      "Invalid embedding batch",
    );
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
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
        finish(new WorkspaceError("MODEL_TIMEOUT", "Embedding timed out"));
      }, this.timeoutMs);
      child.once("error", () => finish(new WorkspaceError("MODEL_MISSING", "Local embedding runtime is unavailable")));
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          child.kill("SIGKILL");
          finish(new WorkspaceError("MODEL_INVALID", "Embedding response is too large"));
        } else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        if (Buffer.concat(stderr).length < 4096) stderr.push(chunk);
      });
      child.once("close", (code) => {
        if (settled) return;
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          if (code !== 0 || !result.ok)
            throw new WorkspaceError(
              code === 3 ? "MODEL_MISSING" : "MODEL_INVALID",
              "Embedding failed",
            );
          check(
            typeof result.profile === "string" &&
              Number.isInteger(result.dimensions) &&
              result.dimensions > 0 &&
              result.dimensions <= 4096 &&
              Array.isArray(result.vectors) &&
              result.vectors.length === texts.length &&
              result.vectors.every(
                (vector) =>
                  Array.isArray(vector) &&
                  vector.length === result.dimensions &&
                  vector.every(Number.isFinite),
              ),
            "MODEL_INVALID",
            "Embedding response is invalid",
          );
          finish(null, result);
        } catch (error) {
          finish(
            error.code
              ? error
              : new WorkspaceError("MODEL_INVALID", "Embedding response is invalid"),
          );
        }
      });
      child.stdin.end(JSON.stringify({ texts }));
    });
  }
}

module.exports = { EmbeddingRuntime };
