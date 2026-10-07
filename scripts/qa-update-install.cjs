"use strict";
// CI-only: exercise the real signed Mac updater with a private localhost feed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const { _electron: electron } = require("playwright");

const installedApp = path.resolve(process.argv[2]);
const releaseDir = path.resolve(process.argv[3]);
const plist = path.join(installedApp, "Contents/Info.plist");
const executable = path.join(installedApp, "Contents/MacOS/FocusBae Update QA");
const version = () => {
  try {
    return execFileSync("/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
};
const relaunched = () => {
  try {
    return execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" })
      .split("\n").some((line) => line.startsWith(executable) && !line.includes(" --type="));
  } catch { return false; }
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assert.equal(version(), "1.3.1", "the installed starting app must be the older signed build");
  const requests = [];
  const server = http.createServer((request, response) => {
    const name = path.basename(new URL(request.url, "http://127.0.0.1").pathname);
    if (!/^latest-mac\.yml$|^FocusBae-Update-QA-1\.3\.2-arm64\.(?:zip|dmg)(?:\.blockmap)?$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    const file = path.join(releaseDir, name);
    if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
    requests.push(name);
    const size = fs.statSync(file).size;
    let start = 0; let end = size - 1;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
    if (match) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end) { response.writeHead(416).end(); return; }
    }
    response.writeHead(match ? 206 : 200, {
      "Content-Type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(file, { start, end }).pipe(response);
  });
  server.listen(17832, "127.0.0.1");
  await once(server, "listening");
  let app;
  let oldExited = false;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    app = await electron.launch({ executablePath: executable, env, timeout: 30000 });
    const page = await app.firstWindow();
    await page.getByRole("heading", { name: "Today", exact: true }).waitFor({ timeout: 30000 });
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
    });
    await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
    const updates = page.getByRole("region", { name: "About & updates" });
    await updates.getByText("1.3.1 · Mac app").waitFor();
    await updates.getByRole("button", { name: "Check for updates" }).click();
    await updates.getByRole("button", { name: "Download version 1.3.2" }).waitFor({ timeout: 30000 });
    await updates.getByRole("button", { name: "Download version 1.3.2" }).click();
    await updates.getByRole("button", { name: "Restart and install version 1.3.2" }).waitFor({ timeout: 120000 });
    const exited = once(app.process(), "exit");
    await updates.getByRole("button", { name: "Restart and install version 1.3.2" }).click();
    let timeout;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("old app did not quit")), 90000);
      })]);
      oldExited = true;
    } finally { clearTimeout(timeout); }
    for (let i = 0; i < 90 && version() !== "1.3.2"; i++) await delay(1000);
    assert.equal(version(), "1.3.2", "installer did not replace the app in place");
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installedApp]);
    for (let i = 0; i < 30 && !relaunched(); i++) await delay(1000);
    assert.equal(relaunched(), true, "the updated app did not relaunch");
    assert.ok(requests.includes("latest-mac.yml"), "app did not check the feed");
    assert.ok(requests.includes("FocusBae-Update-QA-1.3.2-arm64.zip"), "app did not download the signed ZIP");
    console.log(JSON.stringify({ ok: true, from: "1.3.1", to: "1.3.2", signed: true, relaunched: true, requests }));
  } finally {
    if (app && !oldExited) await app.close().catch(() => {});
    server.closeAllConnections();
    server.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
