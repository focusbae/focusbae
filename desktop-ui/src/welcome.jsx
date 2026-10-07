import React, { useLayoutEffect, useRef } from "react";
import { HardDrive, Mic, NotebookPen, X } from "lucide-react";

export function WelcomeNotice({ busy, dismiss, learnMore }) {
  return (
    <section className="welcome-notice" aria-label="Welcome to FocusBae">
      <div>
        <h2>Your notebook is ready.</h2>
        <p>Write below. Your work saves on this Mac. No account needed.</p>
      </div>
      <div className="welcome-actions">
        <button type="button" onClick={learnMore}>How it works</button>
        <button type="button" className="primary" disabled={busy} onClick={dismiss}>
          {busy ? "Saving..." : "Start writing"}
        </button>
      </div>
    </section>
  );
}

export function WorkspaceGuide({ close }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="workspace-guide"
      aria-labelledby="workspace-guide-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="dialog-heading">
        <h2 id="workspace-guide-title">A space for your day.</h2>
        <button type="button" className="icon-button" aria-label="Close workspace guide" onClick={close}>
          <X size={18} />
        </button>
      </div>
      <p className="guide-intro">Start with a thought. Everything else can wait.</p>
      <ul className="guide-steps">
        <li>
          <NotebookPen size={20} aria-hidden="true" />
          <div>
            <h3>Write, and keep going</h3>
            <p>Today opens a fresh page for each day. Notes keeps your other pages together. Changes save automatically; look for “Saved on this Mac”.</p>
          </div>
        </li>
        <li>
          <HardDrive size={20} aria-hidden="true" />
          <div>
            <h3>Your workspace lives here</h3>
            <p>Your notes and transcripts stay on this Mac. There is no cloud sync or automatic cloud backup. Use Settings → Backup & recovery for a full workspace copy, including any audio still stored here. Export all notes in Notes makes a writing-only copy, not a full backup.</p>
          </div>
        </li>
        <li>
          <Mic size={20} aria-hidden="true" />
          <div>
            <h3>Record when you’re ready</h3>
            <p>Choose Record for a conversation or voice note. You choose the audio source and confirm permission before capture starts. Speech setup is optional for recording; you can capture now and transcribe later on this Mac.</p>
          </div>
        </li>
      </ul>
      <p className="guide-footer">Name your workspace and change its appearance in Settings. You can find this guide there, too.</p>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={close}>Got it</button>
      </div>
    </dialog>
  );
}
