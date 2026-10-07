# Contributing

Thanks for helping. FocusBae is a local-first Mac app, so every change has to keep
one promise: **nothing leaves the Mac unless the user turns it on.**

## Before you start

- Open an issue or a [Discord](https://discord.gg/vWugF4Rreb) thread for anything
  bigger than a small fix, so we can agree on the approach first.
- Read [`docs/CONTRACTS.md`](docs/CONTRACTS.md) for the data model and
  [`docs/decisions/`](docs/decisions/) for why things are built the way they are.
- Planned work is in [GitHub issues](https://github.com/focusbae/focusbae/issues).
  Comment on one before starting so two people don't build the same thing.

## Build and test

Requirements: Apple Silicon Mac, macOS 26 or later, Xcode 26 or later (the Swift
helpers for speech, extraction and embeddings are compiled by `npm start`), Node.js 22.

```bash
npm install
npm start            # builds the Swift helpers and the UI, then opens the app
npm test             # unit tests
npm run test:local:network   # proves startup makes no network connections
npm run test:local:e2e       # end-to-end tests in Electron
```

## Branches and releases

- **`main`** is always releasable. Changes land through pull requests only; CI
  (`npm test` and the release configuration tests) must pass. No force pushes.
- Work on a branch named for the change, for example `fix/mic-device-change` or
  `feat/meeting-detection`, and open a pull request into `main`. Use
  `Closes #<issue>` in the description.
- **`release/X.Y`** branches (for example `release/1.4`) are cut from `main` by a
  maintainer for each release. Only fixes for that release go there, by pull
  request. Signed and notarized builds run only from release branches.
- Each public release is tagged `vX.Y.Z` on its release branch.

## Rules for changes

- **No new network calls** without an explicit, off-by-default setting, and a test
  showing nothing is sent while it is off or in Strict Local.
- **AI output stays a suggestion.** It is shown with its source and needs the user
  to accept it; nothing is sent or done on someone's behalf.
- **Keep user data safe.** Schema changes need a migration and must survive
  backup/restore.
- Match the surrounding code style. Add or update tests with every change.

By contributing, you agree your contribution is licensed under the
[MIT License](LICENSE).
