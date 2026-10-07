"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { setImmediate: yieldIO } = require("node:timers/promises");
const files = require("./files");
const { check } = require("./errors");
const v = require("./validation");

// Versioned, uncompressed container: bounded manifest + concatenated file bytes.
// No archive library extraction, links, permissions or executable metadata.
const MAGIC = Buffer.from("FOCUSBAE-BACKUP\n1\n");
const MAX_MANIFEST = 32 * 1024 * 1024;
const MAX_BYTES = 200 * 1024 ** 3;
const MAX_FILES = 100000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function safePath(value) {
  return typeof value === "string" && value.length <= 240 &&
    (value === "workspace.sqlite" || /^(attachments|capture-spool)\//.test(value)) &&
    value.split("/").length <= 6 && value.split("/").every((part) =>
      /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
}
function write(fd, buffer) {
  let at = 0;
  while (at < buffer.length) {
    const count = fs.writeSync(fd, buffer, at, buffer.length - at);
    check(count > 0, "DISK_FULL", "Unable to complete backup write"); at += count;
  }
}
function read(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let at = 0;
  while (at < length) {
    const count = fs.readSync(fd, buffer, at, length - at, position + at);
    check(count > 0, "INVALID_BACKUP", "Backup is incomplete"); at += count;
  }
  return buffer;
}
async function transfer(source, target, start, bytes, progress = () => {}) {
  const hash = createHash("sha256");
  for (let at = 0; at < bytes;) {
    const buffer = read(source, Math.min(1024 * 1024, bytes - at), start + at);
    hash.update(buffer); if (target !== null) write(target, buffer);
    at += buffer.length; progress(buffer.length); await yieldIO();
  }
  return hash.digest("hex");
}
function openRead(file) {
  check(files.inspect(file), "INVALID_BACKUP", "Backup file is missing");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { check(fs.fstatSync(fd).isFile() && fs.fstatSync(fd).nlink === 1, "INVALID_BACKUP", "Not a regular backup file"); }
  catch (error) { fs.closeSync(fd); throw error; }
  return fd;
}
function header(fd) {
  const size = fs.fstatSync(fd).size;
  check(size <= MAX_BYTES + MAX_MANIFEST + 100, "INVALID_BACKUP", "Backup exceeds size limit");
  check(read(fd, MAGIC.length, 0).equals(MAGIC), "INVALID_BACKUP", "Not a FocusBae backup");
  const length = read(fd, 4, MAGIC.length).readUInt32LE();
  check(length > 0 && length <= MAX_MANIFEST, "INVALID_BACKUP", "Invalid backup manifest size");
  const expected = read(fd, 32, MAGIC.length + 4).toString("hex");
  const offset = MAGIC.length + 36 + length;
  const raw = read(fd, length, MAGIC.length + 36);
  check(digest(raw) === expected, "INVALID_BACKUP", "Backup manifest checksum failed");
  const manifest = JSON.parse(raw.toString("utf8"));
  v.object(manifest, ["version", "schemaVersion", "workspaceId", "localActorId", "name", "createdAt", "files"]);
  check(manifest.version === 1, "INVALID_BACKUP", "Unsupported backup format");
  v.integer(manifest.schemaVersion, "schema version", 1);
  check(manifest.schemaVersion <= require("./schema").SCHEMA_VERSION, "NEWER_SCHEMA", "Backup requires a newer app");
  v.uuid(manifest.workspaceId); v.uuid(manifest.localActorId);
  v.text(manifest.name, "name", 200); v.text(manifest.createdAt, "date", 40);
  check(Number.isFinite(Date.parse(manifest.createdAt)), "INVALID_BACKUP", "Invalid backup date");
  check(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, "INVALID_BACKUP", "Invalid file count");
  const seen = new Set();
  let total = 0;
  for (const item of manifest.files) {
    v.object(item, ["path", "bytes", "sha256"]);
    check(safePath(item.path) && !seen.has(item.path.toLowerCase()), "INVALID_BACKUP", "Unsafe or duplicate backup path");
    seen.add(item.path.toLowerCase());
    v.integer(item.bytes, "file size", 0, MAX_BYTES);
    check(/^[0-9a-f]{64}$/.test(item.sha256), "INVALID_BACKUP", "Invalid file checksum");
    total += item.bytes;
  }
  check(seen.has("workspace.sqlite") && total <= MAX_BYTES && offset + total === size, "INVALID_BACKUP", "Missing or trailing backup bytes");
  return { manifest, offset, total };
}
function walk(root, prefix) {
  const result = [];
  const visit = (relative) => {
    check(safePath(relative), "INVALID_BACKUP", "Unsafe managed path");
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    check(!stat.isSymbolicLink(), "INVALID_BACKUP", "Managed files cannot be links");
    if (stat.isDirectory()) {
      check(relative.split("/").length < 6, "INVALID_BACKUP", "Managed files are nested too deeply");
      for (const name of fs.readdirSync(full).sort()) visit(`${relative}/${name}`);
    } else {
      check(safePath(relative) && stat.isFile() && stat.nlink === 1, "INVALID_BACKUP", "Unsupported managed file");
      check(result.length < MAX_FILES, "INVALID_BACKUP", "Too many managed files");
      result.push({ path: relative, file: full, bytes: stat.size });
    }
  };
  // managedPath expects a regular final component, so inspect folders separately.
  if (files.inspect(path.join(root, prefix), true)) {
    for (const name of fs.readdirSync(path.join(root, prefix)).sort()) visit(`${prefix}/${name}`);
  }
  return result;
}
async function describe(entries, progress) {
  const result = [];
  let total = 0;
  for (const entry of entries) {
    check(safePath(entry.path) && (total += entry.bytes) <= MAX_BYTES, "INVALID_BACKUP", "Backup exceeds limits");
    const fd = openRead(entry.file);
    try { result.push({ path: entry.path, bytes: entry.bytes, sha256: await transfer(fd, null, 0, entry.bytes, progress) }); }
    finally { fs.closeSync(fd); }
  }
  return result;
}
async function pack(target, metadata, entries, progress) {
  const manifest = { ...metadata, files: await describe(entries, progress) };
  const raw = Buffer.from(JSON.stringify(manifest));
  check(raw.length <= MAX_MANIFEST, "INVALID_BACKUP", "Backup manifest exceeds limit");
  const length = Buffer.alloc(4); length.writeUInt32LE(raw.length);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    write(fd, Buffer.concat([MAGIC, length, Buffer.from(digest(raw), "hex"), raw]));
    for (let n = 0; n < entries.length; n++) {
      const input = openRead(entries[n].file);
      try {
        check(fs.fstatSync(input).size === manifest.files[n].bytes &&
          await transfer(input, fd, 0, manifest.files[n].bytes, progress) === manifest.files[n].sha256,
        "INVALID_BACKUP", "Managed file changed during backup");
      } finally { fs.closeSync(input); }
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return manifest;
}
async function unpack(file, directory, progress) {
  const fd = openRead(file);
  try {
    const data = header(fd); let position = data.offset;
    for (const item of data.manifest.files) {
      const target = path.join(directory, ...item.path.split("/"));
      // directory is newly created and never contains pre-existing links/files.
      files.privateDirectory(path.dirname(target));
      const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        check(await transfer(fd, output, position, item.bytes, progress) === item.sha256, "INVALID_BACKUP", "Backup file checksum failed");
        fs.fsyncSync(output);
      } finally { fs.closeSync(output); }
      files.flushDirectory(path.dirname(target));
      position += item.bytes;
    }
    return data.manifest;
  } finally { fs.closeSync(fd); }
}
async function verify(file, progress) {
  const fd = openRead(file);
  try {
    const data = header(fd); let at = data.offset;
    for (const item of data.manifest.files) {
      check(await transfer(fd, null, at, item.bytes, progress) === item.sha256, "INVALID_BACKUP", "Backup checksum failed");
      at += item.bytes;
    }
    return data.manifest;
  } finally { fs.closeSync(fd); }
}
module.exports = { pack, unpack, verify, walk, safePath, MAGIC };
