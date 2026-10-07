'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// Builder owns signing. Never delete signatures or replace the app bundle.
module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  const resources = path.join(app, 'Contents/Resources');
  const required = [
    'app.asar',
    'app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    ...['embed', 'extract', 'asr', 'diarize'].map(name => 'app.asar.unpacked/local-ai/bin/focusbae-' + name),
    'app.asar.unpacked/meeting-capture/bin/focusbae-transcribe',
  ];
  for (const file of required) {
    if (!fs.statSync(path.join(resources, file)).isFile()) throw new Error('Missing runtime file: ' + file);
  }
  const info = path.join(app, 'Contents/Info.plist');
  for (const key of [
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
  ]) {
    execFileSync('/usr/bin/plutil', ['-remove', key, info], { stdio: 'pipe' });
  }
  execFileSync('/usr/bin/xattr', ['-cr', app], { stdio: 'inherit' });
};
