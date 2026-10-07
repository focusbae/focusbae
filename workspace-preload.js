"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const invoke = (name, input) => ipcRenderer.invoke(`workspace:${name}`, input);
contextBridge.exposeInMainWorld("focusbaeWorkspace", {
  bootstrap: () => invoke("bootstrap"),
  commands: {
    take: () => invoke("command.take"),
    ack: (input) => invoke("command.ack", input),
    onAvailable: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("workspace:command-available", handler);
      return () => ipcRenderer.removeListener("workspace:command-available", handler);
    },
  },
  appSettings: Object.fromEntries(
    ["get", "captureShortcut", "resetShortcut", "setLogin", "setDock", "checkForUpdates", "downloadUpdate", "installUpdate"].map(
      (name) => [name, (input) => invoke(`appSettings.${name}`, input)],
    ),
  ),
  clipboard: Object.fromEntries(
    ["state", "setEnabled", "clear", "remove", "copy"].map(
      (name) => [name, (input) => invoke(`clipboard.${name}`, input)],
    ),
  ),
  backup: Object.fromEntries(["status", "create", "restore"].map(
    (name) => [name, (input) => invoke(`backup.${name}`, input)],
  )),
  onBackup: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("workspace:backup-event", handler);
    return () => ipcRenderer.removeListener("workspace:backup-event", handler);
  },
  onClipboard: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("workspace:clipboard-event", handler);
    return () => ipcRenderer.removeListener("workspace:clipboard-event", handler);
  },
  models: Object.fromEntries(
    ["state", "refresh", "download", "import", "installLanguage"].map(
      (name) => [name, (input) => invoke(`models.${name}`, input)],
    ),
  ),
  onModels: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("workspace:models-event", handler);
    return () => ipcRenderer.removeListener("workspace:models-event", handler);
  },
  capture: Object.fromEntries(
    [
      "state",
      "start",
      "stop",
      "detail",
      "rename",
      "list",
      "retry",
      "cancel",
      "discard",
      "identifySpeaker",
      "playbackInfo",
      "playbackRead",
      "storage",
      "importWav",
      "exportAudio",
    ].map((name) => [name, (input) => invoke(`capture.${name}`, input)]),
  ),
  onRecording: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("workspace:recording-event", handler);
    return () =>
      ipcRenderer.removeListener("workspace:recording-event", handler);
  },
  workspace: {
    list: () => invoke("workspace.list"),
    create: (input) => invoke("workspace.create", input),
    open: (input) => invoke("workspace.open", input),
    update: (input) => invoke("workspace.update", input),
  },
  notes: Object.fromEntries(
    [
      "list",
      "browse",
      "get",
      "create",
      "daily",
      "update",
      "delete",
      "restore",
      "purge",
      "move",
      "findCommitments",
      "rewrite",
    ].map((name) => [name, (input) => invoke(`notes.${name}`, input)]),
  ),
  attachments: Object.fromEntries(
    ["begin", "chunk", "finish", "cancel", "info", "open"].map(
      (name) => [name, (input) => invoke(`attachments.${name}`, input)],
    ),
  ),
  folders: Object.fromEntries(
    ["list", "create", "update", "delete"].map((name) => [
      name,
      (input) => invoke(`folders.${name}`, input),
    ]),
  ),
  search: {
    query: (input) => invoke("search.query", input),
    hybrid: (input) => invoke("search.hybrid", input),
    source: (input) => invoke("search.source", input),
  },
  semantic: { status: () => invoke("semantic.status") },
  documents: {
    convert: (input) => invoke("documents.convert", input),
    import: (input) => invoke("documents.import", input),
    export: (input) => invoke("documents.export", input),
  },
  appleNotes: {
    preview: (input) => invoke("appleNotes.preview", input),
    import: (input) => invoke("appleNotes.import", input),
  },
  onFlush: (listener) => {
    const handler = async (_event, requestId) => {
      let ok = false;
      try {
        await listener();
        ok = true;
      } catch {
        /* Main keeps the app open on failure. */
      }
      await invoke("flush-result", { requestId, ok });
    };
    ipcRenderer.on("workspace:flush-request", handler);
    return () => ipcRenderer.removeListener("workspace:flush-request", handler);
  },
  onResume: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("workspace:resume", handler);
    return () => ipcRenderer.removeListener("workspace:resume", handler);
  },
  recordings: { list: (input) => invoke("recordings.list", input) },
  actions: Object.fromEntries(
    ["list", "browse", "get", "create", "update", "transition", "delete"].map(
      (name) => [name, (input) => invoke(`actions.${name}`, input)],
    ),
  ),
  links: {
    forNote: (input) => invoke("notes.links", input),
    resolve: (input) => invoke("notes.resolveLink", input),
    targets: (input) => invoke("notes.linkTargets", input),
    graph: (input) => invoke("notes.graph", input),
  },
  people: {
    list: (input) => invoke("people.list", input),
    get: (input) => invoke("people.get", input),
    priorContext: (input) => invoke("people.priorContext", input),
  },
  reminders: {
    due: (input) => invoke("reminders.due", input),
    snooze: (input) => invoke("reminders.snooze", input),
  },
  privacy: {
    get: () => invoke("privacy.get"),
    setStrict: (input) => invoke("privacy.setStrict", input),
    revoke: (input) => invoke("privacy.revoke", input),
  },
  onChange: (listener) => {
    if (typeof listener !== "function")
      throw new TypeError("Expected a listener");
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("workspace:event", handler);
    return () => ipcRenderer.removeListener("workspace:event", handler);
  },
});
