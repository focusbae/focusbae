"use strict";
// People are derived from what the workspace already knows: action owners with a
// name and speakers the user named. For each person:
//   they owe you  - open actions owned by that person
//   you owe them  - your open actions from a recording where they were a named
//                   speaker, or whose text names them
//   to review     - suggestions owned by or involving them
// Unnamed detected speakers ("Speaker 2 · Mac audio") are not people until named.
const { createHash } = require("node:crypto");
const v = require("./validation");
const { check } = require("./errors");
const { publicAction } = require("./actions");

const OPEN = new Set(["accepted", "deferred"]);
const SPEAKER_LABEL = /^Speaker \d+ · /;

function uuidFrom(key) {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const normalizeName = (name) => name.trim().replace(/\s+/g, " ").toLowerCase();
// Stable id for a named person, shared by every recording in the workspace.
const personId = (name) => uuidFrom(`person:${normalizeName(name)}`);

function rows(store, workspaceId, table) {
  return store._db
    .prepare(`SELECT id, data_json, updated_at FROM ${table} WHERE workspace_id=? AND deleted_at IS NULL`)
    .all(workspaceId)
    .map((row) => ({ id: row.id, updatedAt: row.updated_at, ...JSON.parse(row.data_json) }));
}

function viewFor(action) {
  if (action.status === "proposed") return "review";
  if (action.status === "done") return "completed";
  if (action.status === "dropped") return "archived";
  return action.owner.kind === "self" ? "mine" : action.owner.kind === "person" ? "waiting" : "unassigned";
}

function mentions(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function collect(store, workspaceId) {
  store.getWorkspace({ workspaceId });
  const recordings = new Set(rows(store, workspaceId, "recordings").map((row) => row.id));
  const segmentRecording = new Map(
    store._db
      .prepare(
        "SELECT id, recording_id FROM transcript_segments WHERE workspace_id=? AND deleted_at IS NULL",
      )
      .all(workspaceId)
      .filter((row) => recordings.has(row.recording_id))
      .map((row) => [row.id, row.recording_id]),
  );
  const people = new Map();
  const person = (name, at) => {
    const key = normalizeName(name);
    if (!people.has(key))
      people.set(key, { id: personId(name), name: name.trim(), actions: new Map(), recordings: new Set(), lastActivity: at });
    const entry = people.get(key);
    if (at > entry.lastActivity) entry.lastActivity = at;
    return entry;
  };
  const namedIn = new Map();
  for (const speaker of rows(store, workspaceId, "speakers")) {
    if (speaker.identity?.kind !== "person" || !recordings.has(speaker.recordingId)) continue;
    const entry = person(speaker.identity.label, speaker.updatedAt);
    entry.recordings.add(speaker.recordingId);
    if (!namedIn.has(speaker.recordingId)) namedIn.set(speaker.recordingId, new Set());
    namedIn.get(speaker.recordingId).add(normalizeName(speaker.identity.label));
  }
  const actions = rows(store, workspaceId, "actions");
  for (const action of actions)
    if (action.owner.kind === "person" && action.ownerLabel && !SPEAKER_LABEL.test(action.ownerLabel))
      person(action.ownerLabel, action.updatedAt);
  for (const action of actions) {
    const recordingId = segmentRecording.get(action.evidence?.[0]?.segmentId) ?? null;
    if (action.owner.kind === "person" && action.ownerLabel && !SPEAKER_LABEL.test(action.ownerLabel)) {
      const entry = person(action.ownerLabel, action.updatedAt);
      entry.actions.set(action.id, { action, direction: "theyOwe", recordingId });
      if (recordingId) entry.recordings.add(recordingId);
      continue;
    }
    if (action.owner.kind !== "self" && action.status !== "proposed") continue;
    for (const [key, entry] of people) {
      // Your own work is linked by a shared recording or a mention; someone else's
      // suggestion only by naming this person.
      const involved =
        (action.owner.kind === "self" && recordingId && namedIn.get(recordingId)?.has(key)) ||
        mentions(action.title, entry.name);
      if (!involved) continue;
      entry.actions.set(action.id, { action, direction: action.owner.kind === "self" ? "youOwe" : "involves", recordingId });
      if (action.updatedAt > entry.lastActivity) entry.lastActivity = action.updatedAt;
    }
  }
  return people;
}

function summary(entry) {
  let theyOwe = 0, youOwe = 0, review = 0, done = 0;
  for (const { action, direction } of entry.actions.values()) {
    if (action.status === "proposed") review++;
    else if (action.status === "done") done++;
    else if (OPEN.has(action.status)) {
      if (direction === "theyOwe") theyOwe++;
      if (direction === "youOwe") youOwe++;
    }
  }
  return { id: entry.id, name: entry.name, theyOwe, youOwe, review, done, recordings: entry.recordings.size, lastActivity: entry.lastActivity };
}

function list(store, workspaceId) {
  const items = [...collect(store, workspaceId).values()].map(summary);
  items.sort(
    (a, b) =>
      b.theyOwe + b.youOwe + b.review - (a.theyOwe + a.youOwe + a.review) ||
      b.lastActivity.localeCompare(a.lastActivity) ||
      a.name.localeCompare(b.name),
  );
  return { items, total: items.length };
}

function get(store, workspaceId, id) {
  v.uuid(id);
  const entry = [...collect(store, workspaceId).values()].find((item) => item.id === id);
  check(entry, "NOT_FOUND", "Person not found");
  const { chain } = require("./restatements");
  const names = new Map();
  const recordingTitle = (recordingId) => {
    if (!recordingId) return null;
    if (!names.has(recordingId)) {
      let title = null;
      try { title = store.get({ workspaceId }, "recording", recordingId).title || null; } catch {}
      names.set(recordingId, title);
    }
    return names.get(recordingId);
  };
  const item = ({ action, direction, recordingId }) => {
    const promised = OPEN.has(action.status) ? chain(store, workspaceId, action.id).count : 1;
    return {
      ...publicAction({ ...action, workspaceId }),
      direction,
      view: viewFor(action),
      quote: action.evidence?.[0]?.quote?.slice(0, 600) ?? null,
      recordingId,
      recordingTitle: recordingTitle(recordingId),
      promised,
    };
  };
  const sorted = [...entry.actions.values()].sort((a, b) => {
    const due = (x) => x.action.dueDate ?? x.action.dueAt ?? "9999";
    return due(a).localeCompare(due(b)) || b.action.updatedAt.localeCompare(a.action.updatedAt);
  });
  const pick = (test) => sorted.filter(test).map(item);
  return {
    person: summary(entry),
    theyOwe: pick(({ action, direction }) => direction === "theyOwe" && OPEN.has(action.status)),
    youOwe: pick(({ action, direction }) => direction === "youOwe" && OPEN.has(action.status)),
    review: pick(({ action }) => action.status === "proposed"),
    done: pick(({ action }) => action.status === "done").slice(0, 20),
  };
}

// What you already owed these people before a given recording, and what they owed
// you: the "what did I promise you last time" question, answerable without a
// calendar or network. Items whose evidence comes from this recording are excluded,
// so a conversation does not simply echo itself back.
function priorContext(store, workspaceId, recordingId) {
  v.uuid(recordingId);
  const segments = new Set(
    store._db
      .prepare("SELECT id FROM transcript_segments WHERE workspace_id=? AND recording_id=?")
      .all(workspaceId, recordingId)
      .map((row) => row.id),
  );
  const named = new Set(
    rows(store, workspaceId, "speakers")
      .filter((speaker) => speaker.recordingId === recordingId && speaker.identity?.kind === "person")
      .map((speaker) => normalizeName(speaker.identity.label)),
  );
  const items = [];
  for (const [key, entry] of collect(store, workspaceId)) {
    if (!named.has(key)) continue;
    const open = [...entry.actions.values()].filter(
      ({ action, direction }) =>
        OPEN.has(action.status) &&
        ["theyOwe", "youOwe"].includes(direction) &&
        !segments.has(action.evidence?.[0]?.segmentId),
    );
    if (!open.length) continue;
    const count = (direction) => open.filter((item) => item.direction === direction).length;
    items.push({
      id: entry.id,
      name: entry.name,
      theyOwe: count("theyOwe"),
      youOwe: count("youOwe"),
      items: open
        .sort((a, b) => (a.action.dueDate ?? "9999").localeCompare(b.action.dueDate ?? "9999"))
        .slice(0, 3)
        .map(({ action, direction }) => ({
          id: action.id,
          title: action.title,
          direction,
          view: viewFor(action),
          dueDate: action.dueDate,
          promised: require("./restatements").chain(store, workspaceId, action.id).count,
        })),
    });
  }
  items.sort((a, b) => b.theyOwe + b.youOwe - (a.theyOwe + a.youOwe) || a.name.localeCompare(b.name));
  return { items };
}

module.exports = { list, get, priorContext, personId, viewFor, normalizeName };
