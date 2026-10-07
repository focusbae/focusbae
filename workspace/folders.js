'use strict';

const v = require('./validation');
const { check } = require('./errors');
const domain = require('./domain');

const MAX_DEPTH = 8;
const MAX_FOLDERS = 500;

function publicFolder(folder, counts = {}) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    revision: folder.revision,
    notes: counts.notes ?? 0,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

// The path is derived, never stored: renaming one folder must not rewrite the
// rows beneath it, and a stored path is the thing that goes stale.
function pathOf(byId, id) {
  const names = [];
  for (let current = byId.get(id), depth = 0; current && depth <= MAX_DEPTH; current = byId.get(current.parentId), depth += 1)
    names.unshift(current.name);
  return names.join(' / ');
}

const methods = {
  _folderRows(workspaceId) {
    return this._db.prepare('SELECT * FROM folders WHERE workspace_id=? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE, id')
      .all(workspaceId).map((row) => ({ ...JSON.parse(row.data_json), id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }));
  },

  // Guards the two ways a tree stops being a tree: a folder inside itself, and a
  // chain too deep to show or reason about. Returns the level the new or moved
  // folder would sit at, where a top-level folder is level 1.
  _folderLevel(rows, parentId, movingId = null) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    let level = 1;
    for (let current = parentId; current; level += 1) {
      const parent = byId.get(current);
      check(parent, 'NOT_FOUND', 'Parent folder does not exist');
      check(parent.id !== movingId, 'INVALID_INPUT', 'A folder cannot be moved inside itself');
      check(level <= MAX_DEPTH, 'LIMIT_REACHED', `Folders can be nested ${MAX_DEPTH} deep`);
      current = parent.parentId;
    }
    check(level <= MAX_DEPTH, 'LIMIT_REACHED', `Folders can be nested ${MAX_DEPTH} deep`);
    return level;
  },

  // The database index is the backstop; this exists so the person reads a
  // sentence instead of "violates workspace integrity".
  _folderNameFree(rows, name, parentId, exceptId = null) {
    check(!rows.some((row) => row.id !== exceptId && (row.parentId ?? null) === (parentId ?? null) &&
      row.name.toLowerCase() === name.toLowerCase()),
      'ALREADY_EXISTS', 'A folder with this name is already here');
  },

  folderList(ctx) {
    this._scope(ctx);
    const rows = this._folderRows(ctx.workspaceId);
    const counts = new Map(this._db.prepare(
      `SELECT json_extract(data_json, '$.folderId') AS folderId, count(*) AS notes FROM notes
       WHERE workspace_id=? AND deleted_at IS NULL AND folderId IS NOT NULL GROUP BY folderId`,
    ).all(ctx.workspaceId).map((row) => [row.folderId, row.notes]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const unfiled = this._db.prepare(
      `SELECT count(*) AS count FROM notes WHERE workspace_id=? AND deleted_at IS NULL
       AND json_extract(data_json, '$.folderId') IS NULL`,
    ).get(ctx.workspaceId).count;
    return {
      unfiled,
      items: rows
        .map((row) => ({ ...publicFolder(row, { notes: counts.get(row.id) ?? 0 }), path: pathOf(byId, row.id) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  },

  createFolder(ctx, input) {
    v.object(input, ['name', 'parentId'], 'folder');
    return this._mutate(ctx, 'folder.create', input, () => {
      const rows = this._folderRows(ctx.workspaceId);
      check(rows.length < MAX_FOLDERS, 'LIMIT_REACHED', `A workspace holds up to ${MAX_FOLDERS} folders`);
      const data = domain.folder(input, null);
      if (data.parentId) this._folderLevel(rows, data.parentId);
      this._folderNameFree(rows, data.name, data.parentId);
      return publicFolder(this._save('folder', this._new(data)));
    });
  },

  updateFolder(ctx, id, input) {
    v.object(input, ['name', 'parentId'], 'folder');
    return this._mutate(ctx, 'folder.update', { id, input }, () => {
      const old = this._live('folder', id);
      check(old, 'NOT_FOUND', 'Folder does not exist');
      this._expected(ctx, old);
      const data = domain.folder(input, old);
      const rows = this._folderRows(ctx.workspaceId);
      if (data.parentId) {
        check(data.parentId !== id, 'INVALID_INPUT', 'A folder cannot be moved inside itself');
        const level = this._folderLevel(rows, data.parentId, id);
        // Moving a folder carries its subtree, so the deepest child must still fit.
        const byParent = new Map();
        for (const row of rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
        const descend = (parent, depth) => {
          check(depth <= MAX_DEPTH, 'LIMIT_REACHED', `Folders can be nested ${MAX_DEPTH} deep`);
          for (const child of byParent.get(parent) ?? []) descend(child.id, depth + 1);
        };
        descend(id, level);
      }
      this._folderNameFree(rows, data.name, data.parentId, id);
      return publicFolder(this._save('folder', this._next(old, data)));
    });
  },

  // Deleting a folder never deletes writing: its notes and subfolders move up to
  // the parent. Losing a note because a container was tidied away would be the
  // worst failure this app could have.
  deleteFolder(ctx, id) {
    return this._mutate(ctx, 'folder.delete', { id }, () => {
      const old = this._live('folder', id);
      check(old, 'NOT_FOUND', 'Folder does not exist');
      this._expected(ctx, old);
      const moved = { notes: 0, folders: 0 };
      for (const row of this._db.prepare('SELECT id FROM folders WHERE workspace_id=? AND parent_id=? AND deleted_at IS NULL').all(ctx.workspaceId, id)) {
        const child = this._live('folder', row.id);
        this._save('folder', this._next(child, { parentId: old.parentId }));
        moved.folders += 1;
      }
      for (const row of this._db.prepare(
        `SELECT id FROM notes WHERE workspace_id=? AND deleted_at IS NULL AND json_extract(data_json, '$.folderId')=?`,
      ).all(ctx.workspaceId, id)) {
        const note = this._live('note', row.id);
        this._save('note', this._next(note, { folderId: old.parentId }));
        moved.notes += 1;
      }
      this._save('folder', this._next(old, { deletedAt: new Date().toISOString() }));
      return { id, movedTo: old.parentId, ...moved };
    });
  },

  moveNote(ctx, id, folderId) {
    return this._mutate(ctx, 'note.move', { id, folderId }, () => {
      const note = this._live('note', id);
      check(note, 'NOT_FOUND', 'Note does not exist');
      this._expected(ctx, note);
      const target = folderId == null ? null : v.uuid(folderId, 'folder id');
      if (target) check(this._live('folder', target), 'NOT_FOUND', 'Folder does not exist');
      return require('./notebook').publicNote(this._save('note', this._next(note, { folderId: target })));
    });
  },
};

module.exports = { methods, publicFolder, pathOf, MAX_DEPTH, MAX_FOLDERS };
