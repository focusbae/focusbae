import React, { useEffect, useState } from "react";

const api = window.focusbaeWorkspace;
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const when = (iso) => (iso ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(iso)) : "never");

// The team binding of each local workspace (empty when team features are off).
export function useTeamWorkspaces() {
  const [bindings, setBindings] = useState(new Map());
  useEffect(() => {
    let alive = true;
    const update = (value) => alive && setBindings(new Map((value?.workspaces ?? []).map((w) => [w.localId, w])));
    unwrap(api.team.state()).then(update).catch(() => {});
    const off = api.onTeam(update);
    return () => { alive = false; off(); };
  }, []);
  return bindings;
}

// Team workspaces: connect an account, then add workspaces you belong to as separate
// workspaces on this Mac. Personal workspaces never sync; this section says so plainly.
export function TeamSettings({ openWorkspace }) {
  const [team, setTeam] = useState(null);
  const [remote, setRemote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    unwrap(api.team.state()).then((value) => alive && setTeam(value)).catch(() => alive && setTeam({ available: false }));
    const off = api.onTeam((value) => alive && setTeam(value));
    return () => { alive = false; off(); };
  }, []);

  const connected = team?.account?.connected;
  useEffect(() => {
    if (!connected) { setRemote(null); return; }
    unwrap(api.team.remoteWorkspaces()).then(setRemote).catch((failure) => setError(failure.message));
  }, [connected, team?.workspaces?.length]);

  if (!team?.available) return null;

  const act = async (operation) => {
    setBusy(true);
    setError(null);
    try { await operation(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  const local = new Map((team.workspaces ?? []).map((w) => [w.serverWorkspaceId, w]));

  return (
    <section className="team-settings" aria-labelledby="team-title">
      <h2 id="team-title">Team workspaces</h2>
      <p className="storage-explanation">
        Team workspaces sync notes, attachments and accepted commitments with their quotes.
        Your Personal workspace, recordings and full transcripts stay on this Mac.
      </p>
      {team.strict && <p className="muted">Strict Local is on, so team workspaces are not syncing.</p>}
      {!connected ? (
        <div className="setting-row">
          <span>{team.account?.connecting ? "Finish signing in in your browser…" : "No team account connected"}</span>
          {team.account?.connecting ? (
            <button type="button" disabled={busy} onClick={() => act(() => unwrap(api.team.cancelConnect()))}>Cancel</button>
          ) : (
            <button type="button" className="primary" disabled={busy || team.strict}
              onClick={() => act(() => unwrap(api.team.connect()))}>Connect account</button>
          )}
        </div>
      ) : (
        <>
          <div className="setting-row">
            <span className="team-setting-copy"><span>Connected account</span><span className="muted">{team.account.email}</span></span>
            <button type="button" disabled={busy} onClick={() => act(() => unwrap(api.team.disconnect()))}>Disconnect</button>
          </div>
          {(remote ?? []).length === 0 && (
            <p className="muted">{remote ? "You're not in a team workspace yet. Ask an admin to invite you, then accept the email." : "Loading your workspaces…"}</p>
          )}
          {(remote ?? []).map((w) => {
            const here = local.get(w.id);
            return (
              <div className="setting-row" key={w.id}>
                <span className="team-setting-copy">
                  <span>{w.name}</span>
                  <span className="muted">
                    {here
                      ? here.status === "removed" ? "You were removed" : `Synced ${when(here.lastSyncedAt)}${here.lastError ? " · needs attention" : ""}`
                      : w.role}
                  </span>
                </span>
                {here ? (
                  <span className="setting-actions">
                    <button type="button" disabled={busy} onClick={() => openWorkspace(here.localId)}>Open</button>
                    <button type="button" disabled={busy || team.syncing || team.strict} onClick={() => act(() => unwrap(api.team.sync()))}>
                      {team.syncing ? "Syncing…" : "Sync now"}
                    </button>
                  </span>
                ) : (
                  <button type="button" disabled={busy}
                    onClick={() => act(async () => { await unwrap(api.team.join({ serverWorkspaceId: w.id })); })}>
                    Add to this Mac
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
