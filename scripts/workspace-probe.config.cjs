'use strict';
const path = require('node:path');
const pkg = require('../package.json');
module.exports = {
  ...pkg.build,
  extends: null, publish: null,
  productName: 'FocusBae Workspace Probe', appId: 'com.focusbae.workspace-probe',
  directories: { output: 'out/workspace-shell' },
  extraMetadata: { main: 'scripts/workspace-probe-entry.cjs' },
  files: ['**/*', '!qualification/**/*', '!tests/**/*', '!docs/**/*', '!desktop-ui/src/**/*', '!desktop-ui/index.html', '!desktop-ui/vite.config.mjs', '!local-ai/fluid-helpers/.build/**/*', '!local-ai/*/Sources/**/*'],
  // This probe has its own configuration so production exclusions cannot merge into it.
  afterPack: null, npmRebuild: false,
  electronDist: path.join(__dirname, '../node_modules/electron/dist'),
  mac: { ...pkg.build.mac, identity: null, notarize: false, target: [{ target: 'dir', arch: ['arm64'] }] },
};
