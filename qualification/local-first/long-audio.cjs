"use strict";
// Thirty-minute generated WAV qualification. No microphone, speaker or network use.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { RecordingService } = require("../../recording/service");
const { PlaybackService } = require("../../recording/playback");
const { wavHeader } = require("../../recording/diarize");
const wav = require("../../recording/wav");

const SECONDS = 30 * 60;
const RATE = 16000;
const BYTES = SECONDS * RATE * 2;
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256"), stream = fs.createReadStream(file);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
function createSource(file) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, wavHeader(BYTES));
    const second = Buffer.alloc(RATE * 2);
    for (let i = 0; i < RATE; i++)
      second.writeInt16LE(Math.round(Math.sin(i * 0.035) * 7000), i * 2);
    for (let n = 0; n < SECONDS; n++) fs.writeSync(fd, second);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-long-audio-"));
  const original = path.join(root, "generated-30-min.wav");
  const exported = path.join(root, "exported-30-min.wav");
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  let service;
  try {
    createSource(original);
    const originalHash = await hashFile(original);
    await catalog.initialize();
    service = new RecordingService({
      catalog,
      capabilities: () => ({ microphone: { ok: true }, system: { ok: true } }),
      model: () => ({ ready: false }),
    });
    const workspaceId = catalog.activeId;
    console.log("Importing 30 minutes of generated audio...");
    const started = Date.now();
    const record = await service.importWav({
      context: { workspaceId, clientRequestId: randomUUID() },
      purpose: "personal", language: "english", keepAudio: true, consent: true,
      destination: { kind: "standalone" },
    }, original);
    assert.equal(record.state, "captured");
    assert.equal(service.storage(workspaceId).retainedCount, 1);
    assert.equal(await hashFile(original), originalHash);
    let player = new PlaybackService(catalog, service);
    const scope = { workspaceId, id: record.id };
    let info = player.info(scope);
    assert.equal(info.durationMs, SECONDS * 1000);
    assert.deepEqual(info.sources, ["import"]);
    assert.ok(player.read({ ...scope, startMs: 0, durationMs: 5000, source: "all" }).samples.some(n => n !== 0));
    assert.ok(player.read({ ...scope, startMs: 1795000, durationMs: 5000, source: "all" }).samples.some(n => n !== 0));
    await catalog.close();
    await catalog.initialize();
    player = new PlaybackService(catalog, service);
    info = player.info(scope);
    assert.equal(info.durationMs, SECONDS * 1000);
    assert.ok(player.read({ ...scope, startMs: 900000, durationMs: 5000, source: "all" }).samples.some(n => n !== 0));
    console.log("Exporting retained audio after workspace reopen...");
    await player.exportWav({ ...scope, source: "all" }, exported);
    const output = wav.inspectWav(exported);
    try {
      assert.equal(output.durationMs, SECONDS * 1000);
      assert.equal(output.sampleRate, RATE);
      assert.equal(output.channels, 1);
    } finally { fs.closeSync(output.fd); }
    assert.equal(await hashFile(original), originalHash);
    console.log(JSON.stringify({ ok: true, durationMinutes: 30, chunks: info.bytes / 160000,
      inputBytes: fs.statSync(original).size, exportBytes: fs.statSync(exported).size,
      elapsedSeconds: Math.round((Date.now() - started) / 1000), maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
  } finally {
    await service?.close();
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
