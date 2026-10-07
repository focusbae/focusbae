"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async ({ app, page, output, packaged, clickPage }) => {
  await clickPage(page, "Settings");
  const privacy = page.getByRole("region", { name: "Privacy", exact: true });
  const updates = page.getByRole("region", { name: "About & updates" });
  const clipboard = page.getByRole("region", { name: "Clipboard history", exact: true });
  if (packaged) await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  if (packaged) {
    await updates.getByRole("button", { name: "Check for updates", exact: true }).click();
    await updates.getByRole("status").filter({ hasText: "Update cancelled" }).waitFor();
  } else {
    assert.equal(await updates.getByRole("button", { name: "Check for updates", exact: true }).isDisabled(), true);
    await updates.getByText("This development build cannot install them.", { exact: false }).waitFor();
  }
  assert.equal((await page.evaluate(() => window.focusbaeWorkspace.appSettings.checkForUpdates({ url: "https://example.invalid" }))).error.code, "INVALID_INPUT");
  assert.equal((await page.evaluate(() => window.focusbaeWorkspace.privacy.revoke({ purpose: "clipboard" }))).error.code, "INVALID_INPUT");
  await app.evaluate(() => {
    // No download is started; verify the new session-permission revoke control.
    global.workspaceProbe.authorizeModelPermission();
  });
  await privacy.getByRole("button", { name: "Revoke model downloads" }).click();
  await page.waitForFunction(async () => !(await window.focusbaeWorkspace.privacy.get()).value.grants.includes("models"));
  const enable = clipboard.getByRole("switch", { name: "Remember copied text this session" });
  assert.equal(await enable.isChecked(), false);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await enable.click();
  await page.waitForFunction(() => document.querySelector('#clipboard-enabled')?.disabled === false);
  assert.equal(await enable.isChecked(), false);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await enable.click();
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.clipboard.state()).value.enabled);
  assert.deepEqual((await page.evaluate(() => window.focusbaeWorkspace.clipboard.state())).value.items, []);
  await app.evaluate(({ clipboard }) => clipboard.writeText("A useful copied thought <script>window.clipboardInjected = true</script>"));
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.clipboard.state()).value.items.length === 1);
  await app.evaluate(() => global.workspaceProbe.trayMenu().find((item) => item.label === "Clipboard history").click());
  await page.getByRole("heading", { name: "Clipboard history", exact: true }).waitFor();
  await page.getByText(/A useful copied thought <script>/).waitFor();
  assert.equal(await page.evaluate(() => window.clipboardInjected), undefined);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Copied. Paste" }).waitFor();
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /^A useful copied thought/);
  await page.getByRole("searchbox", { name: "Search clipboard history" }).fill("not present");
  await page.getByText("No matching copied text.", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Search clipboard history" }).fill("");
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}clipboard-history.png`) });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).setContentSize(390, 844));
  await page.waitForFunction(() => innerWidth === 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}clipboard-narrow.png`) });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).setContentSize(1120, 760));
  await page.waitForFunction(() => innerWidth === 1120);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForFunction(async () => !(await window.focusbaeWorkspace.clipboard.state()).value.items.length);
  await clickPage(page, "Settings");
  await privacy.getByRole("switch", { name: "Strict Local" }).click();
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.privacy.get()).value.mode === "strict-local");
  assert.equal(await updates.getByRole("button", { name: "Check for updates", exact: true }).isDisabled(), true);
  await app.evaluate(({ clipboard }) => clipboard.writeText("Works offline too"));
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.clipboard.state()).value.items.length === 1);
  await clipboard.getByRole("button", { name: "Open clipboard history" }).click();
  await page.getByRole("button", { name: "Clear history", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "History cleared" }).waitFor();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), "Works offline too");
  await page.getByRole("button", { name: "Turn off & clear" }).click();
  await page.getByRole("heading", { name: "Clipboard history is off" }).waitFor();
  assert.equal(await app.evaluate(() => global.workspaceProbe.trayMenu().some((item) => item.label === "Clipboard history")), false);
  await clickPage(page, "Settings");
  await privacy.getByRole("switch", { name: "Strict Local" }).click();
  await page.waitForFunction(async () => (await window.focusbaeWorkspace.privacy.get()).value.mode === "local");
  await updates.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}settings-updates.png`) });
  await clickPage(page, "Today");
};
