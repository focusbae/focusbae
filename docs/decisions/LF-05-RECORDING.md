# LF-05: Account-Free Recording

Date: 2026-09-11. Status: implemented; acceptance review outstanding.
Contract baseline remains version 2. No database migration or new dependency.

## Boundary

New `recording/` services own the local path. The legacy `local-meeting.js` sink
requires a connected account and uploads its finalized transcript; bypassing its
token check would not provide local durability. It remains separate and mutually
exclusive with workspace recording/transcription. No calendar, URL, credential,
cloud AI, hosted finalize, sync, model download or remote font is needed to Record.

The workspace Record dialog collects source (microphone/system/both), purpose
(conversation/personal/learning), English/Hindi/mixed speech setting, destination
(today/existing note/standalone), and an unchecked consent acknowledgment.
The initial permanent-audio policy is off. Playback/import/retained audio belong
to LF-06; model installation and language-quality claims belong to LF-09.

## Capture and Ownership

The main process owns one capture or transcription, scopes requests to the active
catalog workspace, and blocks workspace switching/legacy capture while busy.
The renderer has only named, exact-sender/main-frame IPC. It cannot choose disk
paths, supply recording metadata, spawn arbitrary workers, or stream audio itself.

Microphone input uses a distinct ephemeral Chromium session and a hidden sandboxed
renderer. Only its bundled files and microphone permission are allowed. Chromium
resamples to mono 16 kHz; an AudioWorklet packs PCM16 into 100 ms batches. Sequence
validation and at most ten outstanding batches bound the transport queue; overflow
ends capture visibly. The workspace renderer still has no media permissions.
Permission requests occur only after explicit Record consent, not at startup.

System input reuses AudioTee in strict lifecycle mode. CoreAudio taps require
macOS 14.2+, checked as Darwin 23.2+. System input means all system output, not
selection of a meeting app. Both sources must actually supply PCM before the state
becomes recording; spawn/permission success alone is insufficient. No silent
downgrade is allowed when one selected source fails. Sources remain independent
when they overlap; neither is treated as a person's identity.

An input-level/stop bar persists across workspace views. The menu bar displays
REC while capture is active, including when the workspace is hidden. Tray menus
refresh on ownership changes, not every level tick. Existing autostop ceilings
remain 15 minutes without detected speech and four hours total. Missing input,
source errors, sleep and disk failure stop and retain partial capture. Quit first
flushes writing, then stops input, drains local work, and closes the catalog.

## Durable Format and Recovery

`capture-spool/<recording UUID>/` contains a versioned manifest and per-source,
sequence-numbered `.pcm` files. Each file is a four-byte LE header length, JSON
metadata, and PCM16 mono 16 kHz bytes. Metadata contains workspace/recording IDs,
source, sequence, global start time, length, duration and SHA-256. Files are not
bare PCM or a playback container; LF-06 must use the parser or convert them.

Chunks are at most 160,000 audio bytes (five seconds). Capture holds bounded
uncommitted buffers; committed audio is not retained in memory. Exclusive private
file creation, file fsync, rename, directory fsync, then atomic manifest commit
precede the durable-time indicator. Source offsets are anchored to monotonic
capture startup and advanced by sample counts, not event callback timestamps.
The recent uncommitted tail is not promised to survive a crash.

On open, formerly active records become interrupted and running transcriptions
return to queued. Recovery scans and validates complete chunks, including an
orphan committed just before a manifest update. Corruption, sequence/timeline
gaps and partial-file tails are visible, and existing bytes are not discarded.
Recovery never resumes capture, requests permissions, or automatically loads a
model. Spool paths reject symlink/hardlink substitutions.

## Transcription and Retention

After stop, an available pre-provisioned speech model starts local processing;
otherwise the recording stays queued with a model-needed state. Explicit Retry
uses the same pipeline. Existing segmentation and Whisper adaptation are reused
inside an Electron utility process, with one utterance in flight and durable
transcript segments committed by the main process. No partial inference exists
only in a renderer. A deterministic segment key prevents duplicates on retry.
Segment provenance names the model/language/source; speaker identity stays null.

Only the existing `large-v3-turbo-q5_0` artifact is accepted initially. Cheap
presence/size checks do not load native code. The worker verifies the pinned
SHA-256 before inference. Hash/size come from the [upstream model commit](https://huggingface.co/ggerganov/whisper.cpp/commit/98aa99a0a9db05ae2342309f5096248665f7cba3),
also checked against the current resolve response on 2026-09-11. No model was
downloaded during implementation. Default path is
`~/.focusbae/models/ggml-large-v3-turbo-q5_0.bin`; LF-09 must provide a supported
installer/import workflow and independently qualify speech/generation/embeddings.

The utility worker receives a minimal environment, no account secrets, and no
network or helper-process JavaScript APIs. This is process containment, not an
OS-enforced network sandbox for native code. LF-09/LF-12 still own whole-process
egress, native runtime, architecture, memory and signed packaging qualification.
Worker diagnostics are drained without retaining possible speech text. Native
decoder WAV files use managed scratch. Cancellation waits for worker termination
before scratch cleanup. Failure preserves chunks and completed transcript text.

Successful complete transcription permits deleting temporary audio. A durable
cleanup tombstone precedes deletion; a separate completion flag prevents a failed
unlink from being reported as erased. Startup finishes pending cleanup. Explicit
Delete uses a native confirmation with Keep as the default and leaves transcript
text intact. Unfinished audio remains after 24 hours with a warning; there is no
silent deadline-based discard. Users can cancel processing or delete temporary
audio themselves. Neither ordinary SQLite nor these files are app-level encrypted.

## Reconsideration Triggers

Measured long-capture latency may require moving spool IO/verification to a
dedicated worker. LF-06 may add an indexed playback container while preserving
source timing and recovery compatibility. LF-09 may replace the single speech
artifact after license, accuracy, resource and offline provisioning review.
Pause/resume, unattended joining, diarization and all-app compatibility are not
part of this implementation.

References: [AudioTee](https://github.com/makeusabrew/audiotee),
[AudioTee JS](https://github.com/makeusabrew/audioteejs),
[Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process),
[Electron sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox).
