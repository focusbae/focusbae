import React, { useEffect, useState } from "react";

const api = window.focusbaeWorkspace;
const shortcutLabels = { workspace: "Open workspace", newNote: "New note", actions: "Actions", record: "Record / Stop" };
const displayShortcut = (value) => value
  ? value.replace(/CommandOrControl/g, "⌘").replace(/Alt/g, "⌥").replace(/Shift/g, "⇧").replace(/Control/g, "⌃").replace(/\+/g, " ")
  : "Not assigned";
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function AppSettings({ run, privacy }) {
  const [settings, setSettings] = useState(null);
  const [capturing, setCapturing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [lastMethod, setLastMethod] = useState(null);
  useEffect(() => {
    let alive = true;
    unwrap(api.appSettings.get()).then((value) => alive && setSettings(value))
      .catch((failure) => alive && setError(failure.message));
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!busy || lastMethod !== "downloadUpdate") return;
    const timer = setInterval(() => {
      unwrap(api.appSettings.get()).then(setSettings).catch(() => {});
    }, 400);
    return () => clearInterval(timer);
  }, [busy, lastMethod]);
  const change = async (method, input) => {
    setBusy(true);
    setError(null);
    setLastMethod(method);
    try {
      await run(async () => {
        const result = await unwrap(api.appSettings[method](input));
        if (result.ok === false) throw new Error(result.error || "Could not change this setting.");
        if (method === "checkForUpdates" || method === "downloadUpdate") {
          const messages = {
            current: "You have the latest version.",
            available: `Version ${result.version} is available. Download it when you're ready.`,
            ready: `Version ${result.version} is ready to install. Save your work, then restart to update.`,
            unavailable: "Update checks work in the signed Mac app. Get the latest release at focusbae.com/download.",
            error: "Could not complete the update. Check your connection and try again.",
          };
          setUpdateMessage(messages[result.status] || "Update cancelled.");
        }
        setSettings(await unwrap(api.appSettings.get()));
      });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setCapturing(null);
      setBusy(false);
    }
  };
  return (
    <><section className="app-settings" aria-labelledby="app-settings-title">
      <h2 id="app-settings-title">App & shortcuts</h2>
      <p className="storage-explanation muted">These settings apply to FocusBae on this Mac, across all workspaces.</p>
      {settings ? <>
        <div className="setting-row">
          <label htmlFor="launch-at-login">Open at login</label>
          <input id="launch-at-login" type="checkbox" role="switch"
            checked={settings.openAtLogin} disabled={busy}
            onChange={(event) => change("setLogin", { enabled: event.target.checked })} />
        </div>
        <div className="setting-row">
          <div><label htmlFor="show-in-dock">Show in Dock</label>
            <p className="storage-explanation muted">Turn off to keep FocusBae in the menu bar. Open it from the menu bar icon or your shortcut.</p></div>
          <input id="show-in-dock" type="checkbox" role="switch"
            checked={settings.showInDock} disabled={busy}
            onChange={(event) => change("setDock", { enabled: event.target.checked })} />
        </div>
        <div className="shortcut-settings">
          {Object.entries(shortcutLabels).map(([name, label]) => (
            <div className="shortcut-setting" key={name}>
              <span>{label}</span>
              <div>
                <button type="button" disabled={busy} aria-label={`Change ${label} shortcut`}
                  onClick={() => { setCapturing(name); change("captureShortcut", { name }); }}>
                  {capturing === name ? "Press keys…" : displayShortcut(settings.shortcuts[name])}
                </button>
                <button type="button" disabled={busy} aria-label={`Reset ${label} shortcut`}
                  onClick={() => change("resetShortcut", { name })}>Reset</button>
              </div>
            </div>
          ))}
        </div>
        <p className="muted" role="status">
          {capturing ? "Press your new key combination. Escape cancels." : "Shortcuts work while FocusBae is in the background. Record opens the recording form, or stops an active recording."}
        </p>
      </> : !error && <p role="status">Loading app settings…</p>}
      {error && !["checkForUpdates", "downloadUpdate", "installUpdate"].includes(lastMethod) && <p role="alert" className="error">{error}</p>}
    </section>
    <section aria-labelledby="updates-title">
      <h2 id="updates-title">About & updates</h2>
      <div className="setting-row"><span>FocusBae</span><span>{settings ? `${settings.version} · ${settings.packaged ? "Mac app" : "Development build"}` : "Loading version…"}</span></div>
      <p className="storage-explanation">Updates are checked only when you ask. Nothing is installed without your confirmation, and no notes or recordings are sent.</p>
      {settings && !settings.packaged && <p className="storage-explanation muted">In-app updates work only in signed Mac releases. This development build cannot install them.</p>}
      {privacy.mode === "strict-local" && <p className="storage-explanation muted">Strict Local is on. Leave it in Privacy before checking or downloading.</p>}
      <button type="button" disabled={busy || !settings?.packaged || privacy.mode === "strict-local" || settings.updates?.status === "ready"} onClick={() => { setUpdateMessage(""); change("checkForUpdates"); }}>{busy && lastMethod === "checkForUpdates" ? "Checking…" : "Check for updates"}</button>
      {settings?.updates?.status === "available" && <button type="button" disabled={busy || privacy.mode === "strict-local"} onClick={() => change("downloadUpdate")}>Download version {settings.updates.version}</button>}
      {settings?.updates?.status === "downloading" && <p role="status" className="storage-explanation">Downloading… {settings.updates.percent}%</p>}
      {settings?.updates?.status === "ready" && <button type="button" disabled={busy} onClick={() => change("installUpdate")}>Restart and install version {settings.updates.version}</button>}
      {updateMessage && <p role="status" className="storage-explanation">{updateMessage}</p>}
      {error && ["checkForUpdates", "downloadUpdate", "installUpdate"].includes(lastMethod) && <p role="alert" className="error">{error}</p>}
    </section></>
  );
}
