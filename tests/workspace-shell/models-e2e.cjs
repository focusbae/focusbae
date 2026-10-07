"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
module.exports = async ({ app, page, output, packaged, clickPage }) => {
  const waitModels = async (predicate) => {
    for (let n = 0; n < 150; n++) {
      const result = await page.evaluate(
        async () => (await window.focusbaeWorkspace.models.state()).value,
      );
      if (predicate(result)) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Model state did not settle");
  };
  await app.evaluate(() => global.workspaceProbe.configureModels());
  await page.getByRole("button", { name: "Record", exact: true }).click();
  const recordForm = page.getByRole("dialog", { name: "New recording" });
  await recordForm.getByLabel("Purpose", { exact: true }).selectOption("learning");
  await recordForm.getByLabel("Audio source", { exact: true }).selectOption("both");
  await recordForm.getByLabel("Speech language", { exact: true }).selectOption("mixed");
  await recordForm.getByLabel("Save with", { exact: true }).selectOption("standalone");
  await recordForm.getByRole("checkbox", { name: /I have permission/ }).check();
  await page.getByRole("button", { name: "Set up speech", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "Speech setup" });
  await setup.waitFor();
  // Opening setup probes Apple speech; Hindi is unavailable in this scripted state.
  await setup.getByRole("button", { name: "Install English", exact: true }).waitFor();
  await setup.getByText("Not available", { exact: true }).waitFor();

  // A folder that fails verification is rejected and nothing is installed.
  await setup
    .locator(".model-block")
    .filter({ hasText: "Parakeet" })
    .getByRole("button", { name: "Import folder", exact: true })
    .click();
  await setup
    .getByText("Choose a complete copy of the supported model folder. It failed verification.")
    .waitFor();
  assert.equal((await waitModels(() => true)).speech.parakeet.ready, false);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(390, 700),
  );
  await page.screenshot({
    path: path.join(output, `${packaged ? "packaged-" : ""}models-corrupted.png`),
  });
  assert.ok(await setup.evaluate((element) => element.scrollWidth <= element.clientWidth));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(1120, 760),
  );
  await setup.getByRole("button", { name: "Back to recording" }).click();
  await recordForm.waitFor();
  assert.equal(await recordForm.getByLabel("Purpose", { exact: true }).inputValue(), "learning");
  assert.equal(await recordForm.getByLabel("Audio source", { exact: true }).inputValue(), "both");
  assert.equal(await recordForm.getByLabel("Speech language", { exact: true }).inputValue(), "mixed");
  assert.equal(await recordForm.getByLabel("Save with", { exact: true }).inputValue(), "standalone");
  assert.equal(await recordForm.getByRole("checkbox", { name: /I have permission/ }).isChecked(), true);
  await recordForm.getByRole("button", { name: "Set up speech" }).click();
  await setup.waitFor();
  await page.keyboard.press("Escape");
  await recordForm.waitFor();
  await recordForm.getByRole("button", { name: "Cancel", exact: true }).click();

  const pending = await page.evaluate(async () => {
    const api = window.focusbaeWorkspace,
      workspaceId = (await api.bootstrap()).value.workspace.id;
    const result = await api.capture.start({
      context: { workspaceId, clientRequestId: crypto.randomUUID() },
      purpose: "learning",
      sourceMode: "microphone",
      language: "english",
      consent: true,
      destination: { kind: "standalone" },
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const stopped = await page.evaluate(
    (record) =>
      window.focusbaeWorkspace.capture.stop({ workspaceId: record.workspaceId, id: record.id }),
    pending,
  );
  assert.equal(stopped.ok, true);
  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button").filter({ hasText: "Learning" }).click();
  await page.getByText("Speech setup needed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Set up speech", exact: true }).click();
  await setup.waitFor();
  await setup.getByRole("button", { name: "Close speech setup" }).click();

  // Strict Local blocks every download and language install, but not offline import.
  await clickPage(page, "Settings");
  await page.getByRole("switch", { name: "Strict Local", exact: true }).click();
  await page
    .getByText("Strict Local is on. Downloads are off; import a model folder to set it up offline.")
    .waitFor();
  for (const name of ["Download Parakeet", "Download Speaker detection", "Install English"])
    assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true, name);
  const blocked = await page.evaluate(() =>
    window.focusbaeWorkspace.models.installLanguage({ locale: "en-US" }),
  );
  assert.equal(blocked.ok, true);
  assert.equal(blocked.value.speech.apple.locales["en-US"], "supported");

  await app.evaluate(() => global.workspaceProbe.chooseModelFolder("good"));
  await page
    .locator(".model-block")
    .filter({ hasText: "Parakeet" })
    .getByRole("button", { name: "Import folder", exact: true })
    .click();
  const imported = await waitModels((state) => state.speech.parakeet.ready);
  assert.equal(imported.speech.languages.english.engine, "parakeet");
  assert.equal(imported.speech.languages.hindi.ready, false);
  await page.getByText("Parakeet for English", { exact: true }).waitFor();
  const state = await page.evaluate(async () => (await window.focusbaeWorkspace.capture.state()).value);
  assert.equal(state.model.ready, true);
  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button").filter({ hasText: "Learning" }).click();
  await page.getByRole("button", { name: "Retry local transcription" }).click();
  await page.getByText("Transcription: complete", { exact: true }).waitFor();

  // With Strict Local off, an Apple language install asks macOS through the permission gate.
  await clickPage(page, "Settings");
  await page.getByRole("switch", { name: "Strict Local", exact: true }).click();
  await page.getByRole("button", { name: "Install English", exact: true }).click();
  await waitModels((value) => value.speech.apple.locales["en-US"] === "installed");
  await page.locator(".model-language").filter({ hasText: "English" }).getByText("Ready").waitFor();
  await page.screenshot({
    path: path.join(output, `${packaged ? "packaged-" : ""}models-ready.png`),
  });

  const invalid = await page.evaluate(() =>
    window.focusbaeWorkspace.models.download({ kind: "whisper" }),
  );
  assert.equal(invalid.error.code, "INVALID_INPUT");
  await app.evaluate(async () => {
    for (const name of ["state", "refresh", "download", "import", "installLanguage"]) {
      const result = await global.workspaceProbe.handlers.get(`workspace:models.${name}`)(
        { sender: {}, senderFrame: {} },
        {},
      );
      if (result.error.code !== "PERMISSION_DENIED")
        throw new Error(`Model IPC ${name} accepted a foreign sender`);
    }
  });
};
