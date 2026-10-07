"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { calendarDate } = require("../../workspace/notebook");
const portable = require("../../workspace/portable");
const doc = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-notebook-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  t.after(async () => {
    await catalog.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    catalog,
    store: catalog.store,
    ctx: (revision) => ({
      workspaceId: catalog.store.identity.id,
      clientRequestId: randomUUID(),
      ...(revision ? { expectedRevision: revision } : {}),
    }),
  };
}
test("daily notes use the workspace date across midnight and DST, and resolve one live page", async (t) => {
  assert.equal(
    calendarDate("Asia/Kolkata", new Date("2026-09-10T18:30:00Z")),
    "2026-09-11",
  );
  assert.equal(
    calendarDate("America/New_York", new Date("2026-03-08T06:59:00Z")),
    "2026-03-08",
  );
  assert.equal(
    calendarDate("America/New_York", new Date("2026-03-08T07:01:00Z")),
    "2026-03-08",
  );
  const { store, ctx } = await fixture(t);
  const first = store.dailyNote(ctx(), new Date("2026-09-11T12:00:00Z"));
  assert.equal(
    store.dailyNote(ctx(), new Date("2026-09-11T12:01:00Z")).id,
    first.id,
  );
  const deleted = store.delete(ctx(first.revision), "note", first.id);
  const replacement = store.dailyNote(ctx(), new Date("2026-09-11T12:00:00Z"));
  assert.notEqual(replacement.id, first.id);
  assert.throws(() => store.restore(ctx(deleted.revision), "note", first.id), {
    code: "CONFLICT",
  });
});
test("notebook edits are revisioned, retry-idempotent, pinned, searchable and restorable", async (t) => {
  const { store, ctx, catalog } = await fixture(t);
  const scope = { workspaceId: store.identity.id };
  const note = store.createNote(ctx(), {
    title: "First",
    content: doc("Quiet green shoreline"),
  });
  const request = ctx(note.revision);
  const edit = store.editNote(request, note.id, {
    title: "Second",
    pinned: true,
  });
  store.editNote(ctx(edit.revision), note.id, { pinned: false });
  assert.deepEqual(
    store.editNote(request, note.id, { title: "Second", pinned: true }),
    edit,
  );
  assert.throws(() => store.editNote(ctx(1), note.id, { title: "Stale" }), {
    code: "REVISION_CONFLICT",
  });
  assert.equal(store.notebookList(scope, { view: "pinned" }).total, 0);
  let current = store.get(scope, "note", note.id);
  current = store.editNote(ctx(current.revision), note.id, { pinned: true });
  assert.equal(
    store.notebookList(scope, { view: "pinned" }).items[0].id,
    note.id,
  );
  assert.equal(store.search(scope, "shoreline")[0].id, note.id);
  const deleted = store.delete(ctx(current.revision), "note", note.id);
  assert.equal(store.search(scope, "shoreline").length, 0);
  assert.equal(store.notebookList(scope, { view: "trash" }).total, 1);
  store.restore(ctx(deleted.revision), "note", note.id);
  await catalog.close();
  await catalog.initialize();
  assert.equal(catalog.store.search(scope, "shoreline")[0].id, note.id);
  assert.equal(
    catalog.store.source(scope, { kind: "note", id: note.id }).pinned,
    true,
  );
});
test("HTML imports sanitize executable content, retain supported structure, and report loss", () => {
  const parsed = portable.parseImport(
    "page.html",
    Buffer.from(
      '<style>secret</style><script>alert(1)</script><h2>Idea</h2><p><strong>Bold</strong> <u>line</u><a href="javascript:alert(1)">bad</a><img src="https://example.com/a" onerror="alert(1)"></p><ol start="3"><li>One</li></ol><pre><code>a &lt; b</code></pre><table><tr><td>kept</td></tr></table>',
    ),
  );
  const json = JSON.stringify(parsed.content);
  assert.doesNotMatch(json, /secret|alert|javascript|example\.com/);
  for (const text of [
    "heading",
    "bold",
    "underline",
    "orderedList",
    "codeBlock",
    "kept",
  ])
    assert.ok(json.includes(text));
  assert.ok(parsed.warnings.length >= 2);
  assert.equal(
    parsed.content.content.find((node) => node.type === "orderedList").attrs
      .start,
    3,
  );
  assert.throws(() => portable.parseImport("binary.txt", Buffer.from([255])), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => portable.parseImport("binary.txt", Buffer.from("a\0b")), {
    code: "INVALID_INPUT",
  });
  assert.throws(
    () => portable.parseImport("large.txt", Buffer.alloc(3 * 1024 * 1024 + 1)),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () =>
      portable.htmlDocument("<div>".repeat(35) + "deep" + "</div>".repeat(35)),
    { code: "INVALID_INPUT" },
  );
});
test("portable export includes hashes, immutable original and lossless structured round trip", async (t) => {
  const { store, ctx, root } = await fixture(t);
  const scope = { workspaceId: store.identity.id };
  const file = path.join(root, "Thinking.md");
  const bytes = Buffer.from(
    "## A thought\n\n**Local** and [linked](https://example.com).\n\n- one\n- two\n",
  );
  fs.writeFileSync(file, bytes);
  const note = portable.importFile(store, file);
  assert.ok(note.metadata.originalAttachmentId);
  assert.deepEqual(
    store.readAttachment(scope, note.metadata.originalAttachmentId),
    bytes,
  );
  const exported = await portable.exportNotes(store, root, [note.id, note.id]);
  assert.equal(exported.count, 1);
  const dir = path.join(root, exported.folderName);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  assert.equal(manifest.complete, true);
  const entry = manifest.notes[0];
  const json = fs.readFileSync(path.join(dir, entry.structured));
  assert.equal(
    require("../../workspace/validation").hash(json),
    entry.structuredHash,
  );
  assert.deepEqual(
    portable.parseImport(entry.structured, json).content,
    note.content,
  );
  assert.deepEqual(fs.readFileSync(path.join(dir, entry.original)), bytes);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const imported = portable.importFile(store, path.join(dir, entry.structured));
  assert.notEqual(imported.id, note.id);
  assert.deepEqual(imported.content, note.content);
  assert.equal(imported.kind, "note");
  assert.match(
    fs.readFileSync(path.join(dir, entry.markdown), "utf8"),
    /\*\*Local\*\*/,
  );
  const link = path.join(root, "link.md");
  fs.symlinkSync(file, link);
  assert.throws(() => portable.readImport(link));
  const recovered = await portable.exportNotes(store, root, undefined, {
    title: "Unsaved",
    content: doc("Recovered draft"),
  });
  assert.equal(recovered.count, 1);
});
test("partial import has a durable warning and failed export has an incomplete manifest", async (t) => {
  const { root, store, ctx } = await fixture(t);
  const scope = { workspaceId: store.identity.id };
  const file = path.join(root, "partial.txt");
  fs.writeFileSync(file, "Preserve me");
  store.putAttachment = () => {
    throw new Error("disk full");
  };
  const note = portable.importFile(store, file);
  assert.match(
    store.get(scope, "note", note.id).metadata.importWarnings.join(" "),
    /incomplete/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "Preserve me");
  await assert.rejects(
    portable.exportNotes(store, root, [note.id, randomUUID()]),
  );
  const folder = fs
    .readdirSync(root)
    .find((name) => name.startsWith("FocusBae-notes-"));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, folder, "manifest.json")))
      .complete,
    false,
  );
  assert.equal(store.get(scope, "note", note.id).title, "partial");
});
test("save queue coalesces edits, preserves ambiguous requests, and drains edits made in flight", async () => {
  const { SaveQueue } = await import("../../desktop-ui/src/save-queue.mjs");
  const note = { id: randomUUID(), workspaceId: randomUUID(), revision: 1 };
  const calls = [];
  let fail = true;
  let release;
  const queue = new SaveQueue({
    note,
    delay: 60000,
    uuid: randomUUID,
    write: async (input) => {
      calls.push(input);
      if (fail) {
        fail = false;
        throw new Error("ACK lost");
      }
      if (calls.length === 2)
        await new Promise((resolve) => {
          release = resolve;
        });
      return {
        ...note,
        ...input.changes,
        revision: input.context.expectedRevision + 1,
      };
    },
  });
  queue.edit({ title: "A" });
  queue.edit({ title: "B" });
  await assert.rejects(queue.flush(), /ACK lost/);
  assert.equal(queue.dirty, true);
  const retry = queue.flush();
  queue.edit({ title: "C" });
  release();
  await retry;
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[2].context.expectedRevision, 2);
  assert.equal(queue.note.title, "C");
  assert.equal(queue.dirty, false);
  queue.dispose();
});
test("10,000-note local search stays bounded and returns canonical sources", async (t) => {
  const { store, ctx } = await fixture(t);
  const scope = { workspaceId: store.identity.id };
  store._db.transaction(() => {
    for (let index = 0; index < 10000; index++)
      store.createNote(ctx(), {
        title: `Synthetic note ${index}`,
        content: doc(
          `Notebook idea ${index} ${index === 9999 ? "uniqueshoreline" : "ordinary"}`,
        ),
      });
  })();
  const start = performance.now();
  const results = store.search(scope, "uniqueshoreline");
  const elapsed = performance.now() - start;
  assert.equal(results.length, 1);
  assert.equal(
    store.source(scope, results.map(({ id, kind }) => ({ id, kind }))[0]).title,
    "Synthetic note 9999",
  );
  assert.equal(store.notebookList(scope, { limit: 40 }).total, 10000);
  assert.ok(elapsed < 300, `Search took ${elapsed.toFixed(1)} ms`);
  t.diagnostic(`10k synthetic notes: search ${elapsed.toFixed(2)} ms`);
});
