"use strict";
// Local desktop entry. Connected calling, legacy capture and onboarding are not loaded.
const fs = require("node:fs");
const path = require("node:path");
const { app, Menu, Tray, nativeImage, globalShortcut, dialog, session } = require("electron");
const privacy = require("./privacy/local-runtime");
const { installSessionPolicy } = require("./privacy/local-electron-session");
const workspace = require("./workspace-window");
const { autoUpdater, CancellationToken } = require("electron-updater");
const { LocalUpdater } = require("./update/local-updater");
const updates = new LocalUpdater({ app, privacy, updater: autoUpdater, CancellationToken });

let tray;
let quitting = false;
let draining = false;
const shortcuts = {};
const defaults = {
  workspace: ["Alt+Space", "CommandOrControl+Shift+Space"],
  newNote: ["Alt+N", "CommandOrControl+Shift+N"],
  actions: ["Alt+D", "CommandOrControl+Shift+D"],
  record: ["Alt+R", "CommandOrControl+Shift+R"],
};
const configFile = () => path.join(app.getPath("userData"), "user_config.json");
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return {}; }
}
function writeConfig(patch) {
  const target = configFile();
  const temp = target + ".tmp";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify({ ...readConfig(), ...patch }));
  fs.renameSync(temp, target);
}
function showInDock() { return readConfig().showInDock !== false; }
function applyDockPreference(enabled) {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy(enabled ? "regular" : "accessory");
  if (enabled) app.dock?.show();
  else app.dock?.hide();
}
function record() {
  const active = workspace.recording()?.active;
  if (active) workspace.recording().stop(active.id).catch(console.error);
  else workspace.open(workspace.recordingBusy() ? "recordings" : "record");
}
const handlers = {
  workspace: () => workspace.open(),
  newNote: () => workspace.open("new-note"),
  actions: () => workspace.open("actions"),
  record,
};
function bind(name, accelerator) {
  try {
    if (Object.entries(shortcuts).some(([other, key]) => other !== name && key === accelerator)) return false;
    if (!globalShortcut.register(accelerator, handlers[name])) return false;
    if (shortcuts[name]) globalShortcut.unregister(shortcuts[name]);
    shortcuts[name] = accelerator;
    return true;
  } catch { return false; }
}
function bindAll() {
  const configured = readConfig().shortcuts || {};
  for (const name of Object.keys(defaults)) {
    for (const key of [configured[name], ...defaults[name]].filter(Boolean)) {
      if (bind(name, key)) break;
    }
  }
}
function setShortcut(name, accelerator) {
  if (!defaults[name] || typeof accelerator !== "string") return { ok: false, error: "Invalid shortcut." };
  if (shortcuts[name] === accelerator) return { ok: true, accelerator };
  if (!bind(name, accelerator)) return { ok: false, error: "Another app is using that combination." };
  writeConfig({ shortcuts: { ...readConfig().shortcuts, [name]: accelerator } });
  refreshTray();
  return { ok: true, accelerator };
}
function resetShortcut(name) {
  if (!defaults[name]) return { ok: false, error: "Unknown shortcut." };
  if (shortcuts[name]) { globalShortcut.unregister(shortcuts[name]); delete shortcuts[name]; }
  const configured = { ...readConfig().shortcuts };
  delete configured[name];
  writeConfig({ shortcuts: configured });
  for (const key of defaults[name]) if (bind(name, key)) break;
  refreshTray();
  return { ok: true, accelerator: shortcuts[name] };
}
function parseShortcut(input) {
  if (input.key === "Escape") return { cancelled: true };
  if (input.type !== "keyDown" || input.isAutoRepeat) return null;
  const code = input.code || "";
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3)
    : /^Digit[0-9]$/.test(code) ? code.slice(5)
    : /^F([1-9]|1[0-9]|2[0-4])$/.test(code) ? code
    : ({ Space: "Space", Enter: "Return", Tab: "Tab", ArrowUp: "Up",
      ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" })[code];
  if (!key) return null;
  const mods = [input.meta && "CommandOrControl", input.control && !input.meta && "Control",
    input.alt && "Alt", input.shift && "Shift"].filter(Boolean);
  if (!mods.length && !key.startsWith("F")) return { ok: false, error: "Add a modifier key." };
  return { accelerator: [...mods, key].join("+") };
}
function captureShortcut(event, name) {
  if (!defaults[name] || !workspace.owns(event.sender)) return { ok: false, error: "Unknown shortcut." };
  const contents = event.sender;
  const saved = { ...shortcuts };
  for (const key of Object.values(saved)) globalShortcut.unregister(key);
  return new Promise((resolve) => {
    let done = false;
    const restore = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      contents.removeListener("before-input-event", onInput);
      contents.removeListener("did-start-loading", cancelled);
      for (const [n, key] of Object.entries(saved)) {
        if (shortcuts[n] === key) globalShortcut.register(key, handlers[n]);
      }
      resolve(result);
    };
    const cancelled = () => restore({ cancelled: true });
    const onInput = (inputEvent, input) => {
      if (input.type !== "keyDown") return;
      inputEvent.preventDefault();
      const parsed = parseShortcut(input);
      if (!parsed) return;
      if (parsed.cancelled || parsed.ok === false) return restore(parsed);
      restore(setShortcut(name, parsed.accelerator));
    };
    const timer = setTimeout(cancelled, 30000);
    contents.on("before-input-event", onInput);
    contents.once("did-start-loading", cancelled);
    workspace.getWindow()?.focus();
  });
}
function refreshTray() {
  if (!tray) return;
  const active = workspace.recording()?.active;
  tray.setTitle(active ? "REC" : "");
  const label = (name, key) => shortcuts[key] ? name + "  " + shortcuts[key] : name;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: label("Open Workspace", "workspace"), click: handlers.workspace },
    { label: label("New note", "newNote"), click: handlers.newNote },
    { label: label(active ? "Stop recording" : "Record…", "record"), click: record },
    { label: label("Actions", "actions"), click: handlers.actions },
    ...(workspace.clipboardHistory()?.enabled ? [{ label: "Clipboard history", click: () => workspace.open("clipboard") }] : []),
    { type: "separator" },
    { label: "Settings…", click: () => workspace.open("settings") },
    { label: "Quit", click: () => app.quit() },
  ]));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => workspace.open());
  app.whenReady().then(() => {
    privacy.initialize({ app, dialog });
    installSessionPolicy(session.defaultSession, privacy.policy);
    workspace.initialize({
      privacy, busy: () => false, onRecordingChange: refreshTray,
      desktopSettings: {
        get: () => ({ shortcuts: { ...shortcuts }, openAtLogin: app.getLoginItemSettings().openAtLogin,
          showInDock: showInDock(),
          version: app.getVersion(), packaged: app.isPackaged, updates: updates.snapshot() }),
        checkForUpdates: () => updates.check(),
        downloadUpdate: () => updates.download(),
        installUpdate: async () => {
          if (!updates.canInstall()) return { ok: false, error: "No downloaded update is ready." };
          if (!await workspace.flushPending()) return { ok: false, error: "Save your writing before installing." };
          if (workspace.recording()?.active || workspace.recordingBusy())
            return { ok: false, error: "Finish the recording before installing." };
          await workspace.close();
          quitting = true;
          workspace.setQuitting(true);
          updates.install();
          return { ok: true };
        },
        captureShortcut, resetShortcut,
        setLogin: (enabled) => {
          app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
          return { openAtLogin: app.getLoginItemSettings().openAtLogin };
        },
        setDock: (enabled) => {
          applyDockPreference(enabled);
          writeConfig({ showInDock: enabled });
          return { showInDock: enabled };
        },
      },
    });
    const icon = nativeImage.createFromPath(path.join(__dirname, "tray-icon.png"));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("FocusBae");
    applyDockPreference(showInDock());
    bindAll();
    refreshTray();
    workspace.open();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { label: "File", submenu: [
        { label: "Open Workspace", click: handlers.workspace },
        { label: "New note", click: handlers.newNote },
        { label: "Record / Stop", click: record },
        { label: "Actions", click: handlers.actions },
        { label: "Settings…", click: () => workspace.open("settings") },
        { role: "close" },
      ] },
      { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    ]));
  }).catch((error) => { console.error(error); app.quit(); });
  app.on("activate", () => workspace.open());
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    Promise.resolve().then(async () => {
      if (!await workspace.flushPending()) {
        workspace.resume();
        workspace.open();
        await dialog.showMessageBox(workspace.getWindow(), { type: "warning",
          message: "Your writing has not been saved.", buttons: ["Keep open"] });
        return false;
      }
      await workspace.close();
      return true;
    }).then((ok) => {
      if (ok) { quitting = true; workspace.setQuitting(true); app.quit(); }
    }).catch((error) => { workspace.resume(); console.error(error); })
      .finally(() => { draining = false; });
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
