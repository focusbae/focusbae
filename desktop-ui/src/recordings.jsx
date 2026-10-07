import React, { useEffect, useRef, useState } from "react";
import {
  Mic,
  Square,
  X,
  AudioLines,
  ArrowLeft,
  RotateCcw,
  Trash2,
  NotebookPen,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Download,
  Upload,
} from "lucide-react";
import "./recordings.css";
import { AudioPlayer } from "./audio-player";
const api = window.focusbaeWorkspace;
const purposeName = {
  conversation: "Conversation",
  personal: "Voice note",
  learning: "Learning",
};
const sourceName = {
  microphone: "Microphone",
  system: "System audio",
  both: "Microphone + system audio",
  import: "Imported WAV",
};
const storageSize = (bytes) => bytes === 0 ? "0 KB" : bytes < 1048576
  ? `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`;
const unwrap = async (promise) => {
  const result = await promise;
  if (!result.ok)
    throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
};
const time = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
// Readiness for a recording's language (English, Hindi, mixed); falls back to the
// English summary when the status predates per-language routing.
const speechReady = (status, language) =>
  status?.model.languages?.[language]?.ready ?? !!status?.model.ready;
function Tool({ label, icon: Icon, ...props }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      <Icon size={17} />
    </button>
  );
}
function RecordingName({ record, workspaceId, saved }) {
  const [value, setValue] = useState(record.title ?? "");
  const [failure, setFailure] = useState(null);
  useEffect(() => setValue(record.title ?? ""), [record.id, record.title]);
  const save = async () => {
    const next = value.trim();
    if (next === (record.title ?? "")) return setValue(next);
    try {
      saved(await unwrap(api.capture.rename({ workspaceId, id: record.id, title: next })));
      setFailure(null);
    } catch (error) {
      setFailure(error.message);
      setValue(record.title ?? "");
    }
  };
  return (
    <>
      <input
        className="recording-name"
        aria-label="Recording name"
        maxLength={200}
        value={value}
        placeholder={purposeName[record.purpose]}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setValue(record.title ?? "");
            requestAnimationFrame(() => event.target.blur());
          }
        }}
      />
      {failure && <p role="alert" className="error">{failure}</p>}
    </>
  );
}
export function useRecording() {
  const [state, setState] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    unwrap(api.capture.state())
      .then((value) => {
        if (alive) setState(value);
      })
      .catch(() => {});
    const off = api.onRecording((value) => {
      setState(value);
      setRevision((old) => old + 1);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return { state, revision };
}
export function RecordDialog({
  workspace,
  status,
  close,
  started,
  setupModel,
}) {
  const ref = useRef(null);
  const [purpose, setPurpose] = useState("conversation");
  const [source, setSource] = useState("microphone");
  const [destination, setDestination] = useState("today");
  const [language, setLanguage] = useState("english");
  const [consent, setConsent] = useState(false);
  const [keepAudio, setKeepAudio] = useState(false);
  const [notes, setNotes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Opening the record form is a user action, so engine availability may be probed here.
  useEffect(() => {
    api?.models.refresh().catch(() => {});
  }, []);
  useEffect(() => {
    ref.current.showModal();
    let alive = true;
    unwrap(api.notes.browse({ workspaceId: workspace.id, limit: 100 }))
      .then((result) => {
        if (alive) setNotes(result.items);
      })
      .catch(setError);
    return () => {
      alive = false;
    };
  }, [workspace.id]);
  return (
    <dialog
      className="record-dialog"
      ref={ref}
      aria-label="New recording"
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
            const value = await unwrap(
              api.capture.start({
                context: {
                  workspaceId: workspace.id,
                  clientRequestId: crypto.randomUUID(),
                },
                purpose,
                sourceMode: source,
                language,
                consent,
                keepAudio,
                destination: ["today", "standalone"].includes(destination)
                  ? { kind: destination }
                  : { kind: "note", noteId: destination },
              }),
            );
            started(value);
            close();
          } catch (failure) {
            setError(failure);
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <h2>New recording</h2>
          <Tool
            label="Close recording dialog"
            icon={X}
            type="button"
            disabled={busy}
            onClick={close}
          />
        </div>
        <label htmlFor="capture-purpose">Purpose</label>
        <select
          id="capture-purpose"
          value={purpose}
          disabled={busy}
          onChange={(event) => setPurpose(event.target.value)}
        >
          {Object.entries(purposeName).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor="capture-source">Audio source</label>
        <select
          id="capture-source"
          value={source}
          disabled={busy}
          onChange={(event) => setSource(event.target.value)}
        >
          <option
            value="microphone"
            disabled={!status?.capabilities.microphone.ok}
          >
            Microphone
          </option>
          <option value="system" disabled={!status?.capabilities.system.ok}>
            System audio
          </option>
          <option
            value="both"
            disabled={
              !status?.capabilities.system.ok ||
              !status?.capabilities.microphone.ok
            }
          >
            Microphone + system audio
          </option>
        </select>
        {source !== "microphone" && (
          <p className="muted">All system output, not a single meeting app.</p>
        )}
        <p className="capture-permission">
          {source === "microphone"
            ? "When you start, macOS may ask for microphone access."
            : source === "system"
              ? "When you start, macOS may ask for system audio recording access."
              : "When you start, macOS may ask for microphone and system audio recording access."}
        </p>
        <label htmlFor="capture-language">Speech language</label>
        <select
          id="capture-language"
          value={language}
          disabled={busy}
          onChange={(event) => setLanguage(event.target.value)}
        >
          <option value="english">English</option>
          <option value="hindi">Hindi</option>
          <option value="mixed">English + Hindi (experimental)</option>
        </select>
        <label htmlFor="capture-destination">Save with</label>
        <select
          id="capture-destination"
          value={destination}
          disabled={busy}
          onChange={(event) => setDestination(event.target.value)}
        >
          <option value="today">Today's note</option>
          <option value="standalone">Recordings only</option>
          {notes.map((note) => (
            <option key={note.id} value={note.id}>
              {note.title || "Untitled"}
            </option>
          ))}
        </select>
        <label className="consent-row retention-choice">
          <input type="checkbox" checked={keepAudio} disabled={busy}
            onChange={(event) => setKeepAudio(event.target.checked)} />
          <span>Keep audio for playback<small>Save the original audio on this Mac until you delete it. Included in workspace backups.</small></span>
        </label>
        {keepAudio ? <p className="capture-storage">Audio stays on this Mac after transcription so you can listen back. You can delete it later without losing your transcript or notes.</p> : <p className="capture-storage">
          Temporary audio stays on this Mac until transcription finishes.
          Unfinished audio is kept for recovery, including after 24 hours,
          unless you delete it. Recent uncommitted audio may be lost if the app
          stops unexpectedly.
        </p>}
        {!speechReady(status, language) && (
          <>
            <p className="model-status">
              {language === "english"
                ? "Transcription pending: speech setup needed"
                : "Transcription pending: Hindi needs Apple speech (macOS 26 or later)"}
              <button type="button" disabled={busy} onClick={setupModel}>
                <Download size={16} /> Set up speech
              </button>
            </p>
            <p className="capture-permission">
              You can record now and transcribe later. Speech setup may need a
              download; it only starts when you choose it.
            </p>
          </>
        )}
        <label className="consent-row">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            I have permission to record everyone included and acknowledge
            {keepAudio ? " local audio storage." : " temporary local audio storage."}
          </span>
        </label>
        {error && (
          <div role="alert" className="error">
            {error.message}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !consent}>
            <Mic size={16} />
            {busy ? "Preparing..." : "Start recording"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function ImportAudioDialog({ workspace, close, imported }) {
  const ref = useRef(null);
  const [purpose, setPurpose] = useState("conversation");
  const [destination, setDestination] = useState("today");
  const [language, setLanguage] = useState("english");
  const [keepAudio, setKeepAudio] = useState(false);
  const [consent, setConsent] = useState(false);
  const [notes, setNotes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    ref.current.showModal();
    let alive = true;
    unwrap(api.notes.browse({ workspaceId: workspace.id, limit: 100 }))
      .then((value) => alive && setNotes(value.items)).catch(setError);
    return () => { alive = false; };
  }, [workspace.id]);
  return <dialog className="record-dialog" ref={ref} aria-label="Import WAV recording"
    onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError(null);
      try {
        const result = await unwrap(api.capture.importWav({
          context: { workspaceId: workspace.id, clientRequestId: crypto.randomUUID() },
          purpose, language, keepAudio, consent,
          destination: ["today", "standalone"].includes(destination)
            ? { kind: destination } : { kind: "note", noteId: destination },
        }));
        if (!result.canceled) { imported(result.recording); close(); }
      } catch (failure) { setError(failure); }
      finally { setBusy(false); }
    }}>
      <div className="dialog-heading"><h2>Import WAV</h2><Tool label="Close import dialog" icon={X}
        type="button" disabled={busy} onClick={close} /></div>
      <p className="capture-storage">Import an uncompressed 16-bit PCM WAV, mono or stereo. FocusBae keeps the original file unchanged and creates its own local copy.</p>
      <label htmlFor="import-purpose">Purpose</label>
      <select id="import-purpose" value={purpose} disabled={busy} onChange={(event) => setPurpose(event.target.value)}>
        {Object.entries(purposeName).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
      <label htmlFor="import-language">Speech language</label>
      <select id="import-language" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value)}>
        <option value="english">English</option><option value="hindi">Hindi</option><option value="mixed">English + Hindi (experimental)</option>
      </select>
      <label htmlFor="import-destination">Save with</label>
      <select id="import-destination" value={destination} disabled={busy} onChange={(event) => setDestination(event.target.value)}>
        <option value="today">Today's note</option><option value="standalone">Recordings only</option>
        {notes.map((note) => <option key={note.id} value={note.id}>{note.title || "Untitled"}</option>)}
      </select>
      <label className="consent-row retention-choice"><input type="checkbox" checked={keepAudio} disabled={busy}
        onChange={(event) => setKeepAudio(event.target.checked)} /><span>Keep audio for playback<small>If turned off, FocusBae removes its copy after transcription. Your original WAV is unchanged.</small></span></label>
      <label className="consent-row"><input type="checkbox" checked={consent} disabled={busy}
        onChange={(event) => setConsent(event.target.checked)} /><span>I have permission to use and transcribe this audio.</span></label>
      {error && <div role="alert" className="error">{error.message}</div>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || !consent} type="submit"><Upload size={16} /> {busy ? "Importing…" : "Choose WAV & import"}</button></div>
    </form>
  </dialog>;
}
export function RecordingBar({ status, stop, open }) {
  const active = status?.active;
  if (!active) return null;
  return (
    <section className="capture-bar" aria-label="Active local recording">
      <button className="capture-open" onClick={() => open(active.id)}>
        <span className="recording-dot" />
        <span>
          {active.state === "preparing"
            ? "Checking audio..."
            : active.state === "stopping"
              ? "Saving audio..."
              : "Recording"}
          <small>
            {purposeName[active.purpose]} ·{" "}
            {time(Math.max(0, Date.now() - Date.parse(active.startedAt)))}
          </small>
        </span>
      </button>
      <div className="input-levels">
        {Object.entries(active.levels).map(([source, level]) => (
          <label key={source}>
            <span>{sourceName[source]}</span>
            <meter
              aria-label={`${sourceName[source]} input level`}
              min="0"
              max="1"
              value={level}
            />
          </label>
        ))}
      </div>
      <span className="durable-audio">{time(active.durableMs)} saved</span>
      <Tool
        label="Stop local recording"
        icon={Square}
        disabled={active.state === "stopping"}
        onClick={() => stop(active.id)}
      />
    </section>
  );
}
// Who each detected speaker is. Marking "This is me" lets suggestions be
// attributed to you; naming others makes them the owner of what they promised.
function SpeakerRow({ speaker, busy, identify }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(
    speaker.identity.kind === "person" ? speaker.identity.label : "",
  );
  const selectId = `speaker-${speaker.id}`;
  const kind = naming ? "person" : speaker.identity.kind;
  return (
    <li className="speaker-row">
      <label htmlFor={selectId}>{speaker.label}</label>
      <select
        id={selectId}
        value={kind}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "person") setNaming(true);
          else {
            setNaming(false);
            identify(speaker.id, { kind: next });
          }
        }}
      >
        <option value="unknown">Not identified</option>
        <option value="self">This is me</option>
        <option value="person">
          {speaker.identity.kind === "person" && !naming
            ? speaker.identity.label
            : "Someone else..."}
        </option>
      </select>
      {naming && (
        <form
          className="speaker-name"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            setNaming(false);
            identify(speaker.id, { kind: "person", label: name.trim() });
          }}
        >
          <input
            aria-label={`Name for ${speaker.label}`}
            value={name}
            maxLength={200}
            autoFocus
            placeholder="Name"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            Save
          </button>
        </form>
      )}
    </li>
  );
}
// What was already open with the people in this conversation, before it happened.
function PriorContext({ context, openPerson }) {
  if (!context?.items.length) return null;
  return (
    <section className="prior-context" aria-label="Already open with these people">
      <div className="section-heading">
        <h3>Already open with these people</h3>
        <span className="muted">Before this conversation</span>
      </div>
      <ul>
        {context.items.map((person) => (
          <li key={person.id}>
            <div>
              <button type="button" className="prior-person" onClick={() => openPerson(person.id)}>
                {person.name}
              </button>
              <small>
                {person.youOwe ? `you owe ${person.youOwe}` : ""}
                {person.youOwe && person.theyOwe ? " · " : ""}
                {person.theyOwe ? `owes you ${person.theyOwe}` : ""}
              </small>
            </div>
            <ul>
              {person.items.map((item) => (
                <li key={item.id}>
                  <span aria-hidden="true">{item.direction === "youOwe" ? "→" : "←"}</span>
                  <span>
                    {item.title}
                    {item.promised > 1 ? ` · promised ${item.promised} times` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
// Why there is nobody to assign. Without the model every line stays "Unknown
// speaker", and the section used to render nothing at all, which read as a bug.
function SpeakersUnavailable({ diarization, setupModel }) {
  if (!diarization || diarization.status === "complete") return null;
  const missing = diarization.reason === "MODEL_MISSING";
  return (
    <section className="speaker-list" aria-label="Speakers">
      <div className="section-heading">
        <h3>Speakers</h3>
        <span className="muted">Not detected</span>
      </div>
      <p className="muted speaker-unavailable">
        {missing
          ? "Speaker detection is not installed, so every line is an unknown speaker."
          : diarization.reason === "TOO_LONG"
            ? "This recording is longer than two hours, so speakers were not detected."
            : "Speakers could not be detected for this recording."}
        {missing && (
          <button type="button" onClick={setupModel}>
            <Download size={15} /> Set up speaker detection
          </button>
        )}
      </p>
    </section>
  );
}
function Speakers({ speakers, busy, identify }) {
  if (!speakers?.length) return null;
  const hasSelf = speakers.some((speaker) => speaker.identity.kind === "self");
  return (
    <section className="speaker-list" aria-label="Speakers">
      <div className="section-heading">
        <h3>Speakers</h3>
        <span className="muted">
          {hasSelf
            ? "Suggestions use these identities"
            : "Mark which speaker is you so suggestions can be assigned"}
        </span>
      </div>
      <ul>
        {speakers.map((speaker) => (
          <SpeakerRow
            key={`${speaker.id}:${speaker.identity.kind}:${speaker.identity.label ?? ""}`}
            speaker={speaker}
            busy={busy}
            identify={identify}
          />
        ))}
      </ul>
    </section>
  );
}
export function Recordings({
  workspace,
  selectedId,
  select,
  status,
  revision,
  openNote,
  openPerson,
  setupModel,
}) {
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [offset, setOffset] = useState(0);
  const [segmentOffset, setSegmentOffset] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState(null);
  const [context, setContext] = useState(null);
  const [showEchoes, setShowEchoes] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [storage, setStorage] = useState(null);
  const player = useRef(null);
  // Playback must not leak into a new capture or continue behind a deletion prompt.
  useEffect(() => { if (status?.active) player.current?.pause(); }, [status?.active?.id]);
  useEffect(() => {
    setSegmentOffset(0);
    setDetail(null);
    setNotice(null);
    setContext(null);
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    let current = true;
    unwrap(api.people.priorContext({ workspaceId: workspace.id, recordingId: selectedId }))
      .then((value) => current && setContext(value))
      .catch(() => current && setContext(null));
    return () => {
      current = false;
    };
  }, [workspace.id, selectedId, revision, attempt]);
  useEffect(() => {
    let current = true;
    const request = selectedId
      ? api.capture.detail({
          workspaceId: workspace.id,
          id: selectedId,
          offset: segmentOffset,
        })
      : api.capture.list({ workspaceId: workspace.id, offset });
    unwrap(request)
      .then((value) => {
        if (current) {
          selectedId ? setDetail(value) : setList(value);
          setError(null);
        }
      })
      .catch((failure) => {
        if (current) setError(failure);
      });
    return () => {
      current = false;
    };
  }, [workspace.id, selectedId, offset, segmentOffset, revision, attempt]);
  useEffect(() => {
    if (selectedId) return;
    let current = true;
    unwrap(api.capture.storage({ workspaceId: workspace.id }))
      .then((value) => current && setStorage(value)).catch(() => current && setStorage(null));
    return () => { current = false; };
  }, [workspace.id, selectedId, revision, attempt]);
  const run = async (method) => {
    if (method === "discard") player.current?.pause();
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.capture[method]({ workspaceId: workspace.id, id: selectedId }),
      );
      setAttempt((old) => old + 1);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const identify = async (speakerId, identity) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await unwrap(
        api.capture.identifySpeaker({
          workspaceId: workspace.id,
          recordingId: selectedId,
          speakerId,
          identity,
        }),
      );
      const changed = result.attribution?.attributed ?? 0;
      setNotice(
        result.attribution?.failed
          ? "Speaker saved. Suggestions could not be updated."
          : changed
            ? `Speaker saved. ${changed} suggestion${changed === 1 ? "" : "s"} now ${changed === 1 ? "has" : "have"} an owner.`
            : "Speaker saved.",
      );
      setAttempt((old) => old + 1);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  if (selectedId) {
    const record = detail?.recording;
    const hasAudio = ["temporary", "retained"].includes(detail?.audio.state);
    const canPlay = detail?.audio.state === "retained" && !status?.active;
    // Echoes of the far side are kept but collapsed: the transcript should read as
    // one conversation, and a microphone line can still hold the user's own words.
    const echoCount = detail?.transcript.filter((segment) => segment.echoOf).length ?? 0;
    const visibleTranscript = showEchoes
      ? (detail?.transcript ?? [])
      : (detail?.transcript ?? []).filter((segment) => !segment.echoOf);
    return (
      <section className="recording-detail">
        <Tool
          label="Back to recordings"
          icon={ArrowLeft}
          onClick={() => select(null)}
        />
        {error && (
          <div role="alert" className="error">
            {error.message}
          </div>
        )}
        {!record ? (
          <p role="status">Opening recording...</p>
        ) : (
          <>
            <div className="recording-heading">
              <div>
                <span className="muted">
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: workspace.preferences.timezone,
                  }).format(new Date(record.startedAt))}
                </span>
                <RecordingName
                  record={record}
                  workspaceId={workspace.id}
                  saved={(recording) =>
                    setDetail((old) => (old ? { ...old, recording: { ...old.recording, ...recording } } : old))
                  }
                />
              </div>
              {detail.noteId && (
                <button onClick={() => openNote(detail.noteId)}>
                  <NotebookPen size={16} />
                  Open note
                </button>
              )}
            </div>
            <div className="recording-facts">
              <span>{sourceName[record.sourceMode]}</span>
              <span>{record.state}</span>
              <span>{time(record.durationMs)}</span>
              {record.originalName && <span className="recording-original" title={record.originalName}>Original: {record.originalName}</span>}
            </div>
            {record.reason && (
              <p className="recording-warning">{record.reason}</p>
            )}
            {record.issues.length > 0 && (
              <ul className="recording-warning">
                {record.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {record.localCapture && (
              <div className="processing-row">
                <div>
                  <strong>
                    {record.transcriptionState === "queued" &&
                    !speechReady(status, record.language)
                      ? "Speech setup needed"
                      : `Transcription: ${record.transcriptionState}`}
                  </strong>
                  <p className="muted">
                    {detail.audio.state === "retained"
                      ? `Audio kept on this Mac · ${(detail.audio.bytes / 1048576).toFixed(1)} MB`
                      : detail.audio.state === "temporary"
                      ? `Temporary audio on this Mac · ${(detail.audio.bytes / 1048576).toFixed(1)} MB`
                      : detail.audio.state === "removed-after-transcription"
                        ? "Temporary audio removed after transcription"
                        : detail.audio.state === "deleted"
                          ? "Audio deleted"
                          : detail.audio.state === "cleanup-pending"
                            ? "Audio cleanup pending. Reopen the workspace to retry cleanup."
                            : "Audio recovery needs attention"}
                  </p>
                </div>
                <div className="processing-tools">
                  {hasAudio && record.transcriptionState !== "complete" &&
                    !speechReady(status, record.language) && (
                      <button type="button" onClick={setupModel}>
                        <Download size={16} /> Set up speech
                      </button>
                    )}
                  {status?.processingId === selectedId ? (
                    <button disabled={busy} onClick={() => run("cancel")}>
                      <Square size={15} />
                      Cancel processing
                    </button>
                  ) : (
                    hasAudio && record.transcriptionState !== "complete" && (
                      <Tool
                        label="Retry local transcription"
                        icon={RotateCcw}
                        disabled={
                          busy ||
                          !!status?.active ||
                          !!status?.processingId ||
                          !speechReady(status, record.language)
                        }
                        onClick={() => run("retry")}
                      />
                    )
                  )}
                  {hasAudio && (
                    <Tool
                      label={record.keepAudio ? "Delete saved audio" : "Delete temporary audio"}
                      icon={Trash2}
                      disabled={
                        busy || !!status?.active || !!status?.processingId
                      }
                      onClick={() => run("discard")}
                    />
                  )}
                </div>
              </div>
            )}
            {canPlay && <AudioPlayer key={`${workspace.id}:${selectedId}`} ref={player} workspaceId={workspace.id} id={selectedId} />}
            {record.processingError &&
              record.transcriptionState !== "complete" && (
                <p className="recording-warning">{record.processingError}</p>
              )}
            {record.aiState === "failed" && (
              <p className="recording-warning">
                Local suggestions could not be generated. The transcript is
                unaffected; open Actions to add follow-ups yourself.
              </p>
            )}
            {record.suggestions?.limited && (
              <p className="recording-warning">
                Local suggestions stopped at the first{" "}
                {record.suggestions.limit ?? 20} matches in this recording.
                Later sections were not scanned.
              </p>
            )}
            {detail.audio.overdue && (
              <p className="recording-warning">
                Unfinished audio has been kept for more than 24 hours. Retry
                transcription or delete the temporary audio.
              </p>
            )}
            <Speakers
              speakers={detail.speakers}
              busy={busy || status?.processingId === selectedId}
              identify={identify}
            />
            {!detail.speakers?.length && (
              <SpeakersUnavailable
                diarization={record.diarization}
                setupModel={setupModel}
              />
            )}
            {notice && (
              <p className="speaker-notice" role="status">
                {notice}
              </p>
            )}
            <PriorContext context={context} openPerson={openPerson} />
            <div className="section-heading">
              <h3>Transcript</h3>
              <span className="muted">
                {echoCount
                  ? `${detail.total - echoCount} of ${detail.total} segments`
                  : `${detail.total} segments`}
              </span>
            </div>
            {!!echoCount && (
              <p className="echo-note">
                {echoCount === 1
                  ? "1 line was also picked up by the microphone"
                  : `${echoCount} lines were also picked up by the microphone`}{" "}
                because the other side played through this Mac's speakers.
                <button type="button" onClick={() => setShowEchoes(!showEchoes)}>
                  {showEchoes ? "Hide duplicates" : "Show duplicates"}
                </button>
              </p>
            )}
            {!detail.transcript.length ? (
              <div className="empty">
                <AudioLines size={26} strokeWidth={1.4} />
                <p>
                  {record.transcriptionState === "complete"
                    ? "No speech detected"
                    : "No transcript yet"}
                </p>
              </div>
            ) : (
              <ol className="transcript-list">
                {visibleTranscript.map((segment) => (
                  <li key={segment.id} data-echo={segment.echoOf ? "true" : undefined}>
                    <div>
                      {canPlay ? <button className="transcript-timestamp" aria-label={`Play audio at ${time(segment.startMs)}`}
                        onClick={() => player.current?.playAt(segment.startMs)}><time>{time(segment.startMs)}</time></button>
                        : <time>{time(segment.startMs)}</time>}
                      <span>
                        {segment.speaker ??
                          `${sourceName[segment.source] ?? segment.source} · Unknown speaker`}
                        {segment.echoOf ? " · duplicate" : ""}
                      </span>
                    </div>
                    <p>{segment.text}</p>
                  </li>
                ))}
              </ol>
            )}
            {detail.total > 100 && (
              <div className="pagination">
                <Tool
                  label="Previous transcript segments"
                  icon={ChevronLeft}
                  disabled={!segmentOffset}
                  onClick={() =>
                    setSegmentOffset(Math.max(0, segmentOffset - 100))
                  }
                />
                <span>{segmentOffset / 100 + 1}</span>
                <Tool
                  label="Next transcript segments"
                  icon={ChevronRight}
                  disabled={segmentOffset + 100 >= detail.total}
                  onClick={() => setSegmentOffset(segmentOffset + 100)}
                />
              </div>
            )}
          </>
        )}
      </section>
    );
  }
  return (
    <section className="recordings-library">
      <div className="section-heading">
        <h2>Recordings</h2>
        <div className="recording-library-actions"><span className="muted">{list?.total ?? 0} on this Mac</span>
          <button type="button" disabled={!!status?.active || !!status?.processingId || status?.importing}
            onClick={() => setShowImport(true)}><Upload size={15} /> Import WAV</button></div>
      </div>
      {storage && <p className="audio-storage" role="status"><strong>{storageSize(storage.totalBytes)} audio on this Mac</strong>
        <span>{storage.retainedCount} kept for playback · {storageSize(storage.retainedBytes)}</span>
        <span>{storage.temporaryCount} awaiting transcription or cleanup · {storageSize(storage.temporaryBytes)}</span></p>}
      {error && (
        <div role="alert" className="error">
          {error.message}
        </div>
      )}
      {!list ? (
        <p role="status">Loading recordings...</p>
      ) : !list.items.length ? (
        <div className="empty">
          <AudioLines size={32} strokeWidth={1.3} />
          <h3>No recordings yet</h3>
        </div>
      ) : (
        <div className="recording-rows">
          {list.items.map((record) => (
            <button key={record.id} onClick={() => select(record.id)}>
              <AudioLines size={20} />
              <div>
                <strong>{record.title || purposeName[record.purpose]}</strong>
                <span>
                  {sourceName[record.sourceMode]} ·{" "}
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: workspace.preferences.timezone,
                  }).format(new Date(record.startedAt))}
                </span>
              </div>
              <span className="recording-state">
                {record.state}
                <small>
                  {record.transcriptionState === "queued" &&
                  !speechReady(status, record.language)
                    ? "Setup needed"
                    : record.transcriptionState}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
      {list?.total > 40 && (
        <div className="pagination">
          <Tool
            label="Previous recordings"
            icon={ChevronLeft}
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 40))}
          />
          <span>{offset / 40 + 1}</span>
          <Tool
            label="Next recordings"
            icon={ChevronRight}
            disabled={offset + 40 >= list.total}
            onClick={() => setOffset(offset + 40)}
          />
        </div>
      )}
      {showImport && <ImportAudioDialog workspace={workspace} close={() => setShowImport(false)}
        imported={(record) => { setAttempt((value) => value + 1); select(record.id); }} />}
    </section>
  );
}
