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

// Enough of the team service for notes: versions, deletions, uploads and the pull.
class NotesServer {
  constructor() { this.folders = new Map(); this.notes = new Map(); this.objects = new Map(); this.registered = new Map(); this.calls = []; this.seq = 0; }
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
      const old = this.notes.get(args.p_id);
      if (old && args.p_version != null && old.version !== args.p_version)
        throw Object.assign(new Error("changed elsewhere"), { code: "VERSION_CONFLICT" });
      const row = { id: args.p_id, spaceId: args.p_space, folderId: args.p_folder ?? null, title: args.p_title, content: args.p_content,
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
        { id: ENG, kind: "custom", name: "Eng", role: "editor" },
        { id: SALES, kind: "custom", name: "Sales", role: "viewer" },
      ],
      folders: [...this.folders.values()].filter((f) => !f.deleted && f.seq > args.p_since),
      visibleFolderIds: [...this.folders.values()].filter((f) => !f.deleted).map((f) => f.id),
      people: [], commitments: [], visibleCommitmentIds: [],
      notes: [...this.notes.values()].filter((n) => !n.deleted && n.seq > args.p_since),
      visibleNoteIds: [...this.notes.values()].filter((n) => !n.deleted).map((n) => n.id),
    };
    throw new Error(`unexpected ${name}`);
  }
  async upload(bucket, path, bytes, contentType) {
    this.calls.push("upload");
    this.objects.set(path, { bytes, contentType });
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
  await server.rpc("save_folder", { p_id: randomUUID(), p_space: SALES, p_parent: null, p_name: "Read-only sales" });
  await round(store, state, server);
  assert.ok(!store.folderList(ws(store)).items.some((f) => f.name === "Read-only sales"));
  assert.equal(state.sentFolderIds().length, 0);
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
