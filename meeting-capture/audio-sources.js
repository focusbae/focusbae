/**
 * The two audio streams a local meeting capture reads.
 *
 *   system output  everyone else on the call, tapped via CoreAudio process taps
 *   microphone     the user
 *
 * Keeping them separate is what makes speaker attribution exact without a
 * diarization model. A bot in the call gets per-participant labels; this gets a
 * clean two-way split instead -- worse for "which of the four attendees said that",
 * better for the only question commitment extraction actually needs, which is
 * whether the person promising is the user or someone else. Grounding then resolves
 * ownership off that label with no inference at all.
 *
 * Requires macOS 14.2+ (Core Audio taps) and the System Audio Recording permission.
 * There is no Windows path yet; see isSupported().
 */
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SAMPLE_RATE = 16000;

/** Lowest macOS release with the Core Audio process-tap API. */
const MIN_DARWIN_MAJOR = 23; // Darwin 23.x == macOS 14.x

function isSupported({ platform = process.platform, release = os.release() } = {}) {
  if (platform !== "darwin") {
    return { ok: false, reason: "Local capture is macOS-only for now" };
  }
  const [major, minor] = release.split('.').map(Number);
  if (!Number.isFinite(major) || major < MIN_DARWIN_MAJOR || (major === 23 && !(minor >= 2))) {
    return { ok: false, reason: "Requires macOS 14.2 or later" };
  }
  return { ok: true };
}

// audiotee finds its binary next to its own module, which in a packaged app is
// inside app.asar -- and the OS cannot execute a file inside an archive (spawn
// fails with ENOTDIR). electron-builder unpacks the binary beside the archive, so
// point at that copy. In development there is no archive and the path is unchanged.
function audioteeBinary(base = path.join(__dirname, "..", "node_modules", "audiotee", "bin", "audiotee")) {
  return base.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * System audio via the `audiotee` binary.
 *
 * Loaded lazily so the module can be required on any platform -- main.js pulls this
 * in at startup to decide whether to show the menu item at all, and a hard require
 * would crash the whole app on a machine where the optional dependency is absent.
 */
class SystemAudioSource extends EventEmitter {
  constructor({ strict = false } = {}) {
    super();
    this._tee = null;
    this.strict = strict;
    this.stopping = false;
  }

  async start() {
    const support = isSupported();
    if (!support.ok) throw new Error(support.reason);

    let AudioTee;
    try {
      ({ AudioTee } = await import("audiotee"));
    } catch (e) {
      throw new Error(
        "System audio capture is unavailable (audiotee could not load). " +
          (e.message || "Run `npm install` in the app directory.")
      );
    }

    // Asking for an explicit sample rate matters twice over: it is what makes
    // audiotee emit signed 16-bit rather than 32-bit float, and 16 kHz mono int16
    // is exactly the speech helper's input format -- so nothing downstream resamples or
    // converts, which is where drift and clipping usually creep in.
    if (this.stopping) throw new Error('System source start was cancelled');
    const binaryPath = audioteeBinary();
    if (!fs.existsSync(binaryPath))
      throw new Error(`System audio capture is unavailable (audiotee binary missing at ${binaryPath})`);
    this._tee = new AudioTee({ sampleRate: SAMPLE_RATE, binaryPath });

    this._tee.on("data", (chunk) => {
      const buf = chunk && chunk.data ? chunk.data : chunk;
      if (buf && buf.length) this.emit("audio", buf);
    });
    this._tee.on("error", (err) => this.emit("error", err));
    // The binary logs permission problems here rather than failing loudly, and a
    // silent capture that produces an empty transcript is the worst outcome, so
    // these are surfaced rather than swallowed.
    this._tee.on("log", (msg) => this.emit("log", String(msg)));

    await this._tee.start();
    if (this.strict) this._tee.process?.once('exit', () => {
      if (!this.stopping) this.emit('error', new Error('System audio source ended unexpectedly'));
    });
    this.emit("started");
  }

  async stop() {
    this.stopping = true;
    if (!this._tee) return;
    try {
      await this._tee.stop();
    } catch (e) {
      console.warn("[capture] system audio stop failed:", e.message);
    }
    this._tee = null;
  }
}

/**
 * Microphone audio, captured in a hidden renderer.
 *
 * Electron's main process has no microphone access; getUserMedia lives in a
 * renderer. So an offscreen window runs an AudioWorklet that downsamples to 16 kHz
 * mono int16 and posts frames back over IPC. Same format as the system tap, so both
 * feed identical segmenters.
 *
 * The window is created hidden and destroyed on stop -- it exists only for the
 * duration of a meeting, and the audio it produces is never written to disk.
 */
class MicrophoneSource extends EventEmitter {
  /**
   * @param {object} deps
   * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
   * @param {typeof import('electron').ipcMain} deps.ipcMain
   * @param {string} deps.preloadPath
   * @param {string} deps.pagePath  file:// URL of mic-capture.html
   */
  constructor({ BrowserWindow, ipcMain, preloadPath, pagePath }) {
    super();
    this._BrowserWindow = BrowserWindow;
    this._ipcMain = ipcMain;
    this._preloadPath = preloadPath;
    this._pagePath = pagePath;
    this._win = null;
    this._channel = `meeting-capture-mic-${Date.now()}`;
    this._onChunk = null;
  }

  async start() {
    this._onChunk = (_event, payload) => {
      if (payload && payload.error) {
        this.emit("error", new Error(payload.error));
        return;
      }
      const buf = Buffer.from(payload.pcm);
      if (buf.length) this.emit("audio", buf);
    };
    this._ipcMain.on(this._channel, this._onChunk);

    this._win = new this._BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        preload: this._preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    await this._win.loadURL(
      `${this._pagePath}?channel=${encodeURIComponent(this._channel)}&rate=${SAMPLE_RATE}`
    );
    this.emit("started");
  }

  async stop() {
    if (this._onChunk) {
      this._ipcMain.removeListener(this._channel, this._onChunk);
      this._onChunk = null;
    }
    if (this._win && !this._win.isDestroyed()) {
      // Destroy rather than close: the page holds a live MediaStream, and a
      // lingering one keeps the macOS microphone indicator lit after the meeting
      // has ended, which reads as the app still listening.
      this._win.destroy();
    }
    this._win = null;
  }
}

module.exports = { SystemAudioSource, MicrophoneSource, isSupported, audioteeBinary, SAMPLE_RATE };
