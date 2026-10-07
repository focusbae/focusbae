"use strict";

const os = require("node:os");
const path = require("node:path");
const { check } = require("../workspace/errors");
const { FluidModel, run, verifyTree, BIN } = require("./fluid-model");
const MANIFEST = require("./fluid-helpers/manifests/speaker-diarization.json");

// Speaker diarization (FluidAudio, pyannote community-1). Cluster ids are
// anonymous; they are never identities.
class DiarizationRuntime extends FluidModel {
  constructor({
    binary = path.join(BIN, "focusbae-diarize"),
    root = path.join(os.homedir(), ".focusbae", "models", "diarizer"),
    manifest = MANIFEST,
    ...options
  } = {}) {
    super({ binary, root, manifest, ...options });
  }

  async diarize(wavPath) {
    check(this.ready(), "MODEL_MISSING", "Speaker detection model is not installed");
    const result = await run(
      this.binary,
      ["diarize", "--models", this.root, "--audio", wavPath],
      this.timeoutMs,
    );
    check(
      Array.isArray(result.segments) &&
        result.segments.every(
          (s) =>
            typeof s.speaker === "string" && s.speaker.length <= 64 &&
            Number.isSafeInteger(s.startMs) && Number.isSafeInteger(s.endMs) &&
            s.startMs >= 0 && s.endMs >= s.startMs,
        ),
      "MODEL_INVALID",
      "Speaker detection response is invalid",
    );
    return result.segments;
  }
}

module.exports = { DiarizationRuntime, verifyTree: (dir, manifest = MANIFEST) => verifyTree(dir, manifest), MANIFEST };
