"use strict";
// Entry for isolated development/unsigned packaging tests; never the release entry.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron");
const { app, globalShortcut, dialog } = electron;
// Synthetic Chromium microphone only. Probe runs must never capture the user's input.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
const profile = process.argv
  .find((arg) => arg.startsWith("--workspace-test-profile="))
  ?.split("=")
  .slice(1)
  .join("=");
if (
  !profile ||
  !fs.realpathSync(profile).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
)
  throw new Error("Temporary test profile required");
app.setName("FocusBaeWorkspaceProbe");
app.setPath("userData", path.join(profile, "profile"));
app.setPath("sessionData", path.join(profile, "session"));
fs.mkdirSync(path.join(profile, "profile"), { recursive: true });
fs.mkdirSync(path.join(profile, "home"), { recursive: true });
os.homedir = () => path.join(profile, "home");
app.isDefaultProtocolClient = () => true;
app.setAsDefaultProtocolClient = () => {
  throw new Error("No system protocol changes in tests");
};
const shortcuts = new Map();
globalShortcut.register = (key, handler) => { shortcuts.set(key, handler); return true; };
globalShortcut.unregister = (key) => shortcuts.delete(key);
globalShortcut.unregisterAll = () => shortcuts.clear();
globalShortcut.isRegistered = () => false;
let loginItem = false;
app.getLoginItemSettings = () => ({ openAtLogin: loginItem });
app.setLoginItemSettings = ({ openAtLogin }) => { loginItem = openAtLogin; };
let trayMenu = [];
const buildMenu = electron.Menu.buildFromTemplate.bind(electron.Menu);
electron.Menu.buildFromTemplate = (template) => {
  if (template.some((item) => item.label?.startsWith("Open Workspace"))) trayMenu = template;
  return buildMenu(template);
};
dialog.showMessageBox = async () => ({ response: 0 });
let clipboardText = "Copied before consent";
electron.clipboard.availableFormats = () => ["public.utf8-plain-text"];
electron.clipboard.readText = () => clipboardText;
electron.clipboard.writeText = (value) => { clipboardText = value; };
dialog.showErrorBox = (title, message) => console.error(title, message);
electron.Notification.isSupported = () => false;
const handlers = new Map();
const handle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (name, callback) => {
  handlers.set(name, callback);
  handle(name, callback);
};
const { WorkspaceCatalog } = require("../workspace/catalog");
const initialize = WorkspaceCatalog.prototype.initialize;
WorkspaceCatalog.prototype.initialize = async function () {
  const value = await initialize.call(this);
  global.workspaceProbe.catalog = this;
  return value;
};
global.workspaceProbe = {
  handlers,
  shortcuts,
  trayMenu: () => trayMenu,
  openCommand: (name) => require("../workspace-window").open(name),
  authorizeModelPermission: () => require("../privacy/local-runtime").policy.authorize("models"),
  // Models setup with synthetic pinned folders and a scripted Apple speech state, so
  // the settings flow exercises real verification, staging and permission checks.
  configureModels: () => {
    const { EventEmitter } = require("node:events");
    const { createHash } = require("node:crypto");
    const policy = require("../privacy/local-runtime").policy;
    const manager = require("../workspace-window").models();
    const service = require("../workspace-window").recording();
    const router = manager.speech;
    const synthetic = (name, title) => {
      const body = Buffer.from(`Synthetic ${title} fixture.\n`.repeat(2000));
      const manifest = {
        version: 1, name, title, license: "test-only", bytes: body.length,
        files: [{ path: "weights.bin", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") }],
      };
      const good = path.join(profile, "fixtures", "good", name);
      const bad = path.join(profile, "fixtures", "bad", name);
      fs.mkdirSync(good, { recursive: true });
      fs.mkdirSync(bad, { recursive: true });
      fs.writeFileSync(path.join(good, "weights.bin"), body);
      fs.writeFileSync(path.join(bad, "weights.bin"), Buffer.alloc(body.length));
      return { manifest, good: path.dirname(good), bad: path.dirname(bad) };
    };
    const models = {
      parakeet: synthetic("parakeet-tdt-0.6b-v3", "Parakeet"),
      speakers: synthetic("speaker-diarization", "Speaker detection"),
    };
    for (const [kind, target] of [["parakeet", router.parakeet], ["speakers", manager.diarization]]) {
      target.manifest = models[kind].manifest;
      target.root = path.join(profile, "models", kind);
      target.binary = process.execPath;
      target.verify();
    }
    const apple = Object.assign(new EventEmitter(), {
      locales: { "en-US": "supported", "hi-IN": "unsupported" },
      probes: 0,
      installing: null,
      supported: () => true,
      probed() { return this.probes > 0; },
      ready(locale) { return this.locales[locale] === "installed"; },
      async refresh() { this.probes++; this.emit("change"); return this.state(); },
      async install(locale) {
        policy.assert("models");
        this.installing = locale;
        this.emit("change");
        await new Promise((resolve) => setTimeout(resolve, 200));
        this.installing = null;
        this.locales[locale] = "installed";
        this.emit("change");
        return this.state();
      },
      state() { return { supported: true, probed: this.probed(), locales: { ...this.locales }, installing: this.installing }; },
    });
    apple.on("change", manager.onChange);
    router.apple = apple;
    service.speech = router;
    service.model = (language) => router.state(language);
    let choice = "bad";
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [models.parakeet[choice]] });
    global.workspaceProbe.chooseModelFolder = (value) => {
      choice = value;
    };
    manager.emit("change");
  },
  // Runs the real helpers far enough to prove they refuse to work without models,
  // without any network access.
  checkSpeechHelpers: async () => {
    const { LineHelper } = require("../recording/speech");
    const { BIN } = require("../local-ai/fluid-model");
    const empty = fs.mkdtempSync(path.join(profile, "empty-models-"));
    const outcomes = {};
    for (const [name, binary, args] of [
      ["parakeet", path.join(BIN, "focusbae-asr"), ["serve", "--models", empty]],
      ["apple", path.join(__dirname, "../meeting-capture/bin/focusbae-transcribe").replace("app.asar/", "app.asar.unpacked/"), ["--serve", "xx-XX"]],
    ]) {
      if (!fs.existsSync(binary)) {
        outcomes[name] = "missing-binary";
        continue;
      }
      try {
        await new LineHelper(binary, args).start();
        outcomes[name] = "started";
      } catch (error) {
        outcomes[name] = error.code;
      }
    }
    return outcomes;
  },
  configureLocalRecording: (nativeMicrophone = false, ready = false) => {
    const service = require("../workspace-window").recording();
    const { EventEmitter } = require("node:events");
    service.capabilities = () => ({
      microphone: { ok: true },
      system: { ok: true },
    });
    service.speech = null;
    service.model = () => ({ ready, model: "synthetic-test-only" });
    service.createEngine = () => ({
      load: async () => {},
      dispose: async () => {},
      transcribe: async () => ({
        content: "Synthetic recording transcript from this Mac.",
      }),
    });
    service.createSource = (kind) => {
      if (kind === "microphone" && nativeMicrophone)
        return new (require("../recording/sources").Microphone)();
      const source = new EventEmitter();
      let timer;
      const pcm = Buffer.alloc(3200);
      for (let n = 0; n < 1600; n++)
        pcm.writeInt16LE(Math.round(Math.sin(n * 0.07) * 8000), n * 2);
      source.start = async () => {
        source.emit("audio", pcm);
        timer = setInterval(() => source.emit("audio", pcm), 100);
      };
      source.stop = async () => {
        clearInterval(timer);
      };
      return source;
    };
    service.emitChange();
  },
  seed: () => {
    const { randomUUID } = require("node:crypto");
    const store = global.workspaceProbe.catalog.store;
    const context = () => ({
      workspaceId: store.identity.id,
      clientRequestId: randomUUID(),
    });
    store.createNote(context(), {
      title: "<img src=x onerror=alert(1)>",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "<script>window.injected=true</script> javascript:alert(1)",
              },
            ],
          },
        ],
      },
    });
    store.createNote(context(), {
      title: "Planning notes",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "We agreed to cut cloud spending next quarter.",
              },
            ],
          },
        ],
      },
    });
  },
  native: async () => {
    const audio = await import("audiotee");
    return {
      audio: !!audio.AudioTee,
      versions: process.versions,
    };
  },
  // A transcribed recording with one detected speaker and an unowned suggestion.
  seedSpeakerMeeting: async () => {
    const { randomUUID } = require("node:crypto");
    const store = global.workspaceProbe.catalog.store;
    const context = () => ({ workspaceId: store.identity.id, clientRequestId: randomUUID() });
    let recording = store.createRecording(context(), { purpose: "conversation", sourceMode: "microphone" });
    for (const state of ["recording", "stopping", "captured"])
      recording = store.updateRecording({ ...context(), expectedRevision: recording.revision }, recording.id,
        state === "captured" ? { state, endedAt: new Date().toISOString(), transcriptionState: "complete" } : { state });
    const speaker = store.createSpeaker(context(), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
    store.createTranscript(context(), {
      recordingId: recording.id, source: "microphone", startMs: 0, endMs: 3000,
      text: "I will send the pricing sheet by Friday.", speakerId: speaker.id,
    });
    const service = require("../workspace-window").recording();
    service.extractor = null;
    await require("../workspace/action-extraction").extractActions(store, recording.id, null);
    service.emitChange();
    return { recordingId: recording.id, speakerId: speaker.id };
  },
  // A meeting with the owner and Priya, each with one accepted promise.
  seedPeopleMeeting: async () => {
    const { randomUUID } = require("node:crypto");
    const store = global.workspaceProbe.catalog.store;
    const context = (revision) => ({ workspaceId: store.identity.id, clientRequestId: randomUUID(), ...(revision ? { expectedRevision: revision } : {}) });
    let recording = store.createRecording(context(), { purpose: "conversation", sourceMode: "both" });
    for (const state of ["recording", "stopping", "captured"])
      recording = store.updateRecording(context(recording.revision), recording.id,
        state === "captured" ? { state, endedAt: new Date().toISOString(), transcriptionState: "complete" } : { state });
    const me = store.createSpeaker(context(), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
    const priya = store.createSpeaker(context(), { recordingId: recording.id, label: "Speaker 1 · Mac audio" });
    store.createTranscript(context(), { recordingId: recording.id, source: "microphone", startMs: 0, endMs: 2000,
      text: "I will send the onboarding plan by Monday.", speakerId: me.id });
    store.createTranscript(context(), { recordingId: recording.id, source: "system", startMs: 3000, endMs: 5000,
      text: "I will confirm the pilot group on Wednesday.", speakerId: priya.id });
    store.identifySpeaker(context(me.revision), me.id, { identity: { kind: "self" } });
    store.identifySpeaker(context(priya.revision), priya.id, { identity: { kind: "person", label: "Priya" } });
    await require("../workspace/action-extraction").extractActions(store, recording.id, null);
    for (const action of store.list({ workspaceId: store.identity.id }, "action"))
      if (["I will send the onboarding plan by Monday", "I will confirm the pilot group on Wednesday"].includes(action.title))
        store.transitionAction(context(action.revision), action.id, { status: "accepted" });
    require("../workspace-window").recording().emitChange();
    return { recordingId: recording.id };
  },
  // The same promise made in two conversations, so the UI has a restatement chain.
  seedRestatement: async () => {
    const { randomUUID } = require("node:crypto");
    const store = global.workspaceProbe.catalog.store;
    const context = (revision) => ({ workspaceId: store.identity.id, clientRequestId: randomUUID(), ...(revision ? { expectedRevision: revision } : {}) });
    const { extractActions } = require("../workspace/action-extraction");
    for (const text of [
      "I will send the quarterly report by Friday.",
      "I will send the quarterly report on Monday.",
    ]) {
      let recording = store.createRecording(context(), { purpose: "conversation", sourceMode: "microphone" });
      for (const state of ["recording", "stopping", "captured"])
        recording = store.updateRecording(context(recording.revision), recording.id,
          state === "captured" ? { state, endedAt: new Date().toISOString(), transcriptionState: "complete" } : { state });
      const speaker = store.createSpeaker(context(), { recordingId: recording.id, label: "Speaker 1 · Microphone" });
      store.identifySpeaker(context(speaker.revision), speaker.id, { identity: { kind: "self" } });
      store.createTranscript(context(), { recordingId: recording.id, source: "microphone", startMs: 0, endMs: 3000, text, speakerId: speaker.id });
      await extractActions(store, recording.id, null);
    }
    require("../workspace-window").recording().emitChange();
    return { ok: true };
  },
  // A transcribed recording where speaker detection never ran.
  seedUndetectedSpeakers: () => {
    const { randomUUID } = require("node:crypto");
    const store = global.workspaceProbe.catalog.store;
    const context = (revision) => ({ workspaceId: store.identity.id, clientRequestId: randomUUID(), ...(revision ? { expectedRevision: revision } : {}) });
    let recording = store.createRecording(context(), { purpose: "conversation", sourceMode: "microphone" });
    for (const state of ["recording", "stopping", "captured"])
      recording = store.updateRecording(context(recording.revision), recording.id,
        state === "captured"
          ? { state, endedAt: new Date().toISOString(), transcriptionState: "complete", metadata: { diarization: { status: "skipped", reason: "MODEL_MISSING" } } }
          : { state });
    store.createTranscript(context(), { recordingId: recording.id, source: "microphone", startMs: 0, endMs: 2000, text: "No speakers were detected here." });
    require("../workspace-window").recording().emitChange();
    return { recordingId: recording.id };
  },
  // A conversation recorded on speakers: the far side lands on both sources.
  seedEchoedMeeting: () => {
    const { randomUUID } = require("node:crypto");
    const store = global.workspaceProbe.catalog.store;
    const context = (revision) => ({ workspaceId: store.identity.id, clientRequestId: randomUUID(), ...(revision ? { expectedRevision: revision } : {}) });
    let recording = store.createRecording(context(), { purpose: "conversation", sourceMode: "both" });
    for (const state of ["recording", "stopping", "captured"])
      recording = store.updateRecording(context(recording.revision), recording.id,
        state === "captured" ? { state, endedAt: new Date().toISOString(), transcriptionState: "complete" } : { state });
    const line = (source, startMs, endMs, text) =>
      store.createTranscript(context(), { recordingId: recording.id, source, startMs, endMs, text });
    line("microphone", 9496, 12296, "Hello, let's start. What's your update?");
    line("microphone", 14116, 32576, "Hey team, I finished the pagination fix and pushed it to staging.");
    line("system", 14228, 32600, "Hey team, I finished the pagination fix and pushed it to staging.");
    line("microphone", 33676, 51556, "Sure, I'll review that PR today.");
    require("../workspace-window").recording().emitChange();
    return { recordingId: recording.id };
  },
  seedSources: () => {
    const store = global.workspaceProbe.catalog.store;
    const context = () => ({
      workspaceId: store.identity.id,
      clientRequestId: require("node:crypto").randomUUID(),
    });
    const recording = store.createRecording(context(), {});
    store.createTranscript(context(), {
      recordingId: recording.id,
      source: "system",
      startMs: 60000,
      endMs: 63000,
      text: "Sourcefixture transcript from the shoreline.",
    });
    store.createAction(context(), { title: "Review sourcefixture" });
  },
  seedActions: () => {
    const store = global.workspaceProbe.catalog.store;
    const { randomUUID } = require("node:crypto");
    const context = (expectedRevision) => ({
      workspaceId: store.identity.id,
      clientRequestId: randomUUID(),
      ...(expectedRevision ? { expectedRevision } : {}),
    });
    const recording = store.createRecording(context(), {});
    const segment = store.createTranscript(context(), {
      recordingId: recording.id,
      source: "system",
      startMs: 74000,
      endMs: 79000,
      text: "Asha will send the enterprise security review by Friday.",
    });
    const quote = segment.text;
    const proposal = store.proposeAction(context(), {
      title: "Send the enterprise security review",
      evidence: [
        {
          segmentId: segment.id,
          revision: segment.revision,
          quote,
          startOffset: 0,
          endOffset: quote.length,
        },
      ],
    });
    const staleSegment = store.createTranscript(context(), {
      recordingId: recording.id,
      source: "microphone",
      startMs: 81000,
      endMs: 84000,
      text: "Prateek will confirm the rollout date.",
    });
    const stale = store.proposeAction(context(), {
      title: "Confirm the rollout date",
      evidence: [
        {
          segmentId: staleSegment.id,
          revision: staleSegment.revision,
          quote: staleSegment.text,
          startOffset: 0,
          endOffset: staleSegment.text.length,
        },
      ],
    });
    store.updateTranscript(context(staleSegment.revision), staleSegment.id, {
      text: "The rollout date still needs discussion.",
    });
    const mine = store.createAction(context(), {
      title: "Prepare the local pilot checklist",
      dueDate: "2020-01-01",
      priority: "high",
    });
    store.createAction(context(), {
      title: "Wait for legal review",
      owner: { kind: "person", id: randomUUID() },
      ownerLabel: "Asha",
    });
    store.createAction(context(), {
      title: "Assign release owner",
      owner: { kind: "unknown", id: null },
    });
    const completed = store.createAction(context(), {
      title: "Verify local storage",
    });
    store.transitionAction(context(completed.revision), completed.id, {
      status: "done",
    });
    const archived = store.createAction(context(), {
      title: "Discard old launch draft",
    });
    store.transitionAction(context(archived.revision), archived.id, {
      status: "dropped",
    });
    return {
      proposal: proposal.id,
      stale: stale.id,
      mine: mine.id,
      recording: recording.id,
    };
  },
};
require("../local-first-main");
