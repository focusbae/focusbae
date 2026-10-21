"use strict";
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { TeamState } = require("./state");
const sync = require("./sync");

const INTERVAL_MS = 60 * 1000;
const DEBOUNCE_MS = 2 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code });

// Team workspaces on this Mac. Only workspaces that have a team.sqlite beside them
// ever sync; Personal workspaces are never read by this service. Nothing here runs
// until a team account is connected, and the privacy policy is checked on every call.
class TeamService extends EventEmitter {
  constructor({ account, catalog, policy }) {
    super();
    this.account = account;
    this.catalog = catalog;
    this.policy = policy;
    this.timer = null;
    this.debounce = null;
    this.running = null;
    this.lastResult = null;
    account.on("change", () => {
      if (!account.status().connected) this.eraseCopies().catch(() => {});
      this.emit("change");
      this.#schedule();
    });
    policy.on("change", () => this.#schedule());
  }

  start() {
    // A Mac that quit while signed out, or before an erase finished, catches up now.
    if (!this.account.status().connected) this.eraseCopies().catch(() => {});
    this.#schedule();
  }

  // Signed out: teammates' pages, their files and the team ledger leave this Mac; the
  // person's own pages and folders stay. Signing in again brings the copies back
  // (TEAM_PLAN §6.8). Closed workspaces are opened just long enough to do it.
  eraseCopies() {
    return this.catalog.serialize(async () => {
      const { openWorkspace } = require("../workspace");
      for (const entry of this.catalog.entries) {
        const directory = this.#directory(entry);
        if (!TeamState.exists(directory)) continue;
        const state = new TeamState(directory);
        try {
          if (!state.mirroredIds().length && !state.binding().cursor) continue;
          const active = this.catalog.store?.identity.id === entry.id;
          const store = active ? this.catalog.store : await openWorkspace({ directory });
          try {
            store._db.transaction(() => { for (const id of state.mirroredIds()) store._dropMirror(id); })();
            state.forgetTeamCopies();
            require("../workspace/attachments").reconcile(store);
          } finally {
            if (!active) store.close();
          }
        } finally {
          state.close();
        }
      }
      this.emit("notes-changed");
    });
  }

  stop() {
    clearInterval(this.timer); clearTimeout(this.debounce);
    this.timer = null; this.debounce = null;
  }

  #schedule() {
    const active = this.policy.allows("team");
    if (active && !this.timer) this.timer = setInterval(() => this.syncNow().catch(() => {}), INTERVAL_MS);
    if (!active) this.stop();
    if (active) this.syncNow().catch(() => {});
  }

  // Called after local changes; batches bursts of edits into one sync.
  localChanged() {
    if (!this.policy.allows("team") || !this.#activeState(false)) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.syncNow().catch(() => {}), DEBOUNCE_MS);
  }

  #directory(entry) { return path.join(this.catalog.root, entry.directory); }

  // The team binding of each local workspace, by local workspace id.
  bindings() {
    const result = new Map();
    for (const entry of this.catalog.entries) {
      const directory = this.#directory(entry);
      if (!TeamState.exists(directory)) continue;
      const state = new TeamState(directory);
      try { result.set(entry.id, state.binding()); } finally { state.close(); }
    }
    return result;
  }

  #activeState(open = true) {
    const store = this.catalog.store;
    if (!store || !TeamState.exists(store._directory)) return null;
    return open ? new TeamState(store._directory) : true;
  }

  snapshot() {
    const bindings = this.bindings();
    return {
      available: true,
      account: this.account.status(),
      allowed: this.policy.allows("team"),
      strict: this.policy.strict,
      syncing: !!this.running,
      workspaces: [...bindings].map(([localId, b]) => ({
        localId, serverWorkspaceId: b.serverWorkspaceId, name: b.name, role: b.role, status: b.status,
        lastSyncedAt: b.lastSyncedAt, lastError: b.lastError, processingLevelMax: b.processingLevelMax,
      })),
    };
  }

  // Server workspaces this account belongs to, marked if already on this Mac.
  async remoteWorkspaces() {
    const userId = this.account.status().userId;
    if (!userId) throw fail("SIGNED_OUT", "Connect a team account first");
    const rows = await this.account.select(`workspace_members?select=role,workspaces(id,name)&user_id=eq.${encodeURIComponent(userId)}`);
    const here = new Set([...this.bindings().values()].map((b) => b.serverWorkspaceId));
    return rows.filter((row) => row.workspaces).map((row) => ({
      id: row.workspaces.id, name: row.workspaces.name, role: row.role, onThisMac: here.has(row.workspaces.id),
    }));
  }

  // Adds a server workspace to this Mac as a new local workspace and opens it.
  async join(serverWorkspaceId) {
    const remote = (await this.remoteWorkspaces()).find((w) => w.id === serverWorkspaceId);
    if (!remote) throw fail("NOT_FOUND", "You are not a member of that workspace");
    if (remote.onThisMac) throw fail("ALREADY_EXISTS", "That workspace is already on this Mac");
    const workspace = await this.catalog.serialize(async () => {
      const value = await this.catalog.create({ name: remote.name });
      TeamState.create(this.catalog.store._directory, {
        serverWorkspaceId, accountUserId: this.account.status().userId, name: remote.name, role: remote.role,
      }).close();
      return value;
    });
    this.emit("change");
    await this.syncNow().catch(() => {});
    return workspace;
  }

  // One round for the open workspace, if it is a team workspace bound to this account.
  syncNow() {
    if (this.running) return this.running;
    this.running = this.#syncOnce().finally(() => {
      this.running = null;
      this.emit("change");
    });
    this.emit("change");
    return this.running;
  }

  async #syncOnce() {
    if (!this.policy.allows("team")) return { skipped: "policy" };
    const store = this.catalog.store;
    if (!store) return { skipped: "closed" };
    const localId = store.identity.id;
    const directory = store._directory;
    if (!TeamState.exists(directory)) return { skipped: "personal" };
    const state = new TeamState(directory);
    try {
      const binding = state.binding();
      if (binding.status === "removed") return { skipped: "removed" };
      if (binding.accountUserId !== this.account.status().userId) return { skipped: "other-account" };
      const sameWorkspace = () => this.catalog.store?.identity.id === localId;
      const work = await this.catalog.serialize(async () => (sameWorkspace() ? sync.plan(this.catalog.store, state) : null));
      if (!work) return { skipped: "switched" };
      let result;
      try {
        result = await sync.exchange(this.account, state, work);
      } catch (error) {
        if (error.code !== "POLICY_DENIED") state.recordError(error.message);
        throw error;
      }
      const outcome = await this.catalog.serialize(async () => (sameWorkspace() ? sync.apply(this.catalog.store, state, result) : null));
      this.lastResult = outcome;
      if (outcome?.applied) this.emit("actions-changed");
      if (outcome?.notesChanged) this.emit("notes-changed");
      return outcome ?? { skipped: "switched" };
    } finally {
      state.close();
    }
  }

  // Who the team will see as owing an action and who it is owed to, with the directory
  // to choose from. Read inside the workspace queue so the action and state agree.
  mapping(actionId) {
    return this.catalog.serialize(async () => {
      const state = this.#activeState();
      if (!state) throw fail("NOT_FOUND", "This is not a team workspace");
      try {
        const store = this.catalog.store;
        const workspaceId = store.identity.id;
        const action = store.get({ workspaceId }, "action", actionId);
        const shared = sync.sharedPeople(store, workspaceId, action, state);
        const me = state.binding().mePersonId;
        const id = (who) => (who?.self ? me : who?.personId ?? null);
        return {
          people: state.people(),
          me,
          ownerPersonId: id(shared.owner),
          ownerName: shared.owner?.name ?? null,
          counterpartyPersonId: id(shared.counterparty),
          suggested: shared.suggested,
          chosen: shared.chosen,
        };
      } finally {
        state.close();
      }
    });
  }

  async setMapping(actionId, mapping) {
    await this.catalog.serialize(async () => {
      const state = this.#activeState();
      if (!state) throw fail("NOT_FOUND", "This is not a team workspace");
      try {
        const store = this.catalog.store;
        store.get({ workspaceId: store.identity.id }, "action", actionId);
        state.setMapping(actionId, mapping);
      } finally {
        state.close();
      }
    });
    this.localChanged();
    return this.mapping(actionId);
  }

  // Called inside the existing IPC workspace queue; never re-enters that queue.
  withFolders(store, fn) {
    if (!TeamState.exists(store._directory)) return null;
    const state = new TeamState(store._directory);
    try {
      if (state.binding().accountUserId !== this.account.status().userId || state.binding().status === "removed")
        throw fail("SIGNED_OUT", "Connect the account for this workspace before changing its folders.");
      require("./folders").prepare(store, state);
      return fn(state, require("./folders"));
    } finally { state.close(); }
  }
  folderList(store) {
    return this.withFolders(store, (state, folders) => folders.decorate(store, state, store.folderList({ workspaceId: store.identity.id })))
      ?? store.folderList({ workspaceId: store.identity.id });
  }
  previewMove(store, kind, id, target) {
    return this.withFolders(store, (state, folders) => folders.guard(store, state, kind, id, target));
  }

  // Which team a note on this Mac belongs to, and the teams it could move to.
  noteVisibility(noteId) {
    return this.catalog.serialize(async () => {
      const state = this.#activeState();
      if (!state) throw fail("NOT_FOUND", "This is not a team workspace");
      try {
        const store = this.catalog.store;
        store.get({ workspaceId: store.identity.id }, "note", noteId);
        const privateSpace = state.privateSpaceId();
        return {
          spaceId: require("./folders").location(store, state, store._raw("note", noteId)?.folderId).spaceId,
          privateSpaceId: privateSpace,
          options: state.spaces().filter((s) => s.role === "editor").map((s) => ({ id: s.id, kind: s.kind, name: s.name })),
          synced: !!state.noteSent(noteId),
        };
      } finally {
        state.close();
      }
    });
  }

  async setNoteVisibility(noteId, spaceId) {
    await this.catalog.serialize(async () => {
      const state = this.#activeState();
      if (!state) throw fail("NOT_FOUND", "This is not a team workspace");
      try {
        const store = this.catalog.store;
        store.get({ workspaceId: store.identity.id }, "note", noteId);
        state.setNoteSpace(noteId, spaceId);
      } finally {
        state.close();
      }
    });
    this.localChanged();
    return this.noteVisibility(noteId);
  }

  // People on the team ledger, with what is open on them there. This Mac's own shared
  // actions are left out: the People view already counts them from the local ledger.
  teamPeople() {
    const state = this.#activeState();
    if (!state) return null;
    try {
      const me = state.binding().mePersonId;
      const open = this.#teamOpen(state);
      return state.people().filter((p) => p.id !== me).map((p) => ({
        id: p.id, name: p.name, email: p.email, isMember: !!p.isMember,
        owes: open.filter((c) => c.owner_person_id === p.id).length,
        owed: open.filter((c) => c.counterparty_person_id === p.id && c.owner_person_id !== p.id).length,
      }));
    } finally {
      state.close();
    }
  }

  // Teammates' open promises involving one person, matched by name as [[links]] are.
  teamPerson(name) {
    const state = this.#activeState();
    if (!state) return null;
    try {
      const key = require("../workspace/links").key;
      const me = state.binding().mePersonId;
      const person = state.people().find((p) => p.id !== me && key(p.name) === key(name));
      if (!person) return null;
      const names = new Map(state.people().map((p) => [p.id, p.id === me ? "You" : p.name]));
      const open = this.#teamOpen(state);
      const view = (c) => ({
        id: c.id, title: c.title, status: c.status, dueDate: c.due_date, quote: c.quote, sourceTitle: c.source_title,
        owner: names.get(c.owner_person_id) ?? null, counterparty: names.get(c.counterparty_person_id) ?? null,
      });
      return {
        person: { id: person.id, name: person.name, email: person.email, isMember: !!person.isMember },
        owes: open.filter((c) => c.owner_person_id === person.id).map(view),
        owed: open.filter((c) => c.counterparty_person_id === person.id && c.owner_person_id !== person.id).map(view),
      };
    } finally {
      state.close();
    }
  }

  #teamOpen(state) {
    return state.commitments().filter((c) => ["accepted", "deferred"].includes(c.status) && !state.sent(c.id));
  }

  // The shared ledger of the open team workspace, for the Team view.
  ledger() {
    const state = this.#activeState();
    if (!state) return null;
    try {
      const people = new Map(state.people().map((p) => [p.id, p]));
      return {
        binding: state.binding(),
        spaces: state.spaces(),
        people: state.people(),
        commitments: state.commitments().map((c) => ({
          id: c.id, title: c.title, status: c.status, dueDate: c.due_date, quote: c.quote,
          sourceTitle: c.source_title, sourceKind: c.source_kind, spaceId: c.space_id, rights: c.rights,
          owner: people.get(c.owner_person_id)?.name ?? null, ownerIsMe: c.owner_person_id === state.binding().mePersonId,
          counterparty: people.get(c.counterparty_person_id)?.name ?? null, updatedAt: c.updated_at,
        })),
      };
    } finally {
      state.close();
    }
  }
}

// Off unless the team service address is configured. Release builds leave it unset
// until the service has a public address, so shipped apps never show team features.
function teamUrl(env = process.env) {
  const value = env.FOCUSBAE_TEAM_URL;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new Error("FOCUSBAE_TEAM_URL must be https, or http on localhost");
  return url.origin;
}

module.exports = { TeamService, teamUrl };
