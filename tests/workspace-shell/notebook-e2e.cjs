"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
module.exports = async function notebookChecks({
  app,
  page,
  profile,
  output,
  packaged,
  clickPage,
}) {
  const screenshot = (name) =>
    page.screenshot({
      path: path.join(
        output,
        `${packaged ? "packaged-" : ""}notebook-${name}.png`,
      ),
    });
  const title = () =>
    page.getByRole("textbox", { name: "Note title", exact: true });
  const body = () =>
    page.getByRole("textbox", { name: "Note body", exact: true });
  const saved = () =>
    page
      .locator(".note-status")
      .filter({ hasText: "Saved on this Mac" })
      .waitFor();
  await title().waitFor();
  await body().fill(
    "A small space to think.\nThe shoreline is quiet this morning.",
  );
  await clickPage(page, "Notes");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".notebook")?.getAttribute("aria-busy") === "false");
  assert.equal(await title().inputValue(), "");
  await title().fill("Thoughts by the water");
  await body().fill("The useful ideas arrive slowly.\nLeave room for them.");
  await body().press("Meta+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  assert.ok((await page.locator(".tiptap strong").count()) > 0);
  await page.getByRole("button", { name: "Pin note", exact: true }).click();
  await saved();
  await body().press("ArrowRight");
  await screenshot("light");
  assert.equal(
    await page
      .locator(".workspace-main > footer")
      .evaluate(
        (element) => element.getBoundingClientRect().bottom <= innerHeight + 1,
      ),
    true,
  );
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await page.getByLabel("Note view").selectOption("pinned");
  await page.locator(".note-rows").getByRole("button", { name: /Thoughts by the water/ }).waitFor();
  await page.getByLabel("Search workspace").fill("slowly");
  await page.locator(".note-rows").getByRole("button", { name: /Thoughts by the water/ }).click();
  assert.match(await body().innerText(), /Leave room/);
  await page
    .getByRole("button", { name: "Move note to Trash", exact: true })
    .click();
  await page.getByText("Moved to Trash.", { exact: true }).waitFor();
  await page.getByLabel("Search workspace").fill("");
  await page.getByLabel("Note view").selectOption("trash");
  await page.locator(".note-rows").getByRole("button", { name: /Thoughts by the water/ }).click();
  assert.equal(await body().getAttribute("contenteditable"), "false");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByLabel("Note view").selectOption("all");
  await page.locator(".note-rows").getByRole("button", { name: /Thoughts by the water/ }).click();
  // HTML clipboard conversion goes through the isolated, bounded main parser.
  await body().press("Meta+End");
  await body().evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      '<p><em>Painted thought</em><img src="https://example.invalid/x" onerror="window.injected=1"><script>window.injected=1</script></p>',
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page
    .locator(".tiptap em")
    .filter({ hasText: "Painted thought" })
    .waitFor();
  await saved();
  assert.equal(await page.locator(".tiptap img, .tiptap script").count(), 0);
  // Pasting is not importing: dropping a web page's styling says nothing.
  assert.equal(await page.getByText(/Import details/).count(), 0);
  // The page list shows what was written, not "Empty page".
  await page
    .locator(".note-rows")
    .getByRole("button", { name: /Thoughts by the water/ })
    .filter({ hasText: /useful ideas arrive slowly/ })
    .waitFor();
  assert.equal(await page.evaluate(() => window.injected), undefined);
  const original = path.join(profile, "Field notes.html");
  fs.writeFileSync(
    original,
    "<h2>Field notes</h2><p><u>A line worth keeping</u></p><table><tr><td>Unsupported table</td></tr></table>",
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, original);
  await page.getByRole("button", { name: "Import notes", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Field notes",
  );
  assert.ok((await page.locator(".tiptap u").count()) > 0);
  await page.getByText(/Import details/).click();
  await page
    .getByText("Unsupported elements were simplified or removed.", {
      exact: true,
    })
    .waitFor();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, profile);
  await page
    .getByRole("button", { name: "Export this note", exact: true })
    .click();
  await page.getByText(/Exported 1 note to/).waitFor();
  const folder = fs
    .readdirSync(profile)
    .find((name) => name.startsWith("FocusBae-notes-"));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(profile, folder, "manifest.json")),
  );
  assert.equal(manifest.complete, true);
  assert.equal(manifest.notes.length, 1);
  assert.equal(
    fs.readFileSync(
      path.join(profile, folder, manifest.notes[0].original),
      "utf8",
    ),
    fs.readFileSync(original, "utf8"),
  );
  // Force a genuine concurrent revision to verify failure stays visible and navigation is blocked.
  await app.evaluate((_electron, requestId) => {
    const { store } = global.workspaceProbe.catalog;
    const row = store
      .notebookList({ workspaceId: store.identity.id })
      .items.find((item) => item.title === "Field notes");
    store.editNote(
      {
        workspaceId: store.identity.id,
        expectedRevision: row.revision,
        clientRequestId: requestId,
      },
      row.id,
      { title: "Edited elsewhere" },
    );
  }, require("node:crypto").randomUUID());
  await title().fill("My unsaved draft");
  await page.locator(".note-status").filter({ hasText: "Not saved" }).waitFor();
  await clickPage(page, "Settings");
  assert.equal(await title().inputValue(), "My unsaved draft");
  const preventedQuit = await app.evaluate(async ({ app, dialog }) => {
    let warned = false;
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async () => {
      warned = true;
      return { response: 0 };
    };
    app.quit();
    for (let count = 0; count < 100 && !warned; count++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    dialog.showMessageBox = original;
    return warned;
  });
  assert.equal(preventedQuit, true);
  await page
    .getByRole("button", { name: "Export recovery copy", exact: true })
    .click();
  await page.getByText(/Exported 1 note to/).waitFor();
  const recovered = fs
    .readdirSync(profile)
    .filter((name) => name.startsWith("FocusBae-notes-"))
    .map((name) => path.join(profile, name))
    .find((dir) => {
      const value = JSON.parse(
        fs.readFileSync(path.join(dir, "manifest.json")),
      );
      return value.notes[0].title === "My unsaved draft";
    });
  assert.ok(recovered, "Unsaved writing must have a portable recovery copy");
  await page
    .getByRole("button", { name: "Reload saved note", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard and reload", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Edited elsewhere",
  );
  await saved();
  await app.evaluate(() => global.workspaceProbe.seedSources());
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await page.getByLabel("Search workspace").fill("sourcefixture");
  await page
    .locator(".note-rows")
    .getByRole("button", { name: /Untitled Sourcefixture transcript/ })
    .click();
  await page
    .locator(".source-page")
    .getByRole("heading", { name: "Transcript", exact: true })
    .waitFor();
  assert.match(await page.locator(".source-page").innerText(), /1:00/);
  assert.match(await page.locator(".source-page p").innerText(), /shoreline/);
  await page
    .getByRole("button", { name: "Back to notes", exact: true })
    .click();
  await page
    .locator(".note-rows")
    .getByRole("button", { name: /Review sourcefixture/ })
    .click();
  await page
    .locator(".source-page")
    .getByRole("heading", { name: "Review sourcefixture", exact: true })
    .waitFor();
  await clickPage(page, "Settings");
  await page.getByLabel("Appearance").selectOption("dark");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await clickPage(page, "Today");
  await body().waitFor();
  assert.match(await body().innerText(), /shoreline/);
  await screenshot("dark");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(390, 700),
  );
  await screenshot("narrow-dark");
  assert.equal(
    await page
      .locator(".workspace-main > footer")
      .evaluate(
        (element) => element.getBoundingClientRect().bottom <= innerHeight + 1,
      ),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const overlaps = await page
    .locator(".format-bar button, .format-bar select")
    .evaluateAll((elements) =>
      elements.some((element, index) =>
        elements.slice(index + 1).some((other) => {
          const a = element.getBoundingClientRect(),
            b = other.getBoundingClientRect();
          return (
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
          );
        }),
      ),
    );
  assert.equal(overlaps, false);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .setContentSize(1120, 760),
  );
  // Folders: make one, file a page into it, read it back, then remove the folder
  // and prove the page is still there. Folders share the quiet view control, so
  // a person who never makes one sees the library exactly as before.
  await clickPage(page, "Notes");
  assert.equal(await page.getByLabel("Folder for this page", { exact: true }).count(), 0,
    "no folder control on a page until a folder exists");
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}notebook-folder-dialog.png`) });
  await page.getByLabel("Name", { exact: true }).fill("Clients");
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Note view"]')?.selectedOptions[0]?.textContent === "Clients",
  );
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".notebook")?.getAttribute("aria-busy") === "false");
  await title().fill("Acme kickoff");
  await saved();
  const clientsId = (await page.getByLabel("Note view", { exact: true }).inputValue()).slice(7);
  assert.equal(
    await page.getByLabel("Folder for this page", { exact: true }).inputValue(), clientsId,
    "a page created inside a folder is filed there",
  );
  await page.getByLabel("Note view", { exact: true }).selectOption("all");
  await page.waitForFunction(() => document.querySelectorAll(".note-row").length > 1);
  await page.getByLabel("Note view", { exact: true }).selectOption({ label: "Clients" });
  await page.waitForFunction(
    () => document.querySelectorAll(".note-row").length === 1 &&
      document.querySelector(".note-row").textContent.includes("Acme kickoff"),
  );
  await screenshot("folders");
  await page.getByRole("button", { name: "Folder options", exact: true }).click();
  await page.getByRole("menu").waitFor();
  await screenshot("folder-menu");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0, "Escape closes the folder menu");
  await page.getByRole("button", { name: "Folder options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove folder", exact: true }).click();
  await page
    .locator(".notebook-notice")
    .filter({ hasText: "1 page moved out of any folder" })
    .waitFor();
  assert.equal(await page.getByLabel("Note view", { exact: true }).inputValue(), "all");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".note-row")].some((row) => row.textContent.includes("Acme kickoff")),
    undefined,
    { timeout: 5000 },
  );
  assert.equal(await page.getByLabel("Folder for this page", { exact: true }).count(), 0,
    "with the last folder gone, the page header is quiet again");
  // Focus writing: the page list steps aside, and the choice is remembered when
  // Notes is opened again.
  await page.getByRole("button", { name: "Hide pages", exact: true }).click();
  await page.locator(".note-library").waitFor({ state: "hidden" });
  await screenshot("pages-hidden");
  await clickPage(page, "Today");
  assert.equal(await page.getByRole("button", { name: "Hide pages", exact: true }).count(), 0,
    "Today has no page list to hide");
  await clickPage(page, "Notes");
  await page.locator(".note-row").first().waitFor({ state: "attached" });
  if (!(await page.getByRole("button", { name: "Show pages", exact: true }).count()))
    await page.locator(".note-row").first().click();
  await page.getByRole("button", { name: "Show pages", exact: true }).click();
  await page.locator(".note-library").waitFor();
  // A daily page belongs to its date, so Today offers no folder control.
  await clickPage(page, "Today");
  assert.equal(await page.getByLabel("Folder for this page", { exact: true }).count(), 0);
  await clickPage(page, "Settings");
  await page.getByRole("heading", { name: "Import from Apple Notes", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}settings-apple-notes.png`) });
  await page.getByLabel("Appearance").selectOption("light");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await clickPage(page, "Today");
  await body().fill("The shoreline survives a reload, even before debounce.");
  const reloaded = page.waitForEvent("load");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith("focusbae-workspace:"))
      .webContents.reload(),
  );
  await reloaded.catch(async (error) => {
    console.error(
      "Reload state",
      await page.evaluate(() => ({
        text: document.querySelector(".note-status")?.textContent,
        inert: document.querySelector("#root").inert,
      })),
    );
    throw error;
  });
  await body().waitFor();
  assert.match(await body().innerText(), /survives a reload/);
  // The notebook header carries no bundled artwork; the writing column is the page.
  assert.equal(await page.locator(".page-painting").count(), 0);
};
