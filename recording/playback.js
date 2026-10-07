"use strict";
const { Spool } = require("./spool");
const v = require("../workspace/validation");
const { check } = require("../workspace/errors");
const RATE = 16000;
const MAX_MS = 4 * 60 * 60 * 1000 + 65000;

// The existing checksummed source chunks are the canonical retained audio.
// Render only bounded timeline windows; never assemble a whole meeting in RAM,
// expose a disk path, create a duplicate playback file, or open a network URL.
class PlaybackService {
  constructor(catalog, recording) {
    this.catalog = catalog;
    this.recording = recording;
    this.index = null;
  }
  open(workspaceId, id) {
    const store = this.catalog.scoped(v.uuid(workspaceId));
    const record = store.get({ workspaceId }, "recording", v.uuid(id));
    check(record.metadata?.localCaptureVersion === 1 && record.keepAudio,
      "NO_AUDIO", "No retained audio for this recording");
    check(!this.recording.active, "WORKSPACE_BUSY", "Stop recording before playback");
    const spool = new Spool(store, id).open();
    check(!spool.manifest.discarded && !spool.manifest.purged,
      "NO_AUDIO", "Audio has been deleted");
    return { store, record, spool };
  }
  info(input) {
    v.object(input, ["workspaceId", "id"]);
    this.index = null;
    const { store, spool } = this.open(input.workspaceId, input.id);
    const scan = spool.scan();
    check(scan.chunks.length > 0, "NO_AUDIO", "No retained audio is available");
    check(!scan.issues.length && scan.bytes >= spool.manifest.bytes &&
      scan.chunks.length >= spool.manifest.chunks && scan.durationMs <= MAX_MS,
      "SPOOL_CORRUPT", "Audio is incomplete or damaged");
    const sources = [...new Set(scan.chunks.map((chunk) => chunk.source))];
    this.index = { store, id: input.id, chunks: scan.chunks, durationMs: scan.durationMs, sources };
    return { durationMs: scan.durationMs, bytes: scan.bytes, sources, sampleRate: RATE };
  }
  read(input) {
    v.object(input, ["workspaceId", "id", "startMs", "durationMs", "source"]);
    v.integer(input.startMs, "startMs", 0, MAX_MS);
    v.integer(input.durationMs, "durationMs", 1, 5000);
    v.choice(input.source, ["all", "microphone", "system", "import"], "source");
    const { store, spool } = this.open(input.workspaceId, input.id);
    const index = this.index;
    check(index?.store === store && index.id === input.id,
      "NO_AUDIO", "Open playback before reading audio");
    check(input.source === "all" || index.sources.includes(input.source),
      "INVALID_INPUT", "Unavailable audio source");
    const start = input.startMs * 16;
    const end = Math.min(Math.round(index.durationMs * 16), start + input.durationMs * 16);
    check(end > start, "INVALID_INPUT", "Seek is outside the recording");
    const samples = new Float32Array(end - start);
    const overlaps = input.source === "all" ? new Uint8Array(end - start) : null;
    for (const chunk of index.chunks) {
      if (input.source !== "all" && chunk.source !== input.source) continue;
      const from = chunk.startMs * 16, to = from + chunk.byteSize / 2;
      if (from >= end || to <= start) continue;
      const current = spool.read(chunk.name);
      // Recheck identity/timing as well as bytes on every read, including seeks.
      check(current.checksum === chunk.checksum && current.startMs === chunk.startMs &&
        current.byteSize === chunk.byteSize, "SPOOL_CORRUPT", "Audio changed during playback");
      for (let n = Math.max(start, from); n < Math.min(end, to); n++) {
        samples[n - start] += current.pcm.readInt16LE((n - from) * 2) / 32768;
        if (overlaps) overlaps[n - start]++;
      }
    }
    if (overlaps)
      for (let n = 0; n < samples.length; n++)
        if (overlaps[n] > 1) samples[n] /= overlaps[n];
    return { samples, sampleRate: RATE, durationMs: samples.length / 16 };
  }
  async exportWav(input, target) {
    v.object(input, ["workspaceId", "id", "source"]);
    v.choice(input.source, ["all", "microphone", "system", "import"], "source");
    const info = this.info({ workspaceId: input.workspaceId, id: input.id });
    check(input.source === "all" || info.sources.includes(input.source),
      "INVALID_INPUT", "Unavailable audio source");
    return require("./wav").writeWav(target, info.durationMs, (startMs, durationMs) =>
      this.read({ ...input, startMs, durationMs }));
  }
}
module.exports = { PlaybackService };
