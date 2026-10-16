"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { RecordingService } = require("../../recording/service");
const { registerWorkspaceIPC, DOCUMENT } = require("../../workspace/ipc");
const { LocalPolicy } = require("../../privacy/local-policy");
const { formatTranscript, transcriptFileName } = require("../../recording/transcript-export");

const recording = {
  title: "",
  purpose: "conversation",
  startedAt: "2026-10-16T09:30:00.000Z",
  durationMs: 125000,
};

test("a transcript formats as text or Markdown, without echoes, naming unknown speakers by source", () => {
  const segments = [
    { id: "a", source: "microphone", startMs: 0, text: "I'll send the deck.", speaker: "You", echoOf: null },
    { id: "b", source: "system", startMs: 65000, text: "Thanks, by Friday?", speaker: null, echoOf: null },
    { id: "c", source: "microphone", startMs: 65400, text: "Thanks, by Friday?", speaker: "You", echoOf: "b" },
  ];
  const text = formatTranscript({ recording, segments, timeZone: "UTC" }, "text");
  assert.equal(text.lines, 2);
  assert.equal(
    text.text,
    "Conversation\nOct 16, 2026, 9:30 AM · 2:05\n\n" +
      "[0:00] You: I'll send the deck.\n" +
      "[1:05] System audio · Unknown speaker: Thanks, by Friday?\n",
  );
  const markdown = formatTranscript({ recording: { ...recording, title: "Pricing call" }, segments, timeZone: "UTC" }, "markdown");
  assert.equal(
    markdown.text,
    "# Pricing call\n\nOct 16, 2026, 9:30 AM · 2:05\n\n" +
      "**[0:00] You:** I'll send the deck.\n\n" +
      "**[1:05] System audio · Unknown speaker:** Thanks, by Friday?\n",
  );
});

test("export file names come from the recording name and day, with unsafe characters removed", () => {
  assert.equal(transcriptFileName(recording, "md"), "Conversation 2026-10-16.md");
  assert.equal(
    transcriptFileName({ ...recording, title: ' Q4: plan / "draft"? ' }, "txt"),
    "Q4 plan draft 2026-10-16.txt",
  );
});

async function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-transcript-export-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const service = new RecordingService({ catalog });
  const store = catalog.store;
  const workspaceId = store.identity.id;
  const mutation = (expectedRevision) => ({
    workspaceId,
    clientRequestId: randomUUID(),
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  const record = store.createRecording(mutation(), { purpose: "conversation", title: "Weekly sync" });
  const speaker = store.createSpeaker(mutation(), { recordingId: record.id, label: "Speaker 1 · Microphone" });
  store.identifySpeaker(mutation(speaker.revision), speaker.id, { identity: { kind: "person", label: "Priya" } });
  // More lines than one page of the transcript view (100), written out of order.
  for (let n = 249; n >= 0; n--)
    store.createTranscript(mutation(), {
      recordingId: record.id, source: "microphone", startMs: n * 3000, endMs: n * 3000 + 2000,
      text: `Line ${n}`, speakerId: speaker.id,
    });
  const empty = store.createRecording(mutation(), { purpose: "personal" });
  t.after(async () => {
    await service.close();
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, catalog, service, workspaceId, record, empty };
}

test("the full transcript spans every page, in order, with speaker names", async (t) => {
  const { service, workspaceId, record } = await workspace(t);
  const { segments } = service.fullTranscript(workspaceId, record.id);
  assert.equal(segments.length, 250);
  assert.deepEqual(segments.map((segment) => segment.text), Array.from({ length: 250 }, (_, n) => `Line ${n}`));
  assert.ok(segments.every((segment) => segment.speaker === "Priya"));
});

test("transcript IPC copies the whole transcript and exports it to the chosen file", async (t) => {
  const { root, catalog, service, workspaceId, record, empty } = await workspace(t);
  const frame = { url: DOCUMENT };
  const contents = { mainFrame: frame, send: () => {} };
  const win = { isDestroyed: () => false, webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map();
  let copied = null;
  let chosen = { canceled: true };
  let dialogOptions = null;
  const remove = registerWorkspaceIPC({
    catalog,
    getWindow: () => win,
    ready: async () => {},
    privacy: { policy: new LocalPolicy() },
    recording: service,
    clipboard: { writeText: (text) => (copied = text) },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => handlers.delete(name),
    },
    dialog: { showSaveDialog: async (_win, options) => ((dialogOptions = options), chosen) },
  });
  t.after(() => remove());
  const call = (name, input) => handlers.get(`workspace:${name}`)(event, input);

  const copy = await call("capture.copyTranscript", { workspaceId, id: record.id });
  assert.equal(copy.ok, true);
  assert.equal(copy.value.lines, 250);
  assert.match(copied, /^Weekly sync\n/);
  assert.match(copied, /\[0:00\] Priya: Line 0\n/);
  assert.match(copied, /\[12:27\] Priya: Line 249\n$/);

  assert.deepEqual((await call("capture.exportTranscript", { workspaceId, id: record.id })).value, { canceled: true });
  assert.equal(dialogOptions.defaultPath, `Weekly sync ${record.startedAt.slice(0, 10)}.md`);

  chosen = { canceled: false, filePath: path.join(root, "sync") };
  const markdown = await call("capture.exportTranscript", { workspaceId, id: record.id });
  assert.deepEqual(markdown.value, { canceled: false, lines: 250, name: "sync.md" });
  const saved = fs.readFileSync(path.join(root, "sync.md"), "utf8");
  assert.match(saved, /^# Weekly sync\n/);
  assert.match(saved, /\*\*\[12:27\] Priya:\*\* Line 249\n$/);

  chosen = { canceled: false, filePath: path.join(root, "sync.txt") };
  await call("capture.exportTranscript", { workspaceId, id: record.id });
  assert.match(fs.readFileSync(path.join(root, "sync.txt"), "utf8"), /\[0:00\] Priya: Line 0\n/);

  const none = await call("capture.copyTranscript", { workspaceId, id: empty.id });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "NO_TRANSCRIPT");
});
