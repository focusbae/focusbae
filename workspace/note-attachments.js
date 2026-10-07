"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const v = require("./validation");
const { check } = require("./errors");
const files = require("./files");
const { MAX_BYTES } = require("./attachments");

const CHUNK_BYTES = 256 * 1024;
const MIME = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", mp3: "audio/mpeg", mp4: "video/mp4", mov: "video/quicktime", wav: "audio/wav", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", key: "application/x-iwork-keynote-sffkey", numbers: "application/x-iwork-numbers-sffnumbers" };
const mutation = (store, revision) => ({ workspaceId: store.identity.id, clientRequestId: randomUUID(), ...(revision ? { expectedRevision: revision } : {}) });
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
function imageURL(workspaceId, noteId, id) {
  return `focusbae-workspace://app/attachments/${workspaceId}/${noteId}/${id}`;
}
function parseImageURL(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "focusbae-workspace:" || url.host !== "app" || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.split("/");
    if (parts.length !== 5 || parts[1] !== "attachments") return null;
    const [workspaceId, noteId, id] = parts.slice(2).map((id) => v.uuid(id));
    if (raw !== imageURL(workspaceId, noteId, id)) return null;
    return { workspaceId, noteId, id };
  } catch { return null; }
}
function owned(store, noteId, id) {
  store._live("note", v.uuid(noteId));
  const record = store._live("attachment", v.uuid(id));
  check(record.noteId === noteId, "SCOPE_MISMATCH", "Attachment belongs to another note");
  return record;
}
function info(store, noteId, id) {
  const record = owned(store, noteId, id);
  const preview = record.previewId ? owned(store, noteId, record.previewId) : record;
  return { id, displayName: record.displayName, mediaType: record.mediaType, byteSize: record.byteSize,
    imageUrl: ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(preview.mediaType)
      ? imageURL(store.identity.id, noteId, id) : null };
}
function imageResponse(catalog, raw) {
  try {
    const scope = parseImageURL(raw);
    check(scope, "NOT_FOUND", "Invalid image URL");
    const store = catalog.scoped(scope.workspaceId);
    const record = owned(store, scope.noteId, scope.id);
    const preview = record.previewId ? owned(store, scope.noteId, record.previewId) : record;
    const bytes = store.readAttachment({ workspaceId: scope.workspaceId }, preview.id);
    const type = imageType(bytes);
    check(type, "NOT_FOUND", "Not a supported image");
    return new Response(bytes, { headers: { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
  } catch { return new Response("Not found", { status: 404 }); }
}

// The renderer sends bounded chunks, never a filesystem path. Only one upload
// can be outstanding, with a declared size and an idle timeout. Staging is local.
class NoteAttachments {
  constructor(catalog) { this.catalog = catalog; this.upload = null; this.previews = new Map(); this.root = null; }
  directory() { return this.root ??= fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-note-files-")); }
  cancel() {
    if (!this.upload) return;
    clearTimeout(this.upload.timer);
    fs.closeSync(this.upload.fd);
    fs.unlinkSync(this.upload.file);
    this.upload = null;
  }
  touch() {
    clearTimeout(this.upload.timer);
    this.upload.timer = setTimeout(() => this.cancel(), 120000);
    this.upload.timer.unref();
  }
  begin(input) {
    v.object(input, ["workspaceId", "noteId", "displayName", "byteSize"]);
    const store = this.catalog.scoped(input.workspaceId);
    store._live("note", v.uuid(input.noteId));
    v.integer(input.byteSize, "file size", 0);
    check(input.byteSize <= MAX_BYTES, "ATTACHMENT_TOO_LARGE", "Choose a file smaller than 100 MB");
    v.text(input.displayName, "file name", 255);
    check(!this.upload, "WORKSPACE_BUSY", "Another file is being attached");
    const token = randomUUID(), file = path.join(this.directory(), token);
    this.upload = { ...input, token, file, fd: fs.openSync(file, "wx", 0o600), received: 0 };
    this.touch();
    return { token };
  }
  current(input) {
    v.uuid(input.token);
    const item = this.upload;
    check(item && item.token === input.token && item.workspaceId === input.workspaceId, "NOT_FOUND", "File transfer expired. Try attaching it again");
    const store = this.catalog.scoped(input.workspaceId);
    store._live("note", item.noteId);
    return item;
  }
  chunk(input) {
    v.object(input, ["workspaceId", "token", "offset", "data"]);
    const item = this.current(input);
    v.integer(input.offset, "offset", 0);
    check(input.offset === item.received && typeof input.data === "string" && input.data.length <= 4 * Math.ceil(CHUNK_BYTES / 3) && /^[A-Za-z0-9+/]*={0,2}$/.test(input.data), "INVALID_INPUT", "Invalid file chunk");
    const bytes = Buffer.from(input.data, "base64");
    check(bytes.toString("base64") === input.data, "INVALID_INPUT", "Invalid file encoding");
    check(bytes.length > 0 && bytes.length <= CHUNK_BYTES && item.received + bytes.length <= item.byteSize, "INVALID_INPUT", "File size changed during transfer");
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(item.fd, bytes, written, bytes.length - written);
    item.received += bytes.length;
    this.touch();
    return { received: item.received };
  }
  finish(input) {
    v.object(input, ["workspaceId", "token"]);
    const item = this.current(input);
    check(item.received === item.byteSize, "INVALID_INPUT", "Incomplete file transfer");
    const store = this.catalog.scoped(input.workspaceId);
    try { return this.put(store, item.noteId, item.displayName, fs.readFileSync(item.file)); }
    finally { this.cancel(); }
  }
  put(store, noteId, displayName, bytes) {
    const extension = path.extname(displayName).slice(1).toLowerCase();
    const heic = ["heic", "heif"].includes(extension);
    const mediaType = imageType(bytes) ?? (heic ? "image/heic" : MIME[extension] ?? "application/octet-stream");
    let record = store.putAttachment(mutation(store), { noteId, displayName, mediaType }, bytes);
    let warning = null;
    if (heic) {
      const source = path.join(this.directory(), `${randomUUID()}.heic`), target = `${source}.png`;
      try {
        files.writeExclusive(source, bytes);
        execFileSync("/usr/bin/sips", ["-s", "format", "png", source, "--out", target], { timeout: 20000, stdio: "ignore" });
        check(fs.statSync(target).size <= MAX_BYTES, "ATTACHMENT_TOO_LARGE", "Image preview is too large");
        const converted = fs.readFileSync(target);
        check(imageType(converted) === "image/png", "INVALID_INPUT", "Invalid converted image");
        const preview = store.putAttachment(mutation(store), { noteId, displayName: `${path.parse(displayName).name}.png`, mediaType: "image/png" }, converted);
        record = store.updateAttachment(mutation(store, record.revision), record.id, { previewId: preview.id });
      } catch { warning = "The original HEIC file was saved, but its image preview could not be created. You can still open it in Quick Look."; }
      finally { for (const file of [source, target]) if (fs.existsSync(file)) fs.unlinkSync(file); }
    }
    return { ...info(store, noteId, record.id), warning };
  }
  open(input, window) {
    v.object(input, ["workspaceId", "noteId", "id"]);
    const store = this.catalog.scoped(input.workspaceId);
    const record = owned(store, input.noteId, input.id);
    // Verify on every open, even if a Quick Look copy was already prepared.
    const bytes = store.readAttachment({ workspaceId: input.workspaceId }, record.id);
    const key = `${input.workspaceId}-${record.id}`;
    let file = this.previews.get(key);
    if (!file) {
      const ext = path.extname(record.displayName).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 20);
      file = path.join(this.directory(), `${key}${ext}`);
      files.writeExclusive(file, bytes);
      this.previews.set(key, file);
    }
    window.previewFile(file, record.displayName);
    return { opened: true };
  }
  close() {
    this.cancel();
    if (this.root) fs.rmSync(this.root, { recursive: true, force: true });
    this.root = null;
    this.previews.clear();
  }
}
module.exports = { NoteAttachments, info, owned, imageType, imageResponse, parseImageURL, CHUNK_BYTES };
