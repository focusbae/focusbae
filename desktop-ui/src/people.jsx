import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  AudioLines,
  Download,
  FileText,
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
const nameKey = (name) => name.trim().replace(/\s+/g, " ").toLowerCase();

// What a person page adds beyond this Mac's own ledger: the pages that link to them,
// and, in a team workspace, teammates' open promises involving them as last synced.
// Both are limited to what this person can already read.
function PersonExtras({ workspace, name, shared, pages, openNote, timezone }) {
  const [team, setTeam] = useState(null);
  const [found, setFound] = useState(pages ?? null);
  useEffect(() => {
    let current = true;
    if (shared) unwrap(api.team.person({ workspaceId: workspace.id, name })).then((value) => current && setTeam(value)).catch(() => {});
    if (!pages) unwrap(api.people.pages({ workspaceId: workspace.id, name })).then((value) => current && setFound(value)).catch(() => {});
    return () => {
      current = false;
    };
  }, [workspace.id, name, shared, pages]);
  // Each list names the other side only: "to Alice" under what Priya owes.
  const teamItems = (items, title, other) => !items.length ? null : (
    <section className="person-section" aria-label={title}>
      <div className="section-heading">
        <h3>{title}</h3>
        <span className="muted">{items.length}</span>
      </div>
      <ul className="person-items">
        {items.map((item) => (
          <li key={item.id}>
            <div className="person-item-copy">
              <strong>{item.title}</strong>
              <small>
                {[other(item), dueLabel(item, timezone),
                  item.sourceTitle ? `from ${item.sourceTitle}` : null].filter(Boolean).join(" · ")}
              </small>
              {item.quote && <q>{item.quote}</q>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <>
      {team && (
        <>
          {teamItems(team.owes, `${name} owes, on the team ledger`, (item) => item.counterparty && `to ${item.counterparty}`)}
          {teamItems(team.owed, `Owed to ${name}, on the team ledger`, (item) => item.owner && `from ${item.owner}`)}
        </>
      )}
      <section className="person-section" aria-label="Pages that mention them">
        <div className="section-heading">
          <h3>Pages that mention {name}</h3>
          <span className="muted">{found?.length ?? ""}</span>
        </div>
        {!found ? null : !found.length ? (
          <p className="muted person-empty">Write [[{name}]] in a page to link it here.</p>
        ) : (
          <ul className="person-items">
            {found.map((page) => (
              <li key={page.id}>
                <div className="person-item-copy">
                  <strong>{page.title || "Untitled page"}</strong>
                  {page.authorName && <small>{page.authorName}&apos;s page</small>}
                </div>
                <div className="person-item-tools">
                  <button type="button" aria-label={`Open ${page.title || "page"}`} onClick={() => openNote?.(page.id)}>
                    <FileText size={14} /> Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
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
  shared,
  openNote,
}) {
  const [listing, setListing] = useState(null);
  const [selected, setSelected] = useState(initialPersonId ?? null);
  // Someone known only from the team ledger: no local history, so no local id.
  const [teamOnly, setTeamOnly] = useState(null);
  const [teamPeople, setTeamPeople] = useState([]);
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
    let current = true;
    if (shared) unwrap(api.team.people({ workspaceId: workspace.id })).then((value) => current && setTeamPeople(value ?? [])).catch(() => {});
    return () => {
      current = false;
    };
  }, [workspace.id, shared, refreshKey]);
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
  const localNames = new Set((listing?.items ?? []).map((person) => nameKey(person.name)));
  const teamRows = teamPeople.filter((person) => !localNames.has(nameKey(person.name)) && (person.owes || person.owed || person.isMember));
  if (teamOnly) {
    return (
      <section className="people-page" aria-label="Person">
        <button type="button" className="icon-button" aria-label="Back to people" title="Back to people" onClick={() => setTeamOnly(null)}>
          <ArrowLeft size={17} />
        </button>
        <div className="person-heading">
          <h2>{teamOnly.name}</h2>
          <p className="muted">{[teamOnly.isMember ? "Teammate" : "Contact", teamOnly.email].filter(Boolean).join(" · ")}</p>
        </div>
        <PersonExtras workspace={workspace} name={teamOnly.name} shared={shared} openNote={openNote} timezone={timezone} />
      </section>
    );
  }
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
            <PersonExtras workspace={workspace} name={detail.person.name} shared={shared} pages={detail.pages} openNote={openNote} timezone={timezone} />
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
      ) : !listing.items.length && !teamRows.length ? (
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
          {teamRows.map((person) => (
            <li key={`team:${person.id}`}>
              <button type="button" onClick={() => setTeamOnly(person)}>
                <span className="person-initial" aria-hidden="true">
                  {person.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="person-row-copy">
                  <strong>{person.name}</strong>
                  <small>
                    {[person.owes ? `owes ${person.owes}` : null, person.owed ? `owed ${person.owed}` : null].filter(Boolean).join(" · ") || "Nothing open"} · on the team ledger
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
