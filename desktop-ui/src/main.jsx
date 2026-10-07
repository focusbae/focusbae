import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CalendarDays,
  NotebookPen,
  AudioLines,
  ListTodo,
  UsersRound,
  Settings,
  Plus,
  Mic,
  HardDrive,
  ShieldCheck,
  Check,
  LoaderCircle,
  ChevronLeft,
  ChevronRight,
  X,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  CircleAlert,
} from "lucide-react";
import "./style.css";
import { Notebook } from "./notebook";
import { ClipboardSettings, ClipboardHistory } from "./clipboard";
import { BackupSettings } from "./backup";
import { AppleNotesImport } from "./apple-notes";
import { useModels, ModelSetup, ModelDialog } from "./models";
import { Actions } from "./actions";
import { People } from "./people";
import { WelcomeNotice, WorkspaceGuide } from "./welcome";
import { AppSettings } from "./app-settings";
import {
  useRecording,
  RecordDialog,
  RecordingBar,
  Recordings,
} from "./recordings";
import "./premium.css";
import brandMark from "./brand-mark.svg";

const api = window.focusbaeWorkspace;
const pages = [
  ["Today", CalendarDays],
  ["Notes", NotebookPen],
  ["Recordings", AudioLines],
  ["Actions", ListTodo],
  ["People", UsersRound],
  ["Settings", Settings],
];
async function unwrap(promise) {
  const result = await promise;
  if (!result.ok)
    throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
}
function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}
function Failure({ error, retry }) {
  return (
    <div className="error" role="alert">
      <CircleAlert size={18} />
      <span>{error.message}</span>
      {retry && (
        <IconButton label="Retry" onClick={retry}>
          <RefreshCw size={17} />
        </IconButton>
      )}
    </div>
  );
}

function DueActions({ workspaceId, refreshKey, open }) {
  const [due, setDue] = useState(null);
  useEffect(() => {
    let current = true;
    unwrap(api.reminders.due({ workspaceId }))
      .then((value) => current && setDue(value))
      .catch(() => current && setDue(null));
    return () => {
      current = false;
    };
  }, [workspaceId, refreshKey]);
  if (!due?.items.length) return null;
  return (
    <section className="today-actions" aria-label="Actions due">
      <ListTodo size={16} />
      <span>
        {due.overdue ? `${due.overdue} overdue` : ""}
        {due.overdue && due.today ? " · " : ""}
        {due.today ? `${due.today} due today` : ""}
      </span>
      <button type="button" onClick={open}>
        Review actions
      </button>
    </section>
  );
}

// Who is waiting on you, and who you are waiting on, without being asked for.
// The People page is the lookup; this is the moment it is actually seen.
function PeopleBand({ workspaceId, refreshKey, open }) {
  const [people, setPeople] = useState(null);
  useEffect(() => {
    let current = true;
    unwrap(api.people.list({ workspaceId }))
      .then((value) => current && setPeople(value))
      .catch(() => current && setPeople(null));
    return () => {
      current = false;
    };
  }, [workspaceId, refreshKey]);
  const items = (people?.items ?? []).filter((person) => person.theyOwe || person.youOwe).slice(0, 4);
  if (!items.length) return null;
  return (
    <section className="today-people" aria-label="Open with people">
      <UsersRound size={16} />
      <ul>
        {items.map((person) => (
          <li key={person.id}>
            <strong>{person.name}</strong>
            <span>
              {person.youOwe ? `you owe ${person.youOwe}` : ""}
              {person.youOwe && person.theyOwe ? " · " : ""}
              {person.theyOwe ? `owes you ${person.theyOwe}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={open}>
        Open People
      </button>
    </section>
  );
}

function NewWorkspace({ close, create }) {
  const ref = useRef(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      aria-labelledby="new-workspace-title"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await create(name.trim());
            close();
          } catch (failure) {
            setError(failure);
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <h2 id="new-workspace-title">New workspace</h2>
          <IconButton
            label="Close dialog"
            type="button"
            onClick={close}
            disabled={busy}
          >
            <X size={18} />
          </IconButton>
        </div>
        <label htmlFor="workspace-name">Name</label>
        <input
          id="workspace-name"
          autoFocus
          maxLength={200}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <p className="muted">Stored on this Mac. Sync is off.</p>
        {error && <Failure error={error} />}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !name.trim()}
          >
            {busy ? "Creating..." : "Create workspace"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Overview({ page, workspace, refreshKey }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const group = page === "Today" ? "notes" : page.toLowerCase();
  useEffect(() => {
    let current = true;
    setItems(null);
    setError(null);
    unwrap(api[group].list({ workspaceId: workspace.id, limit: 25, offset }))
      .then((value) => {
        if (current) setItems(value);
      })
      .catch((failure) => {
        if (current) setError(failure);
      });
    return () => {
      current = false;
    };
  }, [group, workspace.id, offset, refreshKey, attempt]);
  const Icon = pages.find(([name]) => name === page)[1];
  return (
    <>
      {page === "Today" && (
        <div className="today-band">
          <div>
            <span className="eyebrow">
              {new Intl.DateTimeFormat("en", {
                weekday: "long",
                timeZone: workspace.preferences.timezone,
              }).format(new Date())}
            </span>
            <h2>
              {new Intl.DateTimeFormat("en", {
                month: "long",
                day: "numeric",
                timeZone: workspace.preferences.timezone,
              }).format(new Date())}
            </h2>
          </div>
          <div className="local-marker">
            <HardDrive size={16} /> On this Mac
          </div>
        </div>
      )}
      <div className="section-heading">
        <h2>{page === "Today" ? "Your notes" : page}</h2>
        <span className="muted">
          {page === "Recordings"
            ? "Recording unavailable"
            : page === "Actions"
              ? "Read-only"
              : "Editing unavailable"}
        </span>
      </div>
      {error ? (
        <Failure error={error} retry={() => setAttempt((value) => value + 1)} />
      ) : !items ? (
        <div className="empty" role="status">
          <LoaderCircle className="spin" />
          <p>Loading {group}...</p>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <Icon size={32} strokeWidth={1.4} />
          <h3>{offset ? "No more items" : `No ${group} yet`}</h3>
          <p>
            {page === "Recordings"
              ? "Your recordings will appear here."
              : page === "Actions"
                ? "No local actions in this workspace."
                : "This workspace has no saved notes."}
          </p>
        </div>
      ) : (
        <ul className="item-list">
          {items.map((item) => (
            <li key={item.id} tabIndex={0}>
              <Icon size={19} />
              <div>
                <h3>{item.title || "Untitled"}</h3>
                {item.preview && <p>{item.preview}</p>}
                <span className="muted">
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                    timeZone: workspace.preferences.timezone,
                  }).format(new Date(item.updatedAt))}
                </span>
              </div>
              {(item.status || item.state) && (
                <span className="state">{item.status || item.state}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {(offset > 0 || items?.length === 25) && (
        <div className="pagination">
          <IconButton
            label="Previous page"
            disabled={offset === 0}
            onClick={() => setOffset((value) => Math.max(0, value - 25))}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <span>Page {offset / 25 + 1}</span>
          <IconButton
            label="Next page"
            disabled={items?.length !== 25}
            onClick={() => setOffset((value) => value + 25)}
          >
            <ChevronRight size={18} />
          </IconButton>
        </div>
      )}
    </>
  );
}

function Preferences({ workspace, privacy, run, saved, models, openGuide, openClipboard, openWorkspace }) {
  const [name, setName] = useState(workspace.name);
  const [theme, setTheme] = useState(workspace.preferences.theme);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    workspace.preferences.notificationsEnabled,
  );
  const [reminderHour, setReminderHour] = useState(
    workspace.preferences.reminderHour,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [semantic, setSemantic] = useState(null);
  useEffect(() => {
    let current = true;
    unwrap(api.semantic.status())
      .then((value) => current && setSemantic(value))
      .catch(() => current && setSemantic({ available: false }));
    return () => {
      current = false;
    };
  }, []);
  const change = async (operation) => {
    setBusy(true);
    setError(null);
    try {
      await run(operation);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-content">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          change(() =>
            unwrap(
              api.workspace.update({
                context: {
                  workspaceId: workspace.id,
                  clientRequestId: crypto.randomUUID(),
                  expectedRevision: workspace.revision,
                },
                changes: {
                  name: name.trim(),
                  preferences: { theme, notificationsEnabled, reminderHour },
                },
              }),
            ),
          );
        }}
      >
        <h2>Workspace</h2>
        <div className="setting-field">
          <label htmlFor="settings-name">Name</label>
          <input
            id="settings-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            required
            disabled={busy}
          />
        </div>
        <div className="setting-field">
          <label htmlFor="theme">Appearance</label>
          <select
            id="theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
            disabled={busy}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <div className="setting-row">
          <span>Time zone</span>
          <span>{workspace.preferences.timezone}</span>
        </div>
        <div className="setting-row">
          <label htmlFor="action-reminders">Action reminders</label>
          <input
            id="action-reminders"
            type="checkbox"
            role="switch"
            checked={notificationsEnabled}
            disabled={busy}
            onChange={(event) => setNotificationsEnabled(event.target.checked)}
          />
        </div>
        {notificationsEnabled && (
          <div className="setting-field">
            <label htmlFor="reminder-hour">Daily reminder time</label>
            <select
              id="reminder-hour"
              value={reminderHour}
              disabled={busy}
              onChange={(event) => setReminderHour(Number(event.target.value))}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {new Intl.DateTimeFormat("en", {
                    hour: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(Date.UTC(2020, 0, 1, hour)))}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="save-row">
          <button
            type="submit"
            className="primary"
            disabled={busy || !name.trim()}
          >
            {busy ? "Saving..." : "Save changes"}
          </button>
          <span className="muted" role="status">
            {saved ? "Saved on this Mac" : ""}
          </span>
        </div>
      </form>
      <section aria-labelledby="local-storage-title">
        <h2 id="local-storage-title">Your work on this Mac</h2>
        <p className="storage-explanation">
          Notes and transcripts save automatically in this workspace. No account
          is needed. Cloud sync and automatic cloud backup are not available yet.
        </p>
        <p className="storage-explanation muted">
          In Notes, choose Export all notes to keep a separate copy of your
          writing. Note exports do not include recordings or the whole workspace.
        </p>
        <button type="button" onClick={openGuide}>How FocusBae works</button>
      </section>
      <AppleNotesImport key={`apple-${workspace.id}`} workspaceId={workspace.id} run={run} />
      <BackupSettings key={workspace.id} workspaceId={workspace.id} run={run} openWorkspace={openWorkspace} />
      <section aria-labelledby="privacy-title">
        <h2 id="privacy-title">Privacy</h2>
        <div className="setting-row">
          <label htmlFor="strict">Strict Local</label>
          <input
            id="strict"
            type="checkbox"
            role="switch"
            checked={privacy.mode === "strict-local"}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              change(() => unwrap(api.privacy.setStrict({ enabled })));
            }}
          />
        </div>
        <p className="muted">
          Blocks app network operations, including model downloads and update checks.
          Writing, installed models and optional local clipboard history still work.
          Changing this setting requires confirmation.
        </p>
        <p className="storage-explanation muted">Online access is requested only when you start an operation. You can revoke session permissions here.</p>
        {[["models", "Model downloads"], ["updates", "Update access"]].map(([purpose, label]) => (
          <div className="setting-row" key={purpose}>
            <span>{label}</span>
            {privacy.grants?.includes(purpose) ? <button type="button" disabled={busy}
              onClick={() => change(() => unwrap(api.privacy.revoke({ purpose })))}>Revoke {label.toLowerCase()}</button> : <span className="muted">Not allowed</span>}
          </div>
        ))}
      </section>
      <AppSettings run={run} privacy={privacy} />
      <ClipboardSettings run={run} open={openClipboard} />
      <ModelSetup state={models} privacy={privacy} />
      <section>
        <h2>Local capabilities</h2>
        <div className="setting-row">
          <span>Recording</span>
          <span>Local, account-free</span>
        </div>
        <div className="setting-row">
          <span>Semantic search</span>
          <span>
            {semantic == null
              ? "Checking..."
              : semantic.available
                ? `${semantic.language}, on-device`
                : "Lexical fallback"}
          </span>
        </div>
      </section>
      {error && <Failure error={error} />}
    </div>
  );
}

function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState("Today");
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [recordDialog, setRecordDialog] = useState(false);
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [actionTarget, setActionTarget] = useState(null);
  const [personTarget, setPersonTarget] = useState(null);
  const [initialNoteId, setInitialNoteId] = useState(null);
  // The notebook's open pages live here so they survive a visit to Actions.
  const [noteTabs, setNoteTabs] = useState([]);
  const [activeNoteTab, setActiveNoteTab] = useState(null);
  const recording = useRecording();
  const models = useModels();
  const [modelDialog, setModelDialog] = useState(false);
  const [workspaceGuide, setWorkspaceGuide] = useState(false);
  const refresh = useRef(0);
  const heading = useRef(null);
  const flushRef = useRef(null);
  const commandHandler = useRef(null);
  const takingCommand = useRef(false);
  const drainCommand = useRef(null);
  const retryCommand = useRef(false);
  useEffect(() => {
    if (!state || busy || recordDialog || modelDialog || creating || workspaceGuide) return;
    let active = true;
    const take = async () => {
      if (!active) return;
      if (takingCommand.current) { retryCommand.current = true; return; }
      takingCommand.current = true;
      let command;
      try {
        command = await unwrap(api.commands.take());
        if (command && active) {
          try { await commandHandler.current(command); }
          finally { await unwrap(api.commands.ack({ id: command.id })); }
        }
      } catch (failure) {
        setError(failure);
        command = null;
      } finally {
        takingCommand.current = false;
      }
      const retry = retryCommand.current;
      retryCommand.current = false;
      if (command || retry) drainCommand.current?.();
    };
    drainCommand.current = take;
    const off = api.commands.onAvailable(take);
    take();
    return () => { active = false; drainCommand.current = null; off(); };
  }, [!!state, busy, recordDialog, modelDialog, creating, workspaceGuide]);
  const reload = useCallback(async () => {
    const sequence = ++refresh.current;
    try {
      const next = await unwrap(api.bootstrap());
      if (sequence === refresh.current) {
        setState(next);
        setError(null);
      }
    } catch (failure) {
      if (sequence === refresh.current) setError(failure);
      throw failure;
    }
  }, []);
  useEffect(() => {
    if (!api) {
      setError(new Error("Open FocusBae to access your local workspace."));
      return;
    }
    reload().catch(() => {});
    return api.onChange((event) => {
      if (event.type === "reminder.open") setPage("Actions");
      reload().catch(() => {});
    });
  }, [reload]);
  useEffect(() => {
    if (!api) return;
    const off = api.onFlush(async () => {
      document.querySelector("#root").inert = true;
      try {
        await flushRef.current?.();
      } catch (failure) {
        document.querySelector("#root").inert = false;
        throw failure;
      }
    });
    const resume = api.onResume(() => {
      document.querySelector("#root").inert = false;
    });
    return () => {
      off();
      resume();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme =
      state?.workspace.preferences.theme ?? "system";
  }, [state?.workspace.preferences.theme]);
  const run = async (operation) => {
    setBusy(true);
    setSaved(false);
    try {
      await flushRef.current?.();
      await operation();
      await reload();
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };
  const openRecording = async (id) => {
    try {
      await flushRef.current?.();
      setSelectedRecording(id);
      setPage("Recordings");
    } catch (failure) {
      setError(failure);
    }
  };
  const stopRecording = (id) =>
    unwrap(api.capture.stop({ workspaceId: state.workspace.id, id })).catch(
      setError,
    );
  const beginRecording = async () => {
    try {
      await flushRef.current?.();
      setRecordDialog(true);
    } catch (failure) {
      setError(failure);
    }
  };
  const navigate = async (next) => {
    if (busy) return;
    setBusy(true);
    try {
      await flushRef.current?.();
      setSelectedRecording(null);
      setInitialNoteId(null);
      setActionTarget(null);
      setPersonTarget(null);
      setPage(next);
      setSaved(false);
      requestAnimationFrame(() => heading.current?.focus());
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const switchWorkspace = (workspaceId) =>
    run(() => unwrap(api.workspace.open({ workspaceId })))
      .then(() => navigate("Today"))
      .catch(setError);
  commandHandler.current = async ({ name, id }) => {
    if (name === "record") {
      if (recording.state?.active || recording.state?.processingId || recording.state?.importing) await navigate("Recordings");
      else await beginRecording();
    } else if (name === "new-note") {
      setBusy(true);
      try {
        await flushRef.current?.();
        const note = await unwrap(api.notes.create({
          context: { workspaceId: state.workspace.id, clientRequestId: id },
          note: { title: "" },
        }));
        setInitialNoteId(note.id);
        setPage("Notes");
        setSaved(false);
      } finally {
        setBusy(false);
      }
    } else {
      await navigate({ actions: "Actions", settings: "Settings", recordings: "Recordings", clipboard: "Clipboard history" }[name]);
    }
  };
  const dismissWelcome = async () => {
    try {
      await run(() => unwrap(api.workspace.update({
        context: {
          workspaceId: state.workspace.id,
          clientRequestId: crypto.randomUUID(),
          expectedRevision: state.workspace.revision,
        },
        changes: { preferences: { welcomeDismissed: true } },
      })));
      requestAnimationFrame(() =>
        document.querySelector('[aria-label="Note body"]')?.focus(),
      );
    } catch (failure) {
      setError(failure);
    }
  };
  if (!state)
    return (
      <main className="startup">
        <img className="brand-mark brand-mark-large" src={brandMark} alt="" />
        <h1>FocusBae</h1>
        {error ? (
          <Failure
            error={error}
            retry={api ? () => reload().catch(() => {}) : undefined}
          />
        ) : (
          <p role="status">Opening local workspace...</p>
        )}
      </main>
    );
  const { workspace, workspaces, privacy } = state;
  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={brandMark} alt="" />
          <strong aria-label="FocusBae">focusbae.</strong>
        </div>
        <div className="workspace-picker">
          <span className="workspace-picker-symbol" aria-hidden="true"><PanelsTopLeft size={19} /></span>
          <label className="sr-only" htmlFor="workspace-select">
            Workspace
          </label>
          <select
            id="workspace-select"
            aria-label="Workspace"
            value={workspace.id}
            disabled={
              busy ||
              !!recording.state?.active ||
              !!recording.state?.processingId ||
              !!recording.state?.importing
            }
            onChange={(event) => switchWorkspace(event.target.value)}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id === workspace.id ? workspace.name : item.name}
              </option>
            ))}
          </select>
          <IconButton
            label="New workspace"
            disabled={
              busy ||
              !!recording.state?.active ||
              !!recording.state?.processingId ||
              !!recording.state?.importing
            }
            onClick={() => setCreating(true)}
          >
            <Plus size={18} />
          </IconButton>
        </div>
        <nav aria-label="Workspace navigation">
          {pages.map(([name, Icon]) => (
            <button
              key={name}
              aria-current={page === name ? "page" : undefined}
              title={name}
              disabled={busy}
              onClick={() => navigate(name)}
            >
              <Icon size={19} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ShieldCheck size={17} />
          <div>
            <strong>
              {privacy.mode === "strict-local"
                ? "Strict Local"
                : "Local workspace"}
            </strong>
            <span>On this Mac</span>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header>
          <div className="page-name">
            <IconButton
              label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? (
                <PanelLeftOpen size={19} />
              ) : (
                <PanelLeftClose size={19} />
              )}
            </IconButton>
            <h1 ref={heading} tabIndex={-1}>
              {page}
            </h1>
          </div>
          <div className="header-actions">
            <span className="save-indicator" role="status">
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}
              {busy ? "Saving..." : saved ? "Saved on this Mac" : "Local"}
            </span>
            <button
              className="record-button"
              disabled={
                busy ||
                !recording.state ||
                !!recording.state.active ||
                !!recording.state.processingId ||
                !!recording.state.importing
              }
              title="New local recording"
              onClick={beginRecording}
            >
              <Mic size={16} />
              <span>Record</span>
            </button>
          </div>
        </header>
        <RecordingBar
          status={recording.state}
          stop={stopRecording}
          open={openRecording}
        />
        <main
          className={`page-content ${["Today", "Notes"].includes(page) ? "notebook-content" : ""}`}
        >
          {error && (
            <Failure error={error} retry={() => reload().catch(() => {})} />
          )}
          {page === "Today" && (
            <>
              {!workspace.preferences.welcomeDismissed && (
                <WelcomeNotice
                  busy={busy}
                  dismiss={dismissWelcome}
                  learnMore={() => setWorkspaceGuide(true)}
                />
              )}
              <DueActions
                workspaceId={workspace.id}
                refreshKey={state.sequence}
                open={() => navigate("Actions")}
              />
              <PeopleBand
                workspaceId={workspace.id}
                refreshKey={state.sequence}
                open={() => navigate("People")}
              />
            </>
          )}
          {page === "Settings" ? (
            <Preferences
              key={workspace.id}
              workspace={workspace}
              privacy={privacy}
              run={run}
              saved={saved}
              models={models}
              openGuide={() => setWorkspaceGuide(true)}
              openClipboard={() => navigate("Clipboard history")}
              openWorkspace={switchWorkspace}
            />
          ) : page === "Clipboard history" ? (
            <ClipboardHistory settings={() => navigate("Settings")} />
          ) : ["Today", "Notes"].includes(page) ? (
            <Notebook
              key={`${workspace.id}:${page}`}
              workspace={workspace}
              today={page === "Today"}
              refreshKey={state.sequence}
              flushRef={flushRef}
              initialNoteId={initialNoteId}
              noteOpened={() => setInitialNoteId(null)}
              tabs={noteTabs}
              setTabs={setNoteTabs}
              activeKey={activeNoteTab}
              setActiveKey={setActiveNoteTab}
              openPerson={(id) => {
                setPersonTarget(id);
                setPage("People");
              }}
            />
          ) : page === "Recordings" ? (
            <Recordings
              key={workspace.id}
              workspace={workspace}
              selectedId={selectedRecording}
              select={setSelectedRecording}
              status={recording.state}
              revision={recording.revision}
              setupModel={() => setModelDialog(true)}
              openNote={(id) => {
                setInitialNoteId(id);
                setPage("Notes");
              }}
              openPerson={(id) => {
                setPersonTarget(id);
                setPage("People");
              }}
            />
          ) : page === "People" ? (
            <People
              key={`${workspace.id}:${personTarget ?? ""}`}
              initialPersonId={personTarget}
              speakersReady={models ? !!models.diarization?.ready : undefined}
              setupModel={() => setModelDialog(true)}
              workspace={workspace}
              refreshKey={state.sequence}
              openAction={(item) => {
                setActionTarget({ id: item.id, view: item.view });
                setPage("Actions");
              }}
              openRecording={(id) => {
                setSelectedRecording(id);
                setPage("Recordings");
              }}
            />
          ) : page === "Actions" ? (
            <Actions
              key={`${workspace.id}:${actionTarget?.id ?? ""}`}
              workspace={workspace}
              initial={actionTarget}
              refreshKey={state.sequence}
              openNote={(id) => {
                setInitialNoteId(id);
                setPage("Notes");
              }}
              openRecording={(id) => {
                setSelectedRecording(id);
                setPage("Recordings");
              }}
            />
          ) : (
            <Overview
              key={`${workspace.id}:${page}`}
              page={page}
              workspace={workspace}
              refreshKey={state.sequence}
            />
          )}
        </main>
        <footer>
          <span>
            <HardDrive size={13} />
            {workspace.name}
          </span>
          <span>Stored locally</span>
        </footer>
      </div>
      {creating && (
        <NewWorkspace
          close={() => setCreating(false)}
          create={(name) =>
            run(() => unwrap(api.workspace.create({ name }))).then(() =>
              navigate("Today"),
            )
          }
        />
      )}
      {recordDialog && (
        <RecordDialog
          setupModel={() => {
            setModelDialog(true);
          }}
          workspace={workspace}
          status={recording.state}
          close={() => setRecordDialog(false)}
          started={(record) => {
            setSelectedRecording(record.id);
            setPage("Recordings");
          }}
        />
      )}
      {modelDialog && (
        <ModelDialog
          state={models}
          privacy={privacy}
          close={() => setModelDialog(false)}
          returnToRecording={recordDialog}
        />
      )}
      {workspaceGuide && <WorkspaceGuide close={() => setWorkspaceGuide(false)} />}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
