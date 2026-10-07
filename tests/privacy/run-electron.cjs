'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const runtimes = [
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  'qualification/local-first/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
].map((relative) => path.join(root, relative));
if (runtimes.some((runtime) => !fs.existsSync(runtime))) throw new Error('Install the production and qualified runtimes explicitly; this test never downloads them');
for (const runtime of runtimes) for (const mode of ['fresh', 'legacy', 'strict']) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'focusbae-network-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const child = spawnSync(runtime, [path.join(__dirname, 'electron-main.cjs'), `--profile=${profile}`, `--case=${mode}`], { env, encoding: 'utf8', timeout: 30000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(profile, 'report.json'))); } catch {}
  if (child.status !== 0 || !report?.ok) {
    console.error(`Failed ${mode}; isolated evidence retained at ${profile}`, report ?? child.error);
    process.exitCode = 1; break;
  }
  console.log(JSON.stringify({ mode, ok: report.ok, networkAttempts: report.networkAttempts.length,
    helperAttempts: report.helperAttempts.length, speechProbes: report.speechProbes, sensitiveCalls: report.sensitiveCalls.length,
    chromiumConnections: report.chromiumConnections, offlineWritingSearch: report.offlineWritingSearch, offlineActions: report.offlineActions, offlineRecording: report.offlineRecording, electron: report.versions.electron }));
  fs.rmSync(profile, { recursive: true, force: true });
}
