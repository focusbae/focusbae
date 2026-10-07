"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const files = require("../workspace/files");
const { check } = require("../workspace/errors");
const { CHUNK_BYTES } = require("./spool");
const { wavHeader } = require("./diarize");

const TARGET_RATE = 16000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024;

function readExact(fd, size, position) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, buffer, offset, size - offset, position + offset);
    check(count > 0, "INVALID_AUDIO", "WAV file ended unexpectedly");
    offset += count;
  }
  return buffer;
}

function writeAll(fd, buffer, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.writeSync(fd, buffer, offset, buffer.length - offset,
      position === null ? null : position + offset);
    check(count > 0, "IO_ERROR", "Unable to complete WAV write");
    offset += count;
  }
}

function inspectWav(file) {
  check(typeof file === "string" && path.isAbsolute(file), "INVALID_INPUT", "Choose a WAV file");
  check(path.extname(file).toLowerCase() === ".wav", "UNSUPPORTED_AUDIO", "Choose a PCM WAV file");
  files.inspect(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.size >= 44 && stat.size <= MAX_INPUT_BYTES,
      "INVALID_AUDIO", "WAV file size is unsupported");
    const riff = readExact(fd, 12, 0);
    check(riff.toString("ascii", 0, 4) === "RIFF" && riff.toString("ascii", 8, 12) === "WAVE",
      "INVALID_AUDIO", "File is not a WAV recording");
    const end = riff.readUInt32LE(4) + 8;
    check(end === stat.size, "INVALID_AUDIO", "WAV length is invalid");
    let offset = 12, format = null, data = null;
    while (offset + 8 <= end) {
      const header = readExact(fd, 8, offset);
      const kind = header.toString("ascii", 0, 4), size = header.readUInt32LE(4);
      const start = offset + 8, next = start + size + (size % 2);
      check(next <= end && next > offset, "INVALID_AUDIO", "WAV chunk is invalid");
      if (kind === "fmt ") {
        check(!format && size >= 16 && size <= 64, "INVALID_AUDIO", "WAV format is invalid");
        const fmt = readExact(fd, size, start);
        format = {
          audioFormat: fmt.readUInt16LE(0),
          channels: fmt.readUInt16LE(2),
          sampleRate: fmt.readUInt32LE(4),
          byteRate: fmt.readUInt32LE(8),
          blockAlign: fmt.readUInt16LE(12),
          bitsPerSample: fmt.readUInt16LE(14),
        };
      } else if (kind === "data") {
        check(!data && size > 0, "INVALID_AUDIO", "WAV audio data is missing or duplicated");
        data = { offset: start, bytes: size };
      }
      offset = next;
    }
    check(offset === end && format && data, "INVALID_AUDIO", "WAV format or audio data is missing");
    check(format.audioFormat === 1 && format.bitsPerSample === 16 && [1, 2].includes(format.channels),
      "UNSUPPORTED_AUDIO", "Use an uncompressed 16-bit PCM WAV file with one or two channels");
    check(format.sampleRate >= 8000 && format.sampleRate <= 96000,
      "UNSUPPORTED_AUDIO", "WAV sample rate must be between 8 and 96 kHz");
    check(format.blockAlign === format.channels * 2 &&
      format.byteRate === format.sampleRate * format.blockAlign &&
      data.bytes % format.blockAlign === 0,
      "INVALID_AUDIO", "WAV sample layout is invalid");
    const frames = data.bytes / format.blockAlign;
    const durationMs = frames / format.sampleRate * 1000;
    check(durationMs > 0 && durationMs <= MAX_DURATION_MS,
      "INVALID_AUDIO", "WAV recording must be no longer than four hours");
    return { fd, stat, ...format, ...data, frames, durationMs };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function sample(frameBytes, frame, channels) {
  const offset = frame * channels * 2;
  if (channels === 1) return frameBytes.readInt16LE(offset);
  return Math.round((frameBytes.readInt16LE(offset) + frameBytes.readInt16LE(offset + 2)) / 2);
}

async function importToSpool(file, spool) {
  const wav = inspectWav(file);
  try {
    const outputSamples = Math.floor(wav.frames * TARGET_RATE / wav.sampleRate);
    check(outputSamples > 0, "INVALID_AUDIO", "WAV recording is too short");
    const samplesPerChunk = CHUNK_BYTES / 2;
    let sequence = 0;
    for (let outputStart = 0; outputStart < outputSamples; outputStart += samplesPerChunk) {
      const count = Math.min(samplesPerChunk, outputSamples - outputStart);
      const first = Math.floor(outputStart * wav.sampleRate / TARGET_RATE);
      const lastPosition = (outputStart + count - 1) * wav.sampleRate / TARGET_RATE;
      const last = Math.min(wav.frames - 1, Math.ceil(lastPosition) + 1);
      const raw = readExact(wav.fd, (last - first + 1) * wav.blockAlign,
        wav.offset + first * wav.blockAlign);
      const pcm = Buffer.alloc(count * 2);
      for (let n = 0; n < count; n++) {
        const position = (outputStart + n) * wav.sampleRate / TARGET_RATE;
        const lower = Math.floor(position), upper = Math.min(wav.frames - 1, lower + 1);
        const fraction = position - lower;
        const a = sample(raw, lower - first, wav.channels);
        const b = sample(raw, upper - first, wav.channels);
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction))), n * 2);
      }
      spool.append({ source: "import", sequence, startMs: sequence * 5000, pcm });
      sequence++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const after = fs.fstatSync(wav.fd);
    check(after.size === wav.stat.size && after.mtimeMs === wav.stat.mtimeMs && after.ino === wav.stat.ino,
      "INVALID_AUDIO", "WAV file changed while importing");
    return {
      durationMs: outputSamples / 16,
      input: { channels: wav.channels, sampleRate: wav.sampleRate, bitsPerSample: 16 },
    };
  } catch (error) {
    if (["ENOSPC", "EDQUOT"].includes(error.code))
      check(false, "DISK_FULL", "Storage is full while importing audio");
    throw error;
  } finally {
    fs.closeSync(wav.fd);
  }
}

async function writeWav(target, durationMs, read) {
  check(typeof target === "string" && path.isAbsolute(target) && path.extname(target).toLowerCase() === ".wav",
    "INVALID_INPUT", "Choose a .wav destination");
  const parent = fs.realpathSync(path.dirname(target));
  const destination = path.join(parent, path.basename(target));
  if (fs.existsSync(destination)) files.inspect(destination);
  const partial = path.join(parent, `.${path.basename(target)}.${randomUUID()}.partial`);
  const fd = fs.openSync(partial,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let dataBytes = 0;
  try {
    writeAll(fd, Buffer.alloc(44));
    for (let startMs = 0; startMs < durationMs; startMs += 5000) {
      const part = await read(startMs, Math.min(5000, Math.ceil(durationMs - startMs)));
      const pcm = Buffer.alloc(part.samples.length * 2);
      for (let n = 0; n < part.samples.length; n++)
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(part.samples[n] * 32767))), n * 2);
      writeAll(fd, pcm);
      dataBytes += pcm.length;
      await new Promise((resolve) => setImmediate(resolve));
    }
    check(dataBytes > 0 && dataBytes <= 0xffffffff - 36, "INVALID_AUDIO", "Recording is too large to export as WAV");
    writeAll(fd, wavHeader(dataBytes), 0);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(partial); } catch {}
    if (["ENOSPC", "EDQUOT"].includes(error.code))
      check(false, "DISK_FULL", "Storage is full while exporting audio");
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(partial, destination);
    files.flushDirectory(parent);
  } catch (error) {
    try { fs.unlinkSync(partial); } catch {}
    throw error;
  }
  return { fileName: path.basename(destination), bytes: dataBytes + 44 };
}

module.exports = { inspectWav, importToSpool, writeWav, MAX_DURATION_MS, TARGET_RATE };
