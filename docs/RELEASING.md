# Releasing

## Branches

1. Cut `release/X.Y` from `main` (for example `release/1.4`). Only fixes for that
   release go there, by pull request; fixes also land on `main`.
2. Bump `version` in `package.json` on the release branch. `electron-updater` only
   offers versions higher than the installed one.
3. Run the **macOS release** workflow from the release branch. Signed and notarized
   builds run only from `release/*` and need the signing secrets in the repository.
4. After the steps below pass, tag the commit `vX.Y.Z`.

## How updates reach installed apps

The signed Mac app checks for updates only from Settings after a native network
permission prompt. Checking never starts a download. Downloading needs a second
user action and permission prompt. Installation needs a third action and drains
pending workspace edits before restarting. Strict Local blocks both network
steps. No workspace data is part of the update request.

The local-first update channel is deliberately separate from the former app:
`https://pub-f1d20a395b224af7aff8e7b531dbfdae.r2.dev/local/macos/arm64/`.
The packaged app's `Contents/Resources/app-update.yml` must name exactly this
channel. `electron-builder` generates `latest-mac.yml` from the signed ZIP.
The DMG remains the website's first-install artifact; the ZIP is the in-app
update artifact.

For each release:

1. Build and qualify a **Developer ID signed, notarized** candidate. Run the
   release audit, signature, stapler and Gatekeeper checks. Do not publish an
   unsigned candidate or mix metadata from a different build.
2. Inspect the generated `latest-mac.yml`: version, ZIP filename, SHA-512 and
   architecture must match the qualified files. Verify the ZIP and DMG hashes.
3. Upload the signed ZIP and its blockmap to `focusbae-release` at
   `local/macos/arm64/`. Verify both public URLs return the intended bytes.
4. Upload `latest-mac.yml` to the same prefix **last**. It is the switch that
   makes the release visible to installed apps. Verify its public URL and test
   check → download → restart/install from an older signed installation.
5. Only after that test passes, publish the DMG at the website's release URL
   and update the website's version and notes.

The 1.3.0 public app did not contain this updater, so its users need one manual
installer upgrade to the first updater-enabled release. Later versions can be
installed in place. A failed check or download leaves the existing app and
local work intact; keep the previous signed installer available for recovery.

The `Signed macOS in-place update QA` workflow uses two Developer ID signed builds
with a separate `com.focusbae.update-qa` identity and a localhost feed. It
drives Settings through check, download and restart/install, then verifies the
installed bundle is the newer version and still has a valid code signature.
This test never publishes to the production R2 channel or changes a user's
FocusBae installation. Production notarization remains a separate release gate.
