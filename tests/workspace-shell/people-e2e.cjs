"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
module.exports = async ({ app, page, output, packaged, clickPage }) => {
  await app.evaluate(() => global.workspaceProbe.seedPeopleMeeting());
  await clickPage(page, "People");
  const list = page.getByRole("region", { name: "People", exact: true });
  const priya = list.getByRole("button").filter({ hasText: "Priya" });
  await priya.getByText("owes you 1 · you owe 1").waitFor();
  await priya.click();

  const person = page.getByRole("region", { name: "Person", exact: true });
  await person.getByRole("heading", { name: "Priya", exact: true }).waitFor();
  const owes = person.getByRole("region", { name: "Priya owes you" });
  await owes.getByText("I will confirm the pilot group on Wednesday", { exact: true }).waitFor();
  await owes.getByText("I will confirm the pilot group on Wednesday.").waitFor();
  const youOwe = person.getByRole("region", { name: "You owe Priya" });
  await youOwe.getByText("I will send the onboarding plan by Monday", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}people.png`) });
  assert.ok(await person.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));

  await owes.getByRole("button", { name: "Open action I will confirm the pilot group on Wednesday" }).click();
  const detail = page.getByRole("region", { name: "Action detail" });
  await detail.getByText("I will confirm the pilot group on Wednesday.").waitFor();
  assert.equal(
    await page.getByRole("tab", { name: /Waiting/ }).getAttribute("aria-selected"),
    "true",
  );

  await clickPage(page, "People");
  await page.getByRole("region", { name: "People", exact: true }).getByRole("button").filter({ hasText: "Priya" }).click();
  await page.getByRole("button", { name: "Open recording for I will send the onboarding plan by Monday" }).click();
  await page.getByRole("region", { name: "Speakers" }).waitFor();

  // Today surfaces who owes what without being asked.
  await clickPage(page, "Today");
  const band = page.getByRole("region", { name: "Open with people" });
  await band.getByText("Priya", { exact: true }).waitFor();
  await band.getByText("you owe 1 · owes you 1", { exact: true }).waitFor();

  // A prior commitment with Priya, from outside this recording, becomes context.
  await page.evaluate(async () => {
    const api = window.focusbaeWorkspace;
    const workspaceId = (await api.bootstrap()).value.workspace.id;
    const result = await api.actions.create({
      context: { workspaceId, clientRequestId: crypto.randomUUID() },
      action: { title: "Send Priya the signed order form", owner: { kind: "self", id: null }, ownerLabel: null, dueDate: null, priority: "medium" },
    });
    if (!result.ok) throw new Error(result.error.message);
  });
  await clickPage(page, "Recordings");
  await page.locator(".recording-rows button").first().click();
  const prior = page.getByRole("region", { name: "Already open with these people" });
  await prior.getByText("Send Priya the signed order form", { exact: true }).waitFor();
  // Only what was open before: Priya's promise from this conversation is excluded.
  await prior.getByText("you owe 1", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}prior-context.png`) });
  await prior.getByRole("button", { name: "Priya", exact: true }).click();
  await page.getByRole("region", { name: "Person", exact: true }).getByRole("heading", { name: "Priya", exact: true }).waitFor();

  // A promise made twice is counted, and the history is shown on the action.
  await app.evaluate(() => global.workspaceProbe.seedRestatement());
  await clickPage(page, "Actions");
  await page.getByRole("tab", { name: /Review/ }).click();
  await page
    .locator(".action-rows button")
    .filter({ hasText: "I will send the quarterly report on Monday" })
    .click();
  const history = page.getByRole("region", { name: "Promise history" });
  await history.getByRole("heading", { name: "Promised 2 times" }).waitFor();
  await history.getByText("first promised", { exact: true }).waitFor();
  await history.getByText("I will send the quarterly report on Monday · this one", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}restatement.png`) });

  const foreign = await app.evaluate(async () =>
    global.workspaceProbe.handlers.get("workspace:people.list")({ sender: {}, senderFrame: {} }, {
      workspaceId: "00000000-0000-4000-8000-000000000000",
    }),
  );
  assert.equal(foreign.error.code, "PERMISSION_DENIED");
  const foreignContext = await app.evaluate(async () =>
    global.workspaceProbe.handlers.get("workspace:people.priorContext")({ sender: {}, senderFrame: {} }, {
      workspaceId: "00000000-0000-4000-8000-000000000000",
      recordingId: "00000000-0000-4000-8000-000000000000",
    }),
  );
  assert.equal(foreignContext.error.code, "PERMISSION_DENIED");
};
