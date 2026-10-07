#!/bin/bash
# verify-entitlements.sh
# Verifies that the built FocusBae app has the correct entitlements for Call Mode

set -e

APP_PATH="dist/mac/FocusBae.app"
ERRORS=0

echo "🔍 Verifying FocusBae entitlements..."
echo ""

# Check if app exists
if [ ! -d "$APP_PATH" ]; then
  echo "❌ App not found at $APP_PATH"
  echo "   Run 'npm run dist' first to build the app"
  exit 1
fi

echo "📦 App found at: $APP_PATH"
echo ""

# Extract entitlements
ENTITLEMENTS=$(codesign -d --entitlements - "$APP_PATH/Contents/MacOS/FocusBae" 2>/dev/null)

# Check microphone entitlement
echo "Checking microphone entitlement..."
if echo "$ENTITLEMENTS" | grep -q "com.apple.security.device.audio-input"; then
  echo "✅ Microphone entitlement (com.apple.security.device.audio-input) found"
else
  echo "❌ Microphone entitlement (com.apple.security.device.audio-input) missing"
  ERRORS=$((ERRORS + 1))
fi

# Check screen capture entitlement
echo "Checking screen capture entitlement..."
if echo "$ENTITLEMENTS" | grep -q "com.apple.security.device.screen-capture"; then
  echo "✅ Screen capture entitlement (com.apple.security.device.screen-capture) found"
else
  echo "❌ Screen capture entitlement (com.apple.security.device.screen-capture) missing"
  ERRORS=$((ERRORS + 1))
fi

# Check other important entitlements
echo "Checking other entitlements..."
if echo "$ENTITLEMENTS" | grep -q "com.apple.security.network.client"; then
  echo "✅ Network client entitlement found"
else
  echo "⚠️  Network client entitlement missing (may cause connection issues)"
fi

if echo "$ENTITLEMENTS" | grep -q "com.apple.security.automation.apple-events"; then
  echo "✅ Apple Events entitlement found"
else
  echo "⚠️  Apple Events entitlement missing (may affect automation features)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $ERRORS -eq 0 ]; then
  echo "✅ All required entitlements verified successfully!"
  exit 0
else
  echo "❌ $ERRORS required entitlement(s) missing"
  echo ""
  echo "To fix:"
  echo "1. Check build/entitlements.mac.plist"
  echo "2. Ensure package.json references the entitlements file"
  echo "3. Rebuild with: npm run dist"
  exit 1
fi
