"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { _electron: electron } = require("playwright");
const root = path.resolve(__dirname, "../..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "focusbae-attachments-e2e-"));
const packaged = process.argv.includes("--packaged");
const output = path.join(root, "test-results", "attachments");
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
let app, page;
const errors = [];
const args = [...(packaged ? [] : [path.join(root, "scripts/workspace-probe-entry.cjs")]), `--workspace-test-profile=${profile}`];
async function launch() {
  app = await electron.launch({ executablePath: packaged ? path.join(root, "out/workspace-shell/mac-arm64/FocusBae Workspace Probe.app/Contents/MacOS/FocusBae Workspace Probe") : require("electron"), args, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("textbox", { name: "Note body", exact: true }).waitFor();
}
async function saved() {
  await page.locator(".note-status").filter({ hasText: "Saved on this Mac" }).waitFor();
}
async function visible() {
  await page.waitForFunction(() => {
    const image = document.querySelector(".note-attachment img");
    return image?.complete && image.naturalWidth > 0;
  });
  await page.getByRole("button", { name: "Open plan.pdf in Quick Look", exact: true }).waitFor();
  assert.equal(await page.locator(".note-attachment").count(), 2);
}
(async () => {
  await launch();
  const workspaceId = (await page.evaluate(() => window.focusbaeWorkspace.bootstrap())).value.workspace.id;
  const strict = await page.evaluate(() => window.focusbaeWorkspace.privacy.setStrict({ enabled: true }));
  assert.equal(strict.ok, true);
  await page.getByRole("textbox", { name: "Note title", exact: true }).fill("Files stay with my notes");
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await body.fill("A screenshot and a plan, kept on this Mac.");
  await body.press("Meta+End");
  await body.evaluate((element) => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 240;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e4eadf"; context.fillRect(0, 0, 640, 240);
    context.fillStyle = "#335846"; context.font = "32px Georgia"; context.fillText("A little space to think.", 40, 135);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), (char) => char.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.locator(".note-attachment img").waitFor();
  await saved();
  await body.evaluate((element) => {
    const data = new DataTransfer(); data.items.add(new File(["%PDF-1.4\nsynthetic plan"], "plan.pdf", { type: "application/pdf" }));
    const box = element.getBoundingClientRect();
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.bottom - 4 }));
  });
  await visible(); await saved();
  const imageURL = await page.locator(".note-attachment img").getAttribute("src");
  assert.match(imageURL, /^focusbae-workspace:\/\/app\/attachments\//);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith("focusbae-workspace:"));
    win.previewFile = (file, title) => { global.workspaceProbe.attachmentPreview = { file, title }; };
  });
  await page.getByRole("button", { name: "Open plan.pdf in Quick Look", exact: true }).click();
  const preview = await app.evaluate(() => global.workspaceProbe.attachmentPreview);
  assert.equal(preview.title, "plan.pdf"); assert.match(fs.readFileSync(preview.file, "utf8"), /synthetic plan/);
  await page.screenshot({ path: path.join(output, `${packaged ? "packaged-" : ""}attachments.png`) });
  await app.close(); app = null;
  await launch();
  await visible();
  const noteId = await app.evaluate(() => global.workspaceProbe.catalog.store._db.prepare("SELECT id FROM notes WHERE title = ?").get("Files stay with my notes").id);
  // Backup and restore use the real IPC/native picker contract in this isolated profile.
  const backup = path.join(profile, "attachments.focusbae-backup");
  await app.evaluate(({ dialog }, file) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, backup);
  assert.equal((await page.evaluate((workspaceId) => window.focusbaeWorkspace.backup.create({ workspaceId }), workspaceId)).ok, true);
  const restore = await page.evaluate((workspaceId) => window.focusbaeWorkspace.backup.restore({ workspaceId }), workspaceId);
  assert.equal(restore.ok, true, JSON.stringify(restore));
  const restoredId = restore.value.id;
  assert.notEqual(restoredId, workspaceId);
  assert.equal((await page.evaluate((workspaceId) => window.focusbaeWorkspace.workspace.open({ workspaceId }), restoredId)).ok, true);
  await visible();
  assert.ok((await page.locator(".note-attachment img").getAttribute("src")).includes(restoredId));
  // Both confirmation outcomes, through the actual renderer bridge.
  const request = await page.evaluate(async ({ workspaceId, id }) => {
    const api = window.focusbaeWorkspace;
    const note = (await api.notes.get({ workspaceId, id })).value;
    return api.notes.delete({ context: { workspaceId, clientRequestId: crypto.randomUUID(), expectedRevision: note.revision }, id });
  }, { workspaceId: restoredId, id: noteId });
  assert.equal(request.ok, true);
  const purge = { context: { workspaceId: restoredId, clientRequestId: require("node:crypto").randomUUID(), expectedRevision: request.value.revision }, id: noteId };
  assert.equal((await page.evaluate((input) => window.focusbaeWorkspace.notes.purge(input), purge)).value.canceled, true);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  const result = await page.evaluate((input) => window.focusbaeWorkspace.notes.purge(input), purge);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, packaged, profile, checks: ["Strict Local", "synthetic PNG paste", "PDF drop", "protocol image decoded", "Quick Look bridge", "restart persistence", "backup restore with new workspace scope", "cancel and confirm permanent delete"] }));
})().catch(async (error) => {
  console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
}).finally(async () => {
  if (app) await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
});
