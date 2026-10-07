"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createWorkspace, openWorkspace } = require("./index");
const files = require("./files");
const v = require("./validation");
const { check } = require("./errors");

// The renderer receives workspace IDs only. Locations remain owned by main.
class WorkspaceCatalog {
  constructor(root, { busy = () => false } = {}) {
    this.root = root;
    this.busy = busy;
    this.store = null;
    this.entries = [];
    this.sequence = 0;
    this.pending = 0;
    this.tail = Promise.resolve();
  }

  serialize(operation) {
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return result;
  }

  async initialize() {
    files.privateDirectory(this.root);
    this.file = path.join(this.root, "catalog.json");
    if (!files.inspect(this.file)) {
      // Recover an interrupted first creation instead of replacing its files.
      const directories = fs
        .readdirSync(this.root)
        .filter((entry) => /^workspace-[0-9a-f-]{36}$/.test(entry));
      for (const directory of directories) {
        const store = await openWorkspace({
          directory: path.join(this.root, directory),
        });
        try {
          this.entries.push({
            id: store.identity.id,
            directory,
            name: store.getWorkspace({ workspaceId: store.identity.id }).name,
          });
        } finally {
          store.close();
        }
      }
      if (!this.entries.length) return this.create({ name: "My workspace" });
      this.activeId = this.entries[0].id;
      this.persist();
    } else {
      check(
        fs.statSync(this.file).size <= 65536,
        "INVALID_WORKSPACE",
        "Workspace catalog is too large",
      );
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      v.object(data, ["version", "activeId", "entries"]);
      check(
        data.version === 1 &&
          Array.isArray(data.entries) &&
          data.entries.length > 0 &&
          data.entries.length <= 100,
        "INVALID_WORKSPACE",
        "Invalid workspace catalog",
      );
      this.activeId = v.uuid(data.activeId);
      this.entries = data.entries.map((entry) => {
        v.object(entry, ["id", "directory", "name"]);
        v.uuid(entry.id);
        v.text(entry.name, "name", 200);
        check(
          /^workspace-[0-9a-f-]{36}$/.test(entry.directory),
          "INVALID_WORKSPACE",
          "Invalid workspace location",
        );
        return entry;
      });
      check(
        new Set(this.entries.map((entry) => entry.id)).size ===
          this.entries.length,
        "INVALID_WORKSPACE",
        "Duplicate workspace identity",
      );
    }
    return this.open({ workspaceId: this.activeId });
  }

  persist() {
    files.atomicJson(this.file, {
      version: 1,
      activeId: this.activeId,
      entries: this.entries,
    });
  }
  list() {
    return this.entries.map(({ id, name }) => ({ id, name }));
  }
  active() {
    check(this.store, "WORKSPACE_CLOSED", "No workspace is open");
    const { location, ...value } = this.store.getWorkspace({
      workspaceId: this.store.identity.id,
    });
    return value;
  }
  scoped(workspaceId) {
    v.uuid(workspaceId);
    check(
      this.store?.identity.id === workspaceId,
      "SCOPE_MISMATCH",
      "The selected workspace changed. Reload and try again.",
    );
    return this.store;
  }
  async create(input) {
    v.object(input, ["name"]);
    const name = v.text(input.name, "workspace name", 200).trim();
    check(
      !this.busy(),
      "WORKSPACE_BUSY",
      "Finish the active recording before switching workspaces.",
    );
    check(
      this.entries.length < 100,
      "LIMIT_REACHED",
      "Workspace limit reached",
    );
    const directory = `workspace-${randomUUID()}`;
    const next = await createWorkspace({
      directory: path.join(this.root, directory),
      name,
    });
    const previous = { entries: this.entries, activeId: this.activeId };
    this.entries = [...this.entries, { id: next.identity.id, directory, name }];
    this.activeId = next.identity.id;
    try {
      this.persist();
    } catch (error) {
      Object.assign(this, previous);
      next.close();
      throw error;
    }
    this.store?.close();
    this.store = next;
    this.sequence++;
    return this.active();
  }
  async open(input) {
    v.object(input, ["workspaceId"]);
    v.uuid(input.workspaceId);
    if (this.store?.identity.id === input.workspaceId) return this.active();
    check(
      !this.busy(),
      "WORKSPACE_BUSY",
      "Finish the active recording before switching workspaces.",
    );
    const entry = this.entries.find((item) => item.id === input.workspaceId);
    check(entry, "NOT_FOUND", "Workspace is not registered");
    const next = await openWorkspace({
      directory: path.join(this.root, entry.directory),
    });
    const oldId = this.activeId;
    try {
      check(
        next.identity.id === entry.id,
        "INVALID_WORKSPACE",
        "Workspace identity changed",
      );
      this.activeId = entry.id;
      this.persist();
    } catch (error) {
      this.activeId = oldId;
      next.close();
      throw error;
    }
    this.store?.close();
    this.store = next;
    this.sequence++;
    return this.active();
  }
  update(ctx, input) {
    const store = this.scoped(ctx.workspaceId);
    store.updateWorkspace(ctx, input);
    // SQLite is canonical; a catalog-label failure must not negate its durable ack.
    const value = this.active();
    this.entries.find((entry) => entry.id === value.id).name = value.name;
    try {
      this.persist();
    } catch {
      /* The active label is rebuilt from SQLite on open. */
    }
    this.sequence++;
    return value;
  }
  async close() {
    await this.tail;
    this.store?.close();
    this.store = null;
  }
}

module.exports = { WorkspaceCatalog };
