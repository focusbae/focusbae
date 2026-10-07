const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const { probeSqlite } = require('./sqlite-probe.cjs');
const { probeNative } = require('./native-probe.cjs');
const { probeVector } = require('./vector-probe.cjs');

const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
if (!reportArg) throw new Error('Only launch through scripts/run.cjs with an explicit report destination');
const reportFile = path.resolve(reportArg.slice('--report='.length));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'focusbae-lf00-profile-'));
fs.chmodSync(profile, 0o700);
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'chromium'));
app.setPath('logs', path.join(profile, 'logs'));
app.setName('FocusBae LF-00 Qualification');
app.commandLine.appendSwitch('disable-background-networking');
const result = { phase: app.isPackaged ? 'packaged' : 'development', versions: process.versions, arch: process.arch, platform: process.platform, os: os.release(), totalMemoryBytes: os.totalmem(), checks: {}, blockedRequests: [] };
let window;
let finished = false;

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  result.ok = !error;
  if (error) result.error = error.stack || String(error);
  fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (window && !window.isDestroyed()) window.destroy();
  // Never remove a caller-supplied path or the developer's real Electron profile.
  app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => finish(new Error('Qualification timed out')), 45000);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);

app.whenReady().then(async () => {
  app.dock?.hide();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    result.blockedRequests.push(details.url);
    callback({ cancel: true });
  });
  result.checks.sqlite = await probeSqlite(profile);
  result.checks.vector = await probeVector(profile);
  result.checks.native = await probeNative();
  window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  await window.loadFile(path.join(__dirname, 'dist', 'index.html'));
  let renderer;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    renderer = await window.webContents.executeJavaScript('window.__qualification');
    if (renderer) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(renderer, 'Renderer did not complete its probe');
  assert.equal(renderer.error, undefined);
  assert.equal(renderer.mounted, true);
  assert.equal(renderer.roundTrip, true);
  assert.match(renderer.text, /Offline edit survived/);
  assert.equal(renderer.nodeAccess, 'undefined');
  assert.equal(renderer.processAccess, 'undefined');
  result.checks.renderer = renderer;
  assert.deepEqual(result.blockedRequests, [], 'Fixture attempted an unexpected renderer request');
  finish();
}).catch(finish);
