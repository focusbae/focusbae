"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  session,
  protocol,
  net,
  ipcMain,
  dialog,
  Notification,
} = require("electron");
const { WorkspaceCatalog } = require("./workspace/catalog");
const { registerWorkspaceIPC, DOCUMENT, trusted, publicError } = require("./workspace/ipc");
const { randomUUID } = require("node:crypto");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "focusbae-workspace",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let win = null;
let catalog;
let recording;
let models;
let reminders;
let semantic;
let initialization;
let quitting = false;
let pendingCommand = null;
let clipboardHistory;
let backups;
const COMMANDS = new Set(["new-note", "record", "recordings", "actions", "settings", "clipboard"]);
const flushRequests = new Map();
function flushPending() {
  if (!win || win.isDestroyed()) return Promise.resolve(true);
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flushRequests.delete(requestId);
      resolve(false);
    }, 10000);
    flushRequests.set(requestId, (ok) => {
      clearTimeout(timer);
      flushRequests.delete(requestId);
      resolve(ok);
    });
    win.webContents.send("workspace:flush-request", requestId);
  });
}
const PARTITION = "focusbae-workspace";
const rendererRoot = path.join(__dirname, "desktop-ui", "dist");

function assetPath(raw) {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "focusbae-workspace:" ||
      url.host !== "app" ||
      url.username ||
      url.password ||
      url.search
    )
      return null;
    const relative = decodeURIComponent(url.pathname).slice(1);
    if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+\.(js|css|png|svg))$/.test(relative))
      return null;
    const target = path.join(rendererRoot, relative);
    return fs
      .realpathSync(target)
      .startsWith(fs.realpathSync(rendererRoot) + path.sep)
      ? target
      : null;
  } catch {
    return null;
  }
}

function initialize({ privacy, busy, desktopSettings, onRecordingChange = () => {} }) {
  clipboardHistory = new (require("./workspace/clipboard-history").ClipboardHistory)(require("electron").clipboard);
  clipboardHistory.on("change", (value) => {
    if (win && !win.isDestroyed()) win.webContents.send("workspace:clipboard-event", value);
    onRecordingChange();
  });
  ipcMain.handle("workspace:command.take", (event) => {
    if (!trusted(event, win)) return publicError({ code: "PERMISSION_DENIED" });
    // A renderer about to unload must not consume the next window's intent.
    return { ok: true, value: win.webContents.isLoadingMainFrame() ? null : pendingCommand };
  });
  ipcMain.handle("workspace:command.ack", (event, input) => {
    if (!trusted(event, win)) return publicError({ code: "PERMISSION_DENIED" });
    if (!win.webContents.isLoadingMainFrame() && pendingCommand?.id === input?.id) pendingCommand = null;
    return { ok: true, value: true };
  });
  ipcMain.handle("workspace:flush-result", (event, input) => {
    if (
      !trusted(event, win) ||
      typeof input?.requestId !== "string" ||
      typeof input?.ok !== "boolean"
    )
      return;
    flushRequests.get(input.requestId)?.(input.ok);
  });
  const isolated = session.fromPartition(PARTITION);
  const { NoteAttachments, parseImageURL, imageResponse } = require("./workspace/note-attachments");
  isolated.protocol.handle("focusbae-workspace", (request) => {
    if (request.method === "GET" && parseImageURL(request.url)) return imageResponse(catalog, request.url);
    const target = assetPath(request.url);
    return request.method === "GET" && target
      ? net.fetch(pathToFileURL(target).href)
      : new Response("Not found", { status: 404 });
  });
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !assetPath(details.url) && !parseImageURL(details.url) }),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolated.on("will-download", (event) => event.preventDefault());
  catalog = new WorkspaceCatalog(
    path.join(app.getPath("userData"), "workspaces"),
    { busy: () => busy() || recording?.busy() },
  );
  const { RecordingService } = require("./recording/service");
  const { ExtractionRuntime } = require("./local-ai/extraction-runtime");
  const { DiarizationRuntime } = require("./local-ai/diarization-runtime");
  const extractor = new ExtractionRuntime();
  const { SpeechRouter } = require("./recording/speech");
  const diarizer = new DiarizationRuntime();
  const speech = new SpeechRouter();
  recording = new RecordingService({
    catalog,
    legacyBusy: busy,
    extractor,
    diarizer,
    speech,
  });
  const { ModelManager } = require("./recording/model-manager");
  models = new ModelManager({
    speech,
    inUse: () => !!recording.processing || busy(),
    extraction: extractor,
    diarization: diarizer,
  });
  models.on("change", () => {
    if (win && !win.isDestroyed())
      win.webContents.send("workspace:models-event", models.snapshot());
    recording.emitChange();
  });
  let trayRecordingKey = "";
  recording.on("change", () => {
    if (win && !win.isDestroyed())
      win.webContents.send("workspace:recording-event", recording.snapshot());
    const key = `${recording.active?.id ?? ""}:${recording.processing?.id ?? ""}`;
    if (key !== trayRecordingKey) {
      trayRecordingKey = key;
      if (win && !win.isDestroyed())
        win.webContents.send("workspace:models-event", models.snapshot());
      onRecordingChange();
    }
  });
  require("electron").powerMonitor.on("suspend", () => {
    if (recording.active)
      recording.stop(recording.active.id, "sleep").catch(() => {});
  });
  const ready = () => {
    if (!initialization) {
      initialization = catalog.initialize().catch((error) => {
        initialization = null;
        throw error;
      });
    }
    return initialization;
  };
  ready().catch(() => {});
  models.initialize();
  const { EmbeddingRuntime } = require("./local-ai/embedding-runtime");
  const { SemanticSearch } = require("./workspace/semantic-search");
  semantic = new SemanticSearch({ catalog, embedder: new EmbeddingRuntime() });
  backups = new (require("./workspace/backup").BackupService)(catalog);
  backups.on("change", (value) => {
    if (win && !win.isDestroyed()) win.webContents.send("workspace:backup-event", value);
  });
  // Capability probes launch helpers, so they run only when Settings asks
  // (models.refresh); startup stays free of helper processes.
  models.embedding = semantic;
  const attachments = new NoteAttachments(catalog);
  app.once("will-quit", () => attachments.close());
  registerWorkspaceIPC({
    attachments,
    ipcMain,
    catalog,
    getWindow: () => win,
    privacy,
    ready,
    dialog,
    recording,
    models,
    semantic,
    playback: new (require("./recording/playback").PlaybackService)(catalog, recording),
    extraction: extractor,
    desktopSettings,
    clipboardHistory,
    backups,
    appleNotes: new (require("./workspace/apple-notes").AppleNotesImporter)(),
  });
  const { ReminderService } = require("./workspace/reminders");
  reminders = new ReminderService({
    catalog,
    notify: ({ title, body }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body, silent: true });
      notification.on("click", () => {
        open("actions");
      });
      notification.show();
    },
  });
  ready().then(() => reminders.start()).catch(() => {});
  return catalog;
}
function open(command) {
  if (!catalog) return null;
  if (command !== undefined) {
    if (!COMMANDS.has(command)) throw new Error("Unknown workspace command");
    // Keep the latest navigation intent until the renderer is ready and its
    // current dialog/save is finished. Repeated shortcuts do not pile up notes.
    pendingCommand = { id: randomUUID(), name: command };
  }
  if (win && !win.isDestroyed()) {
    win.show();
    app.focus({ steal: true });
    win.focus();
    if (pendingCommand) win.webContents.send("workspace:command-available");
    return win;
  }
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: "FocusBae",
    backgroundColor: "#fafafa",
    webPreferences: {
      preload: path.join(__dirname, "workspace-preload.js"),
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-finish-load", () => {
    if (pendingCommand && win && !win.isDestroyed()) win.webContents.send("workspace:command-available");
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("will-prevent-unload", () => {
    flushPending().then((ok) => {
      if (win && !win.isDestroyed()) {
        if (ok)
          setImmediate(() => {
            if (win && !win.isDestroyed()) win.webContents.reload();
          });
        else win.webContents.send("workspace:resume");
      }
    });
  });
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.once("ready-to-show", () => {
    if (win && !win.isDestroyed()) {
      win.show();
      app.focus({ steal: true });
      win.focus();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  win.loadURL(DOCUMENT);
  return win;
}
function owns(contents) {
  return !!win && !win.isDestroyed() && contents === win.webContents;
}
module.exports = {
  initialize,
  open,
  owns,
  isOpen: () => !!win && !win.isDestroyed(),
  getWindow: () => win,
  close: async () => {
    clipboardHistory?.close();
    reminders?.close();
    await semantic?.close();
    await recording?.close();
    await models?.close();
    await catalog?.close();
  },
  recording: () => recording,
  models: () => models,
  clipboardHistory: () => clipboardHistory,
  recordingBusy: () => recording?.busy() ?? false,
  pending: () => catalog?.pending > 0 || recording?.busy(),
  flushPending,
  resume: () => {
    if (win && !win.isDestroyed()) win.webContents.send("workspace:resume");
  },
  setQuitting: (value) => {
    quitting = value;
  },
  assetPath,
};
