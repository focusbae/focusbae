#!/bin/bash
# verify-info-plist.sh
# Verifies that the built FocusBae app has the correct Info.plist descriptions for Call Mode

set -e

APP_PATH="dist/mac/FocusBae.app"
INFO_PLIST="$APP_PATH/Contents/Info.plist"
ERRORS=0

echo "🔍 Verifying FocusBae Info.plist descriptions..."
echo ""

# Check if app exists
if [ ! -d "$APP_PATH" ]; then
  echo "❌ App not found at $APP_PATH"
  echo "   Run 'npm run dist' first to build the app"
  exit 1
fi

# Check if Info.plist exists
if [ ! -f "$INFO_PLIST" ]; then
  echo "❌ Info.plist not found at $INFO_PLIST"
  exit 1
fi

echo "📦 App found at: $APP_PATH"
echo "📄 Info.plist found at: $INFO_PLIST"
echo ""

# Check NSMicrophoneUsageDescription
echo "Checking NSMicrophoneUsageDescription..."
MIC_DESC=$(/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$INFO_PLIST" 2>/dev/null || echo "")
if [ -n "$MIC_DESC" ]; then
  echo "✅ NSMicrophoneUsageDescription found:"
  echo "   \"$MIC_DESC\""
  
  # Verify it's not empty or generic
  if [ ${#MIC_DESC} -lt 20 ]; then
    echo "⚠️  Description seems too short (less than 20 characters)"
  fi
else
  echo "❌ NSMicrophoneUsageDescription missing"
  ERRORS=$((ERRORS + 1))
fi

echo ""

# Check NSScreenCaptureDescription (macOS 10.15+)
echo "Checking NSScreenCaptureDescription..."
SCREEN_DESC=$(/usr/libexec/PlistBuddy -c "Print :NSScreenCaptureDescription" "$INFO_PLIST" 2>/dev/null || echo "")
if [ -n "$SCREEN_DESC" ]; then
  echo "✅ NSScreenCaptureDescription found:"
  echo "   \"$SCREEN_DESC\""
  
  # Verify it's not empty or generic
  if [ ${#SCREEN_DESC} -lt 20 ]; then
    echo "⚠️  Description seems too short (less than 20 characters)"
  fi
else
  echo "❌ NSScreenCaptureDescription missing"
  ERRORS=$((ERRORS + 1))
fi

echo ""

# Check other relevant descriptions
echo "Checking other usage descriptions..."
APPLE_EVENTS_DESC=$(/usr/libexec/PlistBuddy -c "Print :NSAppleEventsUsageDescription" "$INFO_PLIST" 2>/dev/null || echo "")
if [ -n "$APPLE_EVENTS_DESC" ]; then
  echo "✅ NSAppleEventsUsageDescription found:"
  echo "   \"$APPLE_EVENTS_DESC\""
else
  echo "ℹ️  NSAppleEventsUsageDescription not set (optional)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $ERRORS -eq 0 ]; then
  echo "✅ All required Info.plist descriptions verified successfully!"
  echo ""
  echo "Expected permission prompts:"
  echo "1. Microphone: \"$MIC_DESC\""
  echo "2. Screen Capture: \"$SCREEN_DESC\""
  exit 0
else
  echo "❌ $ERRORS required description(s) missing"
  echo ""
  echo "To fix:"
  echo "1. Check package.json build.mac.extendInfo section"
  echo "2. Add missing NSMicrophoneUsageDescription and/or NSScreenCaptureDescription"
  echo "3. Rebuild with: npm run dist"
  exit 1
fi
