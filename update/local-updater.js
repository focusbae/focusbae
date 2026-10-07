"use strict";
const QA = require("../package.json").focusbaeUpdateQa === true;
const FEED = new URL(QA
  ? "http://127.0.0.1:17832/"
  : "https://pub-f1d20a395b224af7aff8e7b531dbfdae.r2.dev/local/macos/arm64/");

function trustedFiles(info) {
  return Array.isArray(info?.files) && info.files.length > 0 && info.files.every((file) => {
    if (typeof file.url !== "string" || typeof file.sha512 !== "string" || !file.sha512) return false;
    try {
      const url = new URL(file.url, FEED);
      return url.protocol === FEED.protocol && url.host === FEED.host &&
        !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.startsWith(FEED.pathname) &&
        (QA
          ? /\/FocusBae-Update-QA-[0-9]+\.[0-9]+\.[0-9]+-arm64\.(?:zip|dmg)$/.test(url.pathname)
          : /\/FocusBae-[0-9]+\.[0-9]+\.[0-9]+-arm64(?:-mac\.zip|\.dmg)$/.test(url.pathname));
    } catch { return false; }
  });
}

// No network request is made on launch. Settings is the only entry point.
class LocalUpdater {
  constructor({ app, privacy, updater, CancellationToken }) {
    this.app = app;
    this.privacy = privacy;
    this.updater = updater;
    this.CancellationToken = CancellationToken;
    this.state = { status: "idle", version: null, percent: 0 };
    this.token = null;
    this.busy = false;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    // electron-updater emits both a rejected promise and an EventEmitter error.
    updater.on("error", () => {});
    updater.on("download-progress", ({ percent }) => {
      if (this.state.status === "downloading")
        this.state = { ...this.state, percent: Math.max(0, Math.min(100, Math.round(percent))) };
    });
    updater.on("update-downloaded", () => {
      if (this.state.status === "downloading")
        this.state = { ...this.state, status: "ready", percent: 100 };
    });
    privacy.policy.on("change", () => {
      if (!privacy.policy.allows("updates")) this.token?.cancel();
    });
  }

  snapshot() { return { ...this.state }; }

  supported() {
    return this.app.isPackaged && process.platform === "darwin";
  }

  async check() {
    if (!this.supported()) return { ...this.snapshot(), status: "unavailable" };
    if (this.busy) return this.snapshot();
    if (!await this.privacy.permit("updates")) return this.snapshot();
    this.busy = true;
    this.state = { status: "checking", version: null, percent: 0 };
    try {
      const result = await this.updater.checkForUpdates();
      this.privacy.policy.assert("updates");
      const version = result?.updateInfo?.version;
      if (result && Object.hasOwn(result, "downloadPromise") && !trustedFiles(result.updateInfo))
        throw new Error("Untrusted update metadata");
      this.state = version && result && Object.hasOwn(result, "downloadPromise")
        ? { status: "available", version, percent: 0 }
        : { status: "current", version: this.app.getVersion(), percent: 0 };
      return this.snapshot();
    } catch {
      this.state = { status: "error", version: null, percent: 0 };
      return this.snapshot();
    } finally {
      this.busy = false;
      this.privacy.policy.revoke("updates");
    }
  }

  async download() {
    if (this.busy || this.state.status !== "available" || !this.supported()) return this.snapshot();
    if (!await this.privacy.permit("updates", "download")) return this.snapshot();
    this.busy = true;
    this.token = new this.CancellationToken();
    this.state = { ...this.state, status: "downloading", percent: 0 };
    try {
      await this.updater.downloadUpdate(this.token);
      this.privacy.policy.assert("updates");
      this.state = { ...this.state, status: "ready", percent: 100 };
      return this.snapshot();
    } catch {
      this.state = { ...this.state,
        status: this.privacy.policy.allows("updates") ? "error" : "available", percent: 0 };
      return this.snapshot();
    } finally {
      this.token = null;
      this.busy = false;
      this.privacy.policy.revoke("updates");
    }
  }

  canInstall() { return this.state.status === "ready" && !this.busy; }
  install() {
    if (!this.canInstall()) return false;
    this.updater.quitAndInstall();
    return true;
  }
}

module.exports = { LocalUpdater };
