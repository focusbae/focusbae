import React, { useState } from "react";
const api = window.focusbaeWorkspace;
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
// Two steps on purpose: the first asks macOS for access and counts what is there,
// and nothing is copied until the person has seen that count.
export function AppleNotesImport({ workspaceId, run }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(null);
  const act = async (work) => {
    setBusy(true); setError(null);
    try { await run(work); } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const look = () => act(async () => {
    setMessage("");
    setPreview(await unwrap(api.appleNotes.preview({ workspaceId })));
  });
  const bring = () => act(async () => {
    const result = await unwrap(api.appleNotes.import({ workspaceId, token: preview.token }));
    setPreview(null);
    const failed = result.failures.length;
    setMessage(`${result.items.length} ${result.items.length === 1 ? "note" : "notes"} copied into this workspace.${
      failed ? ` ${failed} could not be read and ${failed === 1 ? "remains" : "remain"} in Apple Notes.` : ""}`);
  });
  return <section aria-labelledby="apple-notes-title">
    <h2 id="apple-notes-title">Import from Apple Notes</h2>
    <p className="storage-explanation">Bring your notes across, folders included. Nothing in Apple Notes is changed.</p>
    <p className="storage-explanation muted">Locked notes and attachments stay behind. Import again anytime—only new notes come across.</p>
    {preview && <div className="apple-notes-preview">
      <div className="setting-row"><span>Ready to import</span><span>{preview.ready} of {preview.total}</span></div>
      {preview.alreadyImported > 0 && <p className="storage-explanation muted">{preview.alreadyImported} already imported and will be skipped.</p>}
      {preview.locked > 0 && <p className="storage-explanation muted">{preview.locked} locked and cannot be read.</p>}
      {preview.withAttachments > 0 && <p className="storage-explanation muted">{preview.withAttachments} have attachments that stay in Apple Notes.</p>}
      {preview.sample.length > 0 && <ul className="apple-notes-sample">
        {preview.sample.map((item, index) => <li key={index}>{item.title || "Untitled"}{item.folder ? ` · ${item.folder}` : ""}</li>)}
      </ul>}
    </div>}
    <div className="backup-controls">
      <button type="button" disabled={busy} onClick={look}>{preview ? "Check again" : "Check Apple Notes"}</button>
      {preview && preview.ready > 0 && <button type="button" className="primary" disabled={busy} onClick={bring}>
        Import {preview.ready} {preview.ready === 1 ? "note" : "notes"}
      </button>}
    </div>
    {busy && <p role="status">Working… this can take a moment for a large library.</p>}
    {preview && preview.ready === 0 && !busy && <p role="status" className="storage-explanation">Nothing new to import.</p>}
    {message && <p role="status" className="storage-explanation">{message}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
