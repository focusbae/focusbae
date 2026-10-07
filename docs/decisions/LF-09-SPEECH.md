# LF-09a: Speech Setup and Initial Qualification

Date: 2026-09-13. Status: speech setup implemented; full LF-09 remains IN_PROGRESS.
No schema or account migration. Contract v2 remains unchanged.

## Decision

Keep the existing Whisper worker and model. Extend the shared downloader used by
the tray and legacy settings instead of introducing a second installation path.
Use a main-process ModelManager with separate speech/generation/embedding readiness.
Generation and embeddings are explicitly planned, not implied by speech readiness.

The model manifest pins large-v3-turbo-q5_0, 574041195 bytes, SHA-256
`394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`, upstream revision
`98aa99a0a9db05ae2342309f5096248665f7cba3`.
Artifact identity: [upstream commit](https://huggingface.co/ggerganov/whisper.cpp/commit/98aa99a0a9db05ae2342309f5096248665f7cba3).
The [Whisper MIT license](https://github.com/openai/whisper/blob/main/LICENSE) is
bundled at `recording/WHISPER-LICENSE.txt`. No weights are bundled with the app.
Dependency/runtime notices and signed distribution still require LF-12 review.

## Lifecycle and Privacy

- Missing, unverified, importing, downloading, verifying, paused, ready,
  corrupted, incompatible and error states are explicit.
- Existing model files are hashed asynchronously at startup, without network.
  Readiness is cached only against an unchanged file fingerprint. The isolated
  speech worker still rechecks the exact size and hash before native loading.
- Download requires the separate native models permission, never account login.
  Strict Local blocks download and revokes an active transfer. Offline import and
  verification still work. No model auto-download or inference server is added.
- The renderer supplies no path or URL. Import uses a main-owned file picker.
  All model IPC requires the workspace main-frame sender and rejects extra fields.
- Transfers use a pinned HTTPS artifact, identity encoding, bounded size and exact
  Content-Range checks. A server ignoring Range restarts the partial safely.
  Redirects are limited to approved exact hosts, including `us.aws.cdn.hf.co`.
- Pause waits for streams to close. Download partials survive restart and can be
  resumed or explicitly discarded. Import staging is removed on cancellation or
  failure. An imported file never overwrites a good installation before hashing.
- Disk checks reserve the remaining bytes plus 64 MiB. Import reserves the complete
  new file while preserving an existing installation. OS ENOSPC is also handled.
  Only a checksummed, fsynced staging file is atomically published; a receipt records
  revision, hash, byte count, license and installation time.
- Setup is blocked while speech processing or the legacy capture workflow is busy.
  Recordings may still be captured without a model. Readiness enables explicit
  Retry local transcription; setup does not silently process all historical audio.
- Models are shared across local workspaces on the same OS account. Notes,
  transcripts, recovery audio and workspace identity remain workspace-scoped.

## Runtime Boundary

Initial speech eligibility: Apple Silicon, macOS 14.2+, at least 8 GiB RAM.
These checks are prerequisites, not a claim that every eligible machine is qualified.
One utility process transcribes one recording at a time. Requests have a 120-second
timeout. Cancellation requests termination, escalates after 1.5 seconds, and waits
at most five seconds for exit. Processing retains recovery audio on failure.
The worker denies JavaScript network/helper APIs and receives no account credentials.
This is not an OS-level sandbox or proof that native libraries cannot use networking.

## Quality Decision

On synthetic fixtures on this M1/8 GiB machine, English matched exactly; Hindi had
a small wording/spelling error. Mixed English/Hindi partly translated Hindi into
English with the existing `mixed -> en` adapter. Mixed mode is now visibly marked
experimental. Do not claim code-switch preservation or G1 completion from these
fixtures. Do not silently switch language mappings based on one TTS sample.

Next qualification should compare explicit Hindi/English/auto mappings and prompt
support on a consented code-switch corpus, measuring retained language, names,
numbers and deadlines as well as word error. Also test real microphones, system
audio, Bluetooth, long recordings, constrained memory and supported OS versions.
Keep generation and embedding selection separate; the speech result does not
approve a text model or semantic-search runtime.
