"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright");
const root = path.resolve(__dirname, "../..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-shell-e2e-"));
const output = path.join(root, "test-results", "workspace-shell");
fs.mkdirSync(output, { recursive: true });
const packaged = process.argv.includes("--packaged");
const executablePath = packaged
  ? path.join(
      root,
      "out/workspace-shell/mac-arm64/FocusBae Workspace Probe.app/Contents/MacOS/FocusBae Workspace Probe",
    )
  : require("electron");
const args = [
  ...(packaged ? [] : [path.join(root, "scripts/workspace-probe-entry.cjs")]),
  `--workspace-test-profile=${profile}`,
];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
let app;
const errors = [];
async function launch(expectReady = true) {
  app = await electron.launch({ executablePath, args, env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  // Electron handles beforeunload through will-prevent-unload; CDP can observe a
  // transient dialog that is already gone by the time Playwright dismisses it.
  page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  page.on("pageerror", (error) => errors.push(error.message));
  if (expectReady)
    await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
  return page;
}
async function clickPage(page, name) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
(async () => {
  let page = await launch();
  assert.equal(
    await page
      .getByRole("button", { name: "Record", exact: true })
      .isDisabled(),
    false,
  );
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  assert.equal(
    await page.evaluate(() => typeof window.focusbaeWorkspace.notes.update),
    "function",
  );
  const original = await page.evaluate(
    async () => (await window.focusbaeWorkspace.bootstrap()).value.workspace,
  );
  await page.getByRole("textbox", { name: "Note body", exact: true }).waitFor();
  await page.screenshot({
    path: path.join(
      output,
      `${packaged ? "packaged-" : ""}today-first-launch.png`,
    ),
  });
  await require("./welcome-e2e.cjs")({ app, page, output, packaged, clickPage });
  await require("./entrypoints-e2e.cjs")({ app, page, output, packaged, clickPage });
  await require("./settings-e2e.cjs")({ app, page, output, packaged, clickPage });
  await require("./notebook-e2e.cjs")({
    app,
    page,
    profile,
    output,
    packaged,
    clickPage,
  });
  await require("./links-e2e.cjs")({ page, output, packaged, clickPage });
  await require("./recording-e2e.cjs")({
    app,
    page,
    profile,
    output,
    packaged,
    clickPage,
  });
  await require("./models-e2e.cjs")({ app, page, output, packaged, clickPage });
  await require("./actions-e2e.cjs")({
    app,
    page,
    output,
    packaged,
    clickPage,
  });
  await require("./speakers-e2e.cjs")({ app, page, output, packaged, clickPage });
  await require("./people-e2e.cjs")({ app, page, output, packaged, clickPage });
  await clickPage(page, "Settings");
  await page.getByLabel("Appearance").selectOption("light");
  await page.getByRole("switch", { name: "Action reminders" }).click();
  await page.getByLabel("Daily reminder time").selectOption("10");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await page.screenshot({
    path: path.join(output, `${packaged ? "packaged-" : ""}settings-light.png`),
  });
  await page.getByLabel("Name", { exact: true }).fill("Personal workspace");
  await page.getByLabel("Appearance").selectOption("dark");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page
    .getByRole("region", { name: "Local AI models" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, `${packaged ? "packaged-" : ""}settings-dark.png`),
  });
  await page
    .getByRole("button", { name: "New workspace", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Work workspace");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const second = await page.evaluate(
    async () => (await window.focusbaeWorkspace.bootstrap()).value.workspace,
  );
  assert.notEqual(second.id, original.id);
  const stale = await page.evaluate(
    async (workspaceId) => window.focusbaeWorkspace.notes.list({ workspaceId }),
    original.id,
  );
  assert.equal(stale.error.code, "SCOPE_MISMATCH");
  await page.getByLabel("Workspace", { exact: true }).selectOption(original.id);
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  // Imported-looking content remains text, even when returned by canonical storage.
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().startsWith("focusbae-workspace:"),
    );
    const event = {
      sender: win.webContents,
      senderFrame: win.webContents.mainFrame,
    };
    const probe = global.workspaceProbe;
    const denied = await probe.handlers.get("workspace:bootstrap")({
      sender: {},
      senderFrame: {},
    });
    if (denied.error.code !== "PERMISSION_DENIED")
      throw new Error("Foreign sender accepted");
    const legacy = probe.handlers.get("shortcuts:list");
    let rejected = false;
    try {
      await legacy(event);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Workspace escaped into legacy IPC");
  });
  const hostile = await page.evaluate(async () => {
    const result = await window.focusbaeWorkspace.workspace.create({
      name: "attack",
      directory: "/tmp/escape",
    });
    let fetchBlocked = false;
    try {
      await fetch("https://example.invalid");
    } catch {
      fetchBlocked = true;
    }
    let fileBlocked = false;
    try {
      await fetch("file:///etc/passwd");
    } catch {
      fileBlocked = true;
    }
    window.open("https://example.invalid");
    return { result, fetchBlocked, fileBlocked };
  });
  assert.equal(hostile.result.error.code, "INVALID_INPUT");
  assert.equal(hostile.fetchBlocked, true);
  assert.equal(hostile.fileBlocked, true);
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "file:///etc/passwd";
    link.id = "hostile-link";
    link.textContent = "hostile";
    document.body.append(link);
  });
  await page.locator("#hostile-link").click();
  assert.equal(page.url(), "focusbae-workspace://app/index.html");
  await page.locator("#hostile-link").evaluate((element) => element.remove());
  await app.evaluate(() => global.workspaceProbe.seed());
  const semantic = await page.evaluate(async () => {
    const api = window.focusbaeWorkspace;
    const workspaceId = (await api.bootstrap()).value.workspace.id;
    return api.search.hybrid({
      workspaceId,
      query: "reduce infrastructure costs",
    });
  });
  assert.equal(semantic.ok, true);
  assert.equal(semantic.value.mode, "hybrid");
  assert.ok(semantic.value.items.some((item) => item.title === "Planning notes"));
  for (const name of ["Notes", "Recordings", "Actions", "Today"]) {
    await clickPage(page, name);
    await page.getByRole("heading", { name, exact: true }).first().waitFor();
  }
  await clickPage(page, "Notes");
  await page
    .locator(".note-rows")
    .getByRole("button", { name: /<img src=x onerror=alert\(1\)>/ })
    .click();
  await page
    .getByRole("textbox", { name: "Note title", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator(".tiptap script, .tiptap img").count(), 0);
  // The same vector letterform is used by the site and desktop interface.
  const brandMark = page.locator(".brand .brand-mark");
  assert.equal(await brandMark.isVisible(), true);
  assert.equal(await brandMark.getAttribute("alt"), "");
  assert.equal(await brandMark.evaluate((image) => image.complete && image.naturalWidth > 0), true);
  assert.equal(await page.locator('.brand [aria-label="FocusBae"]').isVisible(), true);
  await page.screenshot({
    path: path.join(output, `${packaged ? "packaged-" : ""}today-desktop.png`),
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(390, 700),
  );
  await clickPage(page, "Settings");
  await page
    .getByRole("region", { name: "Local AI models" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(
      output,
      `${packaged ? "packaged-" : ""}settings-mobile.png`,
    ),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  assert.equal(await page.locator(".compact-switcher").count(), 0);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(1120, 760),
  );
  if (!(await page.getByLabel("Workspace", { exact: true }).isVisible()))
    await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.getByLabel("Workspace", { exact: true }).selectOption(second.id);
  await page.waitForFunction(
    (id) => document.querySelector('[aria-label="Workspace"]').value === id,
    second.id,
  );
  await page.getByLabel("Workspace", { exact: true }).selectOption(original.id);
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await clickPage(page, "Settings");
  await page.getByRole("switch", { name: "Strict Local", exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await window.focusbaeWorkspace.privacy.get()).value.mode ===
      "strict-local",
  );
  await page.keyboard.press("Tab");
  assert.notEqual(
    await page.evaluate(() => document.activeElement.tagName),
    "BODY",
  );
  const native = await app.evaluate(() => global.workspaceProbe.native());
  assert.equal(native.audio, true);
  await clickPage(page, "Today");
  await page
    .getByRole("textbox", { name: "Note body", exact: true })
    .fill("The shoreline survives a reload and immediate quit.");
  await app.evaluate(() =>
    global.workspaceProbe.configureLocalRecording(false, false),
  );
  const quittingRecording = await page.evaluate(async () => {
    const api = window.focusbaeWorkspace,
      workspaceId = (await api.bootstrap()).value.workspace.id;
    return api.capture.start({
      context: { workspaceId, clientRequestId: crypto.randomUUID() },
      purpose: "personal",
      sourceMode: "microphone",
      language: "english",
      consent: true,
      destination: { kind: "standalone" },
    });
  });
  assert.equal(quittingRecording.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await app.close();
  app = null;
  page = await launch();
  const reopened = await page.evaluate(
    async () => (await window.focusbaeWorkspace.bootstrap()).value,
  );
  assert.equal(reopened.workspace.id, original.id);
  assert.equal(reopened.workspace.name, "Personal workspace");
  assert.equal(reopened.workspace.preferences.theme, "dark");
  assert.equal(reopened.workspace.preferences.notificationsEnabled, true);
  assert.equal(reopened.workspace.preferences.reminderHour, 10);
  assert.equal(reopened.workspace.preferences.welcomeDismissed, true);
  assert.equal(await page.getByRole("region", { name: "Welcome to FocusBae" }).count(), 0);
  assert.equal(reopened.workspaces.length, 2);
  assert.equal(reopened.privacy.mode, "strict-local");
  const drainedRecording = await page.evaluate(
    async (record) =>
      window.focusbaeWorkspace.capture.detail({
        workspaceId: record.workspaceId,
        id: record.id,
      }),
    quittingRecording.value,
  );
  assert.equal(drainedRecording.value.recording.state, "captured");
  assert.ok(drainedRecording.value.audio.bytes > 0);
  assert.equal(drainedRecording.value.recording.transcriptionState, "queued");
  await page.getByRole("textbox", { name: "Note body", exact: true }).waitFor();
  assert.match(
    await page
      .getByRole("textbox", { name: "Note body", exact: true })
      .innerText(),
    /survives a reload and immediate quit/,
  );
  await require("./backup-e2e.cjs")({ app, page, output, profile, packaged, clickPage, recording: quittingRecording.value });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .close(),
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) =>
          win.webContents.getURL().startsWith("focusbae-workspace:"),
        )
        .isVisible(),
    ),
    false,
  );
  await app.evaluate(({ app }) => app.emit("activate"));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) =>
          win.webContents.getURL().startsWith("focusbae-workspace:"),
        )
        .isVisible(),
    ),
    true,
  );
  await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  const catalogFile = path.join(profile, "profile/workspaces/catalog.json");
  fs.writeFileSync(catalogFile, "{invalid");
  page = await launch(false);
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "FocusBae", exact: true }).count(),
    1,
  );
  assert.equal(fs.readFileSync(catalogFile, "utf8"), "{invalid");
  await page.screenshot({
    path: path.join(
      output,
      `${packaged ? "packaged-" : ""}workspace-error.png`,
    ),
  });
  await app.close();
  app = null;
  console.log(
    JSON.stringify({
      ok: true,
      packaged,
      profile,
      output,
      checks: [
        "first launch",
        "local tray/shortcuts/settings, draft preservation, queued navigation and retired auth callbacks",
        "dedicated privacy/updates settings and opt-in memory-only clipboard utility",
        "full workspace backup, separate restore, audio recovery and corrupt-backup rejection",
        "write before setup, welcome dismissal/restart and discoverable storage guide",
        "workspace creation/switch/restart",
        "durable preferences",
        "IPC scope/sender",
        "legacy isolation",
        "network/file/popup/navigation denial",
        "responsive layout",
        "keyboard",
        "window reopen",
        "daily/normal writing and revision autosave",
        "formatting and sanitized clipboard/import",
        "FTS/pins/trash/restore",
        "portable export and conflict recovery",
        "dirty reload/quit persistence",
        "synthetic microphone renderer, sources and transcript workflow",
        "speech helpers refuse to run without models",
        "account-free capture quit drain and restart",
      "speech setup: Apple language install, pinned model import, corrupt rejection and Strict Local",
      "recording choices and consent survive the speech setup round trip",
      "local action creation, assignment, lifecycle, evidence navigation and responsive detail",
      "opt-in due reminders, Today summary and snooze",
      "English on-device hybrid semantic retrieval",
      "speaker identification re-attributes suggestions (This is me, named person)",
      "people: who owes whom, detail sections and navigation to actions and recordings",
      "people surfaced unprompted: Today band and prior context in a recording",
      "a promise made twice is counted and its history shown",
      "speaker echo collapses into one conversation, duplicates kept behind a toggle",
      "wikilinks, backlinks, page tabs and the workspace graph",
      "commitments written on a page reach Actions and People",
      "on-device rewriting corrects a selection, or plainly says it cannot",
      ],
    }),
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close();
  });
