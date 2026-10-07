"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WorkspaceCatalog } = require("../../workspace/catalog");
const { NoteAttachments, info, imageResponse, parseImageURL, CHUNK_BYTES } = require("../../workspace/note-attachments");
const { documentContent, attachmentIds } = require("../../workspace/content");
const { MAX_BYTES } = require("../../workspace/attachments");
const { BackupService } = require("../../workspace/backup");
const portable = require("../../workspace/portable");
const { mutation, scope } = require("../local-first/helpers.cjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64");
const document = (...ids) => ({ type: "doc", content: [{ type: "paragraph" }, ...ids.map((id) => ({ type: "noteAttachment", attrs: { id } }))] });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-attachments-test-"));
  const catalog = new WorkspaceCatalog(path.join(root, "workspaces"));
  await catalog.initialize();
  const service = new NoteAttachments(catalog);
  t.after(async () => { service.close(); await catalog.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = catalog.store;
  const note = store.createNote(mutation(store), { title: "Attachments" });
  return { root, catalog, store, service, note };
}
test("attachment nodes accept IDs only, preserve plain text and reject invalid nesting/URLs", () => {
  const id = randomUUID();
  assert.equal(documentContent(document(id)).plainText, "");
  assert.deepEqual(attachmentIds(document(id, id)), [id]);
  for (const node of [
    { type: "noteAttachment", attrs: { id, src: "file:///private" } },
    { type: "noteAttachment", attrs: { id: "https://example.com/image" } },
    { type: "noteAttachment", attrs: { id }, content: [] },
    { type: "noteAttachment" },
    { type: "paragraph", content: [{ type: "noteAttachment", attrs: { id } }] },
  ]) assert.throws(() => documentContent({ type: "doc", content: [node] }));
});
test("bounded chunk uploads, type sniffing, scoped protocol and Quick Look never expose paths", async (t) => {
  const { service, store, catalog, note } = await fixture(t);
  const workspaceId = store.identity.id;
  assert.throws(() => service.begin({ workspaceId, noteId: note.id, displayName: "big.bin", byteSize: MAX_BYTES + 1 }), { code: "ATTACHMENT_TOO_LARGE" });
  assert.throws(() => store.putAttachment(mutation(store), { noteId: note.id, displayName: "big.bin" }, Buffer.alloc(MAX_BYTES + 1)), { code: "ATTACHMENT_TOO_LARGE" });
  service.begin({ workspaceId, noteId: note.id, displayName: "at-limit.bin", byteSize: MAX_BYTES });
  service.cancel();
  const bytes = Buffer.concat([png, Buffer.alloc(CHUNK_BYTES, 7)]);
  const { token } = service.begin({ workspaceId, noteId: note.id, displayName: "screen.png", byteSize: bytes.length });
  const request = { workspaceId, token };
  assert.throws(() => service.finish(request), { code: "INVALID_INPUT" });
  assert.throws(() => service.chunk({ ...request, offset: 1, data: "YQ==" }), { code: "INVALID_INPUT" });
  service.chunk({ ...request, offset: 0, data: bytes.subarray(0, CHUNK_BYTES).toString("base64") });
  service.chunk({ ...request, offset: CHUNK_BYTES, data: bytes.subarray(CHUNK_BYTES).toString("base64") });
  const result = service.finish(request);
  assert.equal(result.mediaType, "image/png");
  assert.equal(result.byteSize, bytes.length);
  assert.equal(JSON.stringify(result).includes(service.root), false);
  assert.deepEqual(Buffer.from(await imageResponse(catalog, result.imageUrl).arrayBuffer()), bytes);
  const second = store.createNote(mutation(store), {});
  assert.throws(() => info(store, second.id, result.id), { code: "SCOPE_MISMATCH" });
  for (const url of [result.imageUrl + "?raw=1", result.imageUrl.replace(workspaceId, randomUUID()), result.imageUrl.replace(note.id, second.id), "file:///etc/passwd"])
    assert.equal(imageResponse(catalog, url).status, 404);
  assert.equal(parseImageURL(result.imageUrl + "#x"), null);
  let preview;
  service.open({ workspaceId, noteId: note.id, id: result.id }, { previewFile: (file) => { preview = file; } });
  assert.deepEqual(fs.readFileSync(preview), bytes);
  const fake = service.put(store, note.id, "fake.png", Buffer.from("<svg onload='alert(1)'>"));
  assert.equal(fake.imageUrl, null);
  service.close();
  assert.equal(fs.existsSync(preview), false);
});
test("HEIC keeps the original, converts a local PNG preview and round-trips both", async (t) => {
  const { root, store, service, note } = await fixture(t);
  const input = path.join(root, "sample.png"), output = path.join(root, "sample.heic");
  fs.writeFileSync(input, png);
  require("node:child_process").execFileSync("/usr/bin/sips", ["-s", "format", "heic", input, "--out", output], { stdio: "pipe" });
  const bytes = fs.readFileSync(output);
  const item = service.put(store, note.id, "sample.heic", bytes);
  assert.equal(item.warning, null);
  assert.ok(item.imageUrl);
  const original = store._raw("attachment", item.id);
  assert.ok(original.previewId);
  assert.deepEqual(store.readAttachment(scope(store), item.id), bytes);
  assert.equal(require("../../workspace/note-attachments").imageType(store.readAttachment(scope(store), original.previewId)), "image/png");
  store.editNote(mutation(store, note.revision), note.id, { content: document(item.id) });
  const exported = await portable.exportNotes(store, root, [note.id]);
  const directory = path.join(root, exported.folderName);
  assert.match(fs.readFileSync(path.join(directory, `${note.id}.md`), "utf8"), /Original sample.heic/);
  const restored = portable.importFile(store, path.join(directory, `${note.id}.json`));
  const copy = store._raw("attachment", attachmentIds(restored.content)[0]);
  assert.notEqual(copy.previewId, original.previewId);
  assert.deepEqual(store.readAttachment(scope(store), copy.id), bytes);
  const bad = service.put(store, note.id, "broken.heic", Buffer.from("not a HEIC"));
  assert.ok(bad.warning); assert.equal(bad.imageUrl, null);
});
test("attachment IPC authenticates senders, limits chunks, rejects renderer paths and surfaces size errors", async (t) => {
  const { catalog, store, note } = await fixture(t);
  const { registerWorkspaceIPC, DOCUMENT } = require("../../workspace/ipc");
  const { LocalPolicy: Policy } = require("../../privacy/local-policy");
  const handlers = new Map(), frame = { url: DOCUMENT };
  const sender = { mainFrame: frame, send() {} }, event = { sender, senderFrame: frame };
  const remove = registerWorkspaceIPC({ catalog, ready: async () => {}, privacy: { policy: new Policy() },
    getWindow: () => ({ isDestroyed: () => false, webContents: sender }),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) } });
  t.after(remove);
  const call = (name, input) => handlers.get(`workspace:attachments.${name}`)(event, input);
  const workspaceId = store.identity.id;
  const input = { workspaceId, noteId: note.id, displayName: "a.txt", byteSize: 1 };
  assert.equal((await call("begin", { ...input, path: "/etc/passwd" })).error.code, "INVALID_INPUT");
  assert.equal((await call("begin", { ...input, byteSize: MAX_BYTES + 1 })).error.code, "ATTACHMENT_TOO_LARGE");
  for (const name of ["begin", "chunk", "finish", "cancel", "info", "open"]) {
    const result = await handlers.get(`workspace:attachments.${name}`)({ sender: {}, senderFrame: frame }, input);
    assert.equal(result.error.code, "PERMISSION_DENIED");
  }
  const started = await call("begin", input);
  const transfer = { workspaceId, token: started.value.token };
  assert.equal((await call("chunk", { ...transfer, offset: 0, data: "a".repeat(600000) })).error.code, "INVALID_INPUT");
  assert.equal((await call("chunk", { ...transfer, offset: 0, data: "YQ==" })).ok, true);
  const added = await call("finish", transfer);
  assert.equal(added.ok, true);
  assert.equal(added.value.displayName, "a.txt");
  assert.equal((await call("info", { workspaceId, noteId: note.id, id: added.value.id, path: "/tmp" })).error.code, "INVALID_INPUT");
});
test("ownership, Trash/restore, detached undo and journaled permanent removal survive restart", async (t) => {
  const { store, service, note, catalog } = await fixture(t);
  const image = service.put(store, note.id, "screen.png", png);
  const second = store.createNote(mutation(store), {});
  assert.throws(() => store.editNote(mutation(store, second.revision), second.id, { content: document(image.id) }), { code: "SCOPE_MISMATCH" });
  const updated = store.editNote(mutation(store, note.revision), note.id, { content: document(image.id) });
  assert.throws(() => store.deleteAttachment(mutation(store, 1), image.id), { code: "ATTACHMENT_IN_USE" });
  const trash = store.delete(mutation(store, updated.revision), "note", note.id);
  assert.equal(imageResponse(catalog, image.imageUrl).status, 404);
  const restored = store.restore(mutation(store, trash.revision), "note", note.id);
  assert.equal(imageResponse(catalog, image.imageUrl).status, 200);
  const detached = store.editNote(mutation(store, restored.revision), note.id, { content: document() });
  assert.deepEqual(store.readAttachment(scope(store), image.id), png, "removal from editor preserves undo");
  const deleted = store.delete(mutation(store, detached.revision), "note", note.id);
  const blob = path.join(store._directory, store._raw("attachment", image.id).relativePath);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => { if (file === blob) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return unlink(file); };
  let purged;
  try { purged = store.purgeNote(mutation(store, deleted.revision), note.id); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(fs.existsSync(blob), true);
  assert.equal(store.notebookList(scope(store), { view: "trash" }).total, 0);
  assert.throws(() => store.restore(mutation(store, purged.revision), "note", note.id), { code: "NOT_FOUND" });
  await catalog.close(); await catalog.initialize();
  assert.equal(fs.existsSync(blob), false);
  assert.equal(catalog.store._db.prepare("SELECT count(*) AS n FROM file_journal").get().n, 0);
});
test("Markdown sidecars, JSON remapping and backup restore preserve images and files", async (t) => {
  const { root, store, service, note, catalog } = await fixture(t);
  const image = service.put(store, note.id, "screen.png", png);
  const pdf = service.put(store, note.id, "Budget [draft].pdf", Buffer.from("%PDF-1.4\nsynthetic PDF"));
  store.editNote(mutation(store, note.revision), note.id, { content: document(image.id, pdf.id) });
  const output = await portable.exportNotes(store, root, [note.id]);
  const directory = path.join(root, output.folderName);
  const md = fs.readFileSync(path.join(directory, `${note.id}.md`), "utf8");
  assert.ok(md.includes(`![screen.png](attachments/${image.id}.png)`));
  assert.ok(md.includes(`(attachments/${pdf.id}.pdf)`));
  const exported = path.join(directory, `${note.id}.json`);
  const imported = portable.importFile(store, exported);
  const ids = attachmentIds(imported.content);
  assert.equal(ids.length, 2); assert.notEqual(ids[0], image.id);
  assert.deepEqual(store.readAttachment(scope(store), ids[0]), png);
  assert.equal(store._raw("attachment", ids[1]).noteId, imported.id);
  const original = JSON.parse(fs.readFileSync(exported));
  const hostile = structuredClone(original); hostile.attachments[0].path = "../outside.txt";
  fs.writeFileSync(exported, JSON.stringify(hostile));
  assert.throws(() => portable.importFile(store, exported), { code: "INVALID_INPUT" });
  fs.writeFileSync(exported, JSON.stringify(original));
  fs.writeFileSync(path.join(directory, original.attachments[0].path), "changed");
  assert.throws(() => portable.importFile(store, exported), { code: "ATTACHMENT_CORRUPT" });
  const backup = new BackupService(catalog), archive = path.join(root, "notes.focusbae-backup");
  await backup.create(store.identity.id, archive);
  const restored = await backup.restore(archive);
  await catalog.open({ workspaceId: restored.id });
  const copy = catalog.store;
  assert.deepEqual(attachmentIds(copy.get(scope(copy), "note", note.id).content), [image.id, pdf.id]);
  assert.deepEqual(copy.readAttachment(scope(copy), image.id), png);
  assert.equal(imageResponse(catalog, info(copy, note.id, image.id).imageUrl).status, 200);
  assert.equal(imageResponse(catalog, image.imageUrl).status, 404);
});
