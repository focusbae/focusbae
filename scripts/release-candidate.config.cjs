'use strict';
const pkg = require('../package.json');
const unsigned = process.env.FOCUSBAE_UNSIGNED_CANDIDATE === '1';
const qa = process.env.FOCUSBAE_QA_UPDATE === '1';
module.exports = {
  ...pkg.build, extends: null,
  ...(qa ? { appId: 'com.focusbae.update-qa', productName: 'FocusBae Update QA' } : {}),
  // Separate local-first updates from the former connected-app feed.
  publish: [{ provider: 'generic', url: qa ? 'http://127.0.0.1:17832/'
    : 'https://pub-f1d20a395b224af7aff8e7b531dbfdae.r2.dev/local/macos/arm64/' }],
  protocols: [],
  extraMetadata: { main: 'local-first-main.js', ...(qa ? { focusbaeUpdateQa: true } : {}) },
  files: [
    'package.json', 'local-first-main.js', 'workspace-window.js',
    'workspace-preload.js', 'tray-icon.png',
    'desktop-ui/dist/**/*', 'workspace/**/*', 'recording/**/*',
    'meeting-capture/segmenter.js', 'meeting-capture/audio-sources.js',
    'meeting-capture/limits.js', 'meeting-capture/bin/**/*',
    'local-ai/*-runtime.js', 'local-ai/fluid-model.js',
    'local-ai/fluid-helpers/manifests/**/*', 'local-ai/bin/**/*',
    'privacy/local-runtime.js', 'privacy/local-policy.js',
    'privacy/local-network.js', 'privacy/local-electron-session.js',
    'update/local-updater.js',
    '!**/.env*', '!**/*.p12', '!**/*.p8', '!**/*.pem',
    '!**/*.key', '!**/*.keychain*',
  ],
  directories: { output: qa ? 'out/release-update-qa' : unsigned ? 'out/release-unsigned' : 'out/release-signed' },
  forceCodeSigning: !unsigned,
  mac: {
    ...pkg.build.mac,
    // The speech and extraction helpers are built for macOS 26 and refuse to
    // launch below it, and the website promises 26 or later. Homebrew and the
    // Finder both read this value, so it must say the same thing.
    minimumSystemVersion: '26.0',
    entitlements: 'build/entitlements.local.mac.plist',
    entitlementsInherit: 'build/entitlements.local.mac.plist',
    extendInfo: {
      LSUIElement: '1',
      NSAppleEventsUsageDescription: 'Import your notes from Apple Notes into your private FocusBae workspace when you choose Import from Apple Notes in Settings.',
      NSMicrophoneUsageDescription: 'Record your voice into your local workspace when you choose to record.',
      NSAudioCaptureUsageDescription: 'Record system audio into your local workspace when you choose to record.',
    },
    ...(unsigned ? { identity: null } : {}),
    notarize: !unsigned && !qa,
    target: qa ? [{ target: 'zip', arch: ['arm64'] }]
      : [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    ...(qa ? { artifactName: 'FocusBae-Update-QA-${version}-arm64.${ext}' } : {}),
  },
  dmg: { ...pkg.build.dmg, artifactName: qa ? 'FocusBae-Update-QA-${version}-arm64.dmg'
    : 'FocusBae-${version}-arm64.dmg' },
};
