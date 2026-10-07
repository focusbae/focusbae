"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { LocalPolicy } = require("../../privacy/local-policy");
const { LocalUpdater } = require("../../update/local-updater");

function setup() {
  const policy = new LocalPolicy();
  const updater = new EventEmitter();
  const calls = { checks: 0, downloads: 0, installs: 0, permits: [] };
  updater.checkForUpdates = async () => {
    calls.checks++;
    return { updateInfo: { version: "1.4.0", files: [{
      url: "FocusBae-1.4.0-arm64-mac.zip", sha512: "test-digest",
    }] }, downloadPromise: null };
  };
  updater.downloadUpdate = async () => {
    calls.downloads++;
    updater.emit("download-progress", { percent: 62.4 });
    updater.emit("update-downloaded");
  };
  updater.quitAndInstall = () => { calls.installs++; };
  const privacy = {
    policy,
    permit: async (purpose, action) => {
      if (policy.strict) return false;
      calls.permits.push([purpose, action || "check"]);
      policy.authorize(purpose);
      return true;
    },
  };
  const app = { isPackaged: true, getVersion: () => "1.3.0" };
  const candidate = new LocalUpdater({ app, privacy, updater,
    CancellationToken: class { cancel() { this.cancelled = true; } } });
  return { candidate, calls, policy, updater };
}

test("updater is idle and makes no network request at startup", () => {
  const { candidate, calls, updater } = setup();
  assert.equal(candidate.snapshot().status, "idle");
  assert.equal(calls.checks, 0);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test("check, download, and install each require an explicit step", async () => {
  const { candidate, calls, policy } = setup();
  assert.equal((await candidate.download()).status, "idle");
  assert.equal(candidate.install(), false);
  assert.equal((await candidate.check()).status, "available");
  assert.equal(calls.checks, 1);
  assert.equal(calls.downloads, 0);
  assert.equal(policy.allows("updates"), false);
  assert.equal((await candidate.download()).status, "ready");
  assert.equal(calls.downloads, 1);
  assert.equal(calls.installs, 0);
  assert.equal(candidate.install(), true);
  assert.equal(calls.installs, 1);
  assert.deepEqual(calls.permits, [["updates", "check"], ["updates", "download"]]);
});

test("Strict Local prevents checks and downloads", async () => {
  const { candidate, calls, policy } = setup();
  policy.setStrict(true);
  assert.equal((await candidate.check()).status, "idle");
  assert.equal(calls.checks, 0);
  policy.setStrict(false);
  await candidate.check();
  policy.setStrict(true);
  assert.equal((await candidate.download()).status, "available");
  assert.equal(calls.downloads, 0);
});

test("an older feed version is not offered as an installable update", async () => {
  const { candidate, updater } = setup();
  updater.checkForUpdates = async () => ({ updateInfo: { version: "1.2.0" } });
  assert.equal((await candidate.check()).status, "current");
  assert.equal((await candidate.download()).status, "current");
});

test("off-channel update files are rejected before any download", async () => {
  const { candidate, updater, calls } = setup();
  updater.checkForUpdates = async () => ({ updateInfo: { version: "1.4.0",
    files: [{ url: "https://example.invalid/FocusBae-1.4.0-arm64-mac.zip", sha512: "test" }] },
    downloadPromise: null });
  assert.equal((await candidate.check()).status, "error");
  assert.equal((await candidate.download()).status, "error");
  assert.equal(calls.downloads, 0);
});

test("revoking update permission cancels an active download", async () => {
  const { candidate, updater, policy } = setup();
  await candidate.check();
  let token;
  updater.downloadUpdate = async (value) => {
    token = value;
    policy.setStrict(true);
    throw new Error("cancelled");
  };
  assert.equal((await candidate.download()).status, "available");
  assert.equal(token.cancelled, true);
  assert.equal(candidate.install(), false);
});
