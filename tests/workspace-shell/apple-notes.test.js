"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { AppleNotesImporter, SCAN, READ } = require("../../workspace/apple-notes");
const { fixture, scope } = require("../local-first/helpers.cjs");

// A stand-in for osascript: SCAN returns the library listing, READ returns one note.
function runner(entries, bodies = {}, failures = new Set()) {
  const calls = [];
  return {
    calls,
    run: async (source, args = []) => {
      calls.push(source === SCAN ? "scan" : `read:${args[0]}`);
      if (source === SCAN) return { entries };
      const id = args[0];
      if (failures.has(id)) {
        const error = new Error("Apple Notes could not be read");
        error.code = "APPLE_NOTES_ACCESS";
        throw error;
      }
      return { id, title: bodies[id]?.title ?? "Untitled", body: bodies[id]?.body ?? "<div>Body</div>" };
    },
  };
}

const entry = (id, over = {}) => ({ id, title: `Note ${id}`, folder: "Notes", locked: false, attachments: 0, ...over });

test("preview counts what can be imported and import needs that preview's token", async (t) => {
  const { store } = await fixture(t);
  const fake = runner([
    entry("x-1"),
    entry("x-2", { locked: true }),
    entry("x-3", { attachments: 2 }),
  ]);
  const importer = new AppleNotesImporter(fake.run);

  const preview = await importer.preview(store);
  assert.equal(preview.total, 3);
  assert.equal(preview.ready, 2, "a locked note is not offered");
  assert.equal(preview.locked, 1);
  assert.equal(preview.withAttachments, 1);
  assert.equal(preview.alreadyImported, 0);
  assert.deepEqual(preview.sample.map((item) => item.title), ["Note x-1", "Note x-3"]);
  assert.equal(fake.calls.length, 1, "preview reads the list only");

  await assert.rejects(() => importer.commit(store, "00000000-0000-4000-8000-000000000000"),
    /Preview Apple Notes again/, "a stale or guessed token cannot import");

  const result = await importer.commit(store, preview.token);
  assert.equal(result.items.length, 2);
  assert.equal(result.failures.length, 0);
  assert.ok(!fake.calls.includes("read:x-2"), "a locked note is never read");

  await assert.rejects(() => importer.commit(store, preview.token),
    /Preview Apple Notes again/, "a token is single use");
});

test("an imported note keeps its Apple identity, the original HTML and its warnings", async (t) => {
  const { store } = await fixture(t);
  const fake = runner([entry("x-1", { folder: "Clients", attachments: 1 })], {
    "x-1": { title: "Priya call", body: "<div><h1>Priya call</h1><p>She owes the budget.</p></div>" },
  });
  const importer = new AppleNotesImporter(fake.run);
  const { token } = await importer.preview(store);
  const { items } = await importer.commit(store, token);

  const note = store.get(scope(store), "note", items[0].id);
  assert.equal(note.metadata.appleNotesId, "x-1");
  assert.equal(note.metadata.appleNotesFolder, "Clients");
  assert.match(JSON.stringify(note.content), /She owes the budget/);
  assert.ok(note.metadata.importWarnings.some((warning) => /attachments were not copied/i.test(warning)),
    "an attachment that was left behind is stated on the note");

  const original = store.list(scope(store), "attachment")
    .find((item) => item.noteId === note.id && item.displayName === "Apple Notes original.html");
  assert.ok(original, "the untouched Apple Notes HTML is kept beside the note");
});

test("a second import skips notes already imported and reports the ones that failed", async (t) => {
  const { store } = await fixture(t);
  const entries = [entry("x-1"), entry("x-2")];
  const first = new AppleNotesImporter(runner(entries).run);
  const { token } = await first.preview(store);
  await first.commit(store, token);

  const fake = runner([...entries, entry("x-3")], {}, new Set(["x-3"]));
  const importer = new AppleNotesImporter(fake.run);
  const preview = await importer.preview(store);
  assert.equal(preview.alreadyImported, 2);
  assert.equal(preview.ready, 1);

  const result = await importer.commit(store, preview.token);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.failures, [{ title: "Note x-3", code: "APPLE_NOTES_ACCESS" }]);
  assert.ok(!fake.calls.includes("read:x-1"), "an already imported note is not read again");
});

test("an unreadable library and an oversized one both stop before any note is created", async (t) => {
  const { store } = await fixture(t);
  const denied = new AppleNotesImporter(async () => {
    const error = new Error("Apple Notes could not be read");
    error.code = "APPLE_NOTES_ACCESS";
    throw error;
  });
  await assert.rejects(() => denied.preview(store), (error) => error.code === "APPLE_NOTES_ACCESS");

  const huge = new AppleNotesImporter(async () => ({ tooMany: true }));
  await assert.rejects(() => huge.preview(store), (error) => error.code === "LIMIT_REACHED");

  const bogus = new AppleNotesImporter(async (source) =>
    source === SCAN ? { entries: [{ id: "x-1", title: "Note", folder: "Notes", locked: "no", attachments: 0 }] } : {});
  await assert.rejects(() => bogus.preview(store), (error) => error.code === "INVALID_INPUT");

  assert.equal(store.list(scope(store), "note").length, 0);
});

test("Apple Notes folders become folders, but only when the library uses more than one", async (t) => {
  const { store } = await fixture(t);
  const sorted = new AppleNotesImporter(runner([
    entry("x-1", { folder: "Clients" }),
    entry("x-2", { folder: "Clients" }),
    entry("x-3", { folder: "Ideas" }),
  ]).run);
  const preview = await sorted.preview(store);
  const { items } = await sorted.commit(store, preview.token);

  const folders = store.folderList(scope(store));
  assert.deepEqual(folders.items.map((folder) => `${folder.path}:${folder.notes}`), ["Clients:2", "Ideas:1"]);
  assert.equal(folders.unfiled, 0);
  const clients = folders.items.find((folder) => folder.path === "Clients");
  assert.equal(store.get(scope(store), "note", items[0].id).folderId, clients.id);
});

test("a library that keeps everything in one folder arrives unfiled", async (t) => {
  const { store } = await fixture(t);
  const flat = new AppleNotesImporter(runner([entry("x-1", { folder: "Notes" }), entry("x-2", { folder: "Notes" })]).run);
  const preview = await flat.preview(store);
  await flat.commit(store, preview.token);

  const folders = store.folderList(scope(store));
  assert.deepEqual(folders.items, [], "Apple's default folder is not recreated as an empty gesture");
  assert.equal(folders.unfiled, 2);
});

test("the scripts read only what the preview and import need", () => {
  assert.match(SCAN, /Application\('Notes'\)/);
  assert.match(READ, /notes\.byId/);
  for (const script of [SCAN, READ])
    for (const forbidden of [/\.delete\(/, /\.make\(/, /doShellScript/, /Application\('System Events'\)/])
      assert.ok(!forbidden.test(script), `Apple Notes script must not ${forbidden}`);
});
