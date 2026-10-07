"use strict";
const fs = require("node:fs");
const path = require("node:path");
const files = require("../workspace/files");
const v = require("../workspace/validation");
const { check } = require("../workspace/errors");
const SOURCES = ["microphone", "system", "import"];
const CHUNK_BYTES = 160000; // Five seconds, mono PCM16 at 16 kHz.
const CHUNK = /^(microphone|system|import)-(\d{6})\.pcm$/;
const MAX_CHUNKS = 6000;
class Spool {
  constructor(store, recordingId) {
    this.workspaceId = store.identity.id;
    this.recordingId = v.uuid(recordingId);
    this.file = files.managedPath(
      store._directory,
      `capture-spool/${recordingId}/manifest.json`,
    );
    this.directory = path.dirname(this.file);
  }
  create(recording, language) {
    check(
      !fs.existsSync(this.directory),
      "CONFLICT",
      "Recording spool already exists",
    );
    fs.mkdirSync(this.directory, { mode: 0o700 });
    files.flushDirectory(path.dirname(this.directory));
    this.manifest = {
      version: 1,
      workspaceId: this.workspaceId,
      recordingId: this.recordingId,
      startedAt: recording.startedAt,
      state: "preparing",
      language,
      reason: null,
      lastCommit: null,
      bytes: 0,
      chunks: 0,
      durationMs: 0,
      processing: "queued",
      purged: false,
      discarded: false,
      issues: [],
    };
    this.save();
    return this;
  }
  open() {
    files.inspect(this.directory, true);
    check(
      files.inspect(this.file),
      "SPOOL_MISSING",
      "Recovery manifest is missing",
    );
    check(
      fs.statSync(this.file).size < 65536,
      "SPOOL_CORRUPT",
      "Recovery manifest exceeds limit",
    );
    this.manifest = JSON.parse(fs.readFileSync(this.file, "utf8"));
    check(
      this.manifest.version === 1 &&
        this.manifest.workspaceId === this.workspaceId &&
        this.manifest.recordingId === this.recordingId,
      "SPOOL_CORRUPT",
      "Wrong recovery manifest",
    );
    v.choice(this.manifest.language, ["english", "hindi", "mixed"], "language");
    return this;
  }
  save(changes = {}) {
    Object.assign(this.manifest, changes);
    files.atomicJson(this.file, this.manifest);
  }
  append({ source, sequence, startMs, pcm }) {
    v.choice(source, SOURCES, "source");
    v.integer(sequence, "sequence", 0, MAX_CHUNKS - 1);
    v.integer(startMs, "startMs", 0, 4 * 60 * 60 * 1000 + 60000);
    check(
      Buffer.isBuffer(pcm) &&
        pcm.length > 0 &&
        pcm.length <= CHUNK_BYTES &&
        pcm.length % 2 === 0,
      "INVALID_AUDIO",
      "Invalid PCM chunk",
    );
    const meta = {
      version: 1,
      workspaceId: this.workspaceId,
      recordingId: this.recordingId,
      source,
      sequence,
      startMs,
      byteSize: pcm.length,
      durationMs: pcm.length / 32,
      checksum: v.hash(pcm),
    };
    const header = Buffer.from(JSON.stringify(meta));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    const name = `${source}-${String(sequence).padStart(6, "0")}.pcm`;
    const temp = path.join(this.directory, `${name}.part`);
    const target = path.join(this.directory, name);
    check(!fs.existsSync(target), "CONFLICT", "Duplicate audio sequence");
    files.writeExclusive(temp, Buffer.concat([length, header, pcm]));
    fs.renameSync(temp, target);
    files.flushDirectory(this.directory);
    this.save({
      lastCommit: new Date().toISOString(),
      bytes: this.manifest.bytes + pcm.length,
      chunks: this.manifest.chunks + 1,
      durationMs: Math.max(this.manifest.durationMs, startMs + meta.durationMs),
    });
    return meta;
  }
  read(name) {
    check(CHUNK.test(name), "UNSAFE_PATH", "Invalid chunk filename");
    const file = files.managedPath(this.directory, name);
    check(files.inspect(file), "SPOOL_MISSING", "Audio chunk is missing");
    check(
      fs.statSync(file).size <= CHUNK_BYTES + 4096,
      "SPOOL_CORRUPT",
      "Audio chunk exceeds limit",
    );
    const buffer = fs.readFileSync(file);
    check(buffer.length >= 4, "SPOOL_CORRUPT", "Incomplete audio header");
    const size = buffer.readUInt32LE();
    check(
      size > 0 && size < 4096 && 4 + size < buffer.length,
      "SPOOL_CORRUPT",
      "Invalid audio header",
    );
    const meta = JSON.parse(buffer.subarray(4, 4 + size).toString("utf8"));
    const pcm = buffer.subarray(4 + size);
    const [, source, seq] = name.match(CHUNK);
    check(
      meta.version === 1 &&
        meta.workspaceId === this.workspaceId &&
        meta.recordingId === this.recordingId &&
        meta.source === source &&
        meta.sequence === Number(seq) &&
        meta.byteSize === pcm.length &&
        pcm.length % 2 === 0 &&
        meta.durationMs === pcm.length / 32 &&
        v.hash(pcm) === meta.checksum,
      "SPOOL_CORRUPT",
      "Audio integrity check failed",
    );
    v.integer(meta.startMs, "startMs", 0, 4 * 60 * 60 * 1000 + 60000);
    return { ...meta, pcm };
  }
  scan() {
    const names = fs.readdirSync(this.directory);
    check(
      names.length <= MAX_CHUNKS + 20,
      "SPOOL_CORRUPT",
      "Too many audio chunks",
    );
    const chunks = [],
      issues = [];
    let bytes = 0,
      durationMs = 0;
    for (const name of names.filter((name) => CHUNK.test(name)).sort()) {
      try {
        const { pcm, ...meta } = this.read(name);
        chunks.push({ ...meta, name });
        bytes += pcm.length;
        durationMs = Math.max(durationMs, meta.startMs + meta.durationMs);
      } catch {
        issues.push(`Unreadable audio chunk: ${name}`);
      }
    }
    for (const source of SOURCES) {
      let sequence = 0,
        end = null;
      for (const chunk of chunks.filter((item) => item.source === source)) {
        if (
          chunk.sequence !== sequence ||
          (end !== null && Math.abs(chunk.startMs - end) > 2)
        )
          issues.push(
            `Gap in ${source} near ${Math.round(chunk.startMs / 1000)}s`,
          );
        sequence = chunk.sequence + 1;
        end = chunk.startMs + chunk.durationMs;
      }
    }
    if (names.some((name) => name.endsWith(".part")))
      issues.push("An uncommitted audio tail remains after interruption.");
    // Recover complete chunks even if a crash happened before the manifest update.
    return { chunks, bytes, durationMs, issues: issues.slice(0, 20) };
  }
  purge(discard = false) {
    this.save({
      cleanupComplete: false,
      ...(discard
        ? { discarded: true, processing: "cancelled" }
        : { purged: true }),
    });
    for (const name of fs.readdirSync(this.directory))
      if (
        CHUNK.test(name) ||
        /^(microphone|system|import)-\d{6}\.pcm\.part$/.test(name)
      ) {
        const file = files.managedPath(this.directory, name);
        if (files.inspect(file)) fs.unlinkSync(file);
      }
    files.flushDirectory(this.directory);
    this.save({ cleanupComplete: true });
  }
}
module.exports = { Spool, CHUNK_BYTES, SOURCES };
