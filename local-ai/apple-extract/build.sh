#!/usr/bin/env bash
# Builds the on-device extraction helper. Requires the macOS 26 SDK or newer
# (FoundationModels). A missing binary means local model extraction is
# unavailable and the rule baseline remains in use.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../bin"
OUT="$OUT_DIR/focusbae-extract"

if [[ "$(uname -s)" != "Darwin" ]] || ! xcrun --sdk macosx --show-sdk-version 2>/dev/null | grep -qE '^(2[6-9]|[3-9][0-9])'; then
  echo "macOS 26 SDK not found; on-device extraction helper not built."
  exit 0
fi

mkdir -p "$OUT_DIR"
xcrun swiftc -O -parse-as-library \
  -target arm64-apple-macos26.0 \
  -framework FoundationModels \
  -o "$OUT" "$HERE/Sources/main.swift"
codesign --force --sign - "$OUT" 2>/dev/null || true
echo "built $OUT"
