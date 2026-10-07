"use strict";
const v = require("./validation");

function calendarDate(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}
function publicNote(note) {
  return {
    id: note.id,
    workspaceId: note.workspaceId,
    revision: note.revision,
    title: note.title,
    kind: note.kind,
    content: note.content,
    contentSchemaVersion: note.contentSchemaVersion,
    plainText: note.plainText,
    dailyDate: note.dailyDate,
    folderId: note.folderId ?? null,
    timezone: note.timezone,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    pinned: note.metadata?.pinned === true,
    importWarnings: note.metadata?.importWarnings ?? [],
    originalAttachmentId: note.metadata?.originalAttachmentId ?? null,
  };
}
const methods = {
  dailyNote(ctx, now = new Date()) {
    const timezone = this._timezone();
    const day = calendarDate(timezone, now);
    return this._mutate(ctx, "note.daily", { day }, () => {
      const row = this._db
        .prepare(
          "SELECT id FROM notes WHERE workspace_id=? AND daily_date=? AND deleted_at IS NULL AND note_kind='daily'",
        )
        .get(ctx.workspaceId, day);
      if (row) return this._live("note", row.id);
      const domain = require("./domain");
      return this._save(
        "note",
        this._new(
          domain.note(
            {
              kind: "daily",
              dailyDate: day,
              timezone,
              title: new Intl.DateTimeFormat("en", {
                timeZone: timezone,
                month: "long",
                day: "numeric",
                year: "numeric",
              }).format(now),
            },
            null,
            timezone,
          ),
        ),
      );
    });
  },
  notebookList(ctx, options = {}) {
    this._scope(ctx);
    v.object(options, ["view", "offset", "limit", "folderId"]);
    const view = v.choice(
      options.view ?? "all",
      ["all", "pinned", "trash"],
      "view",
    );
    const offset = v.integer(options.offset ?? 0, "offset");
    const limit = v.integer(options.limit ?? 50, "limit", 1, 100);
    // A folder is a filter on the same list, not a fourth view: pinned and trash
    // stay meaningful inside one.
    const folderId =
      options.folderId === undefined || options.folderId === null
        ? null
        : options.folderId === "unfiled"
          ? "unfiled"
          : v.uuid(options.folderId, "folder id");
    const params = [ctx.workspaceId];
    let where = `workspace_id=? AND deleted_at IS ${view === "trash" ? "NOT " : ""}NULL${view === "pinned" ? " AND json_extract(data_json, '$.metadata.pinned')=1" : ""}`;
    where += " AND json_extract(data_json, '$.metadata.purgedAt') IS NULL";
    if (folderId === "unfiled") where += " AND json_extract(data_json, '$.folderId') IS NULL";
    else if (folderId) {
      where += " AND json_extract(data_json, '$.folderId') = ?";
      params.push(folderId);
    }
    const total = this._db
      .prepare(`SELECT count(*) AS count FROM notes WHERE ${where}`)
      .get(...params).count;
    const items = this._db
      .prepare(
        `SELECT id, workspace_id AS workspaceId, revision, title, note_kind AS kind, substr(plain_text,1,160) AS preview,
      daily_date AS dailyDate, updated_at AS updatedAt, deleted_at AS deletedAt, coalesce(json_extract(data_json,'$.metadata.pinned'),0) AS pinned,
      json_extract(data_json,'$.folderId') AS folderId
      FROM notes WHERE ${where} ORDER BY pinned DESC, updated_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return {
      items: items.map((item) => ({ ...item, pinned: !!item.pinned })),
      total,
    };
  },
  editNote(ctx, id, changes) {
    v.object(changes, ["title", "content", "pinned"]);
    return this._update(ctx, "note", id, changes, (data, old) => {
      const input = { ...data };
      delete input.pinned;
      if (data.pinned !== undefined)
        input.metadata = {
          ...old.metadata,
          pinned: v.boolean(data.pinned, "pinned"),
        };
      return require("./domain").note(input, old, this._timezone());
    });
  },
  source(ctx, input) {
    v.object(input, ["kind", "id"]);
    v.choice(input.kind, ["note", "transcript", "action"], "source kind");
    const record = this.get(ctx, input.kind, input.id);
    if (input.kind === "note") return publicNote(record);
    return {
      id: record.id,
      kind: input.kind,
      title: record.title ?? "Transcript",
      text: record.text ?? record.title,
      ...(input.kind === "transcript"
        ? {
            recordingId: record.recordingId,
            startMs: record.startMs,
            endMs: record.endMs,
            source: record.source,
          }
        : { status: record.status }),
    };
  },
};
module.exports = { methods, publicNote, calendarDate };
