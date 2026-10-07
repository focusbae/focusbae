// scripts/pre-cleanup.js
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

module.exports = async function (context) {
  console.log("[pre-cleanup] Starting pre-build cleanup...");

  try {
    const projectRoot = process.cwd();

    // remove .DS_Store and AppleDouble across project (except node_modules to save time)
    try {
      execSync(`find "${projectRoot}" -name ".DS_Store" -delete 2>/dev/null || true`);
      execSync(`find "${projectRoot}" -name "._*" -delete 2>/dev/null || true`);
      console.log("[pre-cleanup] removed .DS_Store and AppleDouble files");
    } catch (err) {
      console.warn("[pre-cleanup] DS_Store cleanup failed:", err.message);
    }

    // best-effort xattr cleanup on project files (avoid node_modules heavy ops)
    try {
      execSync(`find "${projectRoot}" -type f -not -path "*/node_modules/*" -exec xattr -c {} \\; 2>/dev/null || true`);
      console.log("[pre-cleanup] cleared extended attributes (excluding node_modules)");
    } catch (err) {
      console.warn("[pre-cleanup] xattr cleanup failed:", err.message);
    }

    // Clear electron cache (optional)
    try {
      const electronCache = path.join(os.homedir(), '.cache', 'electron');
      if (fs.existsSync(electronCache)) {
        execSync(`rm -rf "${electronCache}"`);
        console.log("[pre-cleanup] cleared Electron cache");
      }
    } catch (err) {
      console.warn("[pre-cleanup] Electron cache cleanup failed:", err.message);
    }

    console.log("[pre-cleanup] Pre-build cleanup completed");
  } catch (err) {
    console.error("[pre-cleanup] Pre-cleanup failed:", err.message);
  }
};
