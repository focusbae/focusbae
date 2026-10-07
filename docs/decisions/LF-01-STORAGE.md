# LF-01: Local Workspace Storage

Date: 2026-09-10. Contract baseline: v2. Implementation: `workspace/`.

## Scope and Runtime

This is an in-process repository, not the account-free desktop experience yet.
It imports no Electron, auth, network, model, or vector extension. Production
`main.js` does not load it. Keep the service strongly referenced for the workspace
lifetime; close before switching. Never expose the service, underscore-prefixed
internals, arbitrary method names, SQL or filesystem paths through renderer IPC.

Root dependency: better-sqlite3 13.0.3 (Node >=22). Qualified runtimes: host Node
25.2.0 and Electron 43.7.0 in Node mode. Production Electron 30 is unchanged and
**not qualified for this module**. LF-03 must integrate the qualified runtime
and repeat packaged application tests.

## Location and Durability

Initial support is macOS APFS, checked using `statfs` on the resolved parent.
Known iCloud/Dropbox/OneDrive/Google Drive paths and home Desktop/Documents are
rejected. Custom sync roots cannot be reliably detected and remain unsupported.
Symlinked roots, managed directories/files, and hard-linked managed files are
rejected. This protects against accidental misuse, not hostile same-user
processes racing filesystem operations. Directories use 0700; files use 0600.
Ordinary SQLite/media are **not application-level encrypted**.

Canonical SQLite uses WAL, `foreign_keys=ON`, `synchronous=FULL` and macOS
`fullfsync=ON`. API return acknowledges a commit, not a queued write. See SQLite's
[WAL durability documentation](https://www.sqlite.org/wal.html) and
[fullfsync reference](https://www.sqlite.org/pragma.html#pragma_fullfsync).

A separate `workspace-lock.sqlite` holds a lifetime `BEGIN EXCLUSIVE` transaction.
OS locks release on owner exit, including SIGKILL. Never unlink that file or open
it through unrelated file APIs while its connection is held. Every application
process must use this service; arbitrary external SQLite tools do not participate.
Competing opens return `WORKSPACE_BUSY`, without stale PID timeouts or lock stealing.
See [SQLite locking](https://www.sqlite.org/lockingv3.html).

Migrations have contiguous versions and historical SQL checksums. Before an
existing-schema upgrade, create and flush an online SQLite backup. Apply all
pending migrations in one transaction. Failed/interrupted upgrades preserve the
prior version. Newer canonical schemas are refused before changing database
pragmas or metadata. A missing manifest is regenerated only from an initialized,
branded database with a valid workspace identity; conflicting identities fail.
Initial creation interrupted before identity initialization is not auto-adopted.

## Schema Diagram

```text
workspaces (one row: workspace UUID + independent actor UUID)
  |-- notes -----------------------+-- note_recordings -- recordings
  |    |-- content JSON             |                       |-- speakers
  |    |-- revision/plainText/hash  |                       |-- transcript_segments
  |    +-- attachments <-----------+-----------------------+-- attachments
  |-- actions (owner/status; frozen quote + source revision)
  |-- jobs (input revisions, state, attempts, checkpoint, request hash)
  |    +-- artifacts (reserved for LF-10 output repository)
  |-- source_revisions (immutable note/transcript text snapshots)
  |-- mutation_requests (request UUID, fingerprint, committed response)
  |-- file_journal (create/delete intents)
  |-- legacy_mappings (reserved; no automatic import/cloud IDs)
  +-- search_documents -- search_fts (rebuildable lexical index)
```

STRICT entity tables use JSON payloads with generated typed columns for indexes,
constraints and workspace-scoped foreign keys. Transcript speakers also match
the recording. Domain validation rejects unknown fields, unsupported document
nodes, unsafe links, invalid dates, non-finite JSON and oversize/deep payloads.
Legacy rich content is not silently converted; LF-08 owns preservation/import.
Daily notes use an explicit local date and captured IANA timezone, with one live
daily note per workspace/date. Restoring a replaced daily note is a conflict.

## Service Contract

```javascript
const { randomUUID } = require('node:crypto');
const { createWorkspace, openWorkspace } = require('./workspace');

// Absolute parent must exist; creation requires a new directory.
const store = await createWorkspace({ directory: '/supported/local/new-workspace' });
const read = { workspaceId: store.identity.id };
const write = () => ({ ...read, clientRequestId: randomUUID() });
const note = store.createNote(write(), { title: 'Draft' });
const edit = { ...write(), expectedRevision: note.revision };
const saved = store.updateNote(edit, note.id, { title: 'Revised draft' });
store.search(read, 'draft');
store.close();
const reopened = await openWorkspace({ directory: '/supported/local/new-workspace' });
reopened.close();
```

Factories are async for backups; record methods are synchronous. Reads require
workspace scope. Mutations require a request UUID; edits/transitions/deletions/
restores additionally require the revision last read. Retry the **same** UUID,
inputs and expected revision after an uncertain acknowledgment. The original
committed response is returned even if later edits advanced the record. Read
current state separately after recovering an old acknowledgment.

| API | Behavior |
| --- | --- |
| `identity`, `getWorkspace`, `updateWorkspace` | Stable identity, name/preferences, revision, schema/location |
| `get(ctx, kind, id, options)`, `list(ctx, kind, options)` | Allowlisted kinds, hidden tombstones by default, bounded limit/offset, transcript order by source start |
| `createNote`, `updateNote` | Validated document, derived text/hash, atomic indexing intent |
| `createRecording`, `updateRecording` | Metadata/state only, no device capture |
| `createTranscript`, `updateTranscript` | Recording-scoped segments/corrections, optional unknown speaker |
| `createSpeaker`, `linkRecording` | Unknown identity default; one live primary note destination per recording |
| `createAction`, `proposeAction`, `updateAction`, `transitionAction` | Manual accepted/self defaults; model proposed/unknown defaults; exact quotes and explicit review/reopen |
| `delete`, `restore` | Revisioned soft deletion of notes/recordings/transcripts/actions/speakers/links/artifacts |
| `enqueueJob`, `transitionJob` | Revision-aware durable work, cancellation/retry rather than arbitrary deletion |
| `putAttachment`, `updateAttachment`, `readAttachment`, `deleteAttachment` | Immutable bounded blob, editable metadata, integrity checks, journaled deletion |
| `search`, `rebuildSearch` | Model-free FTS5, rebuild from canonical live notes/transcripts/actions |
| `recoveryReport`, `close` | Recovery diagnostics and ownership release |

Normal transcript reads/search exclude deleted recordings; deleting a note does
not delete recordings. Restoring a recording reindexes live transcripts. Actions
retain evidence and expose `sourceState` (`none/current/stale/deleted`) on reads.
Accepting a stale/deleted proposal requires evidence review. Microphone source
never implies self identity. No action transition executes work. `includeDeleted`
is for explicit recovery reads, not an AI retrieval bypass.

Job keys bind the original normalized payload, including initial checkpoint,
separately from mutation UUIDs. Startup requeues interrupted running jobs with
`INTERRUPTED`, preserving attempts/checkpoints and incrementing revision, but
**does not execute jobs**. Writes and index intents share a transaction. Recording
revisions enqueue fresh child transcript jobs; stale completion is rejected.

## Attachment Recovery

The original Buffer API limit was 16 MiB; LF-04e raises it to **100 MiB** for note
attachments, with bounded renderer-to-main chunk transfers. This is not a
streaming recording API. LF-05 owns
capture spool chunking; this module never cleans capture-spool contents. Display
names are metadata, never caller-controlled paths.

1. Commit a create intent with generated managed paths and expected SHA-256.
2. Write an exclusive private temporary file, fsync, rename on the same filesystem,
   then fsync both directories.
3. Commit the reference, mutation response and intent removal together.
4. On restart, quarantine unreferenced known blobs in `attachments/.recovery/`;
   do not fabricate records or destroy potentially recoverable bytes.
5. For deletion, commit tombstone plus delete intent before unlinking. Cleanup
   failure keeps a retryable intent without revoking the committed acknowledgment.

Startup reports missing/corrupt files while preserving note/attachment metadata.
Unrecognized files are untouched. Quarantine has no automatic expiry; LF-08 must
provide inspection/export and explicit removal. Deleted attachment bytes cannot
be restored through the soft-delete API. No SSD/backups secure-erasure claim.

## Boundaries and Follow-Up

- Process-crash tests are not physical power-loss tests. Blobs use Node fsync, not
  a separately qualified F_FULLFSYNC binding. Physical power-loss and actual
  constrained-volume tests remain release checks.
- Network-denial tests cover this repository, not the whole app or native helpers.
  LF-02 owns fresh-profile/Strict Local egress gates.
- FTS works now. Embedding/chunk retrieval does not. LF-11 uses a disposable
  `search.sqlite`; opening and saving never require it.
- Source history and mutation acknowledgments are retained, including soft-deleted
  records. LF-08 owns explicit compaction, workspace deletion and recovery UI.
- Startup hashes referenced attachments synchronously. Large-library qualification
  must measure this and move bounded checks off the UI path without losing integrity
  reporting. No large-library latency claim yet.
- No automatic import, cloud binding, sync, tokens, encryption, model download,
  inference, device recording or release is added.

Reconsider location support only after filesystem/OS qualification. Once workspaces
are in user hands, change schemas only with new versioned migrations and backups,
never by editing historical SQL. Evidence: LF-01.
