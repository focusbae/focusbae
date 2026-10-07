"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async ({ app, page, output, packaged, clickPage }) => {
  const tray = (prefix) => app.evaluate((_electron, prefix) => {
    const item = global.workspaceProbe.trayMenu().find((item) => item.label?.startsWith(prefix));
    if (!item) throw new Error(`Missing tray entry: ${prefix}`);
    item.click();
  }, prefix);
  const labels = await app.evaluate(() => global.workspaceProbe.trayMenu().map((item) => item.label).filter(Boolean));
  assert.equal(labels.some((label) => /Talk|Dashboard|Connect account|not integrated|Clipboard|Meetings/.test(label)), false);
  assert.match(labels[0], /^Open Workspace/);
  assert.equal(labels.some((label) => /Privacy|updates/.test(label)), false);
  const shortcuts = await page.evaluate(async () => (await window.focusbaeWorkspace.appSettings.get()).value.shortcuts);
  assert.deepEqual(Object.keys(shortcuts).sort(), ["actions", "newNote", "record", "workspace"]);
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await body.fill("Entry point draft survives navigation.");
  await tray("Actions");
  await page.getByRole("heading", { name: "Actions", exact: true }).first().waitFor();
  await clickPage(page, "Today");
  await body.waitFor();
  assert.equal(await body.innerText(), "Entry point draft survives navigation.");
  await tray("New note");
  await page.waitForFunction(() => document.querySelector('[aria-label="Note title"]')?.value === "");
  await body.fill("Entry point new page.");
  await app.evaluate(() => global.workspaceProbe.shortcuts.get("Alt+D")());
  await page.getByRole("heading", { name: "Actions", exact: true }).first().waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).hide());
  await tray("Settings");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().endsWith("shortcuts.html")).length), 0);
  const appSettings = page.getByRole("region", { name: "App & shortcuts" });
  await appSettings.getByRole("switch", { name: "Open at login" }).click();
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.appSettings.get()).value.openAtLogin);
  await appSettings.getByRole("switch", { name: "Open at login" }).click();
  await page.waitForFunction(async () => !(await window.focusbaeWorkspace.appSettings.get()).value.openAtLogin);
  await appSettings.getByRole("switch", { name: "Show in Dock" }).click();
  await page.waitForFunction(async () => !(await window.focusbaeWorkspace.appSettings.get()).value.showInDock);
  await tray("Open Workspace");
  assert.equal((await page.evaluate(async () => window.focusbaeWorkspace.appSettings.get())).value.showInDock, false);
  await appSettings.getByRole("switch", { name: "Show in Dock" }).click();
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.appSettings.get()).value.showInDock);
  const change = appSettings.getByRole("button", { name: "Change Actions shortcut", exact: true });
  await change.click();
  await page.waitForFunction(() => document.querySelector(".app-settings")?.textContent.includes("Press keys…"));
  await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).webContents;
    for (let n = 0; n < 100 && !contents.listenerCount("before-input-event"); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    contents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", code: "KeyY", key: "y", alt: true });
  });
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.appSettings.get()).value.shortcuts.actions === "Alt+Y");
  await appSettings.getByRole("button", { name: "Reset Actions shortcut", exact: true }).click();
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.appSettings.get()).value.shortcuts.actions === "Alt+D");
  await appSettings.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}app-settings.png`) });
  await app.evaluate(() => global.workspaceProbe.shortcuts.get("Alt+R")());
  const record = page.getByRole("dialog", { name: "New recording" });
  await record.waitFor();
  assert.equal(await page.evaluate(async () => (await window.focusbaeWorkspace.capture.state()).value.active), null);
  // An external navigation intent waits for the current dialog to finish.
  await tray("Actions");
  assert.equal(await record.isVisible(), true);
  await record.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "Actions", exact: true }).first().waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"));
    win.webContents.once("did-start-loading", () => global.workspaceProbe.openCommand("settings"));
    win.webContents.reload();
  });
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await app.evaluate(async () => {
    for (const name of ["command.take", "command.ack", "appSettings.get", "appSettings.captureShortcut", "appSettings.resetShortcut", "appSettings.setLogin", "appSettings.setDock", "appSettings.checkForUpdates", "appSettings.downloadUpdate", "appSettings.installUpdate", "privacy.revoke", "clipboard.state", "clipboard.setEnabled", "clipboard.clear", "clipboard.copy", "clipboard.remove"]) {
      const result = await global.workspaceProbe.handlers.get(`workspace:${name}`)({ sender: {}, senderFrame: {} }, {});
      if (result.error?.code !== "PERMISSION_DENIED") throw new Error(`${name} accepted a foreign sender`);
    }
  });
  const rejected = await page.evaluate(() => window.focusbaeWorkspace.appSettings.captureShortcut({ name: "talk" }));
  assert.equal(rejected.error.code, "INVALID_INPUT");
  await app.evaluate(({ app }) => app.emit("open-url", { preventDefault() {} }, "focusbae://auth-success?code=retired-flow"));
  assert.equal(await page.evaluate(async () => (await window.focusbaeWorkspace.bootstrap()).value.privacy.connected), false);
  // A newer intent must survive a busy->ready transition before the old ack returns.
  await app.evaluate(({ ipcMain }) => {
    const original = global.workspaceProbe.handlers.get("workspace:command.ack");
    ipcMain.removeHandler("workspace:command.ack");
    ipcMain.handle("workspace:command.ack", async (event, input) => {
      ipcMain.removeHandler("workspace:command.ack");
      ipcMain.handle("workspace:command.ack", original);
      await new Promise((resolve) => { global.workspaceProbe.releaseCommandAck = resolve; });
      return original(event, input);
    });
  });
  await tray("New note");
  await page.waitForFunction(() => document.querySelector('[aria-label="Note title"]')?.value === "");
  await app.evaluate(async () => {
    for (let n = 0; n < 100 && !global.workspaceProbe.releaseCommandAck; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!global.workspaceProbe.releaseCommandAck) throw new Error("Command acknowledgement was not reached");
    global.workspaceProbe.openCommand("settings");
    global.workspaceProbe.releaseCommandAck();
  });
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await clickPage(page, "Today");
};
