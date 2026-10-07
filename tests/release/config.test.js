'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function config(unsigned, qa = false) {
  return JSON.parse(execFileSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify(require("./scripts/release-candidate.config.cjs")))'],
  { cwd: root, env: { ...process.env, FOCUSBAE_UNSIGNED_CANDIDATE: unsigned ? '1' : '', FOCUSBAE_QA_UPDATE: qa ? '1' : '' } }));
}
test('signed candidate requires signing and notarization with a separate update feed', () => {
  const c = config(false);
  assert.equal(c.forceCodeSigning, true);
  assert.equal(c.mac.notarize, true);
  assert.deepEqual(c.publish, [{ provider: 'generic', url: 'https://pub-f1d20a395b224af7aff8e7b531dbfdae.r2.dev/local/macos/arm64/' }]);
  assert.equal(c.mac.identity, undefined);
  assert.deepEqual(c.mac.target.flatMap(t => t.arch), ['arm64', 'arm64']);
  assert.equal(c.mac.minimumSystemVersion, '26.0', 'the bundle must refuse Macs the helpers cannot run on');
});
test('unsigned candidate is explicitly separated from signed output', () => {
  const c = config(true);
  assert.equal(c.mac.identity, null);
  assert.equal(c.mac.notarize, false);
  assert.notEqual(c.directories.output, config(false).directories.output);
});
test('signed QA updater builds are isolated from the public Mac app and feed', () => {
  const qa = config(false, true);
  assert.equal(qa.appId, 'com.focusbae.update-qa');
  assert.equal(qa.productName, 'FocusBae Update QA');
  assert.equal(qa.extraMetadata.focusbaeUpdateQa, true);
  assert.equal(qa.publish[0].url, 'http://127.0.0.1:17832/');
  assert.equal(qa.forceCodeSigning, true);
  assert.equal(qa.mac.notarize, false);
  assert.deepEqual(qa.mac.target, [{ target: 'zip', arch: ['arm64'] }]);
  assert.notEqual(qa.directories.output, config(false).directories.output);
});
test('candidate excludes credentials, test artifacts and nested build output', () => {
  const c = config(false);
  for (const pattern of ['!**/.env*',
    '!**/*.p12', '!**/*.p8', '!**/*.pem', '!**/*.key']) assert.ok(c.files.includes(pattern));
  for (const old of ['main.js', 'call-mode/**/*', 'onboarding/**/*', 'sync.js', 'docs/**/*', 'tests/**/*'])
    assert.equal(c.files.includes(old), false);
  assert.equal(c.extraMetadata.main, 'local-first-main.js');
  assert.equal(c.protocols.length, 0);
  assert.match(c.mac.entitlements, /entitlements\.local/);
  const entitlements = fs.readFileSync(path.join(root, c.mac.entitlements), 'utf8');
  for (const old of ['device.camera', 'screen-capture'])
    assert.equal(entitlements.includes(old), false);
  assert.equal(require('../../package.json').main, 'local-first-main.js');
  for (const old of ['@nut-tree-fork/nut-js', 'livekit-client', 'axios', 'ws'])
    assert.equal(require('../../package.json').dependencies[old], undefined);
  assert.ok(require('../../package.json').dependencies['electron-updater']);
});
test('workflow cannot publish a GitHub release', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-macos.yml'), 'utf8');
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/release\/'\)/);
  assert.match(workflow, /--publish never/);
  assert.match(workflow, /out\/release-signed\/latest-mac\.yml/);
  assert.doesNotMatch(workflow, /action-gh-release|gh release|contents: write|^  push:/m);
});
test('packaging fails on missing required files instead of swallowing errors', async () => {
  const hook = require('../../scripts/cleanup-signatures.js');
  await assert.rejects(hook({
    electronPlatformName: 'darwin',
    appOutDir: path.join(root, 'out/nonexistent-release-test'),
    packager: { appInfo: { productFilename: 'FocusBae' } },
  }), /ENOENT/);
});
