import React, { useEffect, useRef, useState } from "react";
import {
  Plus,
  Check,
  Clock3,
  CircleCheck,
  RotateCcw,
  Trash2,
  X,
  Quote,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  LoaderCircle,
  BellOff,
} from "lucide-react";
import "./actions.css";
const api = window.focusbaeWorkspace;
const views = [
  ["review", "Review"],
  ["mine", "My actions"],
  ["waiting", "Waiting on"],
  ["unassigned", "Unassigned"],
  ["completed", "Completed"],
  ["archived", "Archived"],
];
const priorities = ["low", "medium", "high", "urgent"];
const unwrap = async (promise) => {
  const result = await promise;
  if (!result.ok)
    throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
};
const context = (workspaceId, revision) => ({
  workspaceId,
  clientRequestId: crypto.randomUUID(),
  ...(revision ? { expectedRevision: revision } : {}),
});
const ownerName = (action) =>
  action.owner.kind === "self"
    ? "Me"
    : action.owner.kind === "person"
      ? action.ownerLabel || "Someone else"
      : "Unassigned";
const due = (action) => {
  if (action.dueDate)
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(`${action.dueDate}T12:00:00.000Z`));
  if (action.dueAt)
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: action.dueTimezone,
    }).format(new Date(action.dueAt));
  return "No due date";
};
function Tool({ label, icon: Icon, ...props }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon size={17} />
    </button>
  );
}
function Fields({ value, setValue, disabled, titleId = "action-title" }) {
  const setOwner = (kind) =>
    setValue((old) => ({
      ...old,
      owner: {
        kind,
        id:
          kind === "person"
            ? old.owner.kind === "person"
              ? old.owner.id
              : crypto.randomUUID()
            : null,
      },
      ownerLabel: kind === "person" ? old.ownerLabel || "" : null,
    }));
  return (
    <div className="action-fields">
      <label htmlFor={titleId}>Action</label>
      <textarea
        id={titleId}
        value={value.title}
        maxLength={1000}
        rows={2}
        required
        disabled={disabled}
        onChange={(event) =>
          setValue((old) => ({ ...old, title: event.target.value }))
        }
      />
      <div className="action-field-grid">
        <div>
          <label htmlFor={`${titleId}-owner`}>Owner</label>
          <select
            id={`${titleId}-owner`}
            value={value.owner.kind}
            disabled={disabled}
            onChange={(event) => setOwner(event.target.value)}
          >
            <option value="self">Me</option>
            <option value="person">Someone else</option>
            <option value="unknown">Unassigned</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${titleId}-due`}>Due date</label>
          <input
            id={`${titleId}-due`}
            type="date"
            value={value.dueDate ?? ""}
            disabled={disabled}
            onChange={(event) =>
              setValue((old) => ({
                ...old,
                dueDate: event.target.value || null,
              }))
            }
          />
        </div>
        <div>
          <label htmlFor={`${titleId}-priority`}>Priority</label>
          <select
            id={`${titleId}-priority`}
            value={value.priority}
            disabled={disabled}
            onChange={(event) =>
              setValue((old) => ({ ...old, priority: event.target.value }))
            }
          >
            {priorities.map((priority) => (
              <option key={priority} value={priority}>
                {priority[0].toUpperCase() + priority.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {value.owner.kind === "person" && (
        <div className="owner-name">
          <label htmlFor={`${titleId}-owner-name`}>Person</label>
          <input
            id={`${titleId}-owner-name`}
            value={value.ownerLabel ?? ""}
            maxLength={200}
            required
            disabled={disabled}
            onChange={(event) =>
              setValue((old) => ({ ...old, ownerLabel: event.target.value }))
            }
          />
        </div>
      )}
    </div>
  );
}
function NewAction({ workspaceId, close, created }) {
  const ref = useRef(null);
  const [value, setValue] = useState({
    title: "",
    owner: { kind: "self", id: null },
    ownerLabel: null,
    dueDate: null,
    priority: "medium",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => ref.current.showModal(), []);
  return (
    <dialog
      ref={ref}
      className="action-dialog"
      aria-labelledby="new-action-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const action = await unwrap(
              api.actions.create({
                context: context(workspaceId),
                action: value,
              }),
            );
            created(action);
            close();
          } catch (failure) {
            setError(failure);
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <h2 id="new-action-heading">New action</h2>
          <Tool
            label="Close new action"
            icon={X}
            onClick={close}
            disabled={busy}
          />
        </div>
        <Fields
          value={value}
          setValue={setValue}
          disabled={busy}
          titleId="new-action-title"
        />
        {error && (
          <p className="action-error" role="alert">
            {error.message}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={
              busy ||
              !value.title.trim() ||
              (value.owner.kind === "person" && !value.ownerLabel?.trim())
            }
          >
            {busy ? "Saving..." : "Create action"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
// `initial` opens a specific action (from People) in its list view.
export function Actions({ workspace, refreshKey, openRecording, openNote, initial }) {
  const [view, setView] = useState(initial?.view ?? "mine");
  const [listing, setListing] = useState(null);
  const [selectedId, setSelectedId] = useState(initial?.id ?? null);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(null);
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dueActions, setDueActions] = useState(null);
  useEffect(() => {
    let current = true;
    setListing(null);
    unwrap(
      api.actions.browse({
        workspaceId: workspace.id,
        view,
        offset,
        limit: 50,
      }),
    )
      .then((value) => {
        if (!current) return;
        setListing(value);
        if (selectedId && !value.items.some((item) => item.id === selectedId)) {
          setSelectedId(null);
          setDetail(null);
          setDraft(null);
        }
      })
      .catch((failure) => current && setError(failure));
    return () => {
      current = false;
    };
  }, [workspace.id, view, offset, version, refreshKey]);
  useEffect(() => {
    let current = true;
    unwrap(api.reminders.due({ workspaceId: workspace.id }))
      .then((value) => current && setDueActions(value))
      .catch((failure) => current && setError(failure));
    return () => {
      current = false;
    };
  }, [workspace.id, version, refreshKey]);
  useEffect(() => {
    if (!selectedId) return;
    let current = true;
    unwrap(api.actions.get({ workspaceId: workspace.id, id: selectedId }))
      .then((value) => {
        if (!current) return;
        setDetail(value);
        setDraft({
          title: value.action.title,
          owner: value.action.owner,
          ownerLabel: value.action.ownerLabel,
          dueDate: value.action.dueDate,
          priority: value.action.priority,
        });
        setError(null);
      })
      .catch((failure) => current && setError(failure));
    return () => {
      current = false;
    };
  }, [workspace.id, selectedId, version, refreshKey]);
  const mutate = async (request, after) => {
    setBusy(true);
    setError(null);
    try {
      const value = await unwrap(request);
      setVersion((old) => old + 1);
      after?.(value);
      return value;
    } catch (failure) {
      setError(failure);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const transition = (status, reopen = false) =>
    mutate(
      api.actions.transition({
        context: context(workspace.id, detail.action.revision),
        id: detail.action.id,
        status,
        ...(reopen ? { reopen: true } : {}),
      }),
    );
  const action = detail?.action;
  const dirty =
    action &&
    draft &&
    JSON.stringify({
      title: action.title,
      owner: action.owner,
      ownerLabel: action.ownerLabel,
      dueDate: action.dueDate,
      priority: action.priority,
    }) !== JSON.stringify(draft);
  return (
    <div
      className={`actions-workspace ${selectedId ? "has-selection" : ""}`}
      aria-busy={busy}
    >
      <section className="action-library" aria-label="Action library">
        <div className="action-library-heading">
          <div>
            <h2>Actions</h2>
            <p className="muted">Stored in {workspace.name}</p>
          </div>
          <Tool
            label="New action"
            icon={Plus}
            disabled={busy}
            onClick={() => setCreating(true)}
          />
        </div>
        <div className="action-tabs" role="tablist" aria-label="Action view">
          {views.map(([name, label]) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={view === name}
              onClick={() => {
                setView(name);
                setOffset(0);
                setSelectedId(null);
              }}
            >
              <span>{label}</span>
              <small>{listing?.counts?.[name] ?? 0}</small>
            </button>
          ))}
        </div>
        {!!(dueActions?.overdue || dueActions?.today) && (
          <div className="action-due-summary" role="status">
            <Clock3 size={15} />
            <span>
              {dueActions.overdue ? `${dueActions.overdue} overdue` : ""}
              {dueActions.overdue && dueActions.today ? " · " : ""}
              {dueActions.today ? `${dueActions.today} due today` : ""}
            </span>
          </div>
        )}
        {error && !detail && (
          <p className="action-error" role="alert">
            {error.message}
          </p>
        )}
        {!listing ? (
          <div className="action-loading" role="status">
            <LoaderCircle className="spin" size={18} /> Loading actions...
          </div>
        ) : !listing.items.length ? (
          <div className="action-empty">
            <CircleCheck size={27} strokeWidth={1.4} />
            <p>
              No {views.find(([name]) => name === view)[1].toLowerCase()} here
            </p>
          </div>
        ) : (
          <div className="action-rows">
            {listing.items.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-current={selectedId === item.id ? "true" : undefined}
                onClick={() => setSelectedId(item.id)}
              >
                <span className={`action-check action-check-${item.status}`}>
                  {item.status === "done" ? <Check size={14} /> : null}
                </span>
                <span className="action-row-copy">
                  <strong>{item.title}</strong>
                  <small>
                    {ownerName(item)} · {due(item)}
                  </small>
                </span>
                <span className={`priority priority-${item.priority}`}>
                  {item.priority}
                </span>
              </button>
            ))}
          </div>
        )}
        {listing?.total > 50 && (
          <div className="pagination">
            <Tool
              label="Previous actions"
              icon={ChevronLeft}
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            />
            <span>{offset / 50 + 1}</span>
            <Tool
              label="Next actions"
              icon={ChevronRight}
              disabled={offset + 50 >= listing.total}
              onClick={() => setOffset(offset + 50)}
            />
          </div>
        )}
      </section>
      <section className="action-detail" aria-label="Action detail">
        {!selectedId ? (
          <div className="action-empty action-detail-empty">
            <Quote size={29} strokeWidth={1.3} />
            <p>Select an action</p>
          </div>
        ) : !action || !draft ? (
          <div className="action-loading" role="status">
            <LoaderCircle className="spin" size={18} /> Opening action...
          </div>
        ) : (
          <>
            <div className="action-detail-heading">
              <div>
                <Tool
                  label="Back to actions"
                  icon={ArrowLeft}
                  onClick={() => setSelectedId(null)}
                />
                <span
                  className={`action-status action-status-${action.status}`}
                >
                  {action.status}
                </span>
                <span className="muted">
                  {action.origin === "model"
                    ? "AI suggestion"
                    : action.origin === "local-model"
                      ? "On-device AI suggestion"
                      : action.origin === "local-rule"
                        ? "Local suggestion"
                        : "Created by you"}
                </span>
              </div>
              <Tool
                label="Delete action"
                icon={Trash2}
                disabled={busy}
                onClick={() =>
                  mutate(
                    api.actions.delete({
                      context: context(workspace.id, action.revision),
                      id: action.id,
                    }),
                    (value) => {
                      if (value.deleted) {
                        setSelectedId(null);
                        setDetail(null);
                      }
                    },
                  )
                }
              />
            </div>
            <Fields value={draft} setValue={setDraft} disabled={busy} />
            {error && (
              <p className="action-error" role="alert">
                {error.message}
              </p>
            )}
            <div className="action-commands">
              {dirty && (
                <button
                  type="button"
                  className="primary"
                  disabled={
                    busy ||
                    !draft.title.trim() ||
                    (draft.owner.kind === "person" && !draft.ownerLabel?.trim())
                  }
                  onClick={() =>
                    mutate(
                      api.actions.update({
                        context: context(workspace.id, action.revision),
                        id: action.id,
                        changes: draft,
                      }),
                    )
                  }
                >
                  Save changes
                </button>
              )}
              {action.status === "proposed" && (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      busy ||
                      dirty ||
                      action.owner.kind === "unknown" ||
                      action.sourceState !== "current"
                    }
                    onClick={() => transition("accepted")}
                  >
                    <Check size={16} /> Accept
                  </button>
                  <button
                    type="button"
                    disabled={busy || dirty}
                    onClick={() => transition("dropped")}
                  >
                    <X size={16} /> Dismiss
                  </button>
                </>
              )}
              {action.status === "accepted" && (
                <>
                  <button
                    type="button"
                    disabled={busy || dirty}
                    onClick={() => transition("deferred")}
                  >
                    <Clock3 size={16} /> Defer
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || dirty}
                    onClick={() => transition("done")}
                  >
                    <CircleCheck size={16} /> Complete
                  </button>
                </>
              )}
              {["accepted", "deferred"].includes(action.status) &&
                action.owner.kind === "self" &&
                dueActions?.items.some((item) => item.id === action.id) && (
                  <button
                    type="button"
                    disabled={busy || dirty}
                    onClick={() =>
                      mutate(
                        api.reminders.snooze({
                          context: context(workspace.id),
                          id: action.id,
                          until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                        }),
                      )
                    }
                  >
                    <BellOff size={16} /> Snooze one day
                  </button>
                )}
              {action.status === "deferred" && (
                <>
                  <button
                    type="button"
                    disabled={busy || dirty}
                    onClick={() => transition("accepted")}
                  >
                    <RotateCcw size={16} /> Resume
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || dirty}
                    onClick={() => transition("done")}
                  >
                    <CircleCheck size={16} /> Complete
                  </button>
                </>
              )}
              {["done", "dropped"].includes(action.status) && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || dirty}
                  onClick={() => transition("accepted", true)}
                >
                  <RotateCcw size={16} /> Reopen
                </button>
              )}
            </div>
            {action.status === "proposed" &&
              action.owner.kind === "unknown" && (
                <p className="action-notice">
                  Choose an owner and save before accepting.
                </p>
              )}
            {action.sourceState !== "none" &&
              action.sourceState !== "current" && (
                <p className="action-notice">
                  The source is {action.sourceState}. Review it before relying
                  on this action.
                </p>
              )}
            {detail.restatements?.count > 1 && (
              <section className="action-restated" aria-label="Promise history">
                <div className="section-heading">
                  <h3>Promised {detail.restatements.count} times</h3>
                  <span className="muted">Same commitment, restated</span>
                </div>
                <ol>
                  {detail.restatements.items.map((item, index) => (
                    <li key={item.id} aria-current={item.current ? "true" : undefined}>
                      <span className="action-restated-when">
                        {new Intl.DateTimeFormat("en", {
                          month: "short",
                          day: "numeric",
                          timeZone: workspace.preferences.timezone,
                        }).format(new Date(item.createdAt))}
                      </span>
                      <span>
                        {item.title}
                        {item.current ? " · this one" : ""}
                      </span>
                      {index === 0 && <small>first promised</small>}
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <div className="action-evidence">
              <div className="section-heading">
                <h3>Source evidence</h3>
                <span className="muted">
                  {detail.evidence.length || "None"}
                </span>
              </div>
              {!detail.evidence.length ? (
                <p className="muted">Manually created action</p>
              ) : (
                detail.evidence.map((source) => (
                  <blockquote key={`${source.segmentId}:${source.startOffset}`}>
                    <Quote size={16} />
                    <div>
                      <p>{source.quote}</p>
                      <span>
                        {source.sourceKind === "note"
                          ? source.available
                            ? `Written on ${source.noteTitle || "an untitled page"}`
                            : "Source page unavailable"
                          : source.available
                            ? `${source.recordingTitle ? `Said in ${source.recordingTitle}` : source.source} · ${Math.floor(source.segmentStartMs / 60000)}:${String(Math.floor(source.segmentStartMs / 1000) % 60).padStart(2, "0")}`
                            : "Source recording unavailable"}
                      </span>
                    </div>
                    {source.available &&
                      (source.sourceKind === "note" ? (
                        <Tool
                          label="Open source page"
                          icon={ArrowUpRight}
                          onClick={() => openNote(source.noteId)}
                        />
                      ) : (
                        <Tool
                          label="Open source recording"
                          icon={ArrowUpRight}
                          onClick={() => openRecording(source.recordingId)}
                        />
                      ))}
                  </blockquote>
                ))
              )}
            </div>
          </>
        )}
      </section>
      {creating && (
        <NewAction
          workspaceId={workspace.id}
          close={() => setCreating(false)}
          created={(action) => {
            setView(
              action.owner.kind === "self"
                ? "mine"
                : action.owner.kind === "person"
                  ? "waiting"
                  : "unassigned",
            );
            setOffset(0);
            setSelectedId(action.id);
            setVersion((old) => old + 1);
          }}
        />
      )}
    </div>
  );
}
