#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Apple embeddings are unavailable on this platform; Search will use exact words."
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "Swift compiler not found; Search will use exact words in development."
  exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../bin"
OUT="$OUT_DIR/focusbae-embed"
SRC="$HERE/Sources/main.swift"
TARGET_VERSION="11.0"
export CLANG_MODULE_CACHE_PATH="${TMPDIR:-/tmp}/focusbae-clang-modules"
export SWIFT_MODULECACHE_PATH="$CLANG_MODULE_CACHE_PATH"

mkdir -p "$OUT_DIR"

build_arch() {
  local arch="$1"
  swiftc -O \
    -target "${arch}-apple-macos${TARGET_VERSION}" \
    -framework NaturalLanguage \
    -o "$OUT_DIR/.focusbae-embed-$arch" \
    "$SRC"
}

echo "building arm64"; build_arch arm64
echo "building x86_64"; build_arch x86_64
lipo -create \
  "$OUT_DIR/.focusbae-embed-arm64" \
  "$OUT_DIR/.focusbae-embed-x86_64" \
  -output "$OUT"
rm -f "$OUT_DIR/.focusbae-embed-arm64" "$OUT_DIR/.focusbae-embed-x86_64"
chmod +x "$OUT"
codesign --force --sign - "$OUT" 2>/dev/null || true
lipo -info "$OUT"
