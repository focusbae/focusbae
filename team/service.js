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
    account.on("change", () => { this.emit("change"); this.#schedule(); });
    policy.on("change", () => this.#schedule());
  }

  start() { this.#schedule(); }

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
