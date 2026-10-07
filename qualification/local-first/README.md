# LF-00 Qualification Fixture

Private test application, not the new FocusBae desktop. Production packaging
excludes `qualification/`. Installing here does not replace root dependencies,
change app startup/auth, migrate user data, or download AI models.

Targets macOS arm64 only. Dependencies and the separate
lockfile pin Electron, SQLite, sqlite-vec, React/TipTap and Vite. The `node` dev
dependency supplies an isolated Node LTS binary to npm scripts.

## Reproduce

From this directory:

```bash
npm ci --cache /private/tmp/focusbae-lf00-npm-cache
npm run setup:electron
npm run build
npm test
npm run package
npm run test:packaged
```

Installation/runtime provisioning may download packages. better-sqlite3 13 ships
Node-API prebuilds; this fixture uses its bundled darwin-arm64 native module, not
an Electron-ABI-specific rebuild. Requalify this when changing binding versions.
Electron tests need permission to launch a Mac GUI process, even though the
fixture window is hidden. `package` creates an **unsigned** arm64 `.app` under
`out/`, never a release/DMG and never publishes. No production version bump is
required for this independent 0.0.0 fixture.

Each run writes a unique report under ignored `test-results/` and uses a new
temporary `focusbae-lf00-profile-*` directory with synthetic data only. Temporary
profiles are retained for diagnosis; no existing user profile is read or removed.
The fixture denies renderer network/permission requests, starts no recording,
requests no model, invokes no real keyboard/mouse action, and does not load the
production entry point or `.env`. This is not a process-level egress audit.

## What It Checks

- SQLite native load, WAL/FULL/fullfsync, transaction rollback, foreign keys,
  optimistic-write primitive, FTS5 rebuild, active-WAL backup and connection reopen.
- sqlite-vec native extension, cosine KNN, filter-before-top-k, wrong dimensions,
  delete/rollback with long text metadata, vector backup/reopen and a deterministic
  10,000 x 384-dimension numeric-vector timing probe.
- nut-js native load and AudioTee `--help` only (Whisper was probed here in LF-00 and
  removed from the product on 2026-09-17). Actual speech,
  capture, permissions, screen sharing and keyboard behavior are not tested.
- Bundled React/TipTap mounts under sandbox/context isolation, round-trips a
  structured fixture and an edit, with no Node globals or dev server/CDN.
- Repeat from an asar-packaged application with native extensions unpacked.

Numeric vectors do not establish meaning-based search accuracy. Connection reopen
is not a power-loss or kill/restart durability test. An unsigned app is not a
notarized offline installation. Root `npm test` remains the existing fast suite.
See `docs/decisions/SEARCH_RESEARCH.md` and LF-00 evidence for remaining gates.
