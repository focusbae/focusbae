"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
module.exports = async ({ app, page, output, packaged, clickPage }) => {
  const image = (name) =>
    page.screenshot({
      path: path.join(
        output,
        `${packaged ? "packaged-" : ""}actions-${name}.png`,
      ),
    });
  await app.evaluate(() => global.workspaceProbe.seedActions());
  await page.reload();
  await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
  await page.getByLabel("Actions due").getByText("1 overdue").waitFor();
  await page.getByRole("button", { name: "Review actions" }).click();
  await page
    .getByText("Prepare the local pilot checklist", { exact: true })
    .waitFor();
  await page.getByText("1 overdue", { exact: true }).waitFor();
  await page
    .getByText("Prepare the local pilot checklist", { exact: true })
    .click();
  await page.getByRole("button", { name: "Snooze one day" }).click();
  await image("mine");

  await page.getByRole("button", { name: "New action" }).click();
  const dialog = page.getByRole("dialog", { name: "New action" });
  await dialog
    .getByLabel("Action", { exact: true })
    .fill("Share offline preview");
  await dialog.getByLabel("Due date").fill("2026-09-25");
  await dialog.getByLabel("Priority").selectOption("urgent");
  await dialog.getByRole("button", { name: "Create action" }).click();
  const detailTitle = page
    .getByLabel("Action detail")
    .getByLabel("Action", { exact: true });
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Action detail"] textarea')?.value ===
      "Share offline preview",
  );
  assert.equal(await detailTitle.inputValue(), "Share offline preview");
  await page
    .getByLabel("Action detail")
    .getByLabel("Owner")
    .selectOption("person");
  await page.getByLabel("Action detail").getByLabel("Person").fill("Raghav");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("tab", { name: /Waiting on/ }).click();
  await page.getByText("Share offline preview", { exact: true }).click();
  await page.getByRole("button", { name: "Defer" }).click();
  await page.getByText("deferred", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Complete" }).click();
  await page.getByRole("tab", { name: /Completed/ }).click();
  await page.getByText("Share offline preview", { exact: true }).click();
  await page.getByRole("button", { name: "Reopen" }).click();
  await page.getByRole("tab", { name: /Waiting on/ }).click();
  await page.getByText("Share offline preview", { exact: true }).waitFor();

  await page.getByRole("tab", { name: /Review/ }).click();
  await page.getByText("Confirm the rollout date", { exact: true }).click();
  await page.getByText("The source is stale.", { exact: false }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Accept" }).isDisabled(),
    true,
  );
  await page.getByRole("tab", { name: /Review/ }).click();
  await page
    .getByText("Send the enterprise security review", { exact: true })
    .click();
  await page
    .getByText("Asha will send the enterprise security review by Friday.", {
      exact: true,
    })
    .waitFor();
  await image("review");
  await page.getByRole("button", { name: "Open source recording" }).click();
  await page
    .getByRole("textbox", { name: "Recording name", exact: true })
    .waitFor();
  await clickPage(page, "Actions");
  await page.getByRole("tab", { name: /Review/ }).click();
  await page
    .getByText("Send the enterprise security review", { exact: true })
    .click();
  await page
    .getByLabel("Action detail")
    .getByLabel("Owner")
    .selectOption("self");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("tab", { name: /My actions/ }).click();
  await page
    .getByText("Send the enterprise security review", { exact: true })
    .waitFor();

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(390, 700),
  );
  await page
    .getByText("Prepare the local pilot checklist", { exact: true })
    .click();
  await page.getByRole("button", { name: "Back to actions" }).waitFor();
  await image("narrow-detail");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.getByRole("button", { name: "Back to actions" }).click();
  await page.getByRole("tablist", { name: "Action view" }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(1120, 760),
  );

  const hostile = await page.evaluate(async () => {
    const api = window.focusbaeWorkspace;
    const workspaceId = (await api.bootstrap()).value.workspace.id;
    return api.actions.create({
      context: { workspaceId, clientRequestId: crypto.randomUUID() },
      action: {
        title: "<img src=x onerror=alert(1)>",
        owner: { kind: "self", id: null },
        ownerLabel: null,
        dueDate: null,
        priority: "medium",
      },
    });
  });
  assert.equal(hostile.ok, true);
  assert.equal(await page.locator(".actions-workspace img").count(), 0);
};
