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
    unwrap(api.team.mapping({ workspaceId, actionId }))
      .then((next) => alive && setValue(next))
      .catch((failure) => alive && setError(failure.message));
    return () => { alive = false; };
  }, [workspaceId, actionId]);

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

  return (
    <fieldset className="team-share" disabled={busy}>
      <legend>
        {status === "proposed" ? `Shared with ${teamName} when accepted, as` : `Shared with ${teamName} as`}
      </legend>
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
