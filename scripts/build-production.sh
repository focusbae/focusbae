#!/usr/bin/env bash
# Private signed candidate only. No publication or update activation.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${APPLE_API_KEY:?Path to notary API key outside the repository required}"
: "${APPLE_API_KEY_ID:?Notary key ID required}"
: "${APPLE_API_ISSUER:?Notary issuer required}"
test -f "$APPLE_API_KEY"
if ! security find-identity -v -p codesigning | grep -q 'Developer ID Application'; then
  echo "Install a valid Developer ID Application identity first." >&2
  exit 1
fi
unset FOCUSBAE_UNSIGNED_CANDIDATE
npm run build:workspace
./node_modules/.bin/electron-builder --config scripts/release-candidate.config.cjs --mac --publish never
APP="out/release-signed/mac-arm64/FocusBae.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvv "$APP" 2>&1 | grep 'Authority=Developer ID Application'
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
echo "Signed, notarized Apple Silicon candidate verified. Publication remains paused."
