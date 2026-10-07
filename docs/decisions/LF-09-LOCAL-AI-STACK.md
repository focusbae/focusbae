# LF-09/LF-10 Decision Input: Local AI Stack Reference

Date: 2026-09-14, measurements added 2026-09-16. Status: PROPOSED — not integrated. Toolchain blocker resolved (§6); first on-device measurements in §6a.
Owners: LF-09 (model manager/runtime), LF-10 (local intelligence), LF-11 (retrieval).

This record captures a reference implementation found in a comparable shipping
product, what it settles about our open decisions D-04/D-05/D-06/D-13, and what
adopting it would cost. It does not change any task state. No dependency here is
approved by appearing in this document.

## 1. Reference Product

`ariso-ai/oats` — MIT, macOS + Windows desktop meeting recorder, v0.24.0 at the
time of writing, signed/notarized, Homebrew cask, R2 auto-update.

- Repository: https://github.com/ariso-ai/oats
- License: MIT (Copyright (c) 2026 Ariso Intelligence)
- Stack: Tauri v2 / Rust / Vue 3, not Electron
- Design specs consulted (in-repo, `docs/superpowers/specs/`):
  - `2026-06-02-backend-abstraction-design.md` — backend switch + STT sidecar
  - `2026-06-03-local-meeting-notes-design.md` — local LLM notes generation
  - `CONTRIBUTING.md` §Local backend — current cross-platform model contract

Positioning overlap is high (bot-free desktop capture, offline mode, no login).
Functional overlap stops at generated notes: a repository-wide search found no
action entity, owner field, action lifecycle, evidence quotes, waiting-on view or
follow-up tracking. Their `note.md` is a generated artifact, not a tracked object.
Our action model (`workspace/domain.js`, owner/evidence/status/`restatementOf`)
has no counterpart there.

## 2. Their Model Choices

### Speech (macOS)

Swift sidecar `ariso-stt` built on FluidAudio.

| Role | Model | Runtime |
| --- | --- | --- |
| ASR | Parakeet TDT 0.6b v3 | CoreML, Apple Neural Engine |
| Diarization | Pyannote (segmentation + WeSpeaker embeddings) | CoreML |
| VAD | Silero | CoreML |

- FluidAudio: https://github.com/FluidInference/FluidAudio — Apache 2.0,
  `swift-tools-version: 6.0`, platforms `.macOS(.v14)` / `.iOS(.v17)`.
- Their spec claims ~110x real-time batch ASR on an M4 Pro. Unverified by us.
- Model weights are converted CoreML bundles on HuggingFace
  (`FluidInference/parakeet-tdt-0.6b-v3-coreml` plus diarizer/VAD bundles).

### Generation (macOS)

- Model: `mlx-community/gemma-3-1b-it-qat-4bit` (Gemma 3 1B, QAT 4-bit, ~1.0 GB)
- Runtime: `mlx-swift-lm` (`MLXLLM`), Metal shaders compiled via `xcodebuild`
- Fixed prompt producing markdown: summary, discussion points, decisions, actions
- `repetitionPenalty ~= 1.15` — their spec states the 1B model otherwise
  degenerates into a loop and echoes the transcript instead of summarising.
- Weights mirrored to their own R2 CDN because the Swift HuggingFace client
  cannot fetch Xet-backed HF repositories.

Their stated sizing rationale, quoted because it is the argument for D-05:

> "Model size is the dominant on-device cost - download footprint, RAM, and
> generation latency all scale with it. The 1B QAT-4bit variant keeps the
> bootstrap download and memory budget small enough to ship to every
> Apple-Silicon user. A larger model is a one-line change to the loaded
> configuration if note quality proves insufficient - the code path is identical."

### Windows

Same contract, different implementation: Parakeet + diarization via sherpa-onnx,
Gemma as GGUF via llama.cpp, runtime files hash-pinned in a manifest.

## 3. What This Settles For Us

| Decision | Status before | What the reference adds |
| --- | --- | --- |
| D-05 text model/runtime | Open; llama.cpp named as candidate | Existence proof that a ~1 GB 4-bit 1B model ships to every Apple Silicon user for transcript-to-notes. Gives LF-09 a concrete first candidate instead of an open search. |
| D-06 speech profiles | Whisper `large-v3-turbo-q5_0` + Apple adapter | A CoreML/ANE ASR alternative with diarization and VAD in one Apache-2.0 library. |
| D-04 supported hardware | "16 GB standard text profile to qualify" | Their floor is any Apple Silicon Mac on macOS 14+; ours is currently unmeasured. |
| D-13 retrieval engine | sqlite-vec chosen; embedding profile open | They ship no semantic search at all. No help here, but it confirms retrieval is not table stakes in this category — it would be a differentiator, not a catch-up. |

It also corrects one assumption in our own planning: they did not choose between
cloud and local. Cloud is the default backend, Local is a Settings switch, and a
`useBackend()` abstraction keeps the views identical across both.

## 4. Component-Level Replacement Map

Current values are read from source, not from prior documentation.

| Layer | Today | Proposed | Change |
| --- | --- | --- | --- |
| Speech (ASR) | Whisper `large-v3-turbo-q5_0`, 574,041,195 bytes, MIT, via `whisper-node-addon` (whisper.cpp) on CPU/Metal — `recording/model.js` | Parakeet TDT 0.6b v3, CoreML on the Apple Neural Engine, via FluidAudio | Replace |
| Speech (alternate) | Apple `SpeechAnalyzer` adapter in `meeting-capture/apple-speech/` — written, requires the macOS 26 SDK, never compiled | Redundant if Parakeet is adopted | Likely drop |
| Speaker identity | None. `microphone -> user`, `system -> participant` source labels only | Pyannote segmentation + WeSpeaker embeddings, real per-speaker turns | New capability |
| Voice activity | RMS threshold in `meeting-capture/segmenter.js` | Silero VAD, bundled with FluidAudio | Replace |
| Text generation | None. 68-line rule set in `workspace/action-extraction.js` | Gemma-class ~1B 4-bit QAT model via `mlx-swift-lm` | New capability |
| Embeddings | `apple-nl-english-word-average-v1`, 300 dimensions, English only — `local-ai/apple-embedding/` | A sentence-embedding model on the adopted runtime | Replace |
| Vector store | `sqlite-vec` 0.1.9 with `better-sqlite3` | Unchanged | Keep |
| Audio capture | AudioTee, CoreAudio process taps — `meeting-capture/audio-sources.js` | Unchanged; the reference product uses the same API | Keep |
| Application shell | Electron + React | Unchanged. Do not migrate to Tauri as part of this | Keep |
| Model delivery | Hash-pinned download, SHA-256 verification, offline import, pause/resume — `model-download.js` | Same pattern extended to two or three model sets with independent readiness | Keep and extend |

### Expected Effect

| Question | Today | After adoption |
| --- | --- | --- |
| Who spoke | Unknown; inferred from audio source | Actual speaker turns |
| "Priya will send the deck" | Attributed to the account owner or missed entirely | Attributed to Priya, owner confirmed on review |
| Commitment detection | Regex; produced 4 false positives and 3 misses on an 8-sentence probe | Model-based, still grounded to verbatim quotes |
| Summaries | None | Purpose-aware markdown |
| Cross-conversation retrieval | Averaged word vectors | Sentence-level semantic retrieval |
| Transcription speed | Whisper on CPU/Metal | Neural Engine; vendor claims ~110x realtime on M4 Pro, unverified by us |

### Unresolved Before Adoption

- **Parakeet CoreML bundle size is not stated** in the reference repository and must
  be measured against the current 574 MB Whisper download before an install-footprint
  claim is made.
- **Language coverage: resolved 2026-09-16 — addition, not replacement.** The
  `nvidia/parakeet-tdt-0.6b-v3` model card lists 25 European languages and no Hindi.
  Our recording model accepts `english | hindi | mixed` (`recording/service.js`), so
  Whisper must be retained for `hindi` and `mixed`. Parakeet can serve `english`
  only. This adds a second engine and a per-recording routing rule to the §7 cost,
  and the install footprint becomes Whisper (574 MB, only if a non-English language
  is used) plus the Parakeet bundle. Pyannote diarization is language-independent
  and still applies to all three.
- **Per-artifact licensing.** Apache 2.0 covers the FluidAudio wrapper only. The
  upstream Parakeet TDT 0.6b v3 weights are CC-BY-4.0 (commercial use permitted with
  attribution — an attribution notice must ship with the app); the FluidAudio CoreML
  conversion's own licence and the Pyannote weights still need checking.
- **Memory headroom.** See §6. Speech plus generation plus Electron on the same machine
  has not been measured.

## 5. Speaker Attribution

`docs/CAPABILITIES_AND_POSITIONING.md` records that our `microphone -> user`
mapping misattributes speech when several people share one microphone, and
"Audio source is not identity" is a settled decision.

Today we implement source separation only: `microphone` and `system` labels, with
speaker identity unknown. Pyannote diarization would let a recording carry real
per-speaker turns, which is a precondition for owner-resolved actions and for the
person view. This is the strongest single technical reason to consider FluidAudio,
independent of ASR speed.

## 6. Blocker: Local Toolchain

Measured on the development machine, 2026-09-14:

| Property | Value | Requirement | Result |
| --- | --- | --- | --- |
| Chip | Apple M1 | Apple Silicon | OK |
| Memory | 8 GB | D-04 target is 16 GB | Below target |
| macOS | 14.3.1 (23D60) | FluidAudio `.macOS(.v14)` | OK to run |
| Swift | 5.10 (Xcode 15.3) | FluidAudio `swift-tools-version: 6.0` | **Fails** |
| Xcode | 15.3 | MLX Metal shaders need `xcodebuild`; Swift 6 needs Xcode 16+ | **Fails** |

Update 2026-09-16: macOS is now 27.0 (26A428). Xcode is still 15.3 / Swift 5.10,
so the Swift 6 requirement remains unmet until Xcode is updated. The existing test
suite and Electron end-to-end pass on macOS 27.

At the time of the original measurement, neither FluidAudio nor an MLX sidecar
could be compiled on this machine as configured. Xcode 16 requires a newer macOS than 14.3.1, so the prerequisite is a
macOS update followed by an Xcode update. The 8 GB memory figure also needs a
deliberate decision: it is below our own stated qualification profile, and a
generation model, a speech model and Electron would share it.

Until that is resolved, LF-09 generation and any FluidAudio work cannot start,
and any quality claim would be unmeasured.

**Resolved 2026-09-16.** Xcode 27.0 (27A266a), Swift 6.4, macOS 27.0 SDK and the
Metal toolchain are installed and selected. FluidAudio and the Apple speech adapter
both compile. Native modules were rebuilt; 106 checks and the 22-check development
Electron E2E pass.

## 6a. First On-Device Measurements (2026-09-16)

Machine: Apple M1, 8 GB, macOS 27.0. FluidAudio at commit `b68f484`, built with
`swift build -c release --product fluidaudiocli`. Test input: a 22.8 s two-speaker
clip generated with the macOS `say` voices Samantha and Daniel, 16 kHz mono, with
0.6 s gaps. **Synthetic voices are far easier to separate and transcribe than real
people; these are a smoke test, not a quality result.**

| Engine | Warm wall time | Model download | Transcript errors on the clip |
| --- | --- | --- | --- |
| Parakeet TDT v3 (FluidAudio `transcribe`) | 0.50 s | Yes (first run ~68 s incl. download) | "loop in Raghav on" -> "ragavon"; "offsite" -> "if site" |
| Apple SpeechAnalyzer (`meeting-capture/bin/focusbae-transcribe`) | 0.47 s | None shipped by us | "Raghav on" -> "Rag Avon"; "offsite" -> "upsight" |

Parakeet peak resident memory: ~554 MB (`/usr/bin/time -l`).

Diarization (FluidAudio `process --mode offline`, Pyannote pipeline):

| Truth | Detected |
| --- | --- |
| Samantha 0.00-5.67 | S2 0.00-5.48 |
| Daniel 6.27-12.50 | S1 6.26-12.29 |
| Samantha 13.10-17.00 | S2 13.63-16.74 |
| Daniel 17.60-22.18 | S1 18.35-22.00 |

Two speakers detected, all four turns attributed consistently, boundaries within
~0.75 s. Processing reported 3.8 s (6x realtime) on a cold run.

### What this changes

- **English ASR: Parakeet is not clearly better than the Apple adapter here**, and
  the Apple path ships no model. On macOS 26+ the adapter should be the default
  English engine, as its own header already argues; Parakeet only earns a place if
  a real-meeting comparison shows a clear accuracy win.
- **The case for FluidAudio is diarization**, which neither Whisper nor the Apple
  adapter provides and which the owner-resolution work depends on.
- Resulting engine plan to validate: Apple SpeechAnalyzer for English on macOS 26+,
  Whisper for `hindi` / `mixed` and older macOS, FluidAudio for speaker turns only.
- The Apple adapter had never compiled: it needed `-parse-as-library` (fixed in
  `meeting-capture/apple-speech/build.sh`). Its build output is now git-ignored like
  `local-ai/bin/`; packaging is unaffected.

Not yet measured: real multi-person calls, overlapping speech, one microphone
shared by several people, long recordings, memory with Electron plus a generation
model loaded, and the Whisper baseline on the same clip.

### Text model update (2026-09-16)

Apple's Foundation Models framework is available on this M1 and needs no download.
It was built into an extraction helper and scored far above the rule baseline (86%
vs 7% end-to-end on synthetic probes; see evidence/LF-10b.md). This supersedes the
Gemma/MLX sidecar as the first text-model path: the same pattern as speech, where
Apple's system model removed the need to ship weights. Gemma or another downloadable
model is now a fallback question for Macs without Apple Intelligence, not the default.

## 7. Cost If Adopted

Ranges are planning estimates, not commitments, and assume the toolchain in §6
has been updated first.

| Item | Cost | Notes |
| --- | --- | --- |
| Toolchain prerequisite | macOS + Xcode update; possibly a 16 GB machine | Blocking; hardware decision belongs to D-04 |
| FluidAudio speech sidecar | 1-2 weeks | New Swift sidecar, model download/verify flow, transcript schema gains speaker turns, replaces or sits beside the existing Whisper path |
| Diarization through the data model | 1 week | `speakers` table exists; owner resolution, UI labels and "unknown speaker" states need real handling |
| Gemma-class generation sidecar | 2-3 weeks | MLX build via `xcodebuild`, ~1 GB model hosting, separate readiness gate, prompt + grounding integration |
| Extraction quality harness | 3-5 days | Gold set of real transcripts; measures commitment precision/recall and owner accuracy. Required before any claim |
| Sentence embeddings replacing word averaging | 3-5 days once a runtime exists | Removes `apple-nl-english-word-average-v1` |
| Install footprint | +1 GB (generation) on top of existing speech model | Two separate opt-in downloads |
| Ongoing | Model hosting/bandwidth on R2; per-model qualification on each supported Mac | |

Total, excluding the toolchain prerequisite and the pilot: roughly 5-8 weeks of
focused work. This replaces the regex extractor and the averaged-word-vector
retrieval, both of which are currently labelled as baselines.

## 8. What Was Implemented Instead (2026-09-14)

Three items from this review needed no new toolchain and are done:

1. `workspace/semantic-search.js` — `_open` called the async `close()`, whose
   continuation could set `this.db = null` after the new handle was assigned,
   crashing the next query after a workspace switch. Awaiting it instead would
   deadlock, because `close()` awaits `this.tail`, which is the in-flight query.
   Replaced with a synchronous `_dispose()` used by both paths. Regression test
   added in `tests/local-first/semantic-search.test.js`.
2. `recording/service.js` set `aiState` and `metadata.actionExtraction` and no
   renderer read either, so a failed or truncated extraction was invisible.
   `publicRecording` now exposes `aiState` and `suggestions`; the recording
   detail view warns on failure and on the 20-match cap.
3. `recording/model-manager.js` reported `embedding: { status: "planned" }` while
   an embedding runtime was actually running, because `workspace-window.js`
   constructed `EmbeddingRuntime` outside the manager. The manager now accepts an
   embedding probe and `embeddingState()` reports the real profile, dimensions
   and language. The three-capability split (speech / generation / embedding)
   that this reference product also uses was already present in our design.

102 checks pass (`npm test`), plus the capture and brief suites.

## 9. Not Decided Here

Adoption is not approved by this record. Before committing:

- Verify the licence of each individual model artifact, not just the wrapper.
  FluidAudio is Apache 2.0; the Parakeet weights are NVIDIA-derived and Pyannote
  has historically required accepting terms on HuggingFace. The wrapper licence
  does not settle the weights.
- Decide D-04 hardware: 8 GB is below our own qualification target.
- Decide whether FluidAudio replaces the Whisper path or runs beside it, and what
  happens to already-transcribed recordings.
- Run the extraction quality harness before any public claim about local AI.

## 10. Reconsideration Trigger

Revisit if: the quality harness shows a 1B-class model cannot reach usable
commitment precision and owner accuracy; FluidAudio's model licensing proves
incompatible with commercial distribution; or the hardware floor implied by
speech + generation excludes the target customer's machine.
