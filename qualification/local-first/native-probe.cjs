const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function probeNative() {
  const root = path.join(__dirname, 'node_modules');
  const nut = require('@nut-tree-fork/nut-js');
  assert.ok(nut.keyboard && nut.mouse);
  const { AudioTee } = await import('audiotee');
  assert.equal(typeof AudioTee, 'function');
  const audioBinary = path.join(root, 'audiotee', 'bin', 'audiotee').replace('app.asar/', 'app.asar.unpacked/');
  const help = execFileSync(audioBinary, ['--help'], { encoding: 'utf8', timeout: 10000 });
  assert.match(help, /sample-rate/);
  return {
    nutJs: 'Native library loaded; no keyboard, mouse or screen operation invoked',
    audioTee: 'Wrapper loaded and native --help exited; no capture started',
    audioArchitecture: execFileSync('/usr/bin/lipo', ['-archs', audioBinary], { encoding: 'utf8' }).trim(),
  };
}

module.exports = { probeNative };
