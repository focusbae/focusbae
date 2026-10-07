# #!/usr/bin/env bash
# set -euo pipefail

# APP="dist/mac-arm64/FocusBae.app"
# IDENTITY="D2C9879E2D541D497E5DAB04F5386C9283C70556"   # update if different
# ENT="build/entitlements.mac.plist"

# echo "1) Check signing identity(s) on this mac:"
# security find-identity -v -p codesigning || true
# echo
# echo "Make sure the hex above contains: $IDENTITY"
# echo

# # quick sanity: top-level attrs cleaned (if not, remove them first)
# echo "2) Ensure no FinderInfo/fileprovider/quarantine attributes remain on top-level"
# xattr -d com.apple.FinderInfo "$APP" 2>/dev/null || true
# xattr -d 'com.apple.fileprovider.fpfs#P' "$APP" 2>/dev/null || true
# xattr -cr "$APP" 2>/dev/null || true
# dot_clean -m "$APP" 2>/dev/null || true
# chflags -R nouchg,noschg "$APP" 2>/dev/null || true

# echo "3) Find and sign nested bundles and frameworks"
# # sign nested .app bundles and .framework directories first (helpers & frameworks)
# find "$APP" -type d \( -name "*.app" -o -name "*.framework" \) -print0 | while IFS= read -r -d '' target; do
#   echo " -> Signing bundle/framework: $target"
#   codesign --remove-signature "$target" 2>/dev/null || true
#   codesign --sign "$IDENTITY" --force --timestamp --options runtime --entitlements "$ENT" --deep "$target" || {
#     echo "!! ERROR signing $target"; codesign --verify --verbose=4 "$target" || true; exit 2;
#   }
#   codesign --verify --verbose=4 "$target" || { echo "!! Verify failed for $target"; exit 3; }
# done

# echo "4) Find and sign all executables and native libs (Mach-O, .dylib, .so, .node)"
# # sign Mach-O executables and libraries under Contents/MacOS and any .dylib/.so/.node
# find "$APP" -type f \( -path "*/Contents/MacOS/*" -o -name "*.dylib" -o -name "*.so" -o -name "*.node" \) -print0 | while IFS= read -r -d '' obj; do
#   echo " -> Signing code-object: $obj"
#   # only sign if it's a code object (file might be plain resource)
#   file "$obj" 2>/dev/null | grep -qi 'mach-o\|shared library\|executable' || { echo "    (skipping, not a mach-o/so): $obj"; continue; }
#   codesign --remove-signature "$obj" 2>/dev/null || true
#   codesign --sign "$IDENTITY" --force --timestamp --options runtime --entitlements "$ENT" "$obj" || {
#     echo "!! ERROR signing $obj"; codesign --verify --verbose=4 "$obj" || true; exit 4;
#   }
#   codesign --verify --verbose=4 "$obj" || { echo "!! Verify failed for $obj"; exit 5; }
# done

# echo "5) Sign the Electron Framework resources (just in case)"
# FRAMEWORK="$APP/Contents/Frameworks/Electron Framework.framework"
# if [ -d "$FRAMEWORK" ]; then
#   echo " -> Signing $FRAMEWORK"
#   codesign --remove-signature "$FRAMEWORK" 2>/dev/null || true
#   codesign --sign "$IDENTITY" --force --timestamp --options runtime --entitlements "$ENT" --deep "$FRAMEWORK" || { echo "!! ERROR signing framework"; exit 6; }
#   codesign --verify --verbose=4 "$FRAMEWORK" || { echo "!! Verify failed for framework"; exit 7; }
# fi

# echo "6) Sign the top-level .app bundle"
# codesign --remove-signature "$APP" 2>/dev/null || true
# codesign --sign "$IDENTITY" --force --timestamp --options runtime --entitlements "$ENT" --deep "$APP" || {
#   echo "!! ERROR signing top-level app"; codesign --verify --verbose=4 "$APP" || true; exit 8;
# }

# echo "7) Verify the top-level app and run Gatekeeper check"
# codesign --verify --deep --strict --verbose=4 "$APP" || { echo "!! codesign verify failed for top-level app"; exit 9; }
# spctl -a -v "$APP" || { echo "!! spctl assessment failed"; exit 10; }

# echo
# echo "SUCCESS: All nested code objects signed and top-level app verified."


#!/usr/bin/env bash
set -euo pipefail

APP="dist/mac-arm64/FocusBae.app"
IDENTITY="D2C9879E2D541D497E5DAB04F5386C9283C70556"
ENT="build/entitlements.mac.plist"

echo "STEP A — list every file/dir that currently has any xattrs (this should be short)"
find "$APP" -print0 | while IFS= read -r -d '' f; do
  keys=$(xattr -l "$f" 2>/dev/null | awk -F: '{print $1}' | uniq | tr '\n' ' ')
  if [ -n "$keys" ]; then
    echo "==HAS-XATTR== $f"
    echo "$keys"
    echo
  fi
done

echo "STEP B — defensively remove common problematic attrs everywhere (idempotent)"
# remove specific known bad keys first
find "$APP" -print0 | while IFS= read -r -d '' f; do
  xattr -d com.apple.FinderInfo "$f" 2>/dev/null || true
  xattr -d com.apple.ResourceFork "$f" 2>/dev/null || true
  xattr -d com.apple.quarantine "$f" 2>/dev/null || true
  xattr -d 'com.apple.fileprovider.fpfs#P' "$f" 2>/dev/null || true
  # remove any com.apple.cs* keys left (code-signature leftovers)
  xattr -l "$f" 2>/dev/null | awk -F: '{print $1}' | grep -E '^com.apple.cs' 2>/dev/null | while read -r k; do
    xattr -d "$k" "$f" 2>/dev/null || true
  done
done

echo "STEP C — final cleanup sweep"
dot_clean -m "$APP" 2>/dev/null || true
xattr -cr "$APP" 2>/dev/null || true
chflags -R nouchg,noschg "$APP" 2>/dev/null || true

echo "STEP D — re-run the 'has xattr' scanner (should print nothing)"
find "$APP" -print0 | while IFS= read -r -d '' f; do
  keys=$(xattr -l "$f" 2>/dev/null | awk -F: '{print $1}' | uniq | tr '\n' ' ')
  if [ -n "$keys" ]; then
    echo "==STILL-HAS-XATTR== $f"
    echo "$keys"
    echo
  fi
done

echo "STEP E — ensure bin is executable and try signing the whole app"
find "$APP" -path "*/Contents/MacOS/*" -type f -exec chmod 755 {} \; 2>/dev/null || true

codesign --remove-signature "$APP" 2>/dev/null || true
codesign --sign "$IDENTITY" --force --timestamp --options runtime --entitlements "$ENT" --deep "$APP" || {
  echo "CODESIGN FAILED — printing verbose verify output below:"
  codesign --verify --verbose=4 "$APP" 2>&1 || true
  exit 1
}

echo "STEP F — final verify"
codesign --verify --deep --strict --verbose=4 "$APP" || true
spctl -a -v "$APP" || true

echo "DONE"
