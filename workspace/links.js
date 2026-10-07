"use strict";
// Wiki-style links between notes, written as [[Target]] in a note's text.
//
// Links are parsed from the note on every save and kept in a derived table, so
// "what points at this?" is a query rather than a scan, and a note can link to
// something that does not exist yet — the link stays unresolved until a note with
// that title appears, which is how a vault grows.
//
// A target resolves against note titles first, then the people the workspace
// already knows, so [[Priya]] in a note joins the same ledger as a spoken promise.
const v = require("./validation");

// [[Target]] or [[Target|shown text]]. Targets cannot contain brackets or newlines.
const LINK = /\[\[([^\[\]\n|]{1,200})(?:\|([^\[\]\n]{0,200}))?\]\]/g;
const normalize = (label) => label.trim().replace(/\s+/g, " ");
const key = (label) => normalize(label).toLowerCase();

// Every [[...]] in a TipTap document, in reading order, without duplicates.
function parse(content) {
  const found = new Map();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string")
      for (const match of node.text.matchAll(LINK)) {
        const label = normalize(match[1]);
        if (label && !found.has(key(label))) found.set(key(label), label);
      }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };
  walk(content);
  return [...found.values()];
}

// Links written as plain markdown, for imported or exported text.
function parseText(text) {
  const found = new Map();
  for (const match of String(text ?? "").matchAll(LINK)) {
    const label = normalize(match[1]);
    if (label && !found.has(key(label))) found.set(key(label), label);
  }
  return [...found.values()];
}

function resolve(store, workspaceId, label) {
  const note = store._db
    .prepare(
      `SELECT id FROM notes WHERE workspace_id=? AND deleted_at IS NULL
       AND lower(trim(json_extract(data_json,'$.title')))=? LIMIT 1`,
    )
    .get(workspaceId, key(label));
  if (note) return { kind: "note", id: note.id };
  const people = require("./people");
  const person = people.list(store, workspaceId).items.find((item) => key(item.name) === key(label));
  return person ? { kind: "person", id: person.id } : { kind: "note", id: null };
}

// What a half-typed [[ could mean. Pages first when they match as well as a
// person does, because a page is the thing a link most often names; an empty
// query offers what was touched most recently rather than nothing at all.
const SUGGEST_LIMIT = 8;
function suggest(store, workspaceId, query, limit = SUGGEST_LIMIT) {
  store.getWorkspace({ workspaceId });
  const wanted = key(query ?? "");
  const rank = (label) => {
    const candidate = key(label);
    if (!wanted) return 1;
    if (candidate.startsWith(wanted)) return 0;
    return candidate.includes(wanted) ? 1 : -1;
  };
  const notes = store._db
    .prepare(
      `SELECT id, json_extract(data_json,'$.title') AS title, updated_at FROM notes
       WHERE workspace_id=? AND deleted_at IS NULL AND title IS NOT NULL AND trim(title) <> ''
       ORDER BY updated_at DESC LIMIT 400`,
    )
    .all(workspaceId)
    .map((row, order) => ({ kind: "note", id: row.id, label: row.title, order }));
  const people = require("./people")
    .list(store, workspaceId)
    .items.map((person, order) => ({
      kind: "person",
      id: person.id,
      label: person.name,
      order,
      open: person.theyOwe + person.youOwe,
    }));
  const take = Math.max(1, Math.min(limit, 20));
  const shown = ({ kind, id, label, open }) => ({
    kind,
    id,
    label,
    ...(kind === "person" ? { open } : {}),
  });
  // Nothing typed yet: the pages just touched, and the people with something
  // outstanding — not one list crowding out the other.
  if (!wanted) {
    const share = Math.max(1, Math.floor(take / 3));
    const chosen = [
      ...notes.slice(0, take - Math.min(share, people.length)),
      ...people.slice(0, share),
    ];
    return chosen.slice(0, take).map(shown);
  }
  return [...notes, ...people]
    .map((item) => ({ ...item, score: rank(item.label) }))
    .filter((item) => item.score >= 0)
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.label.length - b.label.length ||
        a.order - b.order ||
        a.label.localeCompare(b.label),
    )
    .slice(0, take)
    .map(shown);
}

// Links other notes wrote at this one by name. A page that appears later claims the
// links already pointing at its title, and a page moved to the trash releases them,
// so "create this page" never offers to create a page that already exists.
function repair(store, note) {
  const workspaceId = note.workspaceId;
  if (note.deletedAt) {
    store._db
      .prepare("UPDATE note_links SET target_id=NULL WHERE workspace_id=? AND target_kind='note' AND target_id=?")
      .run(workspaceId, note.id);
    return;
  }
  if (!note.title.trim()) return;
  store._db
    .prepare(
      `UPDATE note_links SET target_id=?
       WHERE workspace_id=? AND target_kind='note' AND target_id IS NULL AND target_key=?`,
    )
    .run(note.id, workspaceId, key(note.title));
}

// Rewrites one note's outgoing links. Called from the store whenever a note is saved.
function index(store, note) {
  const workspaceId = note.workspaceId;
  repair(store, note);
  store._db.prepare("DELETE FROM note_links WHERE workspace_id=? AND note_id=?").run(workspaceId, note.id);
  if (note.deletedAt) return;
  const insert = store._db.prepare(
    `INSERT OR IGNORE INTO note_links(workspace_id, note_id, target_key, target_label, target_kind, target_id)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const label of parse(note.content)) {
    const target = resolve(store, workspaceId, label);
    insert.run(workspaceId, note.id, key(label), label, target.kind, target.id);
  }
}

// A note's links out, and everything pointing back at it. Unresolved targets are
// reported so the user can see what a link would create.
function forNote(store, workspaceId, id) {
  v.uuid(id);
  const note = store.get({ workspaceId }, "note", id);
  const outgoing = store._db
    .prepare("SELECT target_label, target_kind, target_id FROM note_links WHERE workspace_id=? AND note_id=? ORDER BY target_label")
    .all(workspaceId, id)
    .map((row) => ({
      label: row.target_label,
      kind: row.target_kind,
      id: row.target_id,
      resolved: !!row.target_id,
    }));
  const rows = store._db
    .prepare(
      `SELECT note_id FROM note_links
       WHERE workspace_id=? AND ((target_kind='note' AND target_id=?) OR (target_kind='note' AND target_id IS NULL AND target_key=?))`,
    )
    .all(workspaceId, id, key(note.title));
  const backlinks = [];
  for (const row of new Set(rows.map((row) => row.note_id))) {
    try {
      const source = store.get({ workspaceId }, "note", row);
      backlinks.push({ id: source.id, title: source.title, kind: source.kind, updatedAt: source.updatedAt });
    } catch {
      // A deleted note keeps no backlink.
    }
  }
  backlinks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { outgoing, backlinks };
}

module.exports = { parse, parseText, index, repair, forNote, resolve, suggest, normalize, key, LINK };
