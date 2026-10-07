'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const electron = require('electron');
const { app, netLog, ipcMain, Menu, dialog, shell, globalShortcut, safeStorage } = electron;
require('../../workspace-window');

const root = process.argv.find((arg) => arg.startsWith('--profile='))?.slice(10);
const mode = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
if (!root || !['fresh', 'legacy', 'strict'].includes(mode) || !fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('An isolated temporary profile is required');
const report = { mode, networkAttempts: [], helperAttempts: [], sensitiveCalls: [], versions: process.versions };
const directory = path.join(root, 'profile');
fs.mkdirSync(directory, { recursive: true });
const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.focusbae/pending'), { recursive: true });
os.homedir = () => home;
app.setName('FocusBaePrivacyProbe'); app.setPath('userData', directory);
app.setPath('sessionData', path.join(root, 'session'));
app.isDefaultProtocolClient = () => true;
app.setAsDefaultProtocolClient = () => { throw new Error('Protocol registration is forbidden in the probe'); };
process.env.FOCUSBAE_API = 'https://api.example.invalid/api/v1';
process.env.FOCUSBAE_WEB = 'https://example.invalid';
delete process.env.FOCUSBAE_OPEN_DEVTOOLS;

if (mode !== 'fresh') {
  fs.writeFileSync(path.join(directory, 'token.json'), JSON.stringify({ token: 'synthetic-legacy-token', refreshToken: 'synthetic-refresh' }));
  fs.writeFileSync(path.join(directory, 'user_config.json'), JSON.stringify({ sync: true, nudgeCardEnabled: true }));
  fs.writeFileSync(path.join(home, '.focusbae/pending/held.json'), '{"segments":[{"text":"synthetic held transcript"}]}');
}
if (mode === 'strict') fs.writeFileSync(path.join(directory, 'privacy.json'), '{"version":1,"strict":true}');

const fail = (list, name) => (..._args) => { list.push(name); throw new Error(`Probe denied ${name}`); };
global.fetch = fail(report.networkAttempts, 'fetch');
for (const name of ['http', 'https']) for (const method of ['get', 'request']) require(name)[method] = fail(report.networkAttempts, `${name}.${method}`);
require('net').Socket.prototype.connect = fail(report.networkAttempts, 'Socket.connect');
require('dgram').createSocket = fail(report.networkAttempts, 'dgram.createSocket');
// Helper launches are recorded with their command, so the only permitted one (the Apple
// speech status probe when a recording stops) can be told apart from anything else.
const helper = (method) => (command, args) => {
  report.helperAttempts.push({ method, command: path.basename(String(command)), args: Array.isArray(args) ? args.slice(0, 2) : [] });
  throw new Error(`Probe denied ${method}`);
};
for (const method of ['spawn', 'exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync']) require('child_process')[method] = helper(method);
for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString']) safeStorage[method] = fail(report.sensitiveCalls, `safeStorage.${method}`);
shell.openExternal = fail(report.networkAttempts, 'shell.openExternal');
for (const method of ['readText', 'availableFormats', 'writeText']) electron.clipboard[method] = fail(report.sensitiveCalls, `clipboard.${method}`);
let acceptedDialog = false;
dialog.showMessageBox = async () => ({ response: acceptedDialog ? 0 : 1 });
dialog.showErrorBox = () => {};
const handlers = new Map();
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); register(channel, handler); };
const shortcuts = new Map();
globalShortcut.register = (key, handler) => { shortcuts.set(key, handler); return true; };
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
globalShortcut.isRegistered = () => false;
let menu;
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => { if (template.some((item) => item.label?.startsWith('Open Workspace'))) menu = template; return buildMenu(template); };
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'dotenv') return { config() {} };
  if (['@nut-tree-fork/nut-js', 'audiotee'].includes(name)) return fail(report.sensitiveCalls, name)();
  return load.call(this, name, ...args);
};

const timeout = setTimeout(() => { process.stderr.write('Privacy probe timed out\n'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const logPath = path.join(root, 'network.json');
  await netLog.startLogging(logPath);
  require('../../local-first-main');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const privacy = require('../../privacy/local-runtime');
  const network = require('../../privacy/local-network');
  const workspaceWindow = require('../../workspace-window').getWindow();
  if (workspaceWindow.webContents.isLoadingMainFrame()) await new Promise((resolve) => workspaceWindow.webContents.once('did-finish-load', resolve));
  const writing = await workspaceWindow.webContents.executeJavaScript(`(async () => {
    const api = window.focusbaeWorkspace;
    const boot = await api.bootstrap(); if (!boot.ok) throw new Error('Workspace unavailable');
    const workspaceId = boot.value.workspace.id;
    const note = await api.notes.create({ context: { workspaceId, clientRequestId: crypto.randomUUID() }, note: { title: 'Offline writing', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Private shoreline thought' }] }] } } });
    if (!note.ok) throw new Error('Offline create failed');
    const edit = await api.notes.update({ context: { workspaceId, clientRequestId: crypto.randomUUID(), expectedRevision: note.value.revision }, id: note.value.id, changes: { title: 'Offline revision' } });
    const result = await api.search.query({ workspaceId, query: 'shoreline' });
    const source = await api.search.source({ workspaceId, kind: 'note', id: note.value.id });
    return edit.ok && result.ok && result.value.some(item => item.id === note.value.id) && source.value.title === 'Offline revision';
  })()`);
  assert.equal(writing, true); report.offlineWritingSearch = true;
  const offlineActions = await workspaceWindow.webContents.executeJavaScript(`(async () => {
    const api = window.focusbaeWorkspace;
    const workspaceId = (await api.bootstrap()).value.workspace.id;
    const created = await api.actions.create({ context: { workspaceId, clientRequestId: crypto.randomUUID() }, action: { title: 'Private local follow-up', owner: { kind: 'self', id: null }, ownerLabel: null, dueDate: '2026-09-20', priority: 'high' } });
    if (!created.ok) throw new Error('Offline action create failed');
    const completed = await api.actions.transition({ context: { workspaceId, clientRequestId: crypto.randomUUID(), expectedRevision: created.value.revision }, id: created.value.id, status: 'done' });
    const listed = await api.actions.browse({ workspaceId, view: 'completed' });
    return completed.ok && listed.ok && listed.value.items.some(item => item.id === created.value.id);
  })()`);
  assert.equal(offlineActions, true); report.offlineActions = true;
  const service = require('../../workspace-window').recording();
  assert.equal(service.snapshot().active, null);
  assert.equal(service.snapshot().model.ready, false);
  // Nothing may launch a helper before the user records.
  assert.deepEqual(report.helperAttempts, []);
  const { EventEmitter } = require('node:events');
  service.capabilities = () => ({ microphone: { ok: true }, system: { ok: true } });
  service.createSource = () => {
    const source = new EventEmitter();
    source.start = async () => source.emit('audio', Buffer.alloc(160000));
    source.stop = async () => {}; return source;
  };
  const offlineRecording = await workspaceWindow.webContents.executeJavaScript(`(async () => {
    const api = window.focusbaeWorkspace;
    const workspaceId = (await api.bootstrap()).value.workspace.id;
    const captured = await api.capture.start({ context: { workspaceId, clientRequestId: crypto.randomUUID() }, purpose: 'personal', sourceMode: 'both', language: 'english', consent: true, destination: { kind: 'standalone' } });
    if (!captured.ok) throw new Error('Offline capture failed');
    const stopped = await api.capture.stop({ workspaceId, id: captured.value.id });
    const detail = await api.capture.detail({ workspaceId, id: captured.value.id });
    return stopped.ok && detail.ok && detail.value.audio.bytes === 320000 && detail.value.recording.transcriptionState === 'queued';
  })()`);
  assert.equal(offlineRecording, true); report.offlineRecording = true;
  // Stopping may check Apple speech locally; it must be that probe and nothing else.
  const permitted = (attempt) => attempt.method === 'spawn' && attempt.command === 'focusbae-transcribe' && attempt.args[0] === '--status';
  report.speechProbes = report.helperAttempts.filter(permitted).length;
  assert.ok(report.speechProbes <= 1);
  report.helperAttempts = report.helperAttempts.filter((attempt) => !permitted(attempt));
  assert.equal(privacy.policy.snapshot().mode, mode === 'strict' ? 'strict-local' : 'local');
  assert.deepEqual(privacy.policy.snapshot().monitoring, []);
  // The shipped app has no account, token, sync, calling or upload channels at all.
  for (const channel of ['get-token', 'call-mode:session:start', 'settings:check-for-updates']) assert.equal(handlers.has(channel), false);
  for (const handler of shortcuts.values()) await handler();
  app.emit('open-url', { preventDefault() {} }, 'focusbae://auth-success?code=synthetic');
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Record now opens the local form. Its explicit readiness check may launch
  // these local probes, but it must not capture audio or initiate a download.
  assert.equal(service.snapshot().active, null);
  const setupProbe = (attempt) => attempt.method === 'spawn' && (
    (['focusbae-transcribe', 'focusbae-extract'].includes(attempt.command) && attempt.args.length === 1 && attempt.args[0] === '--status') ||
    (attempt.command === 'focusbae-embed' && attempt.args.length === 0)
  );
  report.setupProbes = report.helperAttempts.filter(setupProbe).length;
  assert.ok(report.setupProbes <= 3);
  report.helperAttempts = report.helperAttempts.filter((attempt) => !setupProbe(attempt));
  assert.equal(privacy.policy.snapshot().connected, false);
  assert.equal(menu[0].label.startsWith('Open Workspace'), true);
  assert.equal(menu.some((item) => /Privacy|updates|Clipboard/.test(item.label ?? '')), false);
  assert.deepEqual(require('../../workspace-window').clipboardHistory().snapshot(), { enabled: false, items: [] });
  if (mode !== 'strict') {
    acceptedDialog = true;
    await workspaceWindow.webContents.executeJavaScript('window.focusbaeWorkspace.privacy.setStrict({ enabled: true })');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(privacy.policy.strict, true);
  }
  for (const purpose of ['models', 'updates', 'account']) assert.throws(() => network.assert(purpose), { code: 'POLICY_DENIED' });
  if (mode !== 'fresh') {
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'token.json'))).token, 'synthetic-legacy-token');
    assert.equal(fs.existsSync(path.join(home, '.focusbae/pending/held.json')), true);
  }
  await netLog.stopLogging();
  const log = JSON.parse(fs.readFileSync(logPath));
  const types = log.constants.logEventTypes;
  const connecting = new Set(Object.entries(types).filter(([name]) => /^(TCP_CONNECT|UDP_CONNECT|HOST_RESOLVER_MANAGER_JOB|HOST_RESOLVER_IMPL_JOB|QUIC_SESSION)$/.test(name)).map(([, id]) => id));
  report.chromiumConnections = log.events.filter((event) => connecting.has(event.type)).length;
  assert.deepEqual(report.networkAttempts, []); assert.deepEqual(report.helperAttempts, []); assert.deepEqual(report.sensitiveCalls, []);
  assert.equal(report.chromiumConnections, 0);
  report.ok = true;
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  clearTimeout(timeout); app.exit(0);
}).catch((error) => {
  report.ok = false; report.error = error.stack;
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  process.stderr.write(`${error.stack}\n`); clearTimeout(timeout); app.exit(1);
});
