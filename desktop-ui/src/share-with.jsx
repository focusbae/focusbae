import React, { useEffect, useState } from "react";

const api = window.focusbaeWorkspace;
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// The teams a recording in this workspace can share its accepted action items with, or
// null outside team workspaces (TEAM_PLAN §4).
export function useShareTargets(workspaceId) {
  const [targets, setTargets] = useState(null);
  useEffect(() => {
    let alive = true;
    unwrap(api.capture.shareTargets({ workspaceId }))
      .then((value) => alive && setTargets(value))
      .catch(() => alive && setTargets(null));
    return () => { alive = false; };
  }, [workspaceId]);
  return targets;
}

const teamLabel = (space) => (space.kind === "everyone" ? `Everyone at ${space.name}` : space.name);

// "Share with" for a recording. Only me is the default and is never carried over from
// the last recording, so a private call is not shared by habit. "" means Only me.
export function ShareWithField({ id, targets, value, onChange, disabled }) {
  if (!targets) return null;
  const teams = targets.options.filter((space) => space.kind !== "private");
  return (
    <>
      <label htmlFor={id}>Share with</label>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">Only me</option>
        {teams.map((space) => <option key={space.id} value={space.id}>{teamLabel(space)}</option>)}
      </select>
      <p className="muted">
        {value
          ? "Action items you accept go to this team, with the sentence they came from. Audio and the transcript stay on this Mac."
          : "Action items you accept stay in My notes. Teammates see one only if it names them as owner or owed-to."}
      </p>
    </>
  );
}

// The same choice on a recording that already exists. Changing it moves the action items
// already shared from it on the next sync.
export function RecordingShare({ workspaceId, record, targets, saved }) {
  const [error, setError] = useState(null);
  if (!targets) return null;
  const teams = targets.options.filter((space) => space.kind !== "private");
  const value = teams.some((space) => space.id === record.shareWith) ? record.shareWith : "";
  const change = async (next) => {
    setError(null);
    try { saved(await unwrap(api.capture.shareWith({ workspaceId, id: record.id, spaceId: next || null }))); }
    catch (failure) { setError(failure.message); }
  };
  return (
    <>
      <select className="recording-share" aria-label="Share action items with" value={value} onChange={(event) => change(event.target.value)}
        title="Who sees the action items you accept from this recording">
        <option value="">Only me</option>
        {teams.map((space) => <option key={space.id} value={space.id}>Shared with {teamLabel(space)}</option>)}
      </select>
      {error && <span className="note-visibility-error" role="alert">{error}</span>}
    </>
  );
}
