const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const phase = process.argv[2];
if (!['development', 'packaged'].includes(phase)) throw new Error('Expected development or packaged');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only macOS arm64 is qualified');
const reports = path.join(root, 'test-results');
fs.mkdirSync(reports, { recursive: true });
const report = path.join(reports, `${phase}-${Date.now()}.json`);
// Do not require('electron') here: recent packages download binaries lazily.
// Test execution must not silently provision a runtime from the network.
const executable = phase === 'development'
  ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(root, 'out/mac-arm64/FocusBaeQualification.app/Contents/MacOS/FocusBaeQualification');
if (!fs.existsSync(executable)) throw new Error('Runtime missing; run setup:electron or package explicitly before testing');
const args = phase === 'development' ? [root] : [];
args.push(`--report=${report}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const child = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (child.error) console.error(child.error);
if (fs.existsSync(report)) {
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  console.log(`Report: ${report}`);
  process.exitCode = child.status === 0 && result.ok === true ? 0 : 1;
} else {
  console.error('No completed qualification report');
  process.exitCode = 1;
}
