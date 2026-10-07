"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { check } = require("./errors");
const { htmlDocument } = require("./portable");
const { publicNote } = require("./notebook");

const execute = promisify(execFile);
const SCAN = `function run() {
  const notes = Application('Notes').notes();
  if (notes.length > 500) return JSON.stringify({ tooMany: true });
  return JSON.stringify({ entries: notes.map(function (note) {
    let folder = '';
    try { folder = note.container().name(); } catch (error) {}
    let locked = false;
    try { locked = note.passwordProtected(); } catch (error) {}
    let attachments = 0;
    try { attachments = note.attachments().length; } catch (error) {}
    return { id: note.id(), title: note.name(), folder: folder,
      locked: locked, attachments: attachments };
  }) });
}`;
const READ = `function run(argv) {
  const note = Application('Notes').notes.byId(argv[0]);
  return JSON.stringify({ id: note.id(), title: note.name(), body: note.body() });
}`;
const MAX_HTML = 2 * 1024 * 1024;

async function runScript(source, args = []) {
  try {
    const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", source, ...args], {
      timeout: 120000, maxBuffer: 5 * 1024 * 1024, encoding: "utf8",
    });
    return JSON.parse(stdout);
  } catch (error) {
    // Never expose Apple Notes content, JXA diagnostics, or process arguments.
    const failure = new Error("Apple Notes could not be read");
    failure.code = "APPLE_NOTES_ACCESS";
    throw failure;
  }
}

function importedIds(store) {
  return new Set(store._db.prepare(
    "SELECT json_extract(data_json, '$.metadata.appleNotesId') AS id FROM notes WHERE workspace_id=? AND deleted_at IS NULL AND json_extract(data_json, '$.metadata.appleNotesId') IS NOT NULL",
  ).all(store.identity.id).map((row) => row.id));
}

// Apple's own default folder holds everything for most people, so recreating it
// would add a folder that means nothing. Folders are only made when the library
// actually sorts its notes into more than one.
function folderPlan(store, entries) {
  const names = [...new Set(entries.map((entry) => entry.folder).filter(Boolean))];
  if (names.length < 2) return new Map();
  const existing = new Map(store.folderList({ workspaceId: store.identity.id }).items
    .filter((folder) => folder.parentId === null).map((folder) => [folder.name.toLowerCase(), folder.id]));
  const plan = new Map();
  for (const name of names) {
    try {
      const known = existing.get(name.toLowerCase());
      plan.set(name, known ?? store.createFolder(
        { workspaceId: store.identity.id, clientRequestId: randomUUID() }, { name, parentId: null }).id);
    } catch {
      // A folder that cannot be created (a limit, a name clash) must not stop
      // the notes themselves from arriving; they simply come in unfiled.
    }
  }
  return plan;
}

function importOne(store, source, entry, folderId = null) {
  check(source && source.id === entry.id && typeof source.body === "string", "INVALID_INPUT", "Apple Notes changed during import");
  check(Buffer.byteLength(source.body, "utf8") <= MAX_HTML, "INVALID_INPUT", "Apple note is too large");
  const title = String(source.title || entry.title || "Untitled").slice(0, 500);
  const parsed = htmlDocument(source.body);
  const warnings = [...parsed.warnings];
  if (entry.attachments) warnings.push("Apple Notes attachments were not copied. The original note remains in Apple Notes.");
  const ctx = (revision) => ({ workspaceId: store.identity.id, clientRequestId: randomUUID(),
    ...(revision ? { expectedRevision: revision } : {}) });
  let note = store.createNote(ctx(), { title, content: parsed.content, ...(folderId ? { folderId } : {}), metadata: {
    appleNotesId: entry.id, appleNotesFolder: entry.folder,
    importWarnings: [...warnings, "Original preservation is incomplete. Keep the note in Apple Notes."],
  } });
  try {
    const attachment = store.putAttachment(ctx(), {
      noteId: note.id, displayName: "Apple Notes original.html", mediaType: "text/html",
    }, Buffer.from(source.body, "utf8"));
    note = store.updateNote(ctx(note.revision), note.id, { metadata: {
      ...note.metadata, originalAttachmentId: attachment.id, importWarnings: warnings,
    } });
  } catch {
    // The committed note keeps a durable partial-import warning.
  }
  return publicNote(note);
}

class AppleNotesImporter {
  constructor(runner = runScript) {
    this.runner = runner;
    this.pending = null;
  }

  async preview(store) {
    const scan = await this.runner(SCAN);
    check(!scan?.tooMany, "LIMIT_REACHED", "Apple Notes library exceeds 500 notes");
    check(Array.isArray(scan?.entries) && scan.entries.length <= 500, "INVALID_INPUT", "Invalid Apple Notes list");
    const seen = new Set();
    const entries = scan.entries.map((entry) => {
      check(entry && typeof entry.id === "string" && entry.id.length <= 500 &&
        typeof entry.title === "string" && typeof entry.folder === "string" &&
        typeof entry.locked === "boolean" && Number.isInteger(entry.attachments) &&
        entry.attachments >= 0 && !seen.has(entry.id), "INVALID_INPUT", "Invalid Apple Notes list");
      seen.add(entry.id);
      return { id: entry.id, title: entry.title.slice(0, 500), folder: entry.folder.slice(0, 500),
        locked: entry.locked, attachments: entry.attachments };
    });
    const existing = importedIds(store);
    const eligible = entries.filter((entry) => !entry.locked && !existing.has(entry.id));
    const token = randomUUID();
    this.pending = { token, workspaceId: store.identity.id, entries: eligible, expires: Date.now() + 10 * 60 * 1000 };
    return { token, total: entries.length, ready: eligible.length,
      alreadyImported: entries.filter((entry) => existing.has(entry.id)).length,
      locked: entries.filter((entry) => entry.locked).length,
      withAttachments: eligible.filter((entry) => entry.attachments > 0).length,
      sample: eligible.slice(0, 8).map(({ title, folder }) => ({ title, folder })) };
  }

  async commit(store, token) {
    const pending = this.pending;
    check(pending && pending.token === token && pending.workspaceId === store.identity.id &&
      pending.expires > Date.now(), "INVALID_INPUT", "Preview Apple Notes again before importing");
    this.pending = null;
    const existing = importedIds(store);
    const plan = folderPlan(store, pending.entries.filter((entry) => !existing.has(entry.id)));
    const items = [], failures = [];
    for (const entry of pending.entries) {
      if (existing.has(entry.id)) continue;
      try {
        const source = await this.runner(READ, [entry.id]);
        items.push(importOne(store, source, entry, plan.get(entry.folder) ?? null));
      } catch (error) {
        failures.push({ title: entry.title, code: error.code === "APPLE_NOTES_ACCESS" ? "APPLE_NOTES_ACCESS" : "IMPORT_FAILED" });
      }
    }
    return { items, failures };
  }
}

module.exports = { AppleNotesImporter, SCAN, READ, importOne, folderPlan };
