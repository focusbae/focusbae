"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  SystemAudioSource,
  isSupported,
} = require("../meeting-capture/audio-sources");
class Microphone extends EventEmitter {
  constructor() {
    super();
    this.id = randomUUID();
    this.channel = `local-mic:${this.id}`;
    this.sequence = 0;
    this.stopping = false;
  }
  async start() {
    const { BrowserWindow, session, ipcMain } = require("electron");
    this.ipcMain = ipcMain;
    const url = `${pathToFileURL(path.join(__dirname, "mic.html")).href}?capture=${this.id}`;
    const isolated = session.fromPartition(`local-mic-${this.id}`);
    const allowed = new Set([
      url,
      ...["mic.js", "mic-worklet.js"].map(
        (name) => pathToFileURL(path.join(__dirname, name)).href,
      ),
    ]);
    isolated.webRequest.onBeforeRequest((details, done) =>
      done({ cancel: !allowed.has(details.url) }),
    );
    const own = (contents) =>
      contents === this.win?.webContents && contents.getURL() === url;
    isolated.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        own(contents) &&
        permission === "media" &&
        details.mediaType === "audio",
    );
    isolated.setPermissionRequestHandler(
      (contents, permission, done, details) =>
        done(
          own(contents) &&
            permission === "media" &&
            details.mediaTypes?.every((type) => type === "audio"),
        ),
    );
    isolated.on("will-download", (event) => event.preventDefault());
    this.win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        session: isolated,
        preload: path.join(__dirname, "mic-preload.js"),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        webSecurity: true,
      },
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("will-navigate", (event) => event.preventDefault());
    this.win.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    this.win.webContents.on("render-process-gone", () => {
      if (!this.stopping)
        this.emit("error", new Error("Microphone process stopped"));
    });
    this.listener = (event, payload) => {
      if (
        !own(event.sender) ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== url
      )
        return;
      if (payload?.stopped === true && this.stopping) {
        this.stopped?.();
        return;
      }
      if (payload?.error) {
        this.emit(
          "error",
          new Error("Microphone permission, device or audio graph unavailable"),
        );
        return;
      }
      if (
        !(payload?.pcm instanceof Uint8Array) ||
        payload.pcm.length > 32000 ||
        payload.pcm.length % 2 ||
        payload.sequence !== this.sequence++
      ) {
        this.emit("error", new Error("Microphone input sequence interrupted"));
        return;
      }
      if (payload.pcm.length) this.emit("audio", Buffer.from(payload.pcm));
      event.sender.send(`local-mic-ack:${this.id}`);
    };
    ipcMain.on(this.channel, this.listener);
    await this.win.loadURL(url);
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.win && !this.win.isDestroyed()) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 1500);
        this.stopped = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.win.webContents.send(`local-mic-stop:${this.id}`);
      });
      if (!this.win.isDestroyed()) this.win.destroy();
    }
    if (this.listener) this.ipcMain.removeListener(this.channel, this.listener);
    this.win = null;
  }
}
function capabilities() {
  return {
    microphone: {
      ok: process.platform === "darwin",
      reason: "Mac only in this build",
    },
    system: isSupported(),
  };
}
module.exports = {
  Microphone,
  capabilities,
  createSource: (kind) =>
    kind === "system"
      ? new SystemAudioSource({ strict: true })
      : new Microphone(),
};
