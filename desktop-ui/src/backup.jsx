import React, { useEffect, useState } from "react";
const api = window.focusbaeWorkspace;
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export function BackupSettings({ workspaceId, run, openWorkspace }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(null);
  const [restored, setRestored] = useState(null);
  useEffect(() => {
    let alive = true;
    unwrap(api.backup.status({ workspaceId })).then((value) => alive && setStatus(value)).catch((failure) => alive && setError(failure.message));
    const off = api.onBackup((value) => setPhase(value.phase));
    return () => { alive = false; off(); };
  }, [workspaceId]);
  const perform = async (method) => {
    setBusy(true); setError(null); setMessage(""); setRestored(null);
    try {
      await run(async () => {
        const result = await unwrap(api.backup[method]({ workspaceId }));
        if (result.canceled) return;
        if (method === "restore") {
          setRestored(result);
          setMessage(`Restored “${result.name}”. Your current workspace is unchanged.`);
        } else {
          setMessage(result.statusSaved ? `Backup verified and saved: ${result.fileName}` : `Backup verified and saved: ${result.fileName}. Its status could not be saved on this Mac.`);
        }
        setStatus(await unwrap(api.backup.status({ workspaceId })));
      });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); setPhase(null); }
  };
  return <section aria-labelledby="backup-title">
    <h2 id="backup-title">Backup & recovery</h2>
    <p className="storage-explanation">A complete copy of this workspace: notes, transcripts, actions, people, attachments, workspace settings and any audio still stored on this Mac.</p>
    <p className="storage-explanation muted">Clipboard history, downloaded models and app-wide settings stay out. Audio already deleted cannot be recovered. Backups are not encrypted—keep the file somewhere private.</p>
    <div className="setting-row"><span>Last backup created</span><span>{status?.lastBackup ? new Date(status.lastBackup.createdAt).toLocaleString() : status ? "No backup recorded" : "Checking…"}</span></div>
    {status?.lastBackup && <p className="storage-explanation muted">{status.lastBackup.fileName} · {(status.lastBackup.bytes / 1024 / 1024).toFixed(1)} MB. This records when the backup was made, not whether the file still exists.</p>}
    <p className="storage-explanation muted">Use an external drive for protection against disk loss. A copy on this same Mac is not an off-device backup. Restore validates the file and adds a separate workspace without replacing your current one.</p>
    <div className="backup-controls">
      <button type="button" className="primary" disabled={busy} onClick={() => perform("create")}>Create backup</button>
      <button type="button" disabled={busy} onClick={() => perform("restore")}>Restore backup</button>
    </div>
    {busy && <p role="status">{phase || "Preparing… Finish any native dialog to continue."}</p>}
    {message && <p role="status" className="storage-explanation">{message}</p>}
    {restored && <button type="button" disabled={busy} onClick={() => openWorkspace(restored.id)}>Open restored workspace</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
