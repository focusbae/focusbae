import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download, FolderInput, Check, X } from "lucide-react";
import "./models.css";
const api = window.focusbaeWorkspace;
const unwrap = async (promise) => {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
export function useModels() {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!api) return;
    let active = true,
      received = false;
    const off = api.onModels((value) => {
      received = true;
      setState(value);
    });
    unwrap(api.models.state())
      .then((value) => {
        if (active && !received) setState(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      off();
    };
  }, []);
  return state;
}
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
const modelLabels = {
  missing: "Not installed",
  downloading: "Downloading",
  importing: "Importing",
  ready: "Ready on this Mac",
  invalid: "Verification failed",
  error: "Setup interrupted",
  unsupported: "Not supported on this Mac",
};
function Status({ ready, children }) {
  return (
    <span className="model-ready" data-ready={!!ready}>
      {ready && <Check size={15} />}
      {children}
    </span>
  );
}
// A downloadable, pinned local model (Parakeet, speaker detection).
function LocalModel({ title, summary, state, kind, busy, strict, run }) {
  if (!state) return null;
  const unsupported = state.status === "unsupported";
  return (
    <div className="model-block">
      <div className="model-heading">
        <div>
          <h3>{title}</h3>
          <p className="muted">
            {summary}
            {state.bytes ? ` · ${Math.round(state.bytes / 1e6)} MB` : ""}
            {state.license ? ` · ${state.license}` : ""}
          </p>
        </div>
        <Status ready={state.ready}>{modelLabels[state.status] ?? state.status}</Status>
      </div>
      {!state.ready && !unsupported && (
        <div className="model-controls">
          <button
            type="button"
            disabled={busy || state.busy || strict}
            onClick={() => run("download", { kind })}
          >
            <Download size={16} />
            {state.status === "invalid" || state.status === "error"
              ? "Download again"
              : `Download ${title}`}
          </button>
          <button
            type="button"
            disabled={busy || state.busy}
            onClick={() => run("import", { kind })}
          >
            <FolderInput size={16} />
            Import folder
          </button>
        </div>
      )}
    </div>
  );
}
const LANGUAGE_ROWS = [
  { locale: "en-US", name: "English" },
  { locale: "hi-IN", name: "Hindi and mixed", note: "written in Latin letters" },
];
function AppleSpeech({ apple, busy, strict, run }) {
  const probed = apple?.probed;
  return (
    <div className="model-block">
      <div className="model-heading">
        <div>
          <h3>Apple speech</h3>
          <p className="muted">Built into macOS · no model download from FocusBae</p>
        </div>
        <Status ready={apple?.supported && probed}>
          {!apple?.supported
            ? "Needs macOS 26 or later"
            : probed
              ? "Available"
              : "Checking..."}
        </Status>
      </div>
      {apple?.supported &&
        probed &&
        LANGUAGE_ROWS.map(({ locale, name, note }) => {
          const value = apple.locales[locale];
          return (
            <div className="model-language" key={locale}>
              <span>
                {name}
                {note && <small> · {note}</small>}
              </span>
              {value === "installed" ? (
                <Status ready>Ready</Status>
              ) : value === "supported" ? (
                <button
                  type="button"
                  disabled={busy || !!apple.installing || strict}
                  onClick={() => run("installLanguage", { locale })}
                >
                  <Download size={15} />
                  {apple.installing === locale
                    ? "Installing..."
                    : `Install ${name.split(" ")[0]}`}
                </button>
              ) : (
                <Status>Not available</Status>
              )}
            </div>
          );
        })}
    </div>
  );
}
export function ModelSetup({ state, privacy }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  // Probing capabilities launches local helpers, so it happens only here, when
  // the user opens model settings, never at app startup.
  useEffect(() => {
    if (api) api.models.refresh().catch(() => {});
  }, []);
  const run = async (method, input) => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.models[method](input));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  const speech = state?.speech;
  const strict = privacy.mode === "strict-local";
  const locked = busy || !!speech?.inUse;
  return (
    <section className="model-setup" aria-label="Local AI models">
      <h2>Local AI</h2>
      {!speech ? (
        <p role="status">Checking local models...</p>
      ) : (
        <>
          <AppleSpeech apple={speech.apple} busy={locked} strict={strict} run={run} />
          <LocalModel
            title="Parakeet"
            summary="Optional · more accurate English in meetings"
            state={speech.parakeet}
            kind="parakeet"
            busy={locked}
            strict={strict}
            run={run}
          />
          <LocalModel
            title="Speaker detection"
            summary="Tells speakers apart in a recording"
            state={state.diarization}
            kind="speakers"
            busy={locked}
            strict={strict}
            run={run}
          />
          {error && (
            <p role="alert" className="model-warning">
              {error}
            </p>
          )}
          <p className="model-footnote">
            {strict
              ? "Strict Local is on. Downloads are off; import a model folder to set it up offline."
              : "Downloads need your permission. Recordings and transcripts stay on this Mac."}
          </p>
          <div className="model-future">
            <span>Transcription</span>
            <span>
              {speech.languages?.english?.engine === "parakeet"
                ? "Parakeet for English"
                : speech.languages?.english?.ready
                  ? "Apple speech"
                  : "Not set up"}
            </span>
          </div>
          <div className="model-future">
            <span>Action suggestions</span>
            <span>
              {state.generation?.ready
                ? "Apple on-device model"
                : state.generation?.status === "checking"
                  ? "Checking..."
                  : "Basic rules (Apple Intelligence unavailable)"}
            </span>
          </div>
          <div className="model-future">
            <span>Semantic search</span>
            <span>
              {state.embedding?.ready
                ? `${state.embedding.language}, on-device`
                : state.embedding?.status === "checking"
                  ? "Checking..."
                  : "Exact words only"}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
export function ModelDialog({ state, privacy, close, returnToRecording = false }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="model-dialog"
      aria-label="Speech setup"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="model-dialog-close">
        <Tool label="Close speech setup" icon={X} onClick={close} />
      </div>
      <ModelSetup state={state} privacy={privacy} />
      {returnToRecording && (
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={close}>Back to recording</button>
        </div>
      )}
    </dialog>
  );
}
