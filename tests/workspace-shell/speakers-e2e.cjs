"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
module.exports = async ({ app, page, output, packaged, clickPage }) => {
  const seeded = await app.evaluate(() => global.workspaceProbe.seedSpeakerMeeting());
  const owner = () =>
    page.evaluate(async (recordingId) => {
      const api = window.focusbaeWorkspace;
      const workspaceId = (await api.bootstrap()).value.workspace.id;
      const detail = (await api.capture.detail({ workspaceId, id: recordingId })).value;
      const actions = (await api.actions.browse({ workspaceId, view: "review" })).value.items;
      const action = actions.find((item) => item.title.startsWith("I will send the pricing sheet"));
      return { owner: action?.owner.kind, speaker: detail.transcript[0].speaker };
    }, seeded.recordingId);
  assert.deepEqual(await owner(), { owner: "unknown", speaker: "Speaker 1 · Microphone" });

  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button").first().click();
  const speakers = page.getByRole("region", { name: "Speakers" });
  await speakers.getByText("Mark which speaker is you so suggestions can be assigned").waitFor();
  await speakers.getByLabel("Speaker 1 · Microphone").selectOption("self");
  await page.getByText("Speaker saved. 1 suggestion now has an owner.", { exact: true }).waitFor();
  await speakers.getByText("Suggestions use these identities").waitFor();
  assert.deepEqual(await owner(), { owner: "self", speaker: "You" });
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}speakers.png`) });

  // Naming the speaker instead moves the suggestion to that person.
  await speakers.getByLabel("Speaker 1 · Microphone").selectOption("person");
  await speakers.getByLabel("Name for Speaker 1 · Microphone").fill("Priya");
  await speakers.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Speaker saved. 1 suggestion now has an owner.", { exact: true }).waitFor();
  const named = await owner();
  assert.equal(named.speaker, "Priya");
  assert.equal(named.owner, "person");

  // A recording with no detected speakers says why, rather than showing nothing.
  await clickPage(page, "Recordings");
  const rows = page.locator(".recording-rows button");
  const before = await rows.count();
  await app.evaluate(() => global.workspaceProbe.seedUndetectedSpeakers());
  // The list is driven by a change event, so wait for the new row rather than
  // clicking into whatever was rendered a moment ago.
  for (let n = 0; n < 100 && (await rows.count()) === before; n++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await rows.count(), before + 1);
  await rows.first().click();
  const unavailable = page.getByRole("region", { name: "Speakers" });
  await unavailable.getByText("Speaker detection is not installed, so every line is an unknown speaker.").waitFor();
  await unavailable.getByRole("button", { name: "Set up speaker detection" }).click();
  await page.getByRole("dialog", { name: "Speech setup" }).waitFor();
  await page.getByRole("button", { name: "Close speech setup" }).click();

  // The far side heard twice reads as one conversation, with the duplicate kept.
  await clickPage(page, "Recordings");
  const echoRows = page.locator(".recording-rows button");
  const echoBefore = await echoRows.count();
  await app.evaluate(() => global.workspaceProbe.seedEchoedMeeting());
  for (let n = 0; n < 100 && (await echoRows.count()) === echoBefore; n++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  await echoRows.first().click();
  await page.getByText("3 of 4 segments", { exact: true }).waitFor();
  await page
    .getByText("1 line was also picked up by the microphone because the other side played through this Mac's speakers.")
    .waitFor();
  const lines = page.locator(".transcript-list li");
  assert.equal(await lines.count(), 3);
  await page.getByRole("button", { name: "Show duplicates" }).click();
  assert.equal(await lines.count(), 4);
  assert.equal(await page.locator('.transcript-list li[data-echo="true"]').count(), 1);
  await page.getByRole("button", { name: "Hide duplicates" }).click();
  assert.equal(await lines.count(), 3);

  const foreign = await app.evaluate(async ({}, input) =>
    global.workspaceProbe.handlers.get("workspace:capture.identifySpeaker")({ sender: {}, senderFrame: {} }, input),
    { workspaceId: "00000000-0000-4000-8000-000000000000", recordingId: seeded.recordingId, speakerId: seeded.speakerId, identity: { kind: "self" } });
  assert.equal(foreign.error.code, "PERMISSION_DENIED");
};
