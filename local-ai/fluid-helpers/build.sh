#!/usr/bin/env bash
# Builds the FluidAudio helpers: speaker diarization and optional Parakeet English
# transcription (Apple Silicon, Swift 6). Missing binaries mean those features are
# unavailable; nothing else depends on them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../bin"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "FluidAudio helpers require Apple Silicon; not built."
  exit 0
fi
if ! xcrun swift --version 2>/dev/null | grep -qE 'Swift version ([6-9]|[1-9][0-9])\.'; then
  echo "Swift 6 not found; FluidAudio helpers not built."
  exit 0
fi

mkdir -p "$OUT_DIR"
(cd "$HERE" && xcrun swift build -c release --product focusbae-diarize \
  && xcrun swift build -c release --product focusbae-asr)
for name in focusbae-diarize focusbae-asr; do
  cp "$HERE/.build/release/$name" "$OUT_DIR/$name"
  codesign --force --sign - "$OUT_DIR/$name" 2>/dev/null || true
  echo "built $OUT_DIR/$name"
done
