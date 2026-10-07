"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { wavHeader } = require("../../recording/diarize");
module.exports = async ({ app, page, profile, output, packaged, clickPage }) => {
  const waitCapture = async (predicate) => {
    let state;
    for (let n = 0; n < 250; n++) {
      state = await page.evaluate(
        async () => (await window.focusbaeWorkspace.capture.state()).value,
      );
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Capture did not reach expected state: ${JSON.stringify(state)}`,
    );
  };
  const screenshot = (name) =>
    page.screenshot({
      path: path.join(
        output,
        `${packaged ? "packaged-" : ""}recording-${name}.png`,
      ),
    });
  assert.deepEqual(await app.evaluate(() => global.workspaceProbe.checkSpeechHelpers()), {
    parakeet: "MODEL_MISSING",
    apple: "MODEL_MISSING",
  });
  await app.evaluate(() => global.workspaceProbe.configureLocalRecording(true));
  await page.reload();
  await page.getByRole("button", { name: "Record", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New recording" });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "Start recording" }).isDisabled(),
    true,
  );
  await dialog.getByLabel("Purpose", { exact: true }).selectOption("personal");
  assert.equal(await dialog.getByRole("checkbox", { name: /Keep audio for playback/ }).isChecked(), false);
  await dialog.getByRole("checkbox", { name: /I have permission/ }).check();
  await screenshot("dialog");
  await dialog.getByRole("button", { name: "Start recording" }).click();
  await waitCapture((state) => state.active?.state === "recording");
  const state = await page.evaluate(
    async () => (await window.focusbaeWorkspace.capture.state()).value,
  );
  assert.equal(state.active.sourceMode, "microphone");
  assert.equal(state.model.ready, false);
  await waitCapture((state) => state.active?.durableMs >= 5000);
  assert.ok(
    await app.evaluate(({ BrowserWindow }) => {
      const mic = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes("/recording/mic.html"),
      );
      if (!mic)
        throw new Error(
          JSON.stringify(
            BrowserWindow.getAllWindows().map((win) =>
              win.webContents.getURL(),
            ),
          ),
        );
      const prefs = mic.webContents.getLastWebPreferences();
      return prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration;
    }),
  );
  await screenshot("active");
  await clickPage(page, "Today");
  const editor = page.getByRole("textbox", { name: "Note body", exact: true });
  await editor.fill("Writing while synthetic audio is recorded.");
  assert.equal(
    await page.getByLabel("Workspace", { exact: true }).isDisabled(),
    true,
  );
  await app.evaluate(() => global.workspaceProbe.trayMenu()
    .find((item) => item.label?.startsWith("Stop recording")).click());
  await waitCapture((state) => !state.active);
  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button").first().click();
  await page.getByText("Speech setup needed", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry local transcription" })
      .isDisabled(),
    true,
  );
  await screenshot("pending");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(390, 700),
  );
  await screenshot("narrow");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(1120, 760),
  );
  await page.getByRole("button", { name: "Open note", exact: true }).click();
  await editor.waitFor();
  assert.match(await editor.innerText(), /Writing while synthetic/);
  // Fake inference deliberately separate from the real microphone renderer exercise.
  await app.evaluate(() => {
    global.workspaceProbe.configureLocalRecording(false, true);
  });
  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button").first().click();
  await page.getByRole("button", { name: "Retry local transcription" }).click();
  await page.getByText("Transcription: complete", { exact: true }).waitFor();
  await page
    .getByText("Temporary audio removed after transcription", { exact: true })
    .waitFor();
  await page
    .getByText("Synthetic recording transcript from this Mac.", { exact: true })
    .first()
    .waitFor();
  await screenshot("transcript");
  // A recording is named in place, like a page title, and the name survives the
  // list and a reload. Escape abandons an edit.
  const name = page.getByRole("textbox", { name: "Recording name", exact: true });
  assert.equal(await name.inputValue(), "", "a recording starts unnamed");
  await name.fill("Acme kickoff");
  await name.press("Enter");
  await page.waitForFunction(async () => {
    const api = window.focusbaeWorkspace;
    const list = await api.capture.list({ workspaceId: (await api.bootstrap()).value.workspace.id });
    return list.value.items.some((item) => item.title === "Acme kickoff");
  });
  await name.fill("Something else");
  await name.press("Escape");
  assert.equal(await name.inputValue(), "Acme kickoff", "Escape keeps the saved name");
  await screenshot("named");
  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button strong").filter({ hasText: "Acme kickoff" }).waitFor();
  await page.locator(".recording-rows button").first().click();
  for (const source of ["system", "both"]) {
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await dialog
      .getByLabel("Audio source", { exact: true })
      .selectOption(source);
    await dialog
      .getByLabel("Save with", { exact: true })
      .selectOption("standalone");
    await dialog.getByRole("checkbox", { name: /I have permission/ }).check();
    if (source === "both") {
      await dialog.getByRole("checkbox", { name: /Keep audio for playback/ }).check();
      await screenshot("keep-audio-dialog");
    }
    await dialog.getByRole("button", { name: "Start recording" }).click();
    await waitCapture((state) => state.active?.state === "recording");
    await new Promise((resolve) => setTimeout(resolve, source === "both" ? 2200 : 700));
    if (source === "system") {
      await app.evaluate(() => global.workspaceProbe.shortcuts.get("Alt+R")());
    } else {
      await page
        .getByRole("button", { name: "Stop local recording", exact: true })
        .click();
    }
    await page.getByText("Transcription: complete", { exact: true }).waitFor();
  }
  const player = page.getByRole("region", { name: "Audio playback" });
  await player.waitFor();
  await player.getByRole("button", { name: "Play audio", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="Audio position"]').value) >= 100);
  await player.getByRole("button", { name: "Pause audio", exact: true }).click();
  await player.getByLabel("Playback speed").selectOption("1.5");
  await player.getByLabel("Playback source").selectOption("microphone");
  await player.getByRole("slider", { name: "Audio position" }).fill("1000");
  assert.equal(await player.getByRole("slider").inputValue(), "1000");
  await page.getByRole("button", { name: /^Play audio at / }).first().click();
  await player.getByRole("button", { name: "Pause audio", exact: true }).click();
  await screenshot("retained-playback");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).setContentSize(390, 844));
  await screenshot("retained-narrow");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:")).setContentSize(1120, 760));
  const retained = await page.evaluate(async () => {
    const api = window.focusbaeWorkspace;
    const workspaceId = (await api.bootstrap()).value.workspace.id;
    const list = (await api.capture.list({ workspaceId })).value;
    return list.items.find((record) => record.keepAudio);
  });
  assert.ok(retained);
  const denied = await page.evaluate((record) => window.focusbaeWorkspace.capture.playbackRead({
    workspaceId: record.workspaceId, id: record.id, source: "all", startMs: 0, durationMs: 6000,
  }), retained);
  assert.equal(denied.error.code, "INVALID_INPUT");
  await app.evaluate(async () => {
    for (const name of ["capture.playbackInfo", "capture.playbackRead"]) {
      const result = await global.workspaceProbe.handlers.get(`workspace:${name}`)({ sender: {}, senderFrame: {} }, {});
      if (result.error?.code !== "PERMISSION_DENIED") throw new Error(`${name} accepted a foreign sender`);
    }
  });
  await page.reload();
  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button").first().click();
  await player.getByRole("button", { name: "Play audio", exact: true }).waitFor();
  // Cancel leaves bytes and playback available; deletion keeps completed text.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.getByRole("button", { name: "Delete saved audio" }).click();
  await player.waitFor();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.getByRole("button", { name: "Delete saved audio" }).click();
  await page.getByText("Audio deleted", { exact: true }).waitFor();
  assert.equal(await player.count(), 0);
  await page.getByText("Transcription: complete", { exact: true }).waitFor();
  await page.getByText("Synthetic recording transcript from this Mac.", { exact: true }).first().waitFor();
  const importedFile = path.join(profile, "Imported conversation.wav");
  const importedPcm = Buffer.alloc(48000);
  for (let n = 0; n < importedPcm.length / 2; n++)
    importedPcm.writeInt16LE(Math.round(Math.sin(n * 0.08) * 6000), n * 2);
  fs.writeFileSync(importedFile, Buffer.concat([wavHeader(importedPcm.length), importedPcm]));
  const originalImported = fs.readFileSync(importedFile);
  await page.getByRole("button", { name: "Back to recordings" }).click();
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole("button", { name: "Import WAV", exact: true }).click();
  const importDialog = page.getByRole("dialog", { name: "Import WAV recording" });
  assert.equal(await importDialog.getByRole("checkbox", { name: /Keep audio for playback/ }).isChecked(), false);
  await importDialog.getByRole("checkbox", { name: /Keep audio for playback/ }).check();
  await importDialog.getByRole("checkbox", { name: /I have permission/ }).check();
  await screenshot("import-dialog");
  await importDialog.getByRole("button", { name: "Choose WAV & import" }).click();
  await importDialog.waitFor();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, importedFile);
  await importDialog.getByRole("button", { name: "Choose WAV & import" }).click();
  await page.getByText("Transcription: complete", { exact: true }).waitFor();
  await page.getByText("Audio kept on this Mac", { exact: false }).waitFor();
  await page.getByRole("region", { name: "Audio playback" }).waitFor();
  assert.deepEqual(fs.readFileSync(importedFile), originalImported);
  const exportedFile = path.join(profile, "exported.wav");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exportedFile);
  await page.getByRole("button", { name: "Export WAV", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "exported.wav exported." }).waitFor();
  assert.equal(fs.readFileSync(exportedFile).subarray(0, 4).toString(), "RIFF");
  const hostilePortability = await page.evaluate(async () => {
    const api = window.focusbaeWorkspace, workspaceId = (await api.bootstrap()).value.workspace.id;
    return Promise.all([
      api.capture.importWav({ context: { workspaceId, clientRequestId: crypto.randomUUID() }, purpose: "personal",
        language: "english", keepAudio: true, consent: true, destination: { kind: "standalone" }, path: "/etc/passwd" }),
      api.capture.exportAudio({ workspaceId, id: crypto.randomUUID(), source: "all", path: "/tmp/out.wav" }),
    ]);
  });
  assert.ok(hostilePortability.every((result) => result.error.code === "INVALID_INPUT"));
  await app.evaluate(async () => {
    for (const name of ["capture.storage", "capture.importWav", "capture.exportAudio"]) {
      const result = await global.workspaceProbe.handlers.get(`workspace:${name}`)({ sender: {}, senderFrame: {} }, {});
      if (result.error?.code !== "PERMISSION_DENIED") throw new Error(`${name} accepted a foreign sender`);
    }
  });
  await page.getByRole("button", { name: "Back to recordings" }).click();
  await page.getByText(/audio on this Mac/).waitFor();
  await screenshot("audio-storage");
  // Restore the affirmative response expected by later privacy permission tests.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((win) =>
          win.webContents.getURL().includes("/recording/mic.html"),
        ).length,
    ),
    0,
  );
};
