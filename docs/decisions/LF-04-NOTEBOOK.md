# LF-04: A Local Writing Notebook

Date: 2026-09-11. Owner: Codex. Contract baseline remains version 2;
canonical document/schema version remains 1. No database migration is required.

## Context and Choice

The user requested a minimalist, painterly writing experience while implementing
the next local-first milestone. Extend the existing desktop shell, keeping the
web application and legacy capture/voice workflows unchanged.

Today opens a timezone-correct daily page. Notes provides a paginated library,
pinning, Trash/restore, workspace-wide lexical search and source views. The page
uses an original bundled gouache/ink landscape, serif title/body, neutral white
or charcoal surfaces, and compact Lucide controls. No marketing screen, remote
fonts, decorative card stack, account requirement, or model installation.

Reuse the web editor's TipTap command patterns, not its HTML persistence format.
Pin TipTap core/pm/react/StarterKit to 3.31.3; StarterKit includes link, underline
and undo/redo. Disable automatic external links, automatic link creation, drops,
and trailing-node insertion. Render canonical version-1 JSON in a keyed editor;
save acknowledgments update revision/status, never replace a newer dirty buffer.
See [StarterKit](https://tiptap.dev/docs/editor/extensions/functionality/starterkit)
and [setContent's update behavior](https://tiptap.dev/docs/editor/api/commands/content/set-content).

## Ownership and Durability

- `workspace/notebook.js`: bounded library projections, daily get-or-create,
  revisioned edits/pinning and canonical source lookup. Daily uniqueness is
  enforced by the existing SQLite constraint. A replacement daily page can make
  restoring its predecessor conflict; the predecessor stays in Trash.
- `desktop-ui/src/save-queue.mjs`: one queue per workspace/note, 400 ms debounce,
  coalesced edits, one outstanding write and stable request ID/revision on retry.
  A failed write retains the draft and blocks ordinary navigation. Newer edits
  drain only after the prior write is acknowledged.
- `workspace/ipc.js` and preload: named, sender-checked APIs; no SQL, filesystem
  path, arbitrary process, legacy IPC, or arbitrary network bridge. File dialogs
  are main-owned. Scope and sender are checked again after selection. Catalog
  serialization holds the selected workspace throughout import/export.
- Window close still hides. Page/workspace switching drains the editor. Reload
  cancels unload, flushes, then reloads on a later event-loop turn. Quit freezes
  editor interaction, waits for a flush acknowledgment, then drains capture and
  the catalog. Failure/timeout keeps the app open. Recovery-copy export and an
  explicitly confirmed discard/reload make revision conflicts recoverable.

The existing WAL/FULL/fsync save acknowledgment remains authoritative. Unsent
keystrokes in the debounce window are **not crash-durable**; force-kill can lose
that unacknowledged tail. Do not call this continuous crash-proof draft storage.
Electron requires an explicit beforeunload return value; see its
[BrowserWindow lifecycle documentation](https://www.electronjs.org/docs/latest/api/browser-window).

## Import and Export

Parse Markdown with `markdown-it` 14.3.1 and HTML with `htmlparser2` 10.0.0 plus
`sanitize-html` 2.17.7. Only supported version-1 blocks/marks reach TipTap. Remove
scripts, embeds, images, styling, unsafe/relative URLs and unsupported attributes;
report simplification. Clipboard HTML uses the same parser and locks the editor
while parsing so its insertion selection cannot move underneath the request.

Native file import supports UTF-8 `.txt`, `.md`, `.markdown`, `.html`, `.htm`, and
FocusBae `.json` note exports. Up to 20 files per selection, 3 MiB per file;
canonical content stays limited to 2 MiB with bounded tree depth/node count.
The larger file limit accommodates the portable JSON envelope. Reject binary,
symlink, hardlink, oversized, invalid-schema and malformed input. Imported JSON
creates a new ordinary note, never restores IDs or silently overwrites a daily page.

Preserve every imported file as an immutable managed attachment. The note first
commits an incomplete-preservation warning; only a successful attachment commit
and metadata acknowledgment remove it. An interruption or disk error may leave
a usable partial import with that warning. The selected original is never changed.
Clipboard content is sanitized/reported but has no preserved source-file attachment.

Export the current note, all live notes, or an unsaved recovery draft to a new
exclusive `FocusBae-notes-<UUID>` directory. A version-1 manifest begins with
`complete: false` and becomes complete only after all files are durable. Entries
contain IDs, revisions, Markdown/structured filenames and SHA-256 hashes; preserved
source bytes are included as `.original`. Structured JSON is the lossless document
representation; Markdown is a portable approximation (e.g. underline has no
equivalent). No overwrites of existing directories. A failed export remains an
incomplete bundle and does not alter the workspace.

This is **not a full workspace backup**: no transcript/action/media database,
history, workspace settings, or sync identity round trip. LF-08 owns backup/restore.
There is no generic attachment/image editor or live Markdown-folder synchronization.

## Retrieval and Boundaries

Search uses the existing literal-token AND FTS index, title weighting and bounded
100-result UI. It covers live notes, transcripts and actions; opening a result
reads its current canonical source. Deleting a recording also invalidates its
transcript results. No embeddings or semantic-search claim; LF-09/LF-11 own those.

LF-05 is next: durable account-free recording with lazy permission/consent,
spooled audio, local transcript persistence and recovery. Keep the Record button
disabled until that path is implemented. Optional online voice/screen-sharing,
meeting bots and future sync are not supplied by this notebook milestone.

Reconsider this design when new document node types, a second renderer editor,
sync conflicts, much larger libraries, or general attachments require a versioned
contract change. Do not loosen the IPC/CSP boundary to integrate them.
