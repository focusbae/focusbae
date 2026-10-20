"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { ACTION_TRANSITIONS } = require("../workspace/domain");

const SHAREABLE = new Set(["accepted", "deferred", "done", "dropped"]);
const PAGE = 1000;

function listAll(store, workspaceId, kind) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = store.list({ workspaceId }, kind, { includeDeleted: true, limit: PAGE, offset });
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// Where an action's quote came from, in words a teammate can recognise.
function sourceOf(store, workspaceId, action) {
  const evidence = action.evidence?.[0];
  if (!evidence) return { sourceKind: "manual", sourceTitle: null, quote: null };
  try {
    if (evidence.sourceKind === "note") {
      const note = store.get({ workspaceId }, "note", evidence.segmentId, { includeDeleted: true });
      return { sourceKind: "note", sourceTitle: note.title || "Untitled page", quote: evidence.quote };
    }
    const segment = store.get({ workspaceId }, "transcript", evidence.segmentId, { includeDeleted: true });
    const recording = store.get({ workspaceId }, "recording", segment.recordingId, { includeDeleted: true });
    return { sourceKind: "recording", sourceTitle: recording.title || "Conversation", quote: evidence.quote };
  } catch {
    return { sourceKind: "manual", sourceTitle: null, quote: evidence.quote };
  }
}

// People in the conversation an action was quoted from, as the person named them.
function conversationPeople(store, workspaceId, action) {
  const evidence = action.evidence?.[0];
  if (!evidence || evidence.sourceKind === "note") return { named: [], selfSpoke: false };
  try {
    const segment = store.get({ workspaceId }, "transcript", evidence.segmentId, { includeDeleted: true });
    const speakers = store.list({ workspaceId }, "speaker", { recordingId: segment.recordingId, limit: 1000 });
    const named = [...new Set(speakers.filter((s) => s.identity?.kind === "person").map((s) => s.identity.label))];
    return { named, selfSpoke: speakers.some((s) => s.identity?.kind === "self") };
  } catch {
    return { named: [], selfSpoke: false };
  }
}

const byName = (people, label) => people.find((p) => p.name.toLowerCase() === String(label).trim().toLowerCase()) ?? null;

// Who the team sees as owing an action and who it is owed to. An explicit choice made
// on this Mac wins; otherwise the action's own owner, and an "owed to" only when the
// conversation makes it unambiguous (exactly one other identified person).
function sharedPeople(store, workspaceId, action, state) {
  const people = state?.people() ?? [];
  const me = state?.binding()?.mePersonId ?? null;
  const chosen = state?.mapping(action.id) ?? null;
  let owner = null;
  if (chosen?.ownerPersonId) owner = { personId: chosen.ownerPersonId };
  // "self" rather than this person's id, so learning that id on the first pull does
  // not change what was sent; the server resolves it to the same person.
  else if (action.owner?.kind === "self") owner = { self: true };
  else if (action.owner?.kind === "person" && action.ownerLabel) {
    const match = byName(people, action.ownerLabel);
    owner = match ? { personId: match.id } : { name: action.ownerLabel };
  }
  let counterparty = null;
  let suggested = false;
  if (chosen) counterparty = chosen.counterpartyPersonId ? { personId: chosen.counterpartyPersonId } : null;
  else {
    const { named, selfSpoke } = conversationPeople(store, workspaceId, action);
    const candidates = named.map((label) => byName(people, label)?.id).filter(Boolean);
    if (selfSpoke && me) candidates.push(me);
    const ownerId = owner?.self ? me : owner?.personId;
    const others = [...new Set(candidates)].filter((id) => id !== ownerId);
    if (others.length === 1) { counterparty = { personId: others[0] }; suggested = true; }
  }
  return { owner, counterparty, suggested, chosen: !!chosen };
}

// What a teammate sees of one local action. Audio, transcripts and notes stay here;
// only the commitment, its quote and where it was said are shared.
function payloadFor(store, workspaceId, action, state = null) {
  const { owner, counterparty } = sharedPeople(store, workspaceId, action, state);
  return {
    title: action.title,
    status: action.status,
    dueDate: action.dueDate ?? (action.dueAt ? action.dueAt.slice(0, 10) : null),
    owner,
    counterparty,
    ...sourceOf(store, workspaceId, action),
  };
}

const hashOf = (payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

// Phase 1, under the workspace lock: decide what to send.
function plan(store, state) {
  const workspaceId = store.identity.id;
  const shares = [];
  const unshares = [];
  const statusOnly = new Map();
  const localIds = new Set();
  for (const action of listAll(store, workspaceId, "action")) {
    localIds.add(action.id);
    const sent = state.sent(action.id);
    if (!action.deletedAt && SHAREABLE.has(action.status)) {
      const payload = payloadFor(store, workspaceId, action, state);
      const hash = hashOf(payload);
      if (!sent || sent.hash !== hash) shares.push({ id: action.id, payload, hash, version: sent?.version ?? null });
      statusOnly.set(action.id, action.status);
    } else if (sent) unshares.push(action.id);
  }
  // Shared before but gone from this workspace entirely (purged): withdraw it too.
  for (const id of state.sharedIds()) if (!localIds.has(id)) unshares.push(id);
  return { shares, unshares, statusOnly };
}

// Phase 2, network: push, then pull. Returns what phase 3 needs.
async function exchange(account, state, work) {
  const binding = state.binding();
  const ws = binding.serverWorkspaceId;
  const sent = [];
  const errors = [];
  for (const share of work.shares) {
    try {
      const row = await account.rpc("share_commitment", {
        p_workspace: ws, p_id: share.id, p_input: share.payload, p_version: share.version,
      });
      sent.push({ id: share.id, hash: share.hash, version: row.version });
    } catch (error) {
      if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error;
      // Someone changed it since this Mac last saw it: their change arrives with the
      // pull below and the next round resends on top of it.
      if (error.code === "VERSION_CONFLICT") continue;
      // The owner may only change status (e.g. after leaving the team): send just that.
      if (error.code === "FORBIDDEN" && share.version !== null) {
        try {
          const row = await account.rpc("set_commitment_status", { p_id: share.id, p_status: share.payload.status, p_version: null });
          sent.push({ id: share.id, hash: share.hash, version: row.version });
          continue;
        } catch (inner) { errors.push(inner.message); continue; }
      }
      errors.push(error.message);
    }
  }
  const withdrawn = [];
  for (const id of work.unshares) {
    try {
      await account.rpc("unshare_commitment", { p_id: id });
      withdrawn.push(id);
    } catch (error) {
      if (error.code === "POLICY_DENIED" || error.code === "SIGNED_OUT") throw error;
      if (error.code === "FORBIDDEN") withdrawn.push(id); // no longer ours to withdraw
      else errors.push(error.message);
    }
  }
  try {
    const pull = await account.rpc("pull_changes", { p_workspace: ws, p_since: binding.cursor });
    return { sent, withdrawn, pull, errors };
  } catch (error) {
    if (error.code === "FORBIDDEN") return { sent, withdrawn, removed: true, errors };
    throw error;
  }
}

// Phase 3, under the workspace lock again: record what was sent, store the pull, and
// bring teammates' status changes to this Mac's own actions.
function apply(store, state, result) {
  for (const s of result.sent) state.markSent(s.id, s.hash, s.version);
  for (const id of result.withdrawn) state.forgetSent(id);
  if (result.removed) {
    state.markRemoved();
    return { removed: true, applied: 0 };
  }
  state.applyPull(result.pull);
  const workspaceId = store.identity.id;
  let applied = 0;
  for (const remote of result.pull.commitments) {
    const sent = state.sent(remote.id);
    if (!sent || (sent.version !== null && remote.version <= sent.version)) continue;
    let local;
    try { local = store.get({ workspaceId }, "action", remote.id); } catch { continue; }
    // A finished action reopens before it can be deferred, so take the two steps the
    // local rules allow rather than leaving the Mac out of step with the team.
    const steps = ACTION_TRANSITIONS[local.status]?.includes(remote.status) ? [remote.status]
      : ["done", "dropped"].includes(local.status) && remote.status === "deferred" ? ["accepted", "deferred"] : [];
    for (const status of local.status === remote.status ? [] : steps) {
      local = store.transitionAction({ workspaceId, clientRequestId: randomUUID(), expectedRevision: local.revision }, remote.id, {
        status,
        ...(["done", "dropped"].includes(local.status) ? { reopen: true } : {}),
      });
    }
    if (steps.length && local.status === remote.status) applied++;
    // Record what the server now holds. If this Mac also changed something else
    // meanwhile (the title, the due date), leave it unsent so the next round sends it
    // on top of the teammate's change instead of dropping it.
    const payload = payloadFor(store, workspaceId, local, state);
    const inStep = payload.title === remote.title && payload.status === remote.status
      && (payload.dueDate ?? null) === (remote.due_date ?? null);
    state.markSent(remote.id, inStep ? hashOf(payload) : "", remote.version);
  }
  if (result.errors.length) state.recordError(result.errors[0]);
  return { removed: false, applied };
}

module.exports = { plan, exchange, apply, payloadFor, sharedPeople, hashOf };
