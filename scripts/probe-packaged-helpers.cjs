"use strict";
// Launches the system-audio helper from inside a finished app, the way the app
// itself does. Packaged E2E runs use a simulated audio source, so without this a
// helper that cannot be executed from the package (1.2.1-1.3.1: ENOTDIR, because
// the path pointed inside app.asar) passes every other check.
//
// Run with the packaged app's own runtime so app.asar paths resolve exactly as
// they do for users:
//   ELECTRON_RUN_AS_NODE=1 FocusBae.app/Contents/MacOS/FocusBae scripts/probe-packaged-helpers.cjs FocusBae.app
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const app = path.resolve(process.argv[2] || "out/release-signed/mac-arm64/FocusBae.app");
const { audioteeBinary } = require(path.join(app, "Contents/Resources/app.asar/meeting-capture/audio-sources.js"));
const binary = audioteeBinary();
assert.ok(binary.includes("app.asar.unpacked"), `System audio helper resolves inside the archive: ${binary}`);
assert.ok(fs.existsSync(binary), `System audio helper missing: ${binary}`);

const child = spawn(binary, ["--help"], { stdio: "ignore" });
const timer = setTimeout(() => {
  child.kill();
  console.error("System audio helper did not exit within 10 s");
  process.exit(1);
}, 10000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(`System audio helper could not be launched: ${error.code || error.message}`);
  process.exit(1);
});
child.on("spawn", () => {
  clearTimeout(timer);
  child.kill();
  console.log(`System audio helper launches from the package: ${path.relative(app, binary)}`);
  process.exit(0);
});
