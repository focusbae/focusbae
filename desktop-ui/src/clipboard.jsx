import React, { useEffect, useState } from "react";
const api = window.focusbaeWorkspace;
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function useHistory() {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true, received = false;
    const off = api.onClipboard((value) => { received = true; setHistory(value); });
    unwrap(api.clipboard.state()).then((value) => { if (active && !received) setHistory(value); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; off(); };
  }, []);
  return { history, setHistory, error, setError };
}
export function ClipboardSettings({ run, open }) {
  const { history, setHistory, error, setError } = useHistory();
  const [busy, setBusy] = useState(false);
  const enable = async (enabled) => {
    setBusy(true); setError(null);
    try { await run(async () => setHistory(await unwrap(api.clipboard.setEnabled({ enabled })))); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="clipboard-settings-title">
    <h2 id="clipboard-settings-title">Clipboard history</h2>
    <p className="storage-explanation muted">An optional local utility, separate from your notes. Off each time FocusBae starts.</p>
    <div className="setting-row">
      <label htmlFor="clipboard-enabled">Remember copied text this session</label>
      <input id="clipboard-enabled" type="checkbox" role="switch" checked={!!history?.enabled}
        disabled={busy || !history} onChange={(event) => enable(event.target.checked)} />
    </div>
    <p className="storage-explanation">Keeps up to 30 text items in memory, not in a history file. Disabling or quitting clears them. Nothing is synced, and your old clipboard-history file is not imported.</p>
    <p className="storage-explanation muted">Copied text can contain secrets. FocusBae skips recognized sensitive clipboard markers, but cannot detect every password or private item. Images and text over 20,000 characters are skipped.</p>
    {history?.enabled && <button type="button" disabled={busy} onClick={open}>Open clipboard history</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
export function ClipboardHistory({ settings }) {
  const { history, error, setError } = useHistory();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const change = async (method, id) => {
    setBusy(true); setError(null); setMessage("");
    try {
      await unwrap(api.clipboard[method](id ? { id } : undefined));
      setMessage(method === "copy" ? "Copied. Paste wherever you need it." : method === "clear" ? "History cleared. Your system clipboard is unchanged." : "Removed from history.");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const items = history?.items.filter((item) => item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  return <div className="clipboard-content">
    <div className="clipboard-toolbar">
      <p className="muted">Text copied during this app session. Local, temporary, and separate from your workspace.</p>
      <button type="button" onClick={settings}>Clipboard settings</button>
    </div>
    {!history ? <p role="status">Loading clipboard history…</p> : !history.enabled ?
      <section className="clipboard-empty"><h2>Clipboard history is off</h2><p>Enable it in Settings when you want to remember copied text.</p></section> : <>
        <div className="clipboard-toolbar">
          <input aria-label="Search clipboard history" type="search" placeholder="Search copied text" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" disabled={busy || !history.items.length} onClick={() => change("clear")}>Clear history</button>
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setError(null); setMessage("");
            try { await unwrap(api.clipboard.setEnabled({ enabled: false })); }
            catch (failure) { setError(failure.message); }
            finally { setBusy(false); }
          }}>Turn off & clear</button>
        </div>
        {!items.length && <p className="clipboard-empty">{query ? "No matching copied text." : "Copy some text to begin. Anything copied before enabling history stays out."}</p>}
        <ol className="clipboard-items">{items.map((item) => <li key={item.id}>
          <pre>{item.text}</pre>
          <div className="clipboard-toolbar"><time dateTime={new Date(item.copiedAt).toISOString()}>{new Date(item.copiedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
            <button type="button" disabled={busy} onClick={() => change("copy", item.id)}>Copy</button>
            <button type="button" disabled={busy} onClick={() => change("remove", item.id)}>Remove</button></div>
        </li>)}</ol>
      </>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
