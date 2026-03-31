#!/bin/bash
# Nebula Agent - macOS Build Script
set -e

echo "=========================================="
echo " Nebula Agent - macOS Build Script"
echo "=========================================="
echo

# Check Node.js
if ! command -v node &>/dev/null; then
    echo "[ERROR] Node.js not found."
    echo "Install: brew install node   (or https://nodejs.org/)"
    exit 1
fi
echo "[OK] Node.js $(node -v)"

# Check Rust
if ! command -v rustc &>/dev/null; then
    echo "[ERROR] Rust not found."
    echo "Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi
echo "[OK] $(rustc --version)"

# Navigate to agent-app directory
cd "$(dirname "$0")/.."

echo
echo "[1/3] Installing dependencies..."
npm install

echo
echo "[2/3] Building Tauri app..."
npx tauri build

echo
echo "=========================================="
echo " Build complete!"
echo "=========================================="
echo

DMG=$(find src-tauri/target/release/bundle/dmg -name "*.dmg" 2>/dev/null | head -1)
APP=$(find src-tauri/target/release/bundle/macos -name "*.app" 2>/dev/null | head -1)

if [ -n "$DMG" ]; then
    echo "DMG installer: $DMG"
    echo "  Size: $(du -h "$DMG" | cut -f1)"
fi
if [ -n "$APP" ]; then
    echo "App bundle:    $APP"
fi
echo
echo "Install by opening the .dmg, or drag the .app to /Applications."
