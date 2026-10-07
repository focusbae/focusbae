"use strict";
const { check } = require("./errors");
const v = require("./validation");
const VIEWS = [
  "review",
  "mine",
  "waiting",
  "unassigned",
  "completed",
  "archived",
];
function publicAction(action) {
  return {
    id: action.id,
    workspaceId: action.workspaceId,
    revision: action.revision,
    title: action.title,
    status: action.status,
    owner: action.owner,
    ownerLabel: action.ownerLabel ?? null,
    dueDate: action.dueDate,
    dueAt: action.dueAt,
    dueTimezone: action.dueTimezone,
    priority: action.priority,
    origin: action.origin,
    restatementOf: action.restatementOf ?? null,
    acceptedAt: action.acceptedAt,
    completedAt: action.completedAt,
    sourceState: action.sourceState,
    evidenceCount: action.evidence.length,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}
function browse(store, workspaceId, options = {}) {
  v.object(options, ["view", "offset", "limit"]);
  const view = v.choice(options.view ?? "mine", VIEWS, "action view");
  const offset = v.integer(options.offset ?? 0, "offset");
  const limit = v.integer(options.limit ?? 50, "limit", 1, 100);
  store.getWorkspace({ workspaceId });
  const clauses = {
    review: "status='proposed'",
    mine: "status IN ('accepted','deferred') AND owner_kind='self'",
    waiting: "status IN ('accepted','deferred') AND owner_kind='person'",
    unassigned: "status IN ('accepted','deferred') AND owner_kind='unknown'",
    completed: "status='done'",
    archived: "status='dropped'",
  };
  const base = "workspace_id=? AND deleted_at IS NULL AND ";
  const counts = Object.fromEntries(
    VIEWS.map((name) => [
      name,
      store._db
        .prepare(
          `SELECT count(*) AS total FROM actions WHERE ${base}${clauses[name]}`,
        )
        .get(workspaceId).total,
    ]),
  );
  const ids = store._db
    .prepare(
      `SELECT id FROM actions WHERE ${base}${clauses[view]} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
    )
    .all(workspaceId, limit, offset);
  return {
    items: ids.map(({ id }) =>
      publicAction(store.get({ workspaceId }, "action", id)),
    ),
    total: counts[view],
    counts,
  };
}
function detail(store, workspaceId, id) {
  const action = store.get({ workspaceId }, "action", id);
  const evidence = action.evidence.map((entry) => {
    // A commitment quoted from a page you wrote stands on its own; one quoted from
    // a conversation is only reachable while that recording is too.
    const written = entry.sourceKind === "note";
    let source, recording;
    try {
      source = store.get({ workspaceId }, written ? "note" : "transcript", entry.segmentId, {
        includeDeleted: true,
      });
    } catch {}
    try {
      if (source && !written)
        recording = store.get(
          { workspaceId },
          "recording",
          source.recordingId,
          { includeDeleted: true },
        );
    } catch {}
    return {
      ...entry,
      quote: entry.quote.slice(0, 4000),
      truncated: entry.quote.length > 4000,
      noteId: written ? (source?.id ?? entry.segmentId) : null,
      noteTitle: written ? (source?.title ?? null) : null,
      recordingId: written ? null : (source?.recordingId ?? null),
      recordingTitle: written ? null : (recording?.title || null),
      segmentStartMs: written ? null : (source?.startMs ?? null),
      source: written ? null : (source?.source ?? null),
      available:
        !!source &&
        !source.deletedAt &&
        (written || (!!recording && !recording.deletedAt)),
      current: !!source && source.revision === entry.revision,
    };
  });
  // How many times this was promised. One means once, so callers show nothing.
  const restatements = require("./restatements").chain(store, workspaceId, id);
  return { action: publicAction(action), evidence, restatements };
}
function actionInput(input, update = false) {
  v.object(input, ["title", "owner", "ownerLabel", "dueDate", "priority"]);
  const result = {};
  if (!update || Object.hasOwn(input, "title"))
    result.title = v.text(input.title, "action title", 1000);
  if (!update || Object.hasOwn(input, "owner")) {
    v.object(input.owner, ["kind", "id"], "owner");
    result.owner = {
      kind: v.choice(
        input.owner.kind,
        ["self", "person", "unknown"],
        "owner kind",
      ),
      id: input.owner.id == null ? null : v.uuid(input.owner.id),
    };
  }
  if (Object.hasOwn(input, "ownerLabel"))
    result.ownerLabel =
      input.ownerLabel == null
        ? null
        : v.text(input.ownerLabel, "owner label", 200);
  if (Object.hasOwn(input, "dueDate"))
    result.dueDate =
      input.dueDate == null ? null : v.date(input.dueDate, "due date");
  if (!update || Object.hasOwn(input, "priority"))
    result.priority = v.choice(
      input.priority ?? "medium",
      ["low", "medium", "high", "urgent"],
      "priority",
    );
  check(!update || Object.keys(result).length > 0, "INVALID_INPUT", "No action changes supplied");
  return result;
}
module.exports = { VIEWS, publicAction, browse, detail, actionInput };
