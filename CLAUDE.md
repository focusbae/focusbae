# CLAUDE.md

Guidance for coding agents working in this repository.

FocusBae is a local-first Electron app for macOS: notes, meeting recording with
on-device transcription, and a ledger of commitments (who owes what to whom, with the
exact quote). The one rule every change must keep: **nothing leaves the Mac unless the
user turns it on**, and Strict Local blocks even that.

## Commands

- Run: `npm start` (builds the Swift helpers and the Vite UI, then `electron .`)
- Unit tests: `npm test`
- Zero-network startup proof: `npm run test:local:network`
- Electron end-to-end: `npm run test:local:e2e`
- Packaged-app check: `npm run verify:local:package`
- Release build: `npm run dist` (uses `scripts/release-candidate.config.cjs`; bump
  `version` in `package.json` first, `electron-updater` gates on it)

Requires an Apple Silicon Mac, macOS 26+, Xcode 26+ and Node.js 22.

## Layout

- `local-first-main.js`: main process entry (tray, menus, shortcuts, updates).
  `workspace-window.js` / `workspace-preload.js`: the workspace window and its IPC.
- `desktop-ui/src/`: React + TipTap renderer, built with Vite into `desktop-ui/dist/`.
- `workspace/`: SQLite storage, migrations, notes, folders, links, actions, people,
  restatements, search, backup, imports. `workspace/domain.js` holds the action data
  model; read `docs/CONTRACTS.md` before changing it.
- `recording/`: capture service, durable audio spool, speech, diarization, playback.
- `meeting-capture/`: segmenter, system-audio source, the Apple speech helper source.
- `local-ai/`: Swift helpers for Apple Foundation Models extraction, embeddings and
  FluidAudio speaker detection, plus their JS runtimes.
- `privacy/local-*.js`: the local network policy and Strict Local.
- `update/local-updater.js`: user-initiated in-app updates.
- `tests/`, `qualification/`: tests and model/runtime qualification harnesses.
- `docs/`: contracts, architecture decisions, benchmarks and the release process.

## Rules

- Do not add a network call without an off-by-default setting and a test proving
  nothing is sent while it is off or in Strict Local (`tests/privacy/`).
- AI output is a proposal shown with its source; it never acts on the user's behalf.
- Schema changes need a migration and must survive backup/restore.
- `scripts/release-candidate.config.cjs` lists exactly what ships; a new runtime file
  must be added there, and `scripts/audit-local-release.cjs` checks the package.
- Planned work lives in GitHub issues; record new architecture decisions in `docs/decisions/`.
