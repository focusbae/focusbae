#!/usr/bin/env bash
#
# Build the on-device transcription helper.
#
# REQUIRES macOS 26 SDK. SpeechAnalyzer/SpeechTranscriber do not exist in earlier
# SDKs, so this cannot be built on an older machine -- run it on a macOS 26 box (or
# CI image) with a matching Xcode. Without this binary the app cannot transcribe
# on macOS 26+ except through the optional Parakeet download.
#
# Produces a universal binary at meeting-capture/bin/focusbae-transcribe.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../bin"
OUT="$OUT_DIR/focusbae-transcribe"
SRC="$HERE/Sources/main.swift"

# Deployment target must be 26: the binary refuses to launch on older systems, which
# is the correct behaviour -- the JS side already gates on os.release() and would
# never invoke it there anyway, but a hard guarantee beats two agreeing guesses.
TARGET_VERSION="26.0"

mkdir -p "$OUT_DIR"

if ! xcrun --sdk macosx --show-sdk-version 2>/dev/null | grep -qE '^(2[6-9]|[3-9][0-9])'; then
  echo "error: macOS 26 SDK or newer required (found $(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo none))" >&2
  echo "       SpeechAnalyzer is unavailable in earlier SDKs. Without this helper the" >&2
  echo "       app transcribes only through the optional Parakeet download." >&2
  exit 1
fi

build_arch() {
  local arch="$1"
  swiftc -O -parse-as-library \
    -target "${arch}-apple-macos${TARGET_VERSION}" \
    -framework Speech -framework AVFoundation \
    -o "$OUT_DIR/.focusbae-transcribe-$arch" \
    "$SRC"
}

echo "building arm64…"; build_arch arm64
echo "building x86_64…"; build_arch x86_64

lipo -create \
  "$OUT_DIR/.focusbae-transcribe-arm64" \
  "$OUT_DIR/.focusbae-transcribe-x86_64" \
  -output "$OUT"
rm -f "$OUT_DIR/.focusbae-transcribe-arm64" "$OUT_DIR/.focusbae-transcribe-x86_64"

chmod +x "$OUT"
# Ad-hoc sign so it runs during development; electron-builder re-signs for release.
codesign --force --sign - "$OUT" 2>/dev/null || true

echo "built $OUT"
lipo -info "$OUT"
