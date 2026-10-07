"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");

const app = path.resolve(process.argv[2] || "out/release-signed/mac-arm64/FocusBae.app");
const archive = path.join(app, "Contents/Resources/app.asar");
const files = new Set(asar.listPackage(archive));
const metadata = JSON.parse(asar.extractFile(archive, "package.json"));
assert.equal(metadata.main, "local-first-main.js");
for (const required of ["/local-first-main.js", "/workspace-window.js", "/privacy/local-runtime.js", "/update/local-updater.js", "/node_modules/electron-updater/package.json"])
  assert.ok(files.has(required), `Missing ${required}`);
const retired = [
  /^\/main\.js$/, /^\/call-mode\//, /^\/onboarding\//, /^\/sync\.js$/,
  /^\/meeting-capture\/index\.js$/, /^\/privacy\/(runtime|network|credentials)\.js$/,
  /^\/node_modules\/(livekit-client|@nut-tree-fork|axios|ws)\//,
];
for (const file of files)
  assert.ok(!retired.some((pattern) => pattern.test(file)), `Retired code packaged: ${file}`);
const plist = execFileSync("/usr/bin/plutil", ["-p", path.join(app, "Contents/Info.plist")], { encoding: "utf8" });
for (const key of ["NSScreenCaptureDescription",
  "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription", "CFBundleURLTypes"])
  assert.ok(!plist.includes(`"${key}"`), `Retired permission or protocol: ${key}`);
for (const key of ["NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription", "NSAppleEventsUsageDescription"])
  assert.ok(plist.includes(`"${key}"`), `Missing required permission: ${key}`);
// A declared minimum below what the helpers need lets the app install where
// recording and on-device AI cannot start.
assert.match(plist, /"LSMinimumSystemVersion" => "26\.0"/, "Bundle must declare macOS 26.0 as its minimum");
console.log(`Local-only release audit passed: ${files.size} packaged entries`);
