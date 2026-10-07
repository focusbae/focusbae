'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { check } = require('./errors');

function inspect(file, directory = false) {
  if (!fs.existsSync(file)) {
    // existsSync is false for a dangling symlink, which must not be followed.
    try { check(!fs.lstatSync(file).isSymbolicLink(), 'UNSAFE_PATH', 'Symbolic links are not allowed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return false;
  }
  const info = fs.lstatSync(file);
  check(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1),
    'UNSAFE_PATH', 'Workspace path is not a regular private file or directory');
  return true;
}

function validateLocation(directory) {
  check(typeof directory === 'string' && path.isAbsolute(directory), 'INVALID_INPUT', 'Workspace location must be absolute');
  const parent = fs.realpathSync(path.dirname(directory));
  const resolved = path.join(parent, path.basename(directory));
  const home = fs.realpathSync(os.homedir());
  check(!/(^|\/)(Dropbox|OneDrive[^/]*|Google Drive|GoogleDrive|CloudStorage|Mobile Documents)(\/|$)/i.test(resolved) &&
    ![path.join(home, 'Desktop'), path.join(home, 'Documents')].some((base) => resolved === base || resolved.startsWith(`${base}/`)),
  'UNSUPPORTED_LOCATION', 'Choose a local directory outside cloud-synced folders');
  check(process.platform === 'darwin' && fs.statfsSync(parent).type === 26,
    'UNSUPPORTED_LOCATION', 'This storage release is qualified only on local macOS APFS');
  inspect(resolved, true);
  return resolved;
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  inspect(directory, true);
  fs.chmodSync(directory, 0o700);
}

function flushDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      check(written > 0, 'IO_ERROR', 'Unable to complete local file write');
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function atomicJson(file, value) {
  inspect(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeExclusive(temp, Buffer.from(`${JSON.stringify(value)}\n`));
  fs.renameSync(temp, file);
  flushDirectory(path.dirname(file));
}

function managedPath(root, relative) {
  check(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\') &&
    relative.split('/').every((part) => part && part !== '.' && part !== '..'), 'UNSAFE_PATH', 'Invalid managed path');
  const parts = relative.split('/');
  let current = root;
  inspect(root, true);
  parts.forEach((part, index) => {
    current = path.join(current, part);
    inspect(current, index !== parts.length - 1);
  });
  return current;
}

function fileHash(file) {
  inspect(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

module.exports = { inspect, validateLocation, privateDirectory, flushDirectory, writeExclusive, atomicJson, managedPath, fileHash };
