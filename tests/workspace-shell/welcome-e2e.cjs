"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

module.exports = async ({ app, page, output, packaged, clickPage }) => {
  const welcome = page.getByRole("region", { name: "Welcome to FocusBae" });
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await welcome.waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 0);
  const initial = await page.evaluate(async () => ({
    workspace: (await window.focusbaeWorkspace.bootstrap()).value,
    recording: (await window.focusbaeWorkspace.capture.state()).value,
  }));
  assert.equal(initial.workspace.privacy.connected, false);
  assert.equal(initial.recording.active, null);
  // Writing is available before acknowledging any welcome or setup screen.
  await body.fill("My first thought, before any setup.");
  await page.locator(".note-status").filter({ hasText: "Saved on this Mac" }).waitFor();
  await welcome.getByRole("button", { name: "How it works" }).click();
  const guide = page.getByRole("dialog", { name: "A space for your day." });
  await guide.waitFor();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}welcome-guide.png`) });
  await page.keyboard.press("Escape");
  await guide.waitFor({ state: "detached" });
  assert.equal(await welcome.getByRole("button", { name: "How it works" }).evaluate((el) => el === document.activeElement), true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).setContentSize(390, 700),
  );
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}welcome-narrow.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await welcome.getByRole("button", { name: "Start writing" }).click();
  await welcome.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note body");
  assert.equal(await body.innerText(), "My first thought, before any setup.");
  await page.reload();
  await body.waitFor();
  assert.equal(await welcome.count(), 0);
  assert.equal(await body.innerText(), "My first thought, before any setup.");
  await clickPage(page, "Settings");
  await page.getByRole("button", { name: "How FocusBae works" }).click();
  await guide.waitFor();
  assert.equal(await guide.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await guide.getByRole("button", { name: "Got it" }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).setContentSize(1120, 760),
  );
  await clickPage(page, "Today");
};
