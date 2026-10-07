# LF-04e: Note attachment contracts

Date: 2026-10-01. Owner: Codex. Unreleased implementation; public version is 1.3.2.
This amends LF-04's text-only editor/export decisions without changing its HTML
sanitization rules or enabling network access.

## Editor and compatibility

- `noteAttachment` is an atomic block with `{ id: UUID }`, not a URL or path.
  Its file metadata is resolved through authenticated, workspace-scoped IPC.
  Saves verify same-note ownership in the common store `_save` path, including
  restore. Plain text excludes attachment filenames and file contents.
- The content schema remains 1, extended with this block. Database migration 5
  creates `attachments_by_note` as a compatibility fence: older applications
  refuse the workspace instead of silently dropping blocks. Existing data is not
  rewritten. Migration backups and restored older archives use the existing flow.
- Clipboard file data wins over HTML; remote HTML images remain stripped and are
  never downloaded. Drop, paste and the paperclip picker share a sequential upload
  path, lock the editor while adding content, and save each completed file.
- Images use the writing column. Files, including audio/video, use a name/type/size
  card opening macOS Quick Look. There are no inline PDF/audio/video players.

## Storage, access and lifecycle

- Reuse immutable content-hashed, privately permissioned blobs and the existing
  fsync/create/delete journal. The exact limit is 100 * 1024 * 1024 bytes per file;
  UI calls this 100 MB. Reject oversize files before reading and again in main.
- Renderer IPC carries metadata and at most 256 KiB of base64-encoded bytes per
  chunk. One outstanding upload, sequential offsets, declared length, bounded
  messages, and a two-minute idle timeout prevent unbounded staged uploads.
  Staging is private local temporary storage, not canonical until `finish` ACKs.
- `info/open/begin/chunk/finish/cancel` are narrow attachment channels. None accepts
  a renderer filesystem path. `open` verifies bytes and creates a private temporary
  copy with a sanitized extension for Quick Look, not `shell.openPath` execution.
  Orderly quit and permanent deletion clear these temporary copies. An abrupt
  process termination can leave temporary files for macOS temporary-file cleanup.
- Protocol images require exact UUID routes, the currently open workspace, a live
  parent note and matching ownership. MIME comes from PNG/JPEG/GIF/WebP signatures,
  not renderer claims. Responses are `no-store`/`nosniff`; CSP/network denial remains.
- HEIC/HEIF originals remain intact. Local `/usr/bin/sips` creates an optional
  PNG preview, stored through the same journal as another same-note attachment.
  Failed conversion leaves a usable original file card and a visible warning.
- Removing a block preserves bytes for undo; no background attachment GC. Trash
  retains all bytes and prevents protocol access. Restore makes them readable.
  Permanent deletion requires a native confirmation, atomically tombstones the
  note and attachments, empties its content/revision history, and queues journaled
  file removal. Recovery finishes interrupted removals on reopen. Prior backups,
  exports and independently retained commitment evidence are not erased.

## Portable exports and backup

- Text-only JSON exports stay `focusbae-note` version 1; notes with attachments
  use version 2 plus a sidecar manifest (ID, name, type, byte size, SHA-256, relative
  filename and optional preview ID). Attachment IDs are remapped when imported.
- Sidecars use generated UUID filenames in an adjacent `attachments/` directory.
  Markdown uses standard relative images/links; HEIC exports embed the PNG preview
  and also link the original. Keep the export folder together when moving it.
- JSON import validates the complete sidecar set, ownership graph, size, hashes
  and safe filenames before creating the note; it refuses symlinks/traversal and
  rechecks bytes while importing. It never fetches remote resources. An I/O failure
  after note creation leaves a partial-import warning and the original source
  unchanged. JSON, not Markdown re-import, is the lossless round-trip path.
- Backup already includes managed blobs. Restore additionally validates content
  attachment links and preview ownership; copying into a new workspace changes
  workspace identity without changing entity IDs. Protocol URLs are derived anew.

No new dependency, entitlement, account requirement, upload or server endpoint.
