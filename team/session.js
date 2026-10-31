"use strict";
const fs = require("node:fs");
const path = require("node:path");
const files = require("../workspace/files");

// The signed-in team account, encrypted at rest with a key held in the macOS Keychain
// (Electron safeStorage). Nothing is written unless a team account is connected.
class SessionStore {
  constructor(directory, crypto) {
    this.file = path.join(directory, "session.bin");
    this.directory = directory;
    this.crypto = crypto;
  }
  read() {
    // Without a saved session the Keychain is never touched, so starting the app
    // with no team account makes no Keychain request at all.
    if (!fs.existsSync(this.file)) return null;
    try {
      if (!this.crypto.isEncryptionAvailable()) return null;
      const value = JSON.parse(this.crypto.decryptString(fs.readFileSync(this.file)));
      if (typeof value?.refreshToken !== "string" || typeof value?.user?.id !== "string") return null;
      return value;
    } catch {
      return null;
    }
  }
  write(session) {
    if (!this.crypto.isEncryptionAvailable()) throw Object.assign(new Error("Keychain encryption is unavailable"), { code: "KEYCHAIN_UNAVAILABLE" });
    files.privateDirectory(this.directory);
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, this.crypto.encryptString(JSON.stringify(session)), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  clear() {
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { SessionStore };
