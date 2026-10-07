"use strict";

const { randomUUID } = require("node:crypto");
const v = require("./validation");
const { check, WorkspaceError } = require("./errors");
const { publicNote } = require("./notebook");
const portable = require("./portable");
const actions = require("./actions");
const reminders = require("./reminders");
const ORIGIN = "focusbae-workspace://app";
const DOCUMENT = `${ORIGIN}/index.html`;
const CHANNELS = [
  "bootstrap",
  "backup.status",
  "backup.create",
  "backup.restore",
  "appSettings.get",
  "appSettings.captureShortcut",
  "appSettings.resetShortcut",
  "appSettings.setLogin",
  "appSettings.setDock",
  "appSettings.checkForUpdates",
  "appSettings.downloadUpdate",
  "appSettings.installUpdate",
  "clipboard.state",
  "clipboard.setEnabled",
  "clipboard.clear",
  "clipboard.remove",
  "clipboard.copy",
  "workspace.list",
  "workspace.create",
  "workspace.open",
  "workspace.update",
  "notes.list",
  "notes.browse",
  "notes.get",
  "notes.create",
  "notes.move",
  "folders.list",
  "folders.create",
  "folders.update",
  "folders.delete",
  "notes.daily",
  "notes.update",
  "notes.delete",
  "notes.restore",
  "notes.purge",
  "search.query",
  "search.hybrid",
  "semantic.status",
  "search.source",
  "documents.convert",
  "documents.import",
  "appleNotes.preview",
  "appleNotes.import",
  "documents.export",
  "attachments.begin",
  "attachments.chunk",
  "attachments.finish",
  "attachments.cancel",
  "attachments.info",
  "attachments.open",
  "recordings.list",
  "actions.list",
  "actions.browse",
  "actions.get",
  "actions.create",
  "actions.update",
  "actions.transition",
  "actions.delete",
  "reminders.due",
  "people.list",
  "notes.links",
  "notes.graph",
  "notes.resolveLink",
  "notes.linkTargets",
  "notes.findCommitments",
  "notes.rewrite",
  "people.get",
  "people.priorContext",
  "reminders.snooze",
  "privacy.get",
  "privacy.setStrict",
  "privacy.revoke",
  "capture.state",
  "capture.start",
  "capture.stop",
  "capture.detail",
  "capture.rename",
  "capture.list",
  "capture.retry",
  "capture.cancel",
  "capture.discard",
  "capture.identifySpeaker",
  "capture.playbackInfo",
  "capture.playbackRead",
  "capture.storage",
  "capture.importWav",
  "capture.exportAudio",
  "models.state",
  "models.refresh",
  "models.download",
  "models.import",
  "models.installLanguage",
];
const PUBLIC_ERRORS = {
  ATTACHMENT_TOO_LARGE: "This file is larger than 100 MB. Choose a smaller file.",
  ATTACHMENT_MISSING: "This attachment is missing. Restore it from a workspace backup.",
  ATTACHMENT_CORRUPT: "This attachment failed its integrity check. Restore it from a workspace backup.",
  ATTACHMENT_IN_USE: "Remove this attachment from its note before deleting it.",
  NO_AUDIO: "Audio is unavailable. It may have been deleted or not kept for playback.",
  INVALID_AUDIO: "The WAV file is incomplete or damaged. The original file was left unchanged.",
  UNSUPPORTED_AUDIO: "Choose an uncompressed 16-bit PCM WAV file with one or two channels.",
  INVALID_BACKUP: "The backup is incomplete, damaged or unsupported. Your existing workspace has not been replaced.",
  BACKUP_BUSY: "Finish recording or transcription before backing up or restoring.",
  MODEL_INVALID:
    "Choose a complete copy of the supported model folder. It failed verification.",
  EXTRACTION_FAILED:
    "The on-device model couldn't read this page. Try again, or split a very long page into smaller ones.",
  MODEL_INCOMPATIBLE:
    "This local model requires Apple Silicon, and Apple speech requires macOS 26 or later.",
  CONSENT_REQUIRED:
    "Confirm consent and temporary local audio storage before recording.",
  SOURCE_UNAVAILABLE: "The selected audio source is not available on this Mac.",
  MODEL_MISSING:
    "Transcription needs Apple speech (macOS 26) or the Parakeet download. Your temporary audio stays on this Mac.",
  SPOOL_MISSING:
    "Audio recovery files are missing. Existing transcript text has been kept.",
  SPOOL_CORRUPT:
    "Audio recovery needs attention. Existing files have been kept.",
  INVALID_INPUT: "The request contains an invalid value.",
  REWRITE_UNAVAILABLE:
    "Rewriting needs Apple Intelligence on this Mac. Your writing is untouched.",
  REWRITE_UNSAFE:
    "The rewrite changed a number, so your words were kept instead. Try a shorter selection.",
  SCOPE_MISMATCH: "The workspace changed. Reload and try again.",
  REVISION_CONFLICT:
    "This item changed elsewhere. Your unsaved writing is still open; export a recovery copy before reloading.",
  REVISION_REQUIRED: "Reload before saving settings.",
  WORKSPACE_BUSY: "Finish the active recording before switching workspaces.",
  DISK_FULL: "Storage is full. Free some space and retry.",
  NOT_FOUND: "The workspace or item is unavailable.",
  INVALID_WORKSPACE:
    "The workspace could not be opened. Your files have been kept.",
  NEWER_SCHEMA: "This workspace needs a newer version of FocusBae.",
  POLICY_DENIED: "This operation is not permitted.",
  PERMISSION_DENIED: "This window cannot access the workspace.",
  LIMIT_REACHED: "The workspace limit has been reached.",
  CONFLICT:
    "An item already exists for this date. Your original has been kept in Trash.",
  UNSUPPORTED_FORMAT:
    "Choose a UTF-8 Markdown, text, HTML, or FocusBae note JSON file.",
  APPLE_NOTES_ACCESS:
    "FocusBae could not read Apple Notes. Allow access in System Settings → Privacy & Security → Automation, then try again.",
  IMPORT_FAILED: "This Apple note could not be imported. It remains in Apple Notes.",
  INVALID_TRANSITION: "That action has changed state. Reload it and try again.",
  REOPEN_REQUIRED:
    "Use Reopen to return a completed or dismissed action to work.",
  STALE_SOURCE:
    "The supporting transcript changed. Review the source before accepting this suggestion.",
  INVALID_EVIDENCE: "The supporting transcript quote is no longer valid.",
};
function publicError(error) {
  const code = Object.hasOwn(PUBLIC_ERRORS, error.code)
    ? error.code
    : "UNAVAILABLE";
  return {
    ok: false,
    error: {
      code,
      message:
        PUBLIC_ERRORS[code] ||
        "Local workspace unavailable. Your existing files have been kept.",
      retryable: ["UNAVAILABLE", "DISK_FULL", "WORKSPACE_BUSY"].includes(code),
    },
  };
}
function trusted(event, window) {
  return (
    !!window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === DOCUMENT
  );
}
function registerWorkspaceIPC({
  ipcMain,
  catalog,
  getWindow,
  privacy,
  ready,
  dialog,
  recording,
  models,
  semantic,
  // The same on-device extractor a recording uses; absent on a Mac without it,
  // where the sentence rules stand in.
  extraction = null,
  desktopSettings,
  clipboardHistory,
  backups,
  playback,
  appleNotes,
  attachments = new (require("./note-attachments").NoteAttachments)(catalog),
}) {
  const emit = (type = "workspace.changed", entity) => {
    const win = getWindow();
    if (win && !win.isDestroyed() && catalog.store) {
      const value = catalog.active();
      win.webContents.send("workspace:event", {
        type: typeof type === "string" ? type : "workspace.changed",
        workspaceId: value.id,
        entityId: entity?.id ?? value.id,
        revision: entity?.revision ?? value.revision,
        sequence: ++catalog.sequence,
      });
    }
  };
  const snapshot = () => ({
    workspace: catalog.active(),
    workspaces: catalog.list(),
    privacy: privacy.policy.snapshot(),
    sequence: catalog.sequence,
  });
  const handlers = {
    "backup.status": (input) => {
      v.object(input, ["workspaceId"]);
      return backups.status(input.workspaceId);
    },
    "backup.create": async (input, event) => {
      v.object(input, ["workspaceId"]); catalog.scoped(input.workspaceId); backups.guard();
      const consent = await dialog.showMessageBox(getWindow(), {
        type: "warning", buttons: ["Choose backup location", "Cancel"], defaultId: 1, cancelId: 1,
        message: "Create a full workspace backup?",
        detail: "This unencrypted file includes your notes, transcripts, actions, people, workspace settings, attachments and any retained or recovery audio. Anyone with the file can read its contents. Choose an external drive for protection against losing this Mac. Clipboard history, downloaded models and app-wide settings are excluded.",
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
      if (consent.response !== 0) return { canceled: true };
      const selection = await dialog.showSaveDialog(getWindow(), {
        title: "Save workspace backup", defaultPath: `FocusBae-${new Date().toISOString().replace(/[:.]/g, "-")}.focusbae-backup`,
        filters: [{ name: "FocusBae workspace backup", extensions: ["focusbae-backup"] }],
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
      if (selection.canceled || !selection.filePath) return { canceled: true };
      return backups.create(input.workspaceId, selection.filePath);
    },
    "backup.restore": async (input, event) => {
      v.object(input, ["workspaceId"]); catalog.scoped(input.workspaceId); backups.guard();
      const selection = await dialog.showOpenDialog(getWindow(), {
        title: "Choose a workspace backup", properties: ["openFile"],
        filters: [{ name: "FocusBae workspace backup", extensions: ["focusbae-backup"] }],
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
      if (selection.canceled || !selection.filePaths.length) return { canceled: true };
      const consent = await dialog.showMessageBox(getWindow(), {
        type: "question", buttons: ["Restore a separate workspace", "Cancel"], defaultId: 1, cancelId: 1,
        message: "Restore this backup?", detail: "The backup will be checked and restored into a new workspace on this Mac. Your current workspace stays open and unchanged. Only restore backups from a source you trust.",
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
      if (consent.response !== 0) return { canceled: true };
      const value = await backups.restore(selection.filePaths[0]);
      emit(); return value;
    },
    "clipboard.state": () => clipboardHistory.snapshot(),
    "clipboard.setEnabled": async (input, event) => {
      v.object(input, ["enabled"]);
      v.boolean(input.enabled, "enabled");
      if (input.enabled && !clipboardHistory.enabled) {
        const result = await dialog.showMessageBox(getWindow(), {
          type: "question", buttons: ["Enable for this session", "Cancel"], defaultId: 1, cancelId: 1,
          message: "Enable clipboard history?",
          detail: "FocusBae will keep up to 30 recently copied text items in memory on this Mac. Copied text can include passwords or other sensitive information; not every app marks these for exclusion. Nothing is uploaded or saved to a history file. Disabling or quitting clears the history. Existing clipboard contents are not imported.",
        });
        check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
        if (result.response !== 0) return clipboardHistory.snapshot();
      }
      return clipboardHistory.setEnabled(input.enabled);
    },
    "clipboard.clear": () => clipboardHistory.clear(),
    "clipboard.remove": (input) => {
      v.object(input, ["id"]);
      return clipboardHistory.remove(v.uuid(input.id));
    },
    "clipboard.copy": (input) => {
      v.object(input, ["id"]);
      return clipboardHistory.copy(v.uuid(input.id));
    },
    "appSettings.get": () => desktopSettings.get(),
    "appSettings.checkForUpdates": () => desktopSettings.checkForUpdates(),
    "appSettings.downloadUpdate": () => desktopSettings.downloadUpdate(),
    "appSettings.installUpdate": () => desktopSettings.installUpdate(),
    "appSettings.captureShortcut": (input, event) => {
      v.object(input, ["name"]);
      v.choice(input.name, ["workspace", "newNote", "actions", "record"], "shortcut");
      return desktopSettings.captureShortcut(event, input.name);
    },
    "appSettings.resetShortcut": (input) => {
      v.object(input, ["name"]);
      v.choice(input.name, ["workspace", "newNote", "actions", "record"], "shortcut");
      return desktopSettings.resetShortcut(input.name);
    },
    "appSettings.setLogin": (input) => {
      v.object(input, ["enabled"]);
      return desktopSettings.setLogin(v.boolean(input.enabled, "enabled"));
    },
    "appSettings.setDock": (input) => {
      v.object(input, ["enabled"]);
      return desktopSettings.setDock(v.boolean(input.enabled, "enabled"));
    },
    "models.state": () => models.snapshot(),
    "models.refresh": (input) => {
      v.object(input ?? {}, []);
      return models.refresh();
    },
    // Downloads are explicit user actions and need the models network permission.
    "models.download": async (input, event) => {
      v.object(input, ["kind"]);
      const kind = v.choice(input.kind, ["parakeet", "speakers"], "model kind");
      models.guard();
      const current = models.snapshot();
      const state = kind === "parakeet" ? current.speech.parakeet : current.diarization;
      if (state.ready || state.busy) return current;
      if (!(await privacy.permit("models"))) return models.snapshot();
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
      return models.start(kind);
    },
    // Offline install from a folder, for Strict Local or machines without network.
    "models.import": async (input, event) => {
      v.object(input, ["kind"]);
      const kind = v.choice(input.kind, ["parakeet", "speakers"], "model kind");
      models.guard();
      const result = await dialog.showOpenDialog(getWindow(), {
        title: kind === "parakeet" ? "Import Parakeet model folder" : "Import speaker detection model folder",
        properties: ["openDirectory"],
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
      return result.canceled || !result.filePaths.length
        ? models.snapshot()
        : models.importModel(kind, result.filePaths[0]);
    },
    // macOS downloads the language asset; FocusBae only asks for it on request.
    "models.installLanguage": async (input, event) => {
      v.object(input, ["locale"]);
      const locale = v.choice(input.locale, ["en-US", "hi-IN"], "language");
      models.guard();
      if (!(await privacy.permit("models"))) return models.snapshot();
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Window closed");
      return models.installLanguage(locale);
    },
    "capture.state": () => recording.snapshot(),
    "capture.playbackInfo": (input) => playback.info(input),
    "capture.playbackRead": (input) => playback.read(input),
    "capture.storage": (input) => {
      v.object(input, ["workspaceId"]);
      return recording.storage(input.workspaceId);
    },
    "capture.importWav": async (input, event) => {
      recording.validateImport(input);
      recording.guardImport();
      const result = await dialog.showOpenDialog(getWindow(), {
        title: "Import WAV recording",
        properties: ["openFile"],
        filters: [{ name: "PCM WAV audio", extensions: ["wav"] }],
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Workspace window closed");
      catalog.scoped(input.context.workspaceId);
      if (result.canceled || result.filePaths.length !== 1) return { canceled: true };
      return { canceled: false, recording: await recording.importWav(input, result.filePaths[0]) };
    },
    "capture.exportAudio": async (input, event) => {
      v.object(input, ["workspaceId", "id", "source"]);
      const store = catalog.scoped(input.workspaceId);
      const record = store.get({ workspaceId: input.workspaceId }, "recording", v.uuid(input.id));
      v.choice(input.source, ["all", "microphone", "system", "import"], "source");
      const day = record.startedAt.slice(0, 10);
      const result = await dialog.showSaveDialog(getWindow(), {
        title: "Export retained audio",
        defaultPath: `FocusBae-audio-${day}.wav`,
        filters: [{ name: "WAV audio", extensions: ["wav"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Workspace window closed");
      catalog.scoped(input.workspaceId);
      if (result.canceled || !result.filePath) return { canceled: true };
      const filePath = require("node:path").extname(result.filePath)
        ? result.filePath : `${result.filePath}.wav`;
      return { canceled: false, ...(await playback.exportWav(input, filePath)) };
    },
    "capture.start": (input) => recording.start(input),
    "capture.stop": (input) => {
      v.object(input, ["workspaceId", "id"]);
      catalog.scoped(input.workspaceId);
      v.uuid(input.id);
      return recording.stop(input.id);
    },
    "capture.list": (input) => {
      v.object(input, ["workspaceId", "offset"]);
      const store = catalog.scoped(input.workspaceId);
      const offset = v.integer(input.offset ?? 0, "offset");
      const rows = store._db
        .prepare(
          "SELECT id FROM recordings WHERE deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 40 OFFSET ?",
        )
        .all(offset);
      return {
        items: rows.map(({ id }) =>
          require("../recording/service").publicRecording(
            store.get({ workspaceId: input.workspaceId }, "recording", id),
          ),
        ),
        total: store._db
          .prepare(
            "SELECT count(*) AS count FROM recordings WHERE deleted_at IS NULL",
          )
          .get().count,
      };
    },
    "capture.detail": (input) => {
      v.object(input, ["workspaceId", "id", "offset"]);
      return recording.detail(
        input.workspaceId,
        v.uuid(input.id),
        v.integer(input.offset ?? 0, "offset"),
      );
    },
    // A name is the one field on a recording only the person writes, so it is
    // applied to the latest revision: transcription updating the same record in
    // the background must not turn a rename into a conflict.
    "capture.rename": (input) => {
      v.object(input, ["workspaceId", "id", "title"]);
      const store = catalog.scoped(input.workspaceId);
      const id = v.uuid(input.id);
      const current = store.get({ workspaceId: input.workspaceId }, "recording", id);
      const saved = store.updateRecording(
        { workspaceId: input.workspaceId, clientRequestId: randomUUID(), expectedRevision: current.revision },
        id,
        { title: v.text(input.title, "recording name", 200, true) },
      );
      recording.emitChange?.();
      emit("actions.changed");
      return require("../recording/service").publicRecording(saved);
    },
    "capture.identifySpeaker": async (input) => {
      v.object(input, ["workspaceId", "recordingId", "speakerId", "identity"]);
      catalog.scoped(input.workspaceId);
      const result = await recording.identifySpeaker(
        input.workspaceId,
        v.uuid(input.recordingId),
        v.uuid(input.speakerId),
        input.identity,
      );
      emit("actions.changed");
      return result;
    },
    "capture.retry": (input) => {
      v.object(input, ["workspaceId", "id"]);
      catalog.scoped(input.workspaceId);
      return recording.retry(v.uuid(input.id));
    },
    "capture.cancel": async (input) => {
      v.object(input, ["workspaceId", "id"]);
      catalog.scoped(input.workspaceId);
      await recording.cancel(v.uuid(input.id));
      return true;
    },
    "capture.discard": async (input, event) => {
      v.object(input, ["workspaceId", "id"]);
      catalog.scoped(input.workspaceId);
      v.uuid(input.id);
      const result = await dialog.showMessageBox(getWindow(), {
        type: "warning",
        message: "Delete audio from this Mac?",
        detail:
          "You will no longer be able to play or retry from this audio. Existing transcript text and notes will remain.",
        buttons: ["Keep audio", "Delete audio"],
        defaultId: 0,
        cancelId: 0,
      });
      check(
        trusted(event, getWindow()),
        "PERMISSION_DENIED",
        "Workspace window closed",
      );
      catalog.scoped(input.workspaceId);
      if (result.response !== 1) return false;
      recording.discard(input.id);
      return true;
    },
    bootstrap: () => snapshot(),
    "workspace.list": () => catalog.list(),
    "workspace.create": (input) => catalog.create(input),
    "workspace.open": (input) => catalog.open(input),
    "workspace.update": (input) => {
      v.object(input, ["context", "changes"]);
      return catalog.update(input.context, input.changes);
    },
    "notes.browse": (input) => {
      v.object(input, ["workspaceId", "view", "offset", "limit", "folderId"]);
      const { workspaceId, ...options } = input;
      return catalog.scoped(workspaceId).notebookList({ workspaceId }, options);
    },
    "notes.get": (input) => {
      v.object(input, ["workspaceId", "id", "includeDeleted"]);
      return publicNote(
        catalog
          .scoped(input.workspaceId)
          .get({ workspaceId: input.workspaceId }, "note", input.id, {
            includeDeleted: input.includeDeleted ?? false,
          }),
      );
    },
    "notes.create": (input) => {
      v.object(input, ["context", "note"]);
      v.object(input.note, ["title", "content", "folderId"]);
      return publicNote(
        catalog
          .scoped(input.context.workspaceId)
          .createNote(input.context, input.note),
      );
    },
    "notes.move": (input) => {
      v.object(input, ["context", "id", "folderId"]);
      return catalog
        .scoped(input.context.workspaceId)
        .moveNote(input.context, input.id, input.folderId ?? null);
    },
    "folders.list": (input) => {
      v.object(input, ["workspaceId"]);
      return catalog.scoped(input.workspaceId).folderList({ workspaceId: input.workspaceId });
    },
    "folders.create": (input) => {
      v.object(input, ["context", "folder"]);
      return catalog.scoped(input.context.workspaceId).createFolder(input.context, input.folder);
    },
    "folders.update": (input) => {
      v.object(input, ["context", "id", "changes"]);
      return catalog
        .scoped(input.context.workspaceId)
        .updateFolder(input.context, input.id, input.changes);
    },
    "folders.delete": (input) => {
      v.object(input, ["context", "id"]);
      return catalog.scoped(input.context.workspaceId).deleteFolder(input.context, input.id);
    },
    "notes.daily": (input) => {
      v.object(input, ["context"]);
      return publicNote(
        catalog.scoped(input.context.workspaceId).dailyNote(input.context),
      );
    },
    "notes.update": (input) => {
      v.object(input, ["context", "id", "changes"]);
      return publicNote(
        catalog
          .scoped(input.context.workspaceId)
          .editNote(input.context, input.id, input.changes),
      );
    },
    ...Object.fromEntries(
      ["delete", "restore"].map((method) => [
        `notes.${method}`,
        (input) => {
          v.object(input, ["context", "id"]);
          return publicNote(
            catalog
              .scoped(input.context.workspaceId)
              [method](input.context, "note", input.id),
          );
        },
      ]),
    ),
    "notes.purge": async (input, event) => {
      v.object(input, ["context", "id"]);
      const store = catalog.scoped(input.context.workspaceId);
      store._scope(input.context, true);
      const note = store.get({ workspaceId: input.context.workspaceId }, "note", input.id, { includeDeleted: true });
      check(note.deletedAt, "INVALID_TRANSITION", "Move the note to Trash first");
      const answer = await dialog.showMessageBox(getWindow(), {
        type: "warning", message: "Permanently delete this note and its attachments?",
        detail: "This cannot be undone. Copies in previous backups and exports are not removed.",
        buttons: ["Cancel", "Delete permanently"], defaultId: 0, cancelId: 0,
      });
      check(trusted(event, getWindow()), "PERMISSION_DENIED", "Workspace window closed");
      if (answer.response !== 1) return { canceled: true };
      const purged = catalog.scoped(input.context.workspaceId).purgeNote(input.context, input.id);
      getWindow().closeFilePreview?.();
      attachments.close();
      return publicNote(purged);
    },
    "search.query": (input) => {
      v.object(input, ["workspaceId", "query"]);
      return catalog
        .scoped(input.workspaceId)
        .search({ workspaceId: input.workspaceId }, input.query, { limit: 100 })
        .map((item) => ({ ...item, body: item.body.slice(0, 300) }));
    },
    "search.hybrid": async (input) => {
      v.object(input, ["workspaceId", "query"]);
      const store = catalog.scoped(input.workspaceId);
      try {
        return await semantic.query(store, input.workspaceId, input.query, {
          limit: 100,
        });
      } catch (error) {
        const items = store
          .search({ workspaceId: input.workspaceId }, input.query, { limit: 100 })
          .map((item) => ({
            ...item,
            body: item.body.slice(0, 300),
            match: "lexical",
          }));
        return {
          items,
          total: items.length,
          mode: "lexical-fallback",
          coverage: null,
          reason: error.code ?? "UNAVAILABLE",
        };
      }
    },
    "semantic.status": (input) => {
      v.object(input, []);
      return semantic.status();
    },
    "search.source": (input) => {
      v.object(input, ["workspaceId", "kind", "id"]);
      return catalog
        .scoped(input.workspaceId)
        .source(
          { workspaceId: input.workspaceId },
          { kind: input.kind, id: input.id },
        );
    },
    "attachments.begin": (input) => attachments.begin(input),
    "attachments.chunk": (input) => attachments.chunk(input),
    "attachments.finish": (input) => attachments.finish(input),
    "attachments.cancel": (input) => {
      v.object(input, ["workspaceId", "token"]);
      attachments.current(input);
      attachments.cancel();
      return { canceled: true };
    },
    "attachments.info": (input) => {
      v.object(input, ["workspaceId", "noteId", "id"]);
      return require("./note-attachments").info(catalog.scoped(input.workspaceId), input.noteId, input.id);
    },
    "attachments.open": (input) => attachments.open(input, getWindow()),
    "documents.convert": (input) => {
      v.object(input, ["workspaceId", "html"]);
      catalog.scoped(input.workspaceId);
      return portable.htmlDocument(
        v.text(input.html, "HTML", 2 * 1024 * 1024, true),
      );
    },
    "documents.import": async (input, event) => {
      v.object(input, ["workspaceId"]);
      catalog.scoped(input.workspaceId);
      const selection = await dialog.showOpenDialog(getWindow(), {
        title: "Import notes",
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "Notes",
            extensions: ["md", "markdown", "txt", "html", "htm", "json"],
          },
        ],
      });
      if (selection.canceled)
        return { canceled: true, items: [], failures: [] };
      check(
        trusted(event, getWindow()),
        "PERMISSION_DENIED",
        "Workspace window closed",
      );
      check(
        selection.filePaths.length <= 20,
        "INVALID_INPUT",
        "Select at most 20 files",
      );
      const store = catalog.scoped(input.workspaceId);
      const items = [],
        failures = [];
      for (const file of selection.filePaths) {
        try {
          items.push(publicNote(portable.importFile(store, file)));
        } catch (error) {
          failures.push({
            name: require("node:path").basename(file),
            ...publicError(error).error,
          });
        }
      }
      return { canceled: false, items, failures };
    },
    "appleNotes.preview": async (input) => {
      v.object(input, ["workspaceId"]);
      return appleNotes.preview(catalog.scoped(input.workspaceId));
    },
    "appleNotes.import": async (input) => {
      v.object(input, ["workspaceId", "token"]);
      return appleNotes.commit(catalog.scoped(input.workspaceId), v.uuid(input.token));
    },
    "documents.export": async (input, event) => {
      v.object(input, ["workspaceId", "ids", "draft"]);
      catalog.scoped(input.workspaceId);
      if (input.draft) {
        v.object(input.draft, ["title", "content", "noteId"]);
        if (input.draft.noteId) catalog.scoped(input.workspaceId)._live("note", v.uuid(input.draft.noteId));
        v.text(input.draft.title, "title", 500, true);
        require("./content").documentContent(input.draft.content);
      }
      const selection = await dialog.showOpenDialog(getWindow(), {
        title: "Export notes",
        properties: ["openDirectory", "createDirectory"],
      });
      if (selection.canceled) return { canceled: true };
      check(
        trusted(event, getWindow()),
        "PERMISSION_DENIED",
        "Workspace window closed",
      );
      return portable.exportNotes(
        catalog.scoped(input.workspaceId),
        selection.filePaths[0],
        input.ids,
        input.draft,
      );
    },
    "actions.browse": (input) => {
      v.object(input, ["workspaceId", "view", "offset", "limit"]);
      const { workspaceId, ...options } = input;
      const store = catalog.scoped(workspaceId);
      return actions.browse(store, workspaceId, options);
    },
    "actions.get": (input) => {
      v.object(input, ["workspaceId", "id"]);
      return actions.detail(
        catalog.scoped(input.workspaceId),
        input.workspaceId,
        v.uuid(input.id),
      );
    },
    "actions.create": (input) => {
      v.object(input, ["context", "action"]);
      const store = catalog.scoped(input.context.workspaceId);
      const result = store.createAction(
        input.context,
        actions.actionInput(input.action),
      );
      emit("action.created", result);
      return actions.publicAction(result);
    },
    "actions.update": (input) => {
      v.object(input, ["context", "id", "changes"]);
      const store = catalog.scoped(input.context.workspaceId);
      const result = store.updateAction(
        input.context,
        v.uuid(input.id),
        actions.actionInput(input.changes, true),
      );
      emit("action.updated", result);
      return actions.publicAction(result);
    },
    "actions.transition": (input) => {
      v.object(input, ["context", "id", "status", "reopen"]);
      const store = catalog.scoped(input.context.workspaceId);
      const result = store.transitionAction(input.context, v.uuid(input.id), {
        status: v.choice(
          input.status,
          ["accepted", "deferred", "done", "dropped"],
          "status",
        ),
        ...(input.reopen === undefined
          ? {}
          : { reopen: v.boolean(input.reopen, "reopen") }),
      });
      emit("action.transitioned", result);
      return actions.publicAction(result);
    },
    "actions.delete": async (input, event) => {
      v.object(input, ["context", "id"]);
      const store = catalog.scoped(input.context.workspaceId);
      const action = store.get(
        { workspaceId: input.context.workspaceId },
        "action",
        v.uuid(input.id),
      );
      const result = await dialog.showMessageBox(getWindow(), {
        type: "warning",
        message: "Delete this local action?",
        detail:
          "Its source transcript and recording will be kept. This action will no longer appear in search.",
        buttons: ["Keep action", "Delete action"],
        defaultId: 0,
        cancelId: 0,
      });
      check(
        trusted(event, getWindow()),
        "PERMISSION_DENIED",
        "Workspace window closed",
      );
      catalog.scoped(input.context.workspaceId);
      if (result.response !== 1)
        return { deleted: false, action: actions.publicAction(action) };
      const deleted = store.delete(input.context, "action", action.id);
      emit("action.deleted", deleted);
      return { deleted: true };
    },
    "notes.links": (input) => {
      v.object(input, ["workspaceId", "id"]);
      return require("./links").forNote(catalog.scoped(input.workspaceId), input.workspaceId, input.id);
    },
    // Where a [[label]] points right now. Resolution is a read: creating the missing
    // page is the renderer's decision, made when the user follows the link.
    "notes.resolveLink": (input) => {
      v.object(input, ["workspaceId", "label"]);
      v.text(input.label, "label", 200);
      return require("./links").resolve(
        catalog.scoped(input.workspaceId),
        input.workspaceId,
        input.label,
      );
    },
    // What a half-typed [[ could name. A read, bounded, and never a note's body.
    "notes.linkTargets": (input) => {
      v.object(input, ["workspaceId", "query", "limit"]);
      if (input.query !== undefined) v.text(input.query, "query", 200, true);
      if (input.limit !== undefined) v.integer(input.limit, "limit", 1, 20);
      return require("./links").suggest(
        catalog.scoped(input.workspaceId),
        input.workspaceId,
        input.query ?? "",
        input.limit ?? 8,
      );
    },
    // Reads a page you wrote and proposes the commitments in it, the same way a
    // recording does: on-device, grounded in the page's own words, nothing accepted
    // and nothing rewritten.
    "notes.findCommitments": (input) => {
      v.object(input, ["workspaceId", "id"]);
      // Runs outside the workspace queue (see the list below) so the page list and
      // the open page keep working while the on-device model reads; the read and
      // the write are queued inside extractNoteActions.
      return require("./note-extraction").extractNoteActions(
        catalog.scoped(input.workspaceId),
        v.uuid(input.id),
        extraction,
        (fn) => catalog.serialize(fn),
      ).catch((error) => {
        // These codes are shared with model imports, whose messages talk about
        // model folders; reading a page needs its own words.
        if (["MODEL_INVALID", "MODEL_TIMEOUT", "MODEL_CONTEXT"].includes(error.code))
          throw new WorkspaceError("EXTRACTION_FAILED", "The on-device model could not read this page");
        throw error;
      });
    },
    // Rewrites the passage the user selected. Text in, text out: the note is not
    // read, not written, and nothing is stored. Refused when Apple's model is not
    // available on this Mac rather than falling back to anything weaker.
    "notes.rewrite": (input) => {
      v.object(input, ["workspaceId", "style", "text"]);
      // Bad input is bad input whatever this Mac can run, so it is caught before
      // the model is asked for.
      v.choice(input.style, ["tidy", "proofread", "shorten"], "style");
      v.text(input.text, "text", 8000);
      catalog.scoped(input.workspaceId);
      // MODEL_MISSING's public message is about transcription; this is its own thing.
      check(extraction, "REWRITE_UNAVAILABLE", "On-device rewriting is unavailable");
      return extraction.rewrite({ style: input.style, text: input.text });
    },
    "notes.graph": (input) => {
      v.object(input, ["workspaceId"]);
      return require("./graph").build(catalog.scoped(input.workspaceId), input.workspaceId);
    },
    "people.list": (input) => {
      v.object(input, ["workspaceId"]);
      return require("./people").list(catalog.scoped(input.workspaceId), input.workspaceId);
    },
    "people.get": (input) => {
      v.object(input, ["workspaceId", "id"]);
      return require("./people").get(catalog.scoped(input.workspaceId), input.workspaceId, input.id);
    },
    "people.priorContext": (input) => {
      v.object(input, ["workspaceId", "recordingId"]);
      return require("./people").priorContext(
        catalog.scoped(input.workspaceId),
        input.workspaceId,
        input.recordingId,
      );
    },
    "reminders.due": (input) => {
      v.object(input, ["workspaceId"]);
      const store = catalog.scoped(input.workspaceId);
      return reminders.due(store, input.workspaceId);
    },
    "reminders.snooze": (input) => {
      v.object(input, ["context", "id", "until"]);
      const store = catalog.scoped(input.context.workspaceId);
      const result = reminders.snooze(
        store,
        input.context,
        v.uuid(input.id),
        input.until,
      );
      emit("reminder.snoozed", { id: result.actionId });
      return result;
    },
    ...Object.fromEntries(
      [
        ["notes", "note"],
        ["recordings", "recording"],
        ["actions", "action"],
      ].map(([group, kind]) => [
        `${group}.list`,
        (input) => {
          v.object(input, ["workspaceId", "offset", "limit"]);
          const store = catalog.scoped(input.workspaceId);
          const items = store.list({ workspaceId: input.workspaceId }, kind, {
            offset: input.offset ?? 0,
            limit: input.limit ?? 50,
          });
          // Overview pages need text only. Imported HTML and filesystem metadata never cross.
          return items.map((item) => ({
            id: item.id,
            workspaceId: item.workspaceId,
            revision: item.revision,
            title: item.title ?? item.purpose,
            preview: (item.plainText ?? "").slice(0, 240),
            updatedAt: item.updatedAt,
            ...(kind === "action" ? { status: item.status } : {}),
            ...(kind === "recording" ? { state: item.state } : {}),
          }));
        },
      ]),
    ),
    "privacy.get": () => privacy.policy.snapshot(),
    "privacy.revoke": (input) => {
      v.object(input, ["purpose"]);
      privacy.policy.revoke(v.choice(input.purpose, ["models", "updates"], "permission"));
      return privacy.policy.snapshot();
    },
    "privacy.setStrict": async (input) => {
      v.object(input, ["enabled"]);
      v.boolean(input.enabled, "enabled");
      await privacy.setStrict(input.enabled);
      return privacy.policy.snapshot();
    },
  };
  for (const name of CHANNELS)
    ipcMain.handle(`workspace:${name}`, async (event, input = {}) => {
      try {
        check(
          trusted(event, getWindow()),
          "PERMISSION_DENIED",
          "Untrusted workspace sender",
        );
        v.stableJson(
          input,
          [
            "notes.update",
            "notes.create",
            "documents.convert",
            "documents.export",
          ].includes(name)
            ? 3 * 1024 * 1024
            : name === "attachments.chunk" ? 512 * 1024 : 65536,
        );
        if (
          [
            "bootstrap",
            "appSettings.get",
            "appSettings.checkForUpdates",
            "appSettings.downloadUpdate",
            "appSettings.installUpdate",
            "clipboard.state",
            "clipboard.clear",
            "workspace.list",
            "privacy.get",
            "capture.state",
            "models.state",
            "semantic.status",
          ].includes(name)
        )
          v.object(input, []);
        await ready();
        check(
          catalog.pending < 32,
          "WORKSPACE_BUSY",
          "Too many pending requests",
        );
        const operation = async () => {
          check(
            trusted(event, getWindow()),
            "PERMISSION_DENIED",
            "Workspace window closed",
          );
          const value = await handlers[name](input, event);
          if (
            ["workspace.create", "workspace.open", "workspace.update"].includes(
              name,
            )
          )
            emit();
          else if (
            [
              "notes.create",
              "notes.daily",
              "notes.update",
              "notes.delete",
              "notes.restore",
              "notes.purge",
              "documents.import",
              "appleNotes.import",
              "notes.move",
              "folders.create",
              "folders.update",
              "folders.delete",
            ].includes(name)
          )
            emit("notes.changed", value?.id ? value : value?.items?.at(-1));
          return { ok: true, value };
        };
        return ["search.hybrid", "semantic.status", "notes.findCommitments", "appSettings.checkForUpdates", "appSettings.downloadUpdate", "appSettings.installUpdate"].includes(name)
          ? await operation()
          : await catalog.serialize(operation);
      } catch (error) {
        return publicError(error);
      }
    });
  privacy.policy.on("change", emit);
  return () => {
    attachments.close();
    for (const name of CHANNELS) ipcMain.removeHandler(`workspace:${name}`);
    privacy.policy.removeListener("change", emit);
  };
}
module.exports = {
  registerWorkspaceIPC,
  trusted,
  publicError,
  CHANNELS,
  ORIGIN,
  DOCUMENT,
};
