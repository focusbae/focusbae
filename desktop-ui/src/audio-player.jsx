import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Play, Pause, Download } from "lucide-react";
import { PlaybackEngine } from "./playback-engine.mjs";
const api = window.focusbaeWorkspace;
const unwrap = async (request) => {
  const result = await request;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const time = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export const AudioPlayer = forwardRef(function AudioPlayer({ workspaceId, id }, ref) {
  const engine = useRef(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [state, setState] = useState({ playing: false, position: 0 });
  const [speed, setSpeed] = useState(1);
  const [source, setSource] = useState("all");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    let alive = true;
    unwrap(api.capture.playbackInfo({ workspaceId, id })).then((value) => {
      if (!alive) return;
      setInfo(value);
      engine.current = new PlaybackEngine({
        durationMs: value.durationMs,
        read: (range) => unwrap(api.capture.playbackRead({ workspaceId, id, ...range })),
        update: (value) => alive && setState(value),
        fail: (failure) => alive && setError(failure.message),
      });
    }).catch((failure) => alive && setError(failure.message));
    return () => { alive = false; engine.current?.dispose(); engine.current = null; };
  }, [workspaceId, id]);
  const play = (fromMs) => {
    setError(null);
    return engine.current?.play({ fromMs, speed, source });
  };
  useImperativeHandle(ref, () => ({
    playAt: (ms) => play(ms),
    pause: () => engine.current?.pause(),
  }));
  const change = (next) => {
    const current = engine.current;
    if (!current) return;
    const position = current.current(), playing = current.playing;
    current.seek(position);
    if (playing) current.play({ fromMs: position, speed, source, ...next });
  };
  return (
    <section className="audio-player" aria-label="Audio playback">
      <div className="audio-player-heading"><strong>Listen back</strong><span className="muted">Saved on this Mac</span></div>
      {error && <p className="recording-warning" role="alert">{error}</p>}
      {!info && !error && <p role="status">Checking saved audio…</p>}
      <div className="audio-player-controls">
        <button className="audio-play" aria-label={state.playing ? "Pause audio" : "Play audio"} disabled={!info}
          onClick={() => state.playing ? engine.current.pause() : play()}>
          {state.playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <input type="range" aria-label="Audio position" min="0" max={Math.ceil(info?.durationMs ?? 0)} step="100"
          value={state.position} disabled={!info} aria-valuetext={`${time(state.position)} of ${time(info?.durationMs ?? 0)}`}
          onChange={(event) => {
            const ms = Number(event.target.value), playing = engine.current.playing;
            engine.current.seek(ms);
            if (playing) play(ms);
          }} />
        <span className="audio-time" aria-live="off">{time(state.position)} / {time(info?.durationMs ?? 0)}</span>
      </div>
      <div className="audio-player-options">
        <label>Speed <select aria-label="Playback speed" value={speed} onChange={(event) => {
          const value = Number(event.target.value); setSpeed(value); change({ speed: value });
        }}>{[0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        {info?.sources.length > 1 && <label>Listen to <select aria-label="Playback source" value={source} onChange={(event) => {
          setSource(event.target.value); change({ source: event.target.value });
        }}><option value="all">Both sources</option><option value="microphone">Microphone</option><option value="system">System audio</option></select></label>}
        <span className="muted">Select a transcript timestamp to hear that moment.</span>
        <button type="button" disabled={!info || exporting} onClick={async () => {
          engine.current?.pause(); setExporting(true); setError(null); setNotice(null);
          try {
            const result = await unwrap(api.capture.exportAudio({ workspaceId, id, source }));
            if (!result.canceled) setNotice(`${result.fileName} exported.`);
          } catch (failure) { setError(failure.message); }
          finally { setExporting(false); }
        }}><Download size={15} /> {exporting ? "Exporting…" : "Export WAV"}</button>
      </div>
      {notice && <p className="audio-export-notice" role="status">{notice}</p>}
    </section>
  );
});
