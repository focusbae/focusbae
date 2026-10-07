"use strict";
const path = require("node:path");
const { build, Platform, Arch } = require("electron-builder");
build({
  targets: Platform.MAC.createTarget(["dir"], Arch.arm64),
  publish: "never",
  config: path.join(__dirname, 'workspace-probe.config.cjs'),
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
