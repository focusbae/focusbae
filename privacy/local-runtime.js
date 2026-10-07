"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { LocalPolicy } = require("./local-policy");
const { atomicJson } = require("../workspace/files");
const policy = new LocalPolicy();
let app, dialog, settingsFile;
function initialize(options) {
  app = options.app; dialog = options.dialog;
  settingsFile = path.join(app.getPath("userData"), "privacy.json");
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (saved.version !== 1 || typeof saved.strict !== "boolean") throw new Error("Invalid privacy settings");
    policy.setStrict(saved.strict);
  } catch (error) {
    if (error.code !== "ENOENT") policy.setStrict(true);
  }
}
async function permit(purpose, action = "check") {
  if (!["models", "updates"].includes(purpose) || policy.strict) return false;
  if (policy.allows(purpose)) return true;
  const epoch = policy.epoch;
  const result = await dialog.showMessageBox({ type: "question", buttons: ["Allow", "Cancel"],
    defaultId: 1, cancelId: 1,
    message: purpose === "models" ? "Download an on-device model?"
      : action === "download" ? "Download the FocusBae update?" : "Check for updates?",
    detail: purpose === "models"
      ? "The selected model downloads to this Mac. Your workspace content stays here."
      : "FocusBae will contact its update server. No workspace content is sent." });
  if (result.response !== 0 || epoch !== policy.epoch) return false;
  policy.authorize(purpose);
  return true;
}
async function setStrict(enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("Invalid privacy mode");
  const epoch = policy.epoch;
  const result = await dialog.showMessageBox({ type: "question", buttons: ["Continue", "Cancel"],
    defaultId: 1, cancelId: 1,
    message: enabled ? "Enable Strict Local?" : "Leave Strict Local?",
    detail: enabled ? "Any model download stops. Your local files remain." : "Online access requires your permission each session." });
  if (result.response !== 0 || epoch !== policy.epoch) return;
  atomicJson(settingsFile, { version: 1, strict: enabled });
  policy.setStrict(enabled);
}
module.exports = { policy, initialize, permit, setStrict };
