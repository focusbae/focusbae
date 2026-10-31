import React, { useEffect, useState } from "react";

const api = window.focusbaeWorkspace;
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// In a team workspace: who can see this page. It stays in My notes (only you) until
// you choose a team; the team then sees it on the web, read and comment only.
export function NoteVisibility({ workspaceId, noteId }) {
  const [value, setValue] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setValue(null);
    unwrap(api.team.noteVisibility({ workspaceId, noteId }))
      .then((next) => alive && setValue(next))
      .catch((failure) => alive && setError(failure.message));
    return () => { alive = false; };
  }, [workspaceId, noteId]);
  if (!value?.privateSpaceId) return error ? <span className="note-visibility-error" role="alert">{error}</span> : null;
  const change = async (spaceId) => {
    setError(null);
    try { setValue(await unwrap(api.team.setNoteVisibility({ workspaceId, noteId, spaceId }))); }
    catch (failure) { setError(failure.message); }
  };
  return (
    <>
      <span className="note-folder-sep" aria-hidden="true">·</span>
      <select
        className="note-folder note-visibility"
        aria-label="Who can see this page"
        value={value.spaceId}
        onChange={(event) => change(event.target.value)}
        title={value.spaceId === value.privateSpaceId ? "Only you. Synced to your account, not shared." : "Your team can read and comment on the web."}
      >
        {value.options.map((space) => (
          <option key={space.id} value={space.id}>
            {space.kind === "private" ? "Only me" : `Visible to ${space.name}`}
          </option>
        ))}
      </select>
      {error && <span className="note-visibility-error" role="alert">{error}</span>}
    </>
  );
}
