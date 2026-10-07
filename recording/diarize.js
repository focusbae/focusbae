"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { listAll } = require("../workspace/action-extraction");

const SAMPLE_RATE = 16000;
const BYTES_PER_MS = 32; // mono PCM16 at 16 kHz
// Diarization cost grows with audio length; longer sources keep source labels only.
const MAX_SOURCE_MS = 2 * 60 * 60 * 1000;
const SOURCE_NAME = { microphone: "Microphone", system: "Mac audio", import: "Imported audio" };

function requestId(key) {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// Writes one source's chunks as a WAV whose sample offsets equal recording time,
// padding gaps with silence so diarization times align with transcript times.
function writeSourceWav(spool, chunks, file) {
  const ordered = [...chunks].sort((a, b) => a.startMs - b.startMs);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  let written = 0;
  try {
    fs.writeSync(fd, Buffer.alloc(44));
    for (const chunk of ordered) {
      const { pcm, startMs } = spool.read(chunk.name);
      const offset = startMs * BYTES_PER_MS;
      if (offset > written) {
        fs.writeSync(fd, Buffer.alloc(offset - written));
        written = offset;
      }
      // Overlapping chunks cannot occur for one source; skip any overlap defensively.
      const skip = Math.min(pcm.length, Math.max(0, written - offset));
      if (skip < pcm.length) {
        fs.writeSync(fd, pcm, skip);
        written += pcm.length - skip;
      }
    }
    fs.writeSync(fd, wavHeader(written), 0, 44, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return written / BYTES_PER_MS;
}

// Picks, for each transcript segment, the detected speaker with the largest time
// overlap. Segments with no overlapping turn stay unassigned.
function assign(segments, turns) {
  return segments.map((segment) => {
    let best = null;
    let most = 0;
    const totals = new Map();
    for (const turn of turns) {
      const overlap = Math.min(segment.endMs, turn.endMs) - Math.max(segment.startMs, turn.startMs);
      if (overlap <= 0) continue;
      const total = (totals.get(turn.speaker) ?? 0) + overlap;
      totals.set(turn.speaker, total);
      if (total > most) {
        most = total;
        best = turn.speaker;
      }
    }
    return { segment, speaker: best };
  });
}

async function diarizeRecording({ store, recordingId, spool, scan, runtime, isCancelled = () => false }) {
  if (!runtime?.ready()) return { status: "skipped", reason: "MODEL_MISSING" };
  const workspaceId = store.identity.id;
  const scope = { workspaceId };
  const summary = { status: "complete", speakers: 0, assigned: 0, sources: {} };
  const segments = listAll(store, scope, "transcript", { recordingId });
  const existing = listAll(store, scope, "speaker", { recordingId });
  const byLabel = new Map(existing.map((speaker) => [speaker.label, speaker]));
  let number = existing.length;
  for (const source of require("./spool").SOURCES) {
    const chunks = scan.chunks.filter((chunk) => chunk.source === source);
    const pending = segments.filter((s) => s.source === source && !s.speakerId);
    if (!chunks.length || !pending.length) continue;
    const end = Math.max(...chunks.map((c) => c.startMs + c.durationMs));
    if (end > MAX_SOURCE_MS) {
      summary.sources[source] = { status: "skipped", reason: "TOO_LONG" };
      continue;
    }
    const file = path.join(spool.directory, `diarize-${source}.wav`);
    fs.rmSync(file, { force: true });
    let turns;
    try {
      writeSourceWav(spool, chunks, file);
      turns = await runtime.diarize(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
    if (isCancelled()) throw Object.assign(new Error("Cancelled"), { code: "CANCELLED" });
    // Only clusters that own at least one transcript segment become speakers, numbered
    // by first appearance. Cluster ids are only meaningful within one source file,
    // so labels carry the source.
    const assignments = assign(pending, turns).filter((item) => item.speaker);
    const ids = new Map();
    for (const { speaker: cluster } of [...assignments].sort((x, y) => x.segment.startMs - y.segment.startMs)) {
      if (ids.has(cluster)) continue;
      const label = `Speaker ${ids.size + 1} · ${SOURCE_NAME[source]}`;
      let speaker = byLabel.get(label);
      if (!speaker) {
        speaker = store.createSpeaker(
          { ...scope, clientRequestId: requestId(`speaker:${recordingId}:${source}:${label}`) },
          { recordingId, label },
        );
        byLabel.set(label, speaker);
        number++;
      }
      ids.set(cluster, speaker.id);
    }
    let assigned = 0;
    for (const { segment, speaker } of assignments) {
      store.updateTranscript(
        { ...scope, clientRequestId: requestId(`speaker-assign:${segment.id}:${segment.revision}`), expectedRevision: segment.revision },
        segment.id,
        { speakerId: ids.get(speaker) },
      );
      assigned++;
    }
    summary.assigned += assigned;
    summary.sources[source] = { status: "complete", speakers: ids.size, assigned };
  }
  summary.speakers = number;
  return summary;
}

module.exports = { diarizeRecording, writeSourceWav, assign, wavHeader, MAX_SOURCE_MS };
