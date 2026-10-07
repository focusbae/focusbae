# Local-First Contracts

Version: 2 (2026-09-10; explicit hybrid retrieval). Status: design contracts;
qualification fixtures do not implement the production schema/API below.

Product-scope amendment, 2026-09-21:
PRODUCT_BLUEPRINT.md removes customer cloud migration and
legacy connected UI continuity from launch requirements. The local core is free;
paid hosted services are optional and cannot gate local saves or inference.
This amendment changes product scope, not the stored schema or a wire protocol.
Existing local data, migration safety and network/account isolation still apply.

Changes to this file that affect another package require a decision record and
updates to fixtures, migrations, and consumers in the same change set. Existing
user/system instructions take precedence. Paths labeled "proposed" are intended
ownership boundaries, not claims that modules already exist.

## 1. Architecture and Ownership

```text
Packaged desktop renderer (local assets, no cloud SDK)
  -> narrow, validated contextBridge methods
  -> main-process application services / repository
     -> SQLite workspace + managed attachments
     -> capture controller -> durable spool -> speech worker
     -> model-job scheduler -> isolated local text worker
     -> optional network gateway -> account / sync / explicit cloud tools
```

Keep Electron's existing CommonJS main entry. LF-00 should qualify a packaged
React/TipTap renderer build (Vite is the default candidate) and an Electron-safe
SQLite binding (`better-sqlite3` is the default candidate), including native ABI
and signing. These are decisions to verify, not instructions to install arbitrary
latest packages. Pin the qualified versions and use the existing npm lockfile.
Reuse editor/action presentation patterns from web without importing sibling
source files at runtime or bundling Next.js and authenticated routes into Electron.

Proposed desktop boundaries:

| Path | Responsibility |
| --- | --- |
| `workspace/` | Database, migrations, repositories, files, revisions, backup/import |
| `desktop-ui/` | Renderer source and its build config |
| `workspace-window.js`, `workspace-preload.js` | Window lifecycle and restricted IPC |
| `privacy/` | Network policy, consent, safe diagnostics |
| `recording/` | General capture/session lifecycle and playback; adapts `meeting-capture/` |
| `local-ai/` | Models, job scheduling, inference workers, schemas/evaluation |
| `workspace-sync/` | Future opt-in replication, separate from existing usage `sync.js` |
| `tests/local-first/` | Contract, integration, Electron, and recovery tests |
| `docs/decisions/`, `evidence/` | Task-created decisions and test reports; no private content |

Prefer small adapters over moving every legacy file at once. No renderer may
directly open SQLite, spawn a process, read arbitrary paths, or call cloud APIs.
AI workers have no browser automation, shell, network, or credential tools.

Use context isolation, sandboxed renderers, no Node integration, a restrictive
CSP, validated IPC senders, and a controlled local application protocol. External
links go through an allowlisted main-process opener. Imported HTML and AI output
are untrusted. Reference: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security).

## 2. Workspace and Storage

Default workspace: a dedicated subdirectory under Electron's `app.getPath('userData')`.
The user can select another supported local directory through a native picker.
Workspace UUID is independent of account ID; each workspace has a stable local
actor UUID for "me". Use an OS-access-controlled directory and restrictive file
permissions. Do not support opening a live workspace inside iCloud/Dropbox, a
network filesystem, or by multiple application processes in v1. Provide a single
process lock; multiple renderer windows share one repository service.

Layout implemented by LF-01, with the future vector cache identified separately:

```text
workspaces/<workspace-uuid>/
  workspace.json             # format/version/id; no access tokens
  workspace.sqlite           # canonical records and search index
  workspace-lock.sqlite      # lifetime exclusive lock; never unlink while in use
  search.sqlite              # LF-11 future disposable vector/chunk cache, not created by LF-01
  attachments/               # immutable managed blobs, content hashes
    .staging/                # journaled writes not yet acknowledged
    .recovery/               # quarantined unreferenced bytes, never silently deleted
  capture-spool/             # temporary durable audio awaiting processing
  backups/                   # configurable destination; not itself an off-device backup
```

Use transactions, foreign keys, schema migrations, and a tested SQLite durability
configuration. LF-01 must document WAL/synchronous choices and measured costs.
An acknowledged save means a committed durable write, not merely a debounce timer
or renderer memory update. UI may say "Saving" before acknowledgment. Target at
most a one-second edit debounce; force a save on orderly close/navigation and
exercise crash behavior explicitly. Editing remains possible while AI is busy.

Database plus files require a recoverable journal: write a temporary blob, flush,
rename atomically on the same filesystem, commit its reference, then reconcile
unreferenced blobs at startup. Never delete media before its database deletion is
durable. Orphan cleanup must distinguish active jobs from abandoned writes.

LF-01's API, schema diagram, durability choices and recovery limitations are in
[LF-01-STORAGE.md](decisions/LF-01-STORAGE.md). These are repository capabilities,
not evidence that production startup already runs without an account.

## 3. Canonical Entities

All new entity IDs are UUIDs. Mutable records include `workspaceId`, `revision`
(monotonically increasing local integer), `createdAt`, `updatedAt`, and nullable
`deletedAt`. Store instants in UTC and retain relevant IANA time zones. Daily-note
keys and date-only due dates are local calendar dates, not UTC timestamp slices.
Import/sync IDs are mappings, not replacements for local identity.

| Entity | Required domain fields and rules |
| --- | --- |
| Workspace | UUID, name, local actor UUID, schema version, location, preferences; optional account binding does not own the local data |
| Note | UUID, kind `note/daily/meeting`, title, versioned TipTap JSON, derived plain text, metadata, optional daily date, optional folder UUID; created without a recording |
| Folder | UUID, name (trimmed, no slash, unique among its siblings case-insensitively), optional parent folder UUID, at most 8 levels deep; holds notes and folders, never content |
| Recording | UUID, purpose `conversation/personal/learning`, selected source mode `microphone/system/both`, start/end/timezone, retention preference, state, optional explicit calendar context |
| NoteRecording | Stable link between note and recording; supports several recordings on a note without encoding capture into the note body |
| TranscriptSegment | UUID, recording UUID, source, start/end sample-derived milliseconds, content, content revision, optional speaker assignment and confidence, provenance |
| Speaker | Recording-scoped identity with display name and optional person/local-actor mapping; source channel alone cannot create this mapping |
| Artifact | Kind `summary/decisions/outline/questions`, source IDs/revisions, model/prompt versions, structured output, job ID, generated timestamp; distinct from authored content |
| Action | UUID, title, lifecycle status, owner kind/identity, source evidence, due fields, priority, accepted/completed timestamps, optional restatement relation |
| Attachment | UUID, managed relative path, content hash, media type, byte size, retention and original-display-name metadata; never trust a user filename as a path |
| Job | UUID, type, input revisions, engine/model ID, state, attempts/error, checkpoint, timestamps and idempotency key |
| LegacyMapping | Source system, account ID when known, entity type/remote ID, local UUID, import version/hash; unique for idempotent import |
| OutboxOperation | Added when sync is implemented: operation UUID, device/workspace/entity IDs, base server version, encrypted payload version, acknowledgement state |

Folders arrive with schema version 4 (`folders` table, plus an index on the note's
`folderId`). A note's folder is a field on the note, so filing one is an ordinary
revision-checked update and a note with no folder is the default rather than a
special case. The folder **path is derived at read time, never stored**: renaming
a folder must not rewrite the rows beneath it. Deleting a folder moves its notes
and subfolders to the parent — a container being tidied away must never destroy
writing. Workspaces written before version 4 open unchanged, with every note
unfiled. Markdown export stays flat; folders are not yet written as directories.

LF-04e (2026-10-01, unreleased) extends content schema 1 with the block atom
`noteAttachment`, whose only attribute is an attachment UUID `id`. Note saves
validate that each referenced attachment is live and belongs to that note.
Database schema **5** adds `attachments_by_note` and prevents an older editor
from opening a workspace containing unsupported blocks. Images render only via
`focusbae-workspace://app/attachments/<workspace>/<note>/<attachment>` for the
active workspace and a live owning note, with no cache or filesystem paths.
Files are limited to 100 MiB; IPC transfers use 256 KiB chunks. HEIC keeps its
original plus an optional same-note PNG `previewId`; no attachment contents are
indexed. Trash retains bytes; confirmed permanent note deletion tombstones all
its attachments and journals file removal. The JSON portable note envelope is
version 2 when sidecars are present, with relative paths, hashes and remapped IDs
on import; text-only exports remain version 1. Markdown points to the same
adjacent `attachments/` directory. See
[LF-04e decision](decisions/LF-04e-ATTACHMENTS.md) for compatibility and lifecycle.

Workspace preferences now also accept `welcomeDismissed` (boolean, default
`false` when absent). It records acknowledgment of the optional local workspace
welcome, scoped to that workspace, through the existing revision-checked update.
It never grants permissions or enables model downloads, accounts or sync. This
extends the preferences JSON; SQL tables and the database schema version are
unchanged. Earlier binaries that reject unknown preference keys cannot open
preferences written by this version; downgrade compatibility is not claimed.

For v1, a recording has one primary destination note; the link table avoids a
future destructive schema change. Linking to more notes may be deferred. Removing
a note or unlinking it does not silently destroy the recording, and deleting a
recording does not delete authored notes. Destructive dialogs distinguish audio,
transcript/AI, notes, and linked actions; reviewed actions retain source snapshots
with a visible "source deleted" state. Workspace erasure removes all of them only
after explicit confirmation. Synced deletion is specified separately below.

The existing web/API stores editor **HTML** and uses integer Page/Todo IDs and
account-required ownership. Do not pass local UUIDs into those endpoints. New local
JSON needs `contentSchemaVersion`, editor extension compatibility tests, and
lossless preservation of the original sanitized import payload when conversion
cannot represent an old block. Flag unsupported content; never silently discard
it. Markdown export is a portable derivative, not a promise of lossless TipTap
round-tripping or an externally editable vault in v1.

FTS covers titles, note text, and transcript text; rebuild it from canonical data.
No embedding service is required for base search. Index changes commit with source
changes. Derived indexes cannot become the only copy of content.

Semantic retrieval is required for the complete local AI experience, but must not
gate writing, recording, or base search. SQLite remains authoritative. Qualify a
separate, disposable `search.sqlite` per workspace for vector/chunk caches; failure
to load a vector extension must not prevent opening `workspace.sqlite`. Do not put
model generation, embedding inference, or vector-index writes in a note-save
transaction. Enqueue durable indexing work with the source mutation instead.

An embedding profile identifies exact model/checksum, tokenizer, query/document
prefixes, pooling, normalization, dimensions, quantization and chunker version.
Never compare vectors across profiles, even if dimensions match. Cache entries
reference source UUID, revision, content hash, chunk offsets/timestamps and index
generation. Revalidate against canonical live records before showing a result or
building model context. Deletion excludes results immediately; asynchronous cache
cleanup is not permission to return deleted/stale data. Reindex into a new
generation and activate atomically, with bounded disk usage and restart recovery.

Embeddings are sensitive derived data, not anonymized documents. They stay local
and are excluded from sync by default. Backup manifests explicitly identify a
rebuildable search cache; a missing cache never makes a canonical restore fail.
See [SEARCH_RESEARCH.md](decisions/SEARCH_RESEARCH.md) for qualification, model candidates,
retrieval flow and proposed performance/quality gates.

## 4. Action Semantics

Keep existing lifecycle values: `proposed`, `accepted`, `deferred`, `done`, `dropped`.
"Needs review" selects proposed. "Waiting on" selects accepted/deferred actions
assigned to someone else; it is not a stored status. Dismiss maps to dropped.
Manual creation is an explicit acceptance. Model extraction always creates a
proposal, including personal voice notes, unless a separate explicit command is
confirmed by the user. A due date alone does not imply acceptance.

Allowed transitions: proposed -> accepted/dropped; accepted -> deferred/done/dropped;
deferred -> accepted/done/dropped; done/dropped -> accepted by explicit reopen.
Editing ownership or dates does not implicitly change status. Acceptance is
idempotent; completion/reopen maintains timestamps and compatibility with legacy
`completed`. Retain existing low/medium/high/urgent priority values.

Store owner kind `self/person/unknown`. `self` references the workspace actor, not
the logged-in account; unknown ownership stays unknown. Legacy null-owner behavior
means self in existing APIs, so migration must preserve and label that legacy
interpretation, not apply it to new uncertain extraction.

Every extracted claim includes segment IDs and revisions, exact supporting quote,
and offsets into those segment strings. Validate quotations mechanically. A
supported quote does not prove that an inferred owner/date is correct: field-level
uncertainty remains nullable and is evaluated separately. Due dates inferred from
relative phrases retain the recording timezone and interpretation context.

Correction creates a new transcript revision. Pending proposals from old revisions
become stale and can be regenerated; accepted actions do not silently change.
Deduplicate reruns by source/job/output identity and offer semantic restatements
for review. Never merge two different people's commitments just because titles
are similar. Nudges operate only on accepted/deferred work, respect quiet hours
and existing cooldown behavior, and need no foreground-window surveillance unless
the user separately enables that contextual feature.

## 5. IPC Contract

Proposed namespace `window.focusbaeWorkspace`; use named methods, not a generic
channel that accepts SQL, filesystem commands, URLs, or executable names.

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

type MutationContext = {
  workspaceId: string;
  clientRequestId: string; // UUID, enables idempotent retries
  expectedRevision?: number; // mandatory on edits/deletes of existing records
};
```

Method groups: `workspace.create/open/list`, `notes.list/get/create/update/delete`,
`search.query`, `recordings.start/stop/get/list`, `transcripts.correct`,
`actions.list/create/update/transition`, `models.list/prepare/import/cancel`,
`jobs.request/cancel/retry`, `backup.create/restore`, `export.selectDestination`,
`privacy.get/set`, and later `account.*` / `sync.*`.

Define concrete schemas in LF-01/LF-03 before implementing consumers. Validate
input lengths/types/enums, IPC sender/window ownership, workspace scope, current
revision, and operation authorization in main. A request carries a workspace ID;
switching the active UI does not retarget an in-flight recording/job to another
workspace/account. Workspace close/switch during capture requires stop or a clear
background-recording state. Errors include conflict, unsupported, permission,
disk-full, model-unavailable, cancelled, and policy-denied without leaking paths
or tokens into public logs.

Events have entity ID, workspace ID, revision/sequence, and explicit unsubscribe.
Reconnect refetches canonical state rather than assuming every progress event was
delivered. Preview text and progress events are not durable-save acknowledgments.

Local entry-point amendment (2026-09-22): `commands.take/ack/onAvailable` exposes
only main-process-generated navigation intents (`new-note`, `record`, `recordings`,
`actions`, `settings`). The latest pending intent is retained until acknowledged
by the trusted workspace renderer, including during reload or an open dialog.
Multiple unhandled intents coalesce; this is navigation, not a durable job queue.
New-note creation uses the intent UUID as its idempotency key. Navigation flushes
pending writing; failure stays visible instead of discarding the draft.

`appSettings.get/captureShortcut/resetShortcut/setLogin` is app-wide, not a
workspace database preference. Only the four local shortcut names are accepted;
login-item changes require a boolean. Shortcut capture cancels on Escape,
timeout, hide, close or reload. Every method validates the workspace sender.
Record entrances open a consent/source form; they do not begin capture. If a
local recording is already active, Record/Stop uses that same recording service.
`focusbae://workspace` opens the local app; retired auth callbacks never exchange
credentials, and old config links open Settings without silently changing it.

Settings/utility amendment (2026-09-22): Privacy is a Settings section, not the
first tray item. `privacy.revoke` accepts only `models` or `updates`; it cannot
enable access. `appSettings.checkForUpdates` takes no renderer-supplied URL.
`update/local-release.json` stays `preparing` until LF-12 qualifies a local release
feed. Neither development builds nor unqualified packages contact the old feed.

`clipboard.state/setEnabled/clear/remove/copy` is a separate app-session utility,
not a workspace entity or a sync input. It starts disabled every launch, requests
explicit confirmation, and keeps at most 30 text items (20,000 characters each)
only in memory. Copy/remove accept item UUIDs, never arbitrary commands or paths.
The trusted renderer receives `workspace:clipboard-event` snapshots. Turning off
or quitting clears history; clearing does not overwrite the system clipboard.
Recognized concealed/transient/password clipboard types are skipped, but secret
detection is not guaranteed. Existing plaintext legacy history is neither read
nor deleted. No Accessibility permission, paste automation, account, upload,
model processing, or clipboard-related filesystem persistence is introduced.
Strict Local blocks networking; it does not disable this explicitly enabled
local utility. Settings states that distinction.

## 6. Recording and Retention

Capture lifecycle: `preparing -> recording -> stopping -> captured`, or
`interrupted/failed`. Transcription and AI have separate queued/running/complete/
failed/cancelled states. A partial usable recording can remain while processing
fails. `stop` is idempotent and drains sources/queues without blocking the UI.
Do not add pause/resume until sample continuity and interruption behavior are
specified and tested; v1 needs reliable start/stop first.

The new Record command does not call an authenticated meeting endpoint to start
or save. Sources are explicitly selected. System audio currently captures system
output, not a proven per-app audio filter. Hardware/permission failure is reported
per source; do not silently switch both-source recording to microphone only.

1. Create the recording record and bind workspace, purpose, sources, and consent.
2. Acquire permissions/device handles and verify that selected sources produce input.
3. Persist bounded audio chunks and manifests before relying on speech inference.
4. Transcribe through the existing engine adapter into committed transcript segments.
5. On stop/interruption, finalize available chunks and show any gaps explicitly.
6. Schedule text AI independently, only when the local model is ready.

Use a monotonic/sample-derived timeline shared by sources, with a wall-clock anchor
for display. Persist sequence numbers/checksums and backpressure state. Keep
existing autostop safeguards initially; do not infer that quiet audio means a
meeting has definitely ended. Detect permission revocation, device changes, sleep,
disk exhaustion, source failure, and worker crashes without inventing missing text.

`Keep audio = off` means no permanent playback archive, **not** zero temporary
audio on disk. Purge transcribed temporary chunks after durable transcript commit;
retain unfinished chunks for recovery with a visible retry/delete choice and a
documented retention deadline. Initial default: warn at 24 hours and offer explicit
deletion; never silently discard the only recoverable recording to satisfy a timer.
Disclose this behavior before first recording. With retention on, commit managed
audio and a timeline manifest for seekable playback before removing spool copies.
Deletion makes no forensic secure-erasure promise on SSDs/backups.

PCM WAV is the first qualified portability format. Import accepts one native-picked,
regular, uncompressed 16-bit PCM WAV with one or two channels, 8–96 kHz and at
most four hours. It validates RIFF/chunk bounds and layout, resamples in bounded
windows to the canonical 16 kHz mono spool, and never changes or deletes the
source file. Imported audio follows the same opt-in retention, transcription,
recovery, deletion and backup rules. Export writes the currently selected retained
source or mix as a private 16 kHz mono PCM WAV through a native save dialog. It
publishes atomically from a sibling partial file; failure preserves an existing
destination. Neither renderer API accepts a filesystem path.

Record without a speech model is allowed once durable capture is available:
show "Transcription pending: model needed" and preserve chunks until processing or
explicit deletion. Offline first launch without any models still supports writing;
offline transcription/AI requires previously installed or locally imported models.
Do not auto-download on Record without approval or silently fall back to cloud.

Permission to capture is not participant consent. Provide a concise recording
acknowledgment and persistent indicator; do not imply a tray recorder automatically
notifies people in another app. Calendar metadata is attached only by user choice.
The old `/meetings/local` route opportunistically matches calendars, so it must not
become a generic recorder/sync ingestion endpoint.

## 7. Local AI

Two independent capabilities: speech-to-text and text understanding. Preserve the
existing Whisper/Apple adapters, qualify actual supported OS/device combinations,
and add a local text worker. `llama.cpp` is the initial runtime candidate, not a
model selection. Review licenses, redistribution, runtime signing, memory, language
quality, and commercial use before bundling any model. Runtime reference:
[llama.cpp](https://github.com/ggml-org/llama.cpp).

A versioned model manifest includes engine/model/quantization ID, exact bytes,
checksum, source, license, architectures, minimum tested OS/RAM, languages, and
runtime compatibility. Model states: not-installed, downloading, verifying, ready,
incompatible, failed. Verify downloads/imports before activation. Support cancel,
resume, disk-space checks, and offline model import. Avoid local HTTP listeners;
prefer framed stdio/native IPC to a packaged helper with no network access.

Prioritize capture/transcription over optional summarization; bound concurrent
workers and memory. Cancelled/failed text jobs preserve notes/transcripts. Job input
is immutable by revision; idempotent output commits must reject stale input.
Record model/prompt/schema versions. Chunk long transcripts by tokens, preserving
speaker/timestamp evidence, then combine grounded results; never silently truncate
an hour-long session to the model context window.

| Purpose | Default outputs | Guardrail |
| --- | --- | --- |
| Conversation | Summary, decisions, questions, proposed actions | Attribute only with evidence; unknown owners stay unknown |
| Personal | Cleaned outline, ideas, explicit follow-ups for review | Preserve original transcript; mic source alone is not self identity |
| Learning | Topics, explanations, source-linked takeaways | A lecturer's "I will" is not the user's commitment; no default task extraction |

Local Ask is retrieval over the selected workspace with citations and explicit
"not found" behavior, not an omniscient global chat. The full AI milestone combines
FTS, a qualified local embedding model/vector index, and structured metadata.
Fuse ranked candidates rather than adding incomparable BM25/cosine scores.
Reranking is optional and separately measured. Base search degrades explicitly to
FTS if embeddings are unavailable; it must not claim complete semantic coverage.
Counts, due dates, owners and current action status come from scoped, deterministic
queries over canonical records, not from top-k vector hits. Prompt injection
inside recordings/imports is untrusted data;
neither prompts nor model output can change policy, invoke tools, or send content.

## 8. Network, Accounts, and Keys

LF-02 implements session-scoped grants, explicit account connection, protected
credential migration and startup cancellation boundaries. See
[LF-02-NETWORK.md](decisions/LF-02-NETWORK.md) for concrete APIs and test limitations.
Only Strict Local persists currently; a prior token or preference is not new consent.

Central policy evaluates operation purpose, workspace, account, payload category,
destination, and consent version. Do not depend solely on renderer request filters:
main-process axios/fetch/ws, auto-updater, native helpers, and legacy startup paths
also need policy enforcement and process-level testing.

Strict Local is an app-wide override, including when another open workspace has
sync enabled. Enabling it cancels active network jobs and prevents retries; explain
that data already transferred cannot be recalled. Managed enterprise policy takes
precedence over user preferences. Recordings and local writes continue normally.

| State | Allowed network behavior |
| --- | --- |
| Fresh local workspace | None by default; user-initiated model download/update check needs explicit permission |
| Strict Local enabled | No app-initiated network, including downloads/auth refresh; explain how to temporarily leave the mode |
| Account connected only | Auth operations as authorized; no workspace-content upload or sync |
| Cloud snapshot import (deferred, not a launch requirement) | If implemented later, authorized read of selected account data only; no automatic reverse upload or ongoing mirror |
| Sync enabled | Only bound workspace sync payloads under the reviewed protocol; no hosted AI side effects |
| Cloud AI explicitly invoked | Only selected content and purpose after disclosure; not enabled by sign-in or sync |
| Sign-out | Stop network jobs/revoke local session credentials; preserve workspace and bound queued operation identity |

Inventory `main.js` startup, `focusEngine`, nudges, clipboard/history integrations,
token refresh, pending upload retries, update checks, Call Mode, calendar/bots, and
telemetry before calling the app offline. Default sensitive monitoring off in the
new local experience. Existing connected code must stay behind policy while it
remains in the tree. The product reset removes legacy connected launch entry
points; preserving their UI is no longer required.

Store account credentials in platform-protected storage, not a new plaintext
workspace file; migrate existing token handling carefully. Platform credential
protection does not encrypt note/media files. Reference:
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
Protect exported support bundles: redact content, credentials, model prompts,
meeting titles, paths, and identifying URLs by default; preview any voluntary
content inclusion. Local diagnostic files need bounded retention and permissions.

## 9. Migration, Backup, and Restore

No mandatory migration or sign-in to create a new local workspace. Customer cloud
import is no longer a launch requirement. If introduced later, make it explicit
and one-time. Fetch through authorized APIs, preserve
cloud originals, and import IDs through account-scoped mappings. Repeat imports
are idempotent; if local content changed, produce a reviewable conflict, not an
overwrite. Import notes, metadata, transcripts, action ownership/status/provenance,
and legacy unsupported content with a counts/checksum report.

The old web workspace does not magically become a live mirror of imported local
data. Until G4, label imports as snapshots. Later encrypted sync workspaces have an
explicit migration boundary; no automatic dual-write to old cloud endpoints.

Review `~/.focusbae/pending/` before enabling any legacy retry. Some pending
payloads lack reliable account provenance: recover into a local "Recovered"
collection after user review, never upload them to whichever account signs in
next. Stop the old auto-retry path once this flow is authoritative. Keep a rollback
copy until the import has been verified; do not delete an unknown user's files.

Use SQLite's backup API or another verified consistent snapshot method, plus a
coordinated attachment manifest. Do not copy a live `.sqlite` file while ignoring
its WAL. References: [SQLite backup](https://www.sqlite.org/backup.html),
[WAL](https://www.sqlite.org/wal.html).

Back up before migrations; migrate transactionally; test interruption at each
version. Restore into a new directory, validate version/checksums and archive
paths/symlinks, then switch workspaces only after verification. Never overwrite a
live workspace as the first restore step. An older app must refuse writes to a
newer schema; rollback uses a known compatible backup or an explicit export path,
not downgrading the database in place. Same-disk backups are recovery convenience,
not protection against device loss; support a user-selected separate destination.

Implemented manual backup contract (2026-09-22, LF-08): trusted
`backup.status/create/restore({workspaceId})` IPC accepts no filesystem path from
the renderer. Native pickers and confirmation own file selection. All mutations
stay in the catalog queue; backup/restore require capture/transcription to be
idle, and the renderer flushes its editor first. Startup runs SQLite quick_check
before schema migration or file recovery. The default backup is unencrypted and
this is disclosed before saving.

`.focusbae-backup` format 1 is an uncompressed streaming container. Its prefix is
UTF-8 `FOCUSBAE-BACKUP\n1\n`, a 4-byte little-endian manifest length and a 32-byte
SHA-256 manifest digest, then the JSON manifest and concatenated file payloads in
manifest order. File entries contain only relative path, byte size and SHA-256;
no links, permissions or executable extraction directives. Current bounds are a
32 MiB manifest, 100,000 files, 200 GiB payload, six path components and 240 path
characters. Unknown/newer versions, unsafe/duplicate paths, trailing/truncated
bytes and checksum failures are rejected. Checksums detect corruption, not the
identity or trustworthiness of an archive's author.

Included: SQLite backup-API snapshot (committed WAL included), complete managed
attachments and capture-spool files, including still-held recovery audio.
Clipboard history, app credentials/OS settings/permissions, models, disposable
semantic cache, locks, previous backup files and local backup-status metadata are
excluded. Already-purged audio cannot be reconstructed. Source revisions, Trash,
ownership/speaker data, note links and derived People inputs remain in SQLite.

Create writes an exclusive sibling partial file, verifies all payload checksums,
then atomically publishes it. Only then is per-workspace `backup-status.json`
updated. That status records creation, not ongoing existence of the chosen file.
Restore extracts into a fresh hidden directory, compares the SQL schema against
the known migration schema before initialization, checks DB/FKs and referenced
media, then assigns a new workspace ID. Entity and local actor IDs are preserved;
scoped database keys and audio headers/manifests are remapped, while obsolete
mutation retry receipts are discarded. Older supported schema copies upgrade
with the existing pre-migration backup. The validated copy is added to the catalog
without switching the current workspace; Open restored workspace is explicit.
Interrupted staging files are never opened automatically. No automatic cleanup of
crash-left staging artifacts or system-level secure erasure is claimed.

## 10. Optional Sync Boundary (G4, Not G3)

This section sets invariants, not a final cryptographic/protocol specification.
LF-14 must produce reviewed wire schemas, threat model, key-management design,
recovery/device revocation behavior, and compatibility fixtures before LF-15/16
implement sync. Default design direction is client-side E2EE using a maintained,
reviewed library/protocol, not custom crypto. Server-readable sync is a material
product/privacy change and requires explicit owner approval. Do not advertise
E2EE until the full key lifecycle and implementation have been reviewed.

One workspace binds to one sync identity at a time. Enabling sync previews scope,
initial bytes, encryption/recovery setup, and whether retained audio is included
(off by default). Signing into account B cannot send account A's outbox. Disable
sync stops future transfer but does not imply deletion of previously synced data;
remote deletion is a separate explicit operation. A running session keeps its
original local destination through account changes.

Protocol minimums:

- Client-generated operation UUIDs, stable workspace/device/entity IDs, per-entity
  base server version, versioned payload envelope, and server-issued cursor.
- Atomic local mutation plus outbox append; at-least-once retries; transactional
  server deduplication and mutation; atomic client apply plus cursor advance.
- Per-operation acknowledgments; retrying partial batches cannot duplicate work.
  Handle authentication expiry, revocation, quota, corrupt blobs, and schema skew.
- No wall-clock last-write-wins for note bodies. Concurrent edits create explicit
  recoverable conflict revisions/copies in v1; collaborative CRDT editing is deferred.
- Tombstones and defined retention/resync rules prevent a long-offline device from
  resurrecting deleted work. Device expiry requires full reconciliation before push.
- Resumable hashed blob transfer with scope checks; deleted references and blobs
  have coordinated retention. Clearing local cache cannot mean deleting remote data.
- Server applies no hosted summarization, embedding, or meeting-finalize pipeline
  as a side effect of storage sync. E2EE server cannot parse encrypted note content.
- Browser access requires a secure unlock/key path and clear locked/error states;
  no server plaintext shadow copy just to reuse existing authenticated pages.

Existing backend Page/Todo integer IDs, required `user_id`, meeting `meet_url`,
server-held transcript encryption, and HTML editor contracts are legacy APIs, not
the new protocol. Add versioned workspace services additively. The backend's real
migration pattern is hand-written idempotent scripts plus schema bootstrap imports;
do not infer that an Alembic-looking directory is the deployed migration runner.
There is no requirement to maintain customer-facing legacy workspace or
voice/bot flows. Retiring live services or deleting stored data remains a
separately scoped operation, not a consequence of adopting the new sync protocol.
