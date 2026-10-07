const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only macOS arm64 is qualified');
const root = path.join(__dirname, '..');
build({
  projectDir: root,
  targets: Platform.MAC.createTarget('dir', Arch.arm64),
  publish: 'never',
  config: {
    appId: 'com.focusbae.qualification.localfirst',
    productName: 'FocusBaeQualification',
    electronVersion: '43.7.0',
    electronDist: path.join(root, 'node_modules/electron/dist'),
    directories: { output: 'out' },
    files: ['main.cjs', '*-probe.cjs', 'dist/**/*', 'package.json'],
    asar: true,
    asarUnpack: ['**/*.node', '**/node_modules/sqlite-vec*/**', '**/node_modules/audiotee/**', '**/node_modules/@nut-tree-fork/**'],
    npmRebuild: false,
    forceCodeSigning: false,
    mac: { identity: null, category: 'public.app-category.developer-tools', hardenedRuntime: false },
  },
}).catch((error) => { console.error(error); process.exitCode = 1; });
