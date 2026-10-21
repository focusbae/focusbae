"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, mutation, document } = require("../local-first/helpers.cjs");
const { randomUUID } = require("node:crypto");
const folders = require("../../team/folders");
const { TeamState } = require("../../team/state");
const sync = require("../../team/sync");

const PRIVATE = "33333333-3333-4333-8333-333333333333";
const ENG = "44444444-4444-4444-8444-444444444444";
const SALES = "55555555-5555-4555-8555-555555555555";
const ALICE = "66666666-6666-4666-8666-666666666666";
const WS = "11111111-1111-4111-8111-111111111111";

// Enough of the team service for notes: versions, deletions, uploads and the pull.
class NotesServer {
  constructor() { this.engRole = "editor"; this.folders = new Map(); this.notes = new Map(); this.objects = new Map(); this.registered = new Map(); this.calls = []; this.seq = 0; }
  async rpc(name, args) {
    this.calls.push(name);
    if (name === "save_folder") {
      const old = this.folders.get(args.p_id);
      if (old && args.p_version != null && old.version !== args.p_version) throw Object.assign(new Error("changed elsewhere"), { code: "VERSION_CONFLICT" });
      const twin = [...this.folders.values()].find((f) => f.id !== args.p_id && !f.deleted && f.spaceId === args.p_space && f.parentId === args.p_parent && f.name.toLowerCase() === args.p_name.toLowerCase());
      if (twin) return { id: twin.id, version: twin.version, merged: true };
      const row = { id: args.p_id, spaceId: args.p_space, parentId: args.p_parent, name: args.p_name, version: (old?.version ?? 0) + 1, seq: ++this.seq };
      this.folders.set(row.id, row); return row;
    }
    if (name === "delete_folder") {
      const old = this.folders.get(args.p_id);
      if (old && old.version !== args.p_version) throw Object.assign(new Error("changed elsewhere"), { code: "VERSION_CONFLICT" });
      if (old) { old.deleted = true; old.seq = ++this.seq; }
      return null;
    }
    if (name === "upsert_note") {
      if (args.p_space === ENG && this.engRole !== "editor") throw Object.assign(new Error("not allowed"), { code: "FORBIDDEN" });
      const old = this.notes.get(args.p_id);
      if (old && args.p_version != null && old.version !== args.p_version)
        throw Object.assign(new Error("changed elsewhere"), { code: "VERSION_CONFLICT" });
      const row = { id: args.p_id, authorId: "u1", spaceId: args.p_space, folderId: args.p_folder ?? null, title: args.p_title, content: args.p_content,
        text: args.p_text, version: (old?.version ?? 0) + 1, deleted: false, seq: ++this.seq };
      this.notes.set(row.id, row);
      return { version: row.version };
    }
    if (name === "delete_note") { this.notes.get(args.p_id).deleted = true; return null; }
    if (name === "register_note_attachment") {
      if (!this.notes.has(args.p_note)) throw Object.assign(new Error("not allowed"), { code: "FORBIDDEN" });
      this.registered.set(args.p_attachment, args);
      return null;
    }
    if (name === "pull_changes") return {
      cursor: this.seq, workspace: { name: "Acme", role: "member", processingLevelMax: 1 }, me: { personId: "me" },
      spaces: [
        { id: PRIVATE, kind: "private", name: "My notes", role: "editor" },
        ...(this.engRole ? [{ id: ENG, kind: "custom", name: "Eng", role: this.engRole }] : []),
        { id: SALES, kind: "custom", name: "Sales", role: "viewer" },
      ],
      folders: [...this.folders.values()].filter((f) => !f.deleted && f.seq > args.p_since),
      visibleFolderIds: [...this.folders.values()].filter((f) => !f.deleted).map((f) => f.id),
      people: [{ id: ALICE, name: "Alice", email: "alice@acme.com", isMember: true }], commitments: [], visibleCommitmentIds: [],
      notes: [...this.notes.values()].filter((n) => !n.deleted && n.seq > args.p_since),
      visibleNoteIds: [...this.notes.values()].filter((n) => !n.deleted).map((n) => n.id),
    };
    throw new Error(`unexpected ${name}`);
  }
  async upload(bucket, path, bytes, contentType) {
    this.calls.push("upload");
    this.objects.set(path, { bytes, contentType });
  }
  async select(path) {
    this.calls.push("select");
    const ids = new Set(/note_id=in\.\(([^)]*)\)/.exec(path)[1].split(","));
    return [...this.registered.values()].filter((r) => ids.has(r.p_note) && r.p_uploaded).map((r) => ({
      note_id: r.p_note, attachment_id: r.p_attachment, file_name: r.p_file_name, mime_type: r.p_mime_type, byte_size: r.p_byte_size, uploaded: true,
    }));
  }
  async download(bucket, path) {
    this.calls.push("download");
    return this.objects.get(path)?.bytes ?? null;
  }
  // A page Alice writes on the web: what the server holds, as another author.
  teammate(fields) {
    const old = this.notes.get(fields.id);
    const row = { authorId: "alice", authorPersonId: ALICE, spaceId: ENG, folderId: null, title: "Alice's spec",
      content: document("Alice wrote this"), ...old, ...fields, version: (old?.version ?? 0) + 1, deleted: false, seq: ++this.seq };
    this.notes.set(row.id, row);
    return row;
  }
  teammateFile(noteId, id, bytes) {
    this.objects.set(`${WS}/${noteId}/${id}`, { bytes, contentType: "image/png" });
    this.registered.set(id, { p_note: noteId, p_attachment: id, p_file_name: "board.png", p_mime_type: "image/png", p_byte_size: bytes.length, p_uploaded: true });
  }
}

async function setup(t) {
  const { store, directory } = await fixture(t);
  const state = TeamState.create(directory, { serverWorkspaceId: "11111111-1111-4111-8111-111111111111", accountUserId: "u1", name: "Acme" });
  t.after(() => state.close());
  return { store, state, server: new NotesServer() };
}

const round = async (store, state, server) => sync.apply(store, state, await sync.exchange(server, state, sync.plan(store, state)));
const ws = (store) => ({ workspaceId: store.identity.id });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function withAttachment(store, note, attachment) {
  const current = store.get(ws(store), "note", note.id);
  return store.updateNote(mutation(store, current.revision), note.id, {
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "See below" }] }, { type: "noteAttachment", attrs: { id: attachment.id } }] },
  });
}

test("notes wait for the first pull, then go to My notes by default, once", async (t) => {
  const { store, state, server } = await setup(t);
  const note = store.createNote(mutation(store), { title: "Kickoff", content: document("Agreed the scope") });
  await round(store, state, server);
  assert.equal(server.calls.includes("upsert_note"), false, "nothing is sent before My notes is known");
  await round(store, state, server);
  assert.equal(server.notes.get(note.id).spaceId, PRIVATE);
  assert.equal(server.notes.get(note.id).text, "Agreed the scope");
  const sends = server.calls.filter((c) => c === "upsert_note").length;
  await round(store, state, server);
  assert.equal(server.calls.filter((c) => c === "upsert_note").length, sends, "unchanged notes are not resent");
  store.updateNote(mutation(store, store.get(ws(store), "note", note.id).revision), note.id, { title: "Kickoff call" });
  await round(store, state, server);
  assert.equal(server.notes.get(note.id).title, "Kickoff call");
});

test("a note moves to a team the person can edit, never one they only view", async (t) => {
  const { store, state, server } = await setup(t);
  const note = store.createNote(mutation(store), { title: "API spec", content: document("Endpoints") });
  await round(store, state, server);
  state.setNoteSpace(note.id, ENG);
  await round(store, state, server);
  assert.equal(server.notes.get(note.id).spaceId, ENG);
  assert.throws(() => state.setNoteSpace(note.id, SALES), /can't add notes to that team/);
  state.setNoteSpace(note.id, PRIVATE);
  await round(store, state, server);
  assert.equal(server.notes.get(note.id).spaceId, PRIVATE, "choosing My notes moves it back");
});

test("deleting a note here removes it from the team", async (t) => {
  const { store, state, server } = await setup(t);
  const note = store.createNote(mutation(store), { title: "Draft", content: document("x") });
  await round(store, state, server);
  await round(store, state, server);
  store.delete(mutation(store, store.get(ws(store), "note", note.id).revision), "note", note.id);
  await round(store, state, server);
  assert.equal(server.notes.get(note.id).deleted, true);
  assert.equal(state.noteSent(note.id), null);
});

test("attachments upload after their note, once, with HEIC sent as its PNG preview", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const note = store.createNote(mutation(store), { title: "Whiteboard", content: document("") });
  const image = store.putAttachment(mutation(store), { noteId: note.id, displayName: "board.png", mediaType: "image/png" }, PNG);
  withAttachment(store, note, image);
  await round(store, state, server);
  const path = `11111111-1111-4111-8111-111111111111/${note.id}/${image.id}`;
  assert.deepEqual(server.objects.get(path), { bytes: PNG, contentType: "image/png" });
  assert.equal(server.registered.get(image.id).p_uploaded, true);
  assert.ok(server.calls.indexOf("upsert_note") < server.calls.indexOf("upload"), "the note exists before its file");
  const uploads = server.calls.filter((c) => c === "upload").length;
  await round(store, state, server);
  assert.equal(server.calls.filter((c) => c === "upload").length, uploads, "unchanged files are not uploaded again");

  const photoNote = store.createNote(mutation(store), { title: "Photo", content: document("") });
  const preview = store.putAttachment(mutation(store), { noteId: photoNote.id, displayName: "IMG_1.png", mediaType: "image/png" }, PNG);
  const heic = store.putAttachment(mutation(store), { noteId: photoNote.id, displayName: "IMG_1.heic", mediaType: "image/heic", previewId: preview.id }, Buffer.from("not really heic"));
  withAttachment(store, photoNote, heic);
  await round(store, state, server);
  const sentPhoto = server.objects.get(`11111111-1111-4111-8111-111111111111/${photoNote.id}/${heic.id}`);
  assert.equal(sentPhoto.contentType, "image/png");
  assert.deepEqual(sentPhoto.bytes, PNG);
  assert.equal(server.registered.get(heic.id).p_file_name, "IMG_1.heic");
});

test("a file over the team storage limit is listed but stays on this Mac", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const note = store.createNote(mutation(store), { title: "Recording", content: document("") });
  const big = store.putAttachment(mutation(store), { noteId: note.id, displayName: "call.mov", mediaType: "video/quicktime" }, Buffer.alloc(51 * 1024 * 1024));
  withAttachment(store, note, big);
  await round(store, state, server);
  assert.equal(server.calls.includes("upload"), false, "its bytes are never sent");
  assert.equal(server.registered.get(big.id).p_uploaded, false);
  assert.equal(server.registered.get(big.id).p_byte_size, 51 * 1024 * 1024);
});


test("team headings stay local; folder and note placement sync together", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const root = state.rootForSpace(ENG);
  assert.ok(root);
  const folder = store.createFolder(mutation(store), { name: "Clients", parentId: root });
  const child = store.createFolder(mutation(store), { name: "Acme", parentId: folder.id });
  const note = store.createNote(mutation(store), { title: "Kickoff", folderId: child.id });
  await round(store, state, server);
  assert.equal(server.folders.has(root), false, "a team heading is not a server folder");
  assert.equal(server.folders.get(folder.id).parentId, null);
  assert.equal(server.folders.get(child.id).parentId, folder.id);
  assert.equal(server.notes.get(note.id).spaceId, ENG);
  assert.equal(server.notes.get(note.id).folderId, child.id);
  const calls = server.calls.length;
  await round(store, state, server);
  assert.deepEqual(server.calls.slice(calls), ["pull_changes"], "no echo after the pull");
});

test("web filing reaches the Mac and a stale edit retries with the new location", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const note = store.createNote(mutation(store), { title: "Kickoff", content: document("Draft"), folderId: state.rootForSpace(ENG) });
  await round(store, state, server);
  const f = await server.rpc("save_folder", { p_id: randomUUID(), p_space: ENG, p_parent: null, p_name: "Web folder" });
  Object.assign(server.notes.get(note.id), { folderId: f.id, version: 2, seq: ++server.seq });
  store.updateNote(mutation(store, note.revision), note.id, { content: document("My unsent writing") });
  await round(store, state, server);
  assert.equal(store.get(ws(store), "note", note.id).folderId, f.id);
  assert.equal(store.get(ws(store), "note", note.id).plainText, "My unsent writing");
  await round(store, state, server);
  assert.equal(server.notes.get(note.id).folderId, f.id);
  assert.equal(server.notes.get(note.id).text, "My unsent writing");
});

test("a move made during a request survives the incoming placement", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const note = store.createNote(mutation(store), { title: "Draft" });
  await round(store, state, server);
  server.notes.get(note.id).version++; server.notes.get(note.id).seq = ++server.seq;
  const result = await sync.exchange(server, state, sync.plan(store, state));
  store.moveNote(mutation(store, note.revision), note.id, state.rootForSpace(ENG));
  sync.apply(store, state, result);
  assert.equal(store.get(ws(store), "note", note.id).folderId, state.rootForSpace(ENG));
  await round(store, state, server);
  assert.equal(server.notes.get(note.id).spaceId, ENG);
});

test("concurrent same-name folders merge without losing the Mac's pages", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const remote = await server.rpc("save_folder", { p_id: randomUUID(), p_space: ENG, p_parent: null, p_name: "Clients" });
  const local = store.createFolder(mutation(store), { name: "Clients", parentId: state.rootForSpace(ENG) });
  const note = store.createNote(mutation(store), { title: "Brief", folderId: local.id });
  await round(store, state, server);
  assert.equal(store.get(ws(store), "note", note.id).folderId, remote.id);
  assert.equal(server.notes.get(note.id).folderId, remote.id);
  assert.equal(store.folderList(ws(store)).items.filter((f) => f.name === "Clients").length, 1);
});

test("team sections and daily pages are protected; viewers' folders never become private folders", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const root = state.rootForSpace(ENG);
  assert.throws(() => folders.guard(store, state, "folder", root, null), /managed/);
  const daily = store.dailyNote(mutation(store));
  assert.throws(() => folders.guard(store, state, "note", daily.id, root), /Daily notes/);
  const viewed = await server.rpc("save_folder", { p_id: randomUUID(), p_space: SALES, p_parent: null, p_name: "Read-only sales" });
  await round(store, state, server);
  const shown = store.folderList(ws(store)).items.find((f) => f.name === "Read-only sales");
  assert.equal(shown.parentId, state.rootForSpace(SALES), "a team the person only reads still shows its folders, under its heading");
  assert.throws(() => folders.guard(store, state, "folder", null, viewed.id), /permission/);
  const calls = server.calls.length;
  await round(store, state, server);
  assert.deepEqual(server.calls.slice(calls), ["pull_changes"], "nothing in a read-only team is sent back");
});

test("eight levels inside a team heading fit, but a ninth is rejected", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  let parent = state.rootForSpace(ENG);
  for (let n = 1; n <= 8; n++) parent = store.createFolder(mutation(store), { name: `L${n}`, parentId: parent }).id;
  assert.throws(() => store.createFolder(mutation(store), { name: "L9", parentId: parent }), /nested/);
});

test("a failed local apply rolls back the cursor so the same pull can retry", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const cursor = state.binding().cursor;
  await server.rpc("save_folder", { p_id: randomUUID(), p_space: ENG, p_parent: null, p_name: "Retry me" });
  const result = await sync.exchange(server, state, sync.plan(store, state));
  const save = store._save;
  store._save = () => { throw new Error("disk full"); };
  assert.throws(() => sync.apply(store, state, result), /disk full/);
  store._save = save;
  assert.equal(state.binding().cursor, cursor);
  sync.apply(store, state, result);
  assert.ok(store.folderList(ws(store)).items.some((f) => f.name === "Retry me"));
});


test("deleting a local folder merges a same-name child without losing pages", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const root = state.rootForSpace(ENG);
  const clients = store.createFolder(mutation(store), { name: "Clients", parentId: root });
  const inside = store.createFolder(mutation(store), { name: "Acme", parentId: clients.id });
  const outside = store.createFolder(mutation(store), { name: "Acme", parentId: root });
  const note = store.createNote(mutation(store), { title: "Proposal", folderId: inside.id });
  await round(store, state, server);
  store.deleteFolder(mutation(store, clients.revision), clients.id);
  assert.equal(store.get(ws(store), "note", note.id).folderId, outside.id);
  assert.equal(store.folderList(ws(store)).items.filter((f) => f.name === "Acme").length, 1);
});

const imageDoc = (id) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Board" }] }, { type: "noteAttachment", attrs: { id } }] });

test("a teammate's page arrives read-only under its team and folder, and is never sent back", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const specs = await server.rpc("save_folder", { p_id: randomUUID(), p_space: ENG, p_parent: null, p_name: "Specs" });
  const remote = server.teammate({ id: randomUUID(), folderId: specs.id });
  await round(store, state, server);
  const page = store.get(ws(store), "note", remote.id);
  assert.equal(page.plainText, "Alice wrote this");
  assert.equal(page.folderId, specs.id);
  assert.deepEqual(require("../../workspace/notebook").publicNote(page).team, { readOnly: true, authorName: "Alice", spaceName: "Eng", arriving: false, lostAccess: false });

  assert.throws(() => store.updateNote(mutation(store, page.revision), page.id, { content: document("mine now") }), /teammate/);
  assert.throws(() => store.delete(mutation(store, page.revision), "note", page.id), /teammate/);
  assert.throws(() => store.moveNote(mutation(store, page.revision), page.id, null), /teammate/);
  assert.throws(() => store.putAttachment(mutation(store), { noteId: page.id, displayName: "x.png", mediaType: "image/png" }, PNG), /teammate/);
  const pinned = store.editNote(mutation(store, page.revision), page.id, { pinned: true });
  assert.equal(pinned.metadata.pinned, true, "pinning is the reader's own choice");

  const calls = server.calls.length;
  await round(store, state, server);
  assert.deepEqual(server.calls.slice(calls), ["pull_changes"], "a copy is never pushed and an unchanged one is not rewritten");

  server.teammate({ id: remote.id, title: "Alice's spec v2", content: document("Revised") });
  await round(store, state, server);
  const updated = store.get(ws(store), "note", remote.id);
  assert.equal(updated.title, "Alice's spec v2");
  assert.equal(updated.metadata.pinned, true, "their edit keeps the reader's pin");
});

test("a teammate's images arrive with their page; until then the page shows without them", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const id = randomUUID(), image = randomUUID();
  server.teammate({ id, content: imageDoc(image) });
  await round(store, state, server);
  assert.equal(store.get(ws(store), "note", id).plainText, "Board", "shown before its file is uploaded");
  assert.equal(state.mirrored(id).complete, false);
  server.teammateFile(id, image, PNG);
  await round(store, state, server);
  const page = store.get(ws(store), "note", id);
  assert.equal(page.content.content[1].attrs.id, image);
  assert.deepEqual(store.readAttachment(ws(store), image), PNG);
  assert.equal(state.mirrored(id).complete, true);
  const downloads = server.calls.filter((c) => c === "download").length;
  await round(store, state, server);
  assert.equal(server.calls.filter((c) => c === "download").length, downloads, "a file is fetched once");
});

test("a teammate's page that is no longer visible is erased here, files included", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const id = randomUUID(), image = randomUUID();
  server.teammate({ id, content: imageDoc(image) });
  server.teammateFile(id, image, PNG);
  await round(store, state, server);
  server.notes.get(id).deleted = true;
  await round(store, state, server);
  const raw = store._raw("note", id);
  assert.ok(raw.deletedAt && raw.metadata.purgedAt, "erased, not in Trash");
  assert.equal(raw.plainText, "");
  assert.equal(store._raw("attachment", image).deletedAt !== null, true);
  assert.equal(state.mirrored(id), null);
  server.teammate({ id, content: document("Shared again") });
  await round(store, state, server);
  assert.equal(store.get(ws(store), "note", id).plainText, "Shared again", "visible again, it comes back");
});

test("a page shared from a team the person is not in gathers under Shared with you", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const elsewhere = "77777777-7777-4777-8777-777777777777";
  const remote = server.teammate({ id: randomUUID(), spaceId: elsewhere, folderId: randomUUID() });
  await round(store, state, server);
  const root = state.rootForSpace(folders.SHARED);
  assert.equal(store.get(ws(store), "note", remote.id).folderId, root);
  assert.equal(store._raw("folder", root).name, "Shared with you");
  assert.throws(() => folders.guard(store, state, "note", null, root), /permission/);
});

test("removal from the workspace erases teammates' pages but keeps the person's own", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const mine = store.createNote(mutation(store), { title: "Mine", content: document("my words") });
  const theirs = server.teammate({ id: randomUUID() });
  await round(store, state, server);
  server.rpc = async () => { throw Object.assign(new Error("not allowed"), { code: "FORBIDDEN" }); };
  const outcome = await round(store, state, server);
  assert.equal(outcome.removed, true);
  assert.equal(store._raw("note", theirs.id).metadata.purgedAt != null, true);
  assert.equal(store.get(ws(store), "note", mine.id).plainText, "my words");
});

test("one page this Mac cannot read is reported without stopping the others", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const bad = server.teammate({ id: randomUUID(), title: "Broken", content: { type: "doc", content: [{ type: "mysteryNode" }] } });
  const good = server.teammate({ id: randomUUID(), title: "Fine" });
  await round(store, state, server);
  assert.equal(store.get(ws(store), "note", good.id).title, "Fine");
  assert.ok(!store._raw("note", bad.id));
  assert.match(state.binding().lastError, /Broken/);
});

test("a person page lists pages that mention them, teammates' pages included", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const mine = store.createNote(mutation(store), { title: "1:1 notes", content: document("Agreed with [[Priya]] on scope") });
  store.createNote(mutation(store), { title: "Priya", content: document("Her page, not a mention") });
  const theirs = server.teammate({ id: randomUUID(), title: "Standup", content: document("[[ priya ]] owns the rollout") });
  await round(store, state, server);
  const pages = require("../../workspace/people").pages(store, store.identity.id, "Priya");
  assert.deepEqual(pages.map((p) => p.id).sort(), [mine.id, theirs.id].sort());
  assert.equal(pages.find((p) => p.id === theirs.id).authorName, "Alice");
});

test("team people and their open promises come from the synced ledger, without this Mac's own", async (t) => {
  const { store, state } = await setup(t);
  const { TeamService } = require("../../team/service");
  const { EventEmitter } = require("node:events");
  state.applyPull({
    cursor: 1, workspace: { name: "Acme", role: "member", processingLevelMax: 1 }, me: { personId: "me" },
    spaces: [], people: [{ id: "me", name: "Me", isMember: true }, { id: ALICE, name: "Alice", email: "alice@acme.com", isMember: true }],
    commitments: [
      { id: "c1", version: 1, title: "Send the deck", status: "accepted", owner_person_id: ALICE, counterparty_person_id: "me", due_date: null, quote: "I'll send it", source_title: "Standup" },
      { id: "c2", version: 1, title: "Review pricing", status: "accepted", owner_person_id: "me", counterparty_person_id: ALICE, due_date: null },
      { id: "c3", version: 1, title: "Old thing", status: "done", owner_person_id: ALICE, counterparty_person_id: null, due_date: null },
    ],
    visibleCommitmentIds: ["c1", "c2", "c3"], notes: [], visibleNoteIds: [],
  });
  state.markSent("c2", "h", 1); // this Mac's own action, already on its local People page
  const service = new TeamService({ account: new EventEmitter(), policy: Object.assign(new EventEmitter(), { allows: () => false }), catalog: { store } });
  assert.deepEqual(service.teamPeople(), [{ id: ALICE, name: "Alice", email: "alice@acme.com", isMember: true, owes: 1, owed: 0 }]);
  const alice = service.teamPerson(" alice ");
  assert.deepEqual(alice.owes.map((c) => [c.title, c.owner, c.counterparty, c.sourceTitle]), [["Send the deck", "Alice", "You", "Standup"]]);
  assert.equal(alice.owed.length, 0);
  assert.equal(service.teamPerson("Nobody"), null);
});

test("a teammate's page handed to this person becomes theirs to edit here, and syncs as theirs", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const remote = server.teammate({ id: randomUUID(), title: "Runbook" });
  await round(store, state, server);
  assert.ok(store.get(ws(store), "note", remote.id).team, "read-only while it is Alice's");
  Object.assign(server.notes.get(remote.id), { authorId: "u1", seq: ++server.seq }); // an admin hands it over
  await round(store, state, server);
  const mine = store.get(ws(store), "note", remote.id);
  assert.equal(mine.team ?? null, null, "now an ordinary page");
  assert.equal(state.mirrored(remote.id), null);
  const calls = server.calls.length;
  await round(store, state, server);
  assert.deepEqual(server.calls.slice(calls), ["pull_changes"], "not pushed straight back");
  store.updateNote(mutation(store, mine.revision), mine.id, { content: document("Edited by me") });
  await round(store, state, server);
  assert.equal(server.notes.get(remote.id).text, "Edited by me");
});

test("this person's page written elsewhere arrives editable once its files are here", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const id = randomUUID(), image = randomUUID();
  server.teammate({ id, authorId: "u1", title: "From the web", content: imageDoc(image) });
  await round(store, state, server);
  assert.equal(require("../../workspace/notebook").publicNote(store.get(ws(store), "note", id)).team.arriving, true);
  assert.throws(() => store.updateNote(mutation(store, store.get(ws(store), "note", id).revision), id, { title: "x" }), /teammate/);
  server.teammateFile(id, image, PNG);
  await round(store, state, server);
  const page = store.get(ws(store), "note", id);
  assert.equal(page.team ?? null, null);
  assert.equal(page.content.content[1].attrs.id, image);
});

test("signing out erases teammates' copies and the team ledger, keeps own pages, and a sign-in brings them back", async (t) => {
  const { store, state, server } = await setup(t);
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { TeamService } = require("../../team/service");
  await round(store, state, server);
  const mine = store.createNote(mutation(store), { title: "Mine", content: document("my words") });
  const theirs = server.teammate({ id: randomUUID(), title: "Theirs" });
  await round(store, state, server);
  const account = Object.assign(new EventEmitter(), { status: () => ({ connected: true }) });
  const catalog = { store, root: path.dirname(store._directory), entries: [{ id: store.identity.id, directory: path.basename(store._directory) }], serialize: (fn) => fn() };
  const service = new TeamService({ account, catalog, policy: Object.assign(new EventEmitter(), { allows: () => false }) });
  account.status = () => ({ connected: false });
  await service.eraseCopies();
  assert.ok(store._raw("note", theirs.id).metadata.purgedAt, "the teammate's page is erased");
  assert.equal(store.get(ws(store), "note", mine.id).plainText, "my words");
  assert.deepEqual([state.mirroredIds(), state.remoteNotes(), state.binding().cursor], [[], [], 0]);
  await round(store, state, server);
  assert.equal(store.get(ws(store), "note", theirs.id).title, "Theirs", "signed in again, it is back");
});

test("removed from a team, edits not yet sent are saved as a copy in My notes and the page turns read-only", async (t) => {
  const { store, state, server } = await setup(t);
  await round(store, state, server);
  const page = store.createNote(mutation(store), { title: "Spec", content: document("Agreed"), folderId: state.rootForSpace(ENG) });
  const image = store.putAttachment(mutation(store), { noteId: page.id, displayName: "board.png", mediaType: "image/png" }, PNG);
  withAttachment(store, page, image);
  await round(store, state, server);
  assert.equal(server.notes.get(page.id).spaceId, ENG);
  const sent = server.notes.get(page.id).text;
  // Edited on the Mac while an admin removes them from Eng, before the edit is sent.
  server.engRole = null;
  const current = store.get(ws(store), "note", page.id);
  store.updateNote(mutation(store, current.revision), page.id, { title: "Spec v2", content: { ...current.content, content: [{ type: "paragraph", content: [{ type: "text", text: "My late edit" }] }, current.content.content[1]] } });
  await round(store, state, server);
  assert.equal(server.notes.get(page.id).text, sent, "the team's page is untouched");
  const original = store.get(ws(store), "note", page.id);
  assert.equal(require("../../workspace/notebook").publicNote(original).team.lostAccess, true);
  assert.equal(original.plainText, sent, "the page shows what the team has");
  const copy = store.list(ws(store), "note").find((n) => n.title === "Spec v2 (your copy)");
  assert.equal(copy.plainText, "My late edit");
  const copiedImage = copy.content.content[1].attrs.id;
  assert.notEqual(copiedImage, image.id);
  assert.deepEqual(store.readAttachment(ws(store), copiedImage), PNG, "the copy has its own copy of the image");
  assert.equal(folders.location(store, state, copy.folderId).spaceId, PRIVATE);
  assert.match(state.binding().lastError, /saved as "Spec v2 \(your copy\)" in My notes/);
  const calls = server.calls.length;
  await round(store, state, server);
  assert.deepEqual(server.calls.slice(calls).filter((c) => c === "upsert_note").length, 1, "only the copy is sent, to My notes");

  server.engRole = "editor"; // added back
  await round(store, state, server);
  assert.equal(store.get(ws(store), "note", page.id).team ?? null, null, "editable again");
});

test("cloud transcription is offered only where the admin allows level 3, to the connected account, outside Strict Local", async (t) => {
  const { store, state } = await setup(t);
  const { EventEmitter } = require("node:events");
  const { TeamService } = require("../../team/service");
  const { LocalPolicy } = require("../../privacy/local-policy");
  const policy = new LocalPolicy();
  policy.setTeamConnected(true);
  const asked = [];
  const account = Object.assign(new EventEmitter(), { status: () => ({ connected: true, userId: "u1" }), speechToken: async (ws) => { asked.push(ws); return { accessToken: "x" }; } });
  const service = new TeamService({ account, policy, catalog: { store, serialize: async () => null } });
  t.after(() => service.stop());
  const pull = (level) => state.applyPull({ cursor: 1, workspace: { name: "Acme", role: "member", processingLevelMax: level }, me: { personId: "me" },
    spaces: [], people: [], commitments: [], visibleCommitmentIds: [], notes: [], visibleNoteIds: [] });
  pull(1);
  assert.equal(service.cloudSpeech(store), null, "level 1: this Mac only");
  pull(3);
  const cloud = service.cloudSpeech(store);
  await cloud.token();
  assert.deepEqual(asked, [WS], "the token is asked for this workspace");
  policy.setStrict(true);
  assert.equal(service.cloudSpeech(store), null, "Strict Local");
  policy.setStrict(false);
  policy.setTeamConnected(true);
  account.status = () => ({ connected: true, userId: "someone-else" });
  assert.equal(service.cloudSpeech(store), null, "another account");
});
