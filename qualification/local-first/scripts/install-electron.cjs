const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/electron/install.js')], {
  cwd: root,
  env: { ...process.env, electron_config_cache: path.join(root, '.cache/electron') },
  stdio: 'inherit',
  timeout: 600000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status === 0 ? 0 : 1;
