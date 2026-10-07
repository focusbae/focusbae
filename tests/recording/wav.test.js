"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { Spool } = require("../../recording/spool");
const { PlaybackService } = require("../../recording/playback");
const wav = require("../../recording/wav");

function pcmWav({ rate = 44100, channels = 2, seconds = 1.2 } = {}) {
  const frames = Math.floor(rate * seconds), data = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++)
      data.writeInt16LE(Math.round(Math.sin(frame * 0.04) * (channel ? 4000 : 8000)),
        (frame * channels + channel) * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("PCM WAV import resamples a bounded stereo source without changing the original, then exports a valid WAV", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-wav-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  t.after(async () => { await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, "original.wav"), bytes = pcmWav();
  fs.writeFileSync(source, bytes); const before = createHash("sha256").update(bytes).digest("hex");
  const store = catalog.store, context = { workspaceId: store.identity.id, clientRequestId: randomUUID() };
  const record = store.createRecording(context, { keepAudio: true,
    metadata: { localCaptureVersion: 1, importedWavVersion: 1 } });
  const spool = new Spool(store, record.id).create(record, "english");
  const result = await wav.importToSpool(source, spool);
  assert.equal(result.input.sampleRate, 44100); assert.equal(result.input.channels, 2);
  assert.ok(Math.abs(result.durationMs - 1200) < 1);
  assert.equal(createHash("sha256").update(fs.readFileSync(source)).digest("hex"), before);
  const scan = spool.scan();
  assert.equal(scan.issues.length, 0); assert.ok(scan.chunks.every((chunk) => chunk.source === "import"));
  assert.ok(spool.read(scan.chunks[0].name).pcm.some((byte) => byte !== 0));
  const player = new PlaybackService(catalog, {}), scope = { workspaceId: store.identity.id, id: record.id };
  assert.deepEqual(player.info(scope).sources, ["import"]);
  const destination = path.join(root, "export.wav");
  const exported = await player.exportWav({ ...scope, source: "all" }, destination);
  assert.equal(exported.fileName, "export.wav");
  const output = wav.inspectWav(destination);
  try { assert.equal(output.sampleRate, 16000); assert.equal(output.channels, 1); assert.equal(output.bitsPerSample, 16); }
  finally { fs.closeSync(output.fd); }
});

test("WAV validation rejects aliases, compressed/truncated/trailing data and unsafe output", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-wav-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const good = path.join(root, "good.wav"); fs.writeFileSync(good, pcmWav({ rate: 16000, channels: 1, seconds: 0.1 }));
  const compressed = Buffer.from(fs.readFileSync(good)); compressed.writeUInt16LE(3, 20);
  const cases = [
    ["compressed.wav", compressed, "UNSUPPORTED_AUDIO"],
    ["truncated.wav", fs.readFileSync(good).subarray(0, 50), "INVALID_AUDIO"],
    ["trailing.wav", Buffer.concat([fs.readFileSync(good), Buffer.from("tail")]), "INVALID_AUDIO"],
    ["wrong.mp3", fs.readFileSync(good), "UNSUPPORTED_AUDIO"],
  ];
  for (const [name, data, code] of cases) {
    const file = path.join(root, name); fs.writeFileSync(file, data);
    assert.throws(() => wav.inspectWav(file), { code });
  }
  const link = path.join(root, "linked.wav"); fs.symlinkSync(good, link);
  assert.throws(() => wav.inspectWav(link), { code: "UNSAFE_PATH" });
  await assert.rejects(wav.writeWav(path.join(root, "bad.txt"), 100, async () => ({ samples: new Float32Array(1) })),
    { code: "INVALID_INPUT" });
  const existing = path.join(root, "existing.wav"); fs.writeFileSync(existing, "previous export");
  await assert.rejects(wav.writeWav(existing, 100, async () => { throw new Error("Synthetic read failure"); }),
    /Synthetic read failure/);
  assert.equal(fs.readFileSync(existing, "utf8"), "previous export");
  const linkedOutput = path.join(root, "linked-output.wav"); fs.symlinkSync(existing, linkedOutput);
  await assert.rejects(wav.writeWav(linkedOutput, 100, async () => ({ samples: new Float32Array(1600) })),
    { code: "UNSAFE_PATH" });
});
