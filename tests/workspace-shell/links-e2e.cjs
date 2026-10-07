"use strict";
// The Obsidian-shaped part of the notebook, exercised the way it is used: write a
// link to a page that does not exist, follow it, come back through the backlink,
// keep both pages open as tabs, and see the two of them joined in the graph.
const assert = require("node:assert/strict");
const path = require("node:path");
module.exports = async function linkChecks({
  page,
  output,
  packaged,
  clickPage,
}) {
  const screenshot = (name) =>
    page.screenshot({
      path: path.join(output, `${packaged ? "packaged-" : ""}links-${name}.png`),
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
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  await clickPage(page, "Notes");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await title().fill("Vendor call");
  await body().fill("Pricing lives in [[Pricing sheet]].");
  await saved();
  // The link is painted without changing what is stored.
  await page.locator('.tiptap [data-wikilink="Pricing sheet"]').waitFor();
  await page
    .locator(".link-chip")
    .filter({ hasText: "Pricing sheet" })
    .waitFor();
  assert.equal(
    await page.locator(".link-chip.unresolved").count(),
    1,
    "a link to a page that does not exist yet reads as unresolved",
  );
  await screenshot("unresolved");

  // Following it creates the page it names.
  await page.locator('.tiptap [data-wikilink="Pricing sheet"]').click();
  await page.getByText('Created "Pricing sheet".', { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Pricing sheet",
  );
  await body().fill("Two options, both quarterly.");
  await saved();
  // Both pages are open, and the one just left is still there.
  await tab("Vendor call").waitFor();
  await tab("Pricing sheet").waitFor();
  assert.equal(
    await page.locator(".note-tab.active").innerText(),
    "Pricing sheet",
  );
  // The backlink is the way home.
  await page
    .locator(".link-panel")
    .getByRole("button", { name: "Vendor call", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Vendor call",
  );
  assert.equal(
    await page.locator(".link-chip.unresolved").count(),
    0,
    "the link resolves once its page exists",
  );

  // Switching tabs saves the page being left, without a separate editor per tab.
  await body().press("Meta+End");
  await body().pressSequentially(" Ask about the discount.");
  await tab("Pricing sheet").click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Pricing sheet",
  );
  await tab("Vendor call").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".tiptap")
      ?.innerText.includes("Ask about the discount."),
  );

  const graph = await page.evaluate(async () => {
    const api = window.focusbaeWorkspace;
    const workspace = (await api.bootstrap()).value.workspace;
    return (await api.links.graph({ workspaceId: workspace.id })).value;
  });
  const titles = new Map(graph.nodes.map((node) => [node.label, node.id]));
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from === titles.get("Vendor call") &&
        edge.to === titles.get("Pricing sheet"),
    ),
    "the graph joins the two pages the link joined",
  );

  await page.getByRole("button", { name: "Workspace graph" }).click();
  await page.locator(".graph-canvas svg").waitFor();
  await tab("Graph").waitFor();
  const nodes = page.locator(".graph-node");
  assert.ok((await nodes.count()) >= 2);
  assert.equal(
    await page.locator(".graph-note").count(),
    0,
    "a small workspace is drawn whole, and is not told otherwise",
  );
  await screenshot("graph");
  // Hiding a kind removes it from the picture, not from the workspace.
  const before = await nodes.count();
  const notesToggle = page.getByRole("checkbox", { name: /^Notes/ });
  await notesToggle.uncheck();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".graph-node").length < count,
    before,
  );
  await notesToggle.check();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".graph-node").length === count,
    before,
  );
  // A node is a way in: clicking the page opens it as a tab.
  await page
    .locator(".graph-node")
    .filter({ hasText: "Pricing sheet" })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Pricing sheet",
  );

  // Typing [[ offers what it could name, and choosing finishes the link.
  await tab("Vendor call").click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Vendor call",
  );
  await body().press("Meta+End");
  await body().pressSequentially(" See [[pric");
  const options = page.getByRole("listbox", { name: "Link to" });
  await options.waitFor();
  assert.deepEqual(
    await options.locator(".link-suggestion-label").allInnerTexts(),
    ["Pricing sheet"],
    "the page being typed is offered",
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".tiptap")?.innerText.includes("[[Pricing sheet]]"),
  );
  assert.equal(
    await options.count(),
    0,
    "choosing closes the list rather than leaving it over the page",
  );
  await saved();
  // Escape leaves the brackets alone: writing a literal [[ must stay possible,
  // and Enter must go back to being Enter.
  const paragraphs = await page.locator(".tiptap p").count();
  await body().pressSequentially(" [[pric");
  await options.waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await options.count(), 0);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".tiptap p").length === count + 1,
    paragraphs,
  );
  // Take the experiment back out, one keystroke at a time rather than by undo.
  for (let count = 0; count < 8; count++) await page.keyboard.press("Backspace");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".tiptap p").length === count,
    paragraphs,
  );
  await saved();
  assert.match(await body().innerText(), /See \[\[Pricing sheet\]\]/);

  // One page's connections, opened from the page itself.
  await page
    .getByRole("button", { name: "Show this page's connections" })
    .click();
  await page.locator(".graph-canvas svg").waitFor();
  await tab("Graph · Vendor call").waitFor();
  assert.equal(
    await page.getByRole("tab").count(),
    3,
    "the graph tab is reused, not duplicated",
  );
  const focused = await page.locator(".graph-node").count();
  await page.getByRole("checkbox", { name: "Only this page" }).uncheck();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".graph-node").length > count,
    focused,
  );
  await page.getByRole("checkbox", { name: "Only this page" }).check();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".graph-node").length === count,
    focused,
  );
  await screenshot("focused");

  // The strip survives leaving the notebook entirely.
  await clickPage(page, "Actions");
  await page
    .getByRole("heading", { name: "Actions", exact: true })
    .first()
    .waitFor();
  await clickPage(page, "Notes");
  await tab("Vendor call").waitFor();
  await tab("Pricing sheet").waitFor();
  assert.equal(await page.getByRole("tab").count(), 3);
  await tab("Pricing sheet").click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Pricing sheet",
  );

  // Rewriting. This runs on whatever the machine has: where Apple Intelligence is
  // available the passage is corrected and one undo brings the original back, and
  // where it is not, the refusal is plain and the words are untouched. Both are
  // correct; what must never happen is the page quietly losing what it said.
  await body().press("Meta+End");
  await body().pressSequentially(" I owe Priya teh contract by tommorow.");
  await saved();
  const original = await body().innerText();
  await body().press("Meta+a");
  await page.getByLabel("Rewrite selection").selectOption("proofread");
  // Either the status settles or the refusal appears; the model is slow, not silent.
  await page.waitForFunction(
    () =>
      document.querySelector('[role="alert"]') ||
      /undo restores/.test(document.querySelector(".note-status")?.textContent ?? ""),
    undefined,
    { timeout: 180000 },
  );
  if (await page.getByRole("alert").count()) {
    assert.match(
      await page.getByRole("alert").innerText(),
      /Rewriting needs Apple Intelligence/,
    );
    assert.equal(await body().innerText(), original, "a refused rewrite changes nothing");
  } else {
    const rewritten = await body().innerText();
    assert.match(rewritten, /Priya/, "a rewrite keeps the person it was about");
    assert.doesNotMatch(rewritten, /teh contract/, "and fixes what it was asked to fix");
    await body().press("Meta+z");
    await page.waitForFunction(
      (was) => document.querySelector(".tiptap")?.innerText === was,
      original,
    );
  }
  // Leave the page as it was found.
  await body().press("Meta+a");
  await body().pressSequentially("Two options, both quarterly.");
  await saved();

  // A meeting you could not record: type it, and it still reaches the ledger.
  await page.getByRole("button", { name: "New note", exact: true }).click();
  // The new page's editor replaces the one open now; typing before it arrives
  // types into an editor that is about to be thrown away.
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Note title"]')?.value === "",
  );
  await title().fill("Corridor chat");
  await body().fill(
    "Raghav will draft the budget by Friday.\nI will send [[Pricing sheet]] to the vendor.",
  );
  await saved();
  await tab("Corridor chat").waitFor();
  await page
    .getByRole("button", { name: "Find commitments on this page" })
    .click();
  await page.getByText(/2 commitments proposed from this page/).waitFor();
  await page
    .getByRole("button", { name: "Find commitments on this page" })
    .click();
  await page.getByText(/Nothing new here/).waitFor();
  await clickPage(page, "Actions");
  await page.getByRole("tab", { name: /Review/ }).click();
  await page
    .getByRole("button", { name: /Raghav will draft the budget by Friday/ })
    .first()
    .click();
  await page.getByText("Written on Corridor chat", { exact: true }).waitFor();
  // The evidence goes back to the page it was quoted from.
  await page.getByRole("button", { name: "Open source page" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Corridor chat",
  );
  await clickPage(page, "People");
  await page
    .getByRole("button", { name: /Raghav/ })
    .first()
    .waitFor();
  await clickPage(page, "Notes");

  // Four pages open, on the one we were last reading.
  assert.equal(await page.getByRole("tab").count(), 4);
  assert.equal(
    await page.locator(".note-tab.active").innerText(),
    "Corridor chat",
  );
  // Closing a tab you are not looking at leaves the page you are reading alone.
  await page.getByRole("button", { name: "Close Graph · Vendor call" }).click();
  assert.equal(await page.getByRole("tab").count(), 3);
  assert.equal(
    await page.locator(".note-tab.active").innerText(),
    "Corridor chat",
  );
  // Closing the active one falls back to its neighbour, not to nothing.
  await page.getByRole("button", { name: "Close Corridor chat" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Pricing sheet",
  );
  await page.getByRole("button", { name: "Close Pricing sheet" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      "Vendor call",
  );
  await page.getByRole("button", { name: "Close Vendor call" }).click();
  assert.equal(await page.getByRole("tab").count(), 0);
  await page.locator(".blank-page").waitFor();
};
