import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  AudioLines,
  Download,
  LoaderCircle,
  UsersRound,
} from "lucide-react";
import "./people.css";
const api = window.focusbaeWorkspace;
const unwrap = async (promise) => {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const STATUS = { proposed: "Suggestion", accepted: "Open", deferred: "Deferred", done: "Done", dropped: "Dismissed" };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
function dueLabel(item, timezone) {
  if (item.dueDate) {
    const [year, month, day] = item.dueDate.split("-").map(Number);
    return `Due ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day))}`;
  }
  if (item.dueAt)
    return `Due ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: timezone }).format(new Date(item.dueAt))}`;
  return "No due date";
}
function Counts({ person }) {
  const parts = [];
  if (person.theyOwe) parts.push(`owes you ${person.theyOwe}`);
  if (person.youOwe) parts.push(`you owe ${person.youOwe}`);
  if (person.review) parts.push(`${person.review} to review`);
  return <span>{parts.length ? parts.join(" · ") : "Nothing open"}</span>;
}
function Items({ title, empty, items, timezone, openAction, openRecording }) {
  return (
    <section className="person-section" aria-label={title}>
      <div className="section-heading">
        <h3>{title}</h3>
        <span className="muted">{items.length}</span>
      </div>
      {!items.length ? (
        <p className="muted person-empty">{empty}</p>
      ) : (
        <ul className="person-items">
          {items.map((item) => (
            <li key={item.id}>
              <div className="person-item-copy">
                <strong>{item.title}</strong>
                <small>
                  {STATUS[item.status] ?? item.status} ·{" "}
                  {dueLabel(item, timezone)}
                  {item.promised > 1 ? ` · promised ${item.promised} times` : ""}
                </small>
                {item.quote && <q>{item.quote}</q>}
              </div>
              <div className="person-item-tools">
                {item.recordingId && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Open recording for ${item.title}`}
                    title={item.recordingTitle ? `Open ${item.recordingTitle}` : "Open recording"}
                    onClick={() => openRecording(item.recordingId)}
                  >
                    <AudioLines size={16} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Open action ${item.title}`}
                  onClick={() => openAction(item)}
                >
                  Open <ArrowUpRight size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
// `initialPersonId` opens straight to one person (from a recording's prior context).
export function People({
  workspace,
  refreshKey,
  openAction,
  openRecording,
  initialPersonId,
  speakersReady,
  setupModel,
}) {
  const [listing, setListing] = useState(null);
  const [selected, setSelected] = useState(initialPersonId ?? null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let current = true;
    unwrap(api.people.list({ workspaceId: workspace.id }))
      .then((value) => {
        if (!current) return;
        setListing(value);
        setError(null);
      })
      .catch((failure) => current && setError(failure));
    return () => {
      current = false;
    };
  }, [workspace.id, refreshKey]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let current = true;
    unwrap(api.people.get({ workspaceId: workspace.id, id: selected }))
      .then((value) => current && setDetail(value))
      .catch((failure) => {
        if (!current) return;
        setError(failure);
        setSelected(null);
      });
    return () => {
      current = false;
    };
  }, [workspace.id, selected, refreshKey]);
  const timezone = workspace.preferences.timezone;
  if (selected) {
    return (
      <section className="people-page" aria-label="Person">
        <button
          type="button"
          className="icon-button"
          aria-label="Back to people"
          title="Back to people"
          onClick={() => setSelected(null)}
        >
          <ArrowLeft size={17} />
        </button>
        {!detail ? (
          <p role="status" className="muted">
            <LoaderCircle className="spin" size={16} /> Loading...
          </p>
        ) : (
          <>
            <div className="person-heading">
              <h2>{detail.person.name}</h2>
              <p className="muted">
                <Counts person={detail.person} />
                {detail.person.recordings
                  ? ` · in ${plural(detail.person.recordings, "recording")}`
                  : ""}
              </p>
            </div>
            <Items
              title={`${detail.person.name} owes you`}
              empty="Nothing open."
              items={detail.theyOwe}
              timezone={timezone}
              openAction={openAction}
              openRecording={openRecording}
            />
            <Items
              title={`You owe ${detail.person.name}`}
              empty="Nothing open."
              items={detail.youOwe}
              timezone={timezone}
              openAction={openAction}
              openRecording={openRecording}
            />
            {!!detail.review.length && (
              <Items
                title="Suggestions to review"
                items={detail.review}
                timezone={timezone}
                openAction={openAction}
                openRecording={openRecording}
              />
            )}
            {!!detail.done.length && (
              <Items
                title="Recently done"
                items={detail.done}
                timezone={timezone}
                openAction={openAction}
                openRecording={openRecording}
              />
            )}
          </>
        )}
      </section>
    );
  }
  return (
    <section className="people-page" aria-label="People">
      <div className="section-heading">
        <h2>People</h2>
        <span className="muted">
          Who owes what, from your recordings and actions
        </span>
      </div>
      {error && (
        <p role="alert" className="action-error">
          {error.message}
        </p>
      )}
      {!listing ? (
        <p role="status" className="muted">
          <LoaderCircle className="spin" size={16} /> Loading people...
        </p>
      ) : !listing.items.length ? (
        <div className="empty">
          <UsersRound size={32} strokeWidth={1.4} />
          <h3>No people yet</h3>
          <p>
            Name a speaker in a recording, or give an action an owner, and they
            will appear here.
          </p>
          {/* Without speaker detection there is nobody to name, so this stays
              empty however many conversations are recorded. */}
          {speakersReady === false && (
            <p className="people-blocked">
              Speaker detection is not installed, so recordings have no speakers
              to name.
              <button type="button" onClick={setupModel}>
                <Download size={15} /> Set up speaker detection
              </button>
            </p>
          )}
        </div>
      ) : (
        <ul className="people-rows">
          {listing.items.map((person) => (
            <li key={person.id}>
              <button type="button" onClick={() => setSelected(person.id)}>
                <span className="person-initial" aria-hidden="true">
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="person-row-copy">
                  <strong>{person.name}</strong>
                  <small>
                    <Counts person={person} />
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
