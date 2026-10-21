"use strict";

const { randomUUID, createHash } = require("node:crypto");
const domain = require("../workspace/domain");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message) => Object.assign(new Error(message), { code: "INVALID_INPUT" });
const ctx = (store) => ({ workspaceId: store.identity.id });

// Team headings are real local folders, but never server folders. Their mapping lives
// exclusively in team.sqlite. Personal workspaces never acquire this state.
function prepare(store, state) {
  if (!state.privateSpaceId()) return;
  store._db.transaction(() => {
    // Every team this person is in gets a heading, including ones they can only read.
    for (const space of state.spaces().filter((s) => s.kind !== "private")) {
      let root = state.rootForSpace(space.id);
      if (!root) { root = randomUUID(); state.setRoot(space.id, root); }
      const old = store._raw("folder", root);
      const rows = store._folderRows(store.identity.id);
      let name = space.name.replace(/[/\\]/g, " · ").slice(0, 180) || "Team";
      if (rows.some((r) => r.id !== root && !r.parentId && r.name.toLowerCase() === name.toLowerCase())) name += ` · ${space.id.slice(0, 8)}`;
      if (!old) store._save("folder", { ...store._new(domain.folder({ name }, null)), id: root });
      else if (old.name !== name || old.deletedAt) store._save("folder", store._next(old, { name, deletedAt: null }));
    }
    // Migrate the old independent "Visible to" setting exactly once, then retire it.
    for (const { note_id: id, space_id: spaceId } of state.db.prepare("SELECT * FROM note_spaces").all()) {
      const root = state.rootForSpace(spaceId);
      const note = store._raw("note", id);
      if ((root || spaceId === state.privateSpaceId()) && note && !note.deletedAt && note.kind !== "daily") store._save("note", store._next(note, { folderId: root }));
      if (root || spaceId === state.privateSpaceId() || note?.kind === "daily") state.db.prepare("DELETE FROM note_spaces WHERE note_id = ?").run(id);
    }
  })();
  store._teamFolderRoots = new Set(state.roots().map((r) => r.folderId));
}

// Pages shared with this person from a team they are not in have no team heading of
// their own; they gather under one local heading, made when the first one arrives.
const SHARED = "shared";
function sharedRoot(store, state) {
  let root = state.rootForSpace(SHARED);
  if (!root) { root = randomUUID(); state.setRoot(SHARED, root); }
  const old = store._raw("folder", root);
  const taken = store._folderRows(store.identity.id).some((r) => r.id !== root && !r.parentId && r.name.toLowerCase() === "shared with you");
  const name = taken ? `Shared with you · ${root.slice(0, 8)}` : "Shared with you";
  if (!old) store._save("folder", { ...store._new(domain.folder({ name }, null)), id: root });
  else if (old.deletedAt) store._save("folder", store._next(old, { deletedAt: null }));
  store._teamFolderRoots = new Set(state.roots().map((r) => r.folderId));
  return root;
}

function location(store, state, folderId) {
  const roots = new Map(state.roots().map((r) => [r.folderId, r.spaceId]));
  let current = folderId;
  const visited = new Set();
  while (current && !visited.has(current)) {
    if (roots.has(current)) return { spaceId: roots.get(current), folderId: roots.has(folderId) ? null : folderId };
    visited.add(current);
    current = store._raw("folder", current)?.parentId;
  }
  return { spaceId: state.privateSpaceId(), folderId: folderId ?? null };
}

function folderPayload(store, state, folder) {
  const where = location(store, state, folder.id);
  return { spaceId: where.spaceId, parentId: state.roots().some((r) => r.folderId === folder.parentId) ? null : folder.parentId, name: folder.name };
}

function plan(store, state) {
  prepare(store, state);
  if (!state.privateSpaceId()) return { folders: [], folderDeletions: [], folderSnapshots: {} };
  const roots = new Set(state.roots().map((r) => r.folderId));
  const rows = store._folderRows(store.identity.id).filter((f) => !roots.has(f.id));
  const folders = [], folderSnapshots = {};
  // Parents must be sent before their children, including a newly created subtree.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const depth = (f) => { let n = 0; for (let p = f; p && n < 12; p = byId.get(p.parentId)) n++; return n; };
  for (const folder of rows.sort((a, b) => depth(a) - depth(b))) {
    const payload = folderPayload(store, state, folder);
    const fingerprint = hash(payload);
    folderSnapshots[folder.id] = fingerprint;
    const sent = state.folderSent(folder.id);
    if (!sent || sent.hash !== fingerprint) folders.push({ id: folder.id, payload, hash: fingerprint, version: sent?.version ?? null });
  }
  const folderDeletions = state.sentFolderIds().filter((id) => !byId.has(id)).map((id) => ({ id, version: state.folderSent(id).version }));
  return { folders, folderDeletions, folderSnapshots };
}

// Local folder structure uses the same stable ids as the server. Pulling placement
// never replaces a note's content, attachments or edits made while the request ran.
function apply(store, state, result) {
  const pull = result.pull;
  if (!pull?.folders) return false;
  const before = store._folderRows(store.identity.id).length;
  prepare(store, state);
  let changed = before !== store._folderRows(store.identity.id).length;
  store._db.transaction(() => {
    for (const sent of result.foldersSent ?? []) state.markFolderSent(sent.id, sent.hash, sent.version);
    const incoming = new Map(pull.folders.map((f) => [f.id, f]));
    const pending = [...incoming.values()];
    for (let round = 0; pending.length && round < 10; round++) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const f = pending[i];
        if (f.spaceId !== state.privateSpaceId() && !state.rootForSpace(f.spaceId)) { pending.splice(i, 1); continue; }
        const parentId = f.parentId ?? state.rootForSpace(f.spaceId) ?? null;
        if (parentId && !store._raw("folder", parentId)) continue;
        const old = store._raw("folder", f.id);
        const planned = result.folderSnapshots?.[f.id];
        const changedDuringRequest = old && !old.deletedAt && planned && hash(folderPayload(store, state, old)) !== planned;
        const payload = { spaceId: f.spaceId, parentId: f.parentId, name: f.name };
        if (!changedDuringRequest) {
          // Concurrent same-name creates return one id. Merge the local duplicate
          // into that id before materialising it so SQLite's unique index holds.
          const twin = store._folderRows(store.identity.id).find((r) => r.id !== f.id && r.parentId === parentId && r.name.toLowerCase() === f.name.toLowerCase());
          if (twin && (result.folderAliases ?? []).some((a) => a.from === twin.id && a.to === f.id)) {
            store._save("folder", store._next(store._raw("folder", twin.id), { deletedAt: new Date().toISOString() }));
          } else if (twin) {
            // Preserve an unsent local folder instead of overwriting it. Give it a
            // distinct name; it will be sent on the next round.
            store._save("folder", store._next(store._raw("folder", twin.id), { name: `${twin.name.slice(0, 170)} (local ${twin.id.slice(0, 6)})` }));
          }
          if (!old) { store._save("folder", { ...store._new(domain.folder({ name: f.name, parentId }, null)), id: f.id }); changed = true; }
          else if (old.name !== f.name || old.parentId !== parentId || old.deletedAt) {
            store._save("folder", store._next(old, { name: f.name, parentId, deletedAt: null })); changed = true;
          }
        }
        state.markFolderSent(f.id, hash(payload), f.version);
        pending.splice(i, 1);
      }
    }
    for (const { from, to } of result.folderAliases ?? []) {
      if (!store._raw("folder", to)) continue;
      for (const f of store._folderRows(store.identity.id).filter((f) => f.parentId === from)) store._save("folder", store._next(store._raw("folder", f.id), { parentId: to }));
      for (const { id } of store._db.prepare("SELECT id FROM notes WHERE deleted_at IS NULL AND json_extract(data_json, '$.folderId') = ?").all(from)) {
        const n = store._raw("note", id); store._save("note", store._next(n, { folderId: to }));
      }
      const old = store._raw("folder", from);
      if (old && !old.deletedAt) store._save("folder", store._next(old, { deletedAt: new Date().toISOString() }));
      state.forgetFolderSent(from); changed = true;
    }
    const visible = new Set(pull.visibleFolderIds);
    for (const id of state.sentFolderIds()) if (!visible.has(id)) {
      const old = store._raw("folder", id);
      if (old && !old.deletedAt) {
        // Remote deletion must not discard a page or leave it pointing at a dead folder.
        const parentId = old.parentId && store._raw("folder", old.parentId)?.deletedAt ? null : old.parentId;
        for (const { id: noteId } of store._db.prepare("SELECT id FROM notes WHERE deleted_at IS NULL AND json_extract(data_json, '$.folderId') = ?").all(id)) {
          const n = store._raw("note", noteId); store._save("note", store._next(n, { folderId: parentId }));
        }
        store._save("folder", store._next(old, { deletedAt: new Date().toISOString() })); changed = true;
      }
      state.forgetFolderSent(id);
    }
  })();
  return changed;
}

function decorate(store, state, listing) {
  prepare(store, state);
  const roots = new Set(state.roots().map((r) => r.folderId));
  const spaces = new Map(state.spaces().map((s) => [s.id, s]));
  return { ...listing, team: true, items: listing.items.map((f) => {
    const loc = location(store, state, f.id);
    const homeName = loc.spaceId === SHARED ? "Shared with you" : spaces.get(loc.spaceId)?.name ?? "My notes";
    return { ...f, teamRoot: roots.has(f.id), spaceId: loc.spaceId, homeName, writable: spaces.get(loc.spaceId)?.role === "editor" };
  }) };
}

function guard(store, state, kind, id, target) {
  const roots = new Set(state.roots().map((r) => r.folderId));
  if (kind === "folder" && roots.has(id)) throw fail("Team sections are managed in People & teams on the web.");
  const record = id ? store._raw(kind, id) : null;
  const before = location(store, state, kind === "folder" ? id : record?.folderId);
  const after = location(store, state, target);
  const space = state.spaces().find((s) => s.id === after.spaceId);
  if (!space || space.role !== "editor") throw fail("Sync your teams before filing pages here. You need permission to add pages to this team.");
  if (record?.kind === "daily" && after.spaceId !== state.privateSpaceId()) throw fail("Daily notes stay in My notes.");
  if (kind === "folder" && before.spaceId !== state.privateSpaceId() && after.spaceId === state.privateSpaceId()) throw fail("A shared team folder cannot move into My notes.");
  return before.spaceId === after.spaceId ? null : {
    name: record?.title || record?.name || "this page", home: space.kind === "private" ? "My notes" : space.name,
    private: space.kind === "private", folder: kind === "folder",
  };
}

module.exports = { prepare, sharedRoot, SHARED, location, folderPayload, plan, apply, decorate, guard, hash };
