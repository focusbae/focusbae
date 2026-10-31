import React, { useEffect, useState } from "react";

const api = window.focusbaeWorkspace;
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// In a team workspace: who the team sees as owing this action and who it is owed to.
// Choices are stored on this Mac and shared when the action is accepted.
export function TeamShare({ workspaceId, actionId, status, teamName, disabled }) {
  const [value, setValue] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setValue(null);
    const load = () => unwrap(api.team.mapping({ workspaceId, actionId }))
      .then((next) => alive && setValue(next))
      .catch((failure) => alive && setError(failure.message));
    load();
    // A sync can find that a teammate already shared this; show it when it does.
    const off = api.onTeam(load);
    return () => { alive = false; off(); };
  }, [workspaceId, actionId, status]);

  if (!value) return error ? <p className="action-error" role="alert">{error}</p> : null;

  const save = async (changes) => {
    setSaving(true);
    setError(null);
    try {
      setValue(await unwrap(api.team.setMapping({
        workspaceId, actionId,
        ownerPersonId: value.ownerPersonId,
        counterpartyPersonId: value.counterpartyPersonId,
        ...changes,
      })));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  };
  const label = (person) => (person.id === value.me ? `${person.name} (you)` : person.name);
  const members = value.people.filter((p) => p.isMember);
  const contacts = value.people.filter((p) => !p.isMember);
  const options = (
    <>
      <option value="">Nobody yet</option>
      <optgroup label="Team">
        {members.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
      </optgroup>
      {contacts.length > 0 && (
        <optgroup label="Contacts">
          {contacts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </optgroup>
      )}
    </>
  );
  const busy = disabled || saving;
  const decide = async (decision) => {
    setSaving(true);
    setError(null);
    try { setValue(await unwrap(api.team.resolveDuplicate({ workspaceId, actionId, decision }))); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  };
  const where = !value.space ? teamName
    : value.space.kind === "private" ? null
    : value.space.kind === "everyone" ? `everyone at ${value.space.name}` : value.space.name;
  const dup = value.duplicate;

  return (
    <fieldset className="team-share" disabled={busy}>
      <legend>
        {!where ? (status === "proposed" ? "Kept in My notes when accepted, as" : "In My notes, as")
          : status === "proposed" ? `Shared with ${where} when accepted, as` : `Shared with ${where} as`}
      </legend>
      {dup?.decision === "pending" && (
        <div className="team-duplicate" role="status">
          <p><strong>Already on the team?</strong> {dup.commitment.owner ?? "Someone"}: “{dup.commitment.title}”
            {dup.commitment.space ? ` · ${dup.commitment.space}` : ""}{dup.commitment.sourceTitle ? ` · from ${dup.commitment.sourceTitle}` : ""}</p>
          <p className="muted">This one isn't shared until you choose, so the team doesn't see it twice.</p>
          <div className="team-duplicate-actions">
            <button type="button" className="primary" onClick={() => decide("theirs")}>Use theirs</button>
            <button type="button" onClick={() => decide("both")}>Share mine too</button>
          </div>
        </div>
      )}
      {dup?.decision === "theirs" && (
        <div className="team-duplicate" role="status">
          <p>Linked to the team's copy: “{dup.commitment.title}”.</p>
          <p className="muted">{dup.canFollow ? "Marking this done or deferred here updates theirs, and their changes reach this one." : "Their changes reach this one; yours stay on this Mac."}</p>
          <div className="team-duplicate-actions"><button type="button" onClick={() => decide("both")}>Share mine separately</button></div>
        </div>
      )}
      <div className="team-share-row">
        <label>
          <span>Owner</span>
          <select
            value={value.ownerPersonId ?? ""}
            onChange={(event) => save({ ownerPersonId: event.target.value || null })}
          >
            {value.ownerPersonId === null && value.ownerName && <option value="">{value.ownerName} (not in the team yet)</option>}
            {options}
          </select>
        </label>
        <label>
          <span>Owed to</span>
          <select
            value={value.counterpartyPersonId ?? ""}
            onChange={(event) => save({ counterpartyPersonId: event.target.value || null })}
          >
            {options}
          </select>
        </label>
      </div>
      {value.suggested && !value.chosen && (
        <p className="muted">Owed to was suggested from who was in the conversation. Change it if it's wrong.</p>
      )}
      {error && <p className="action-error" role="alert">{error}</p>}
    </fieldset>
  );
}
