#!/bin/bash
# Build platform installers for Nebula Agent Client
set -e
cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Building installers for nebula-agent v${VERSION}"

rm -rf dist/staging dist/*.pkg dist/*.bat
mkdir -p dist/staging/nebula-agent dist/scripts

# Copy source files to staging
cp -r package.json package-lock.json index.js lib dist/staging/nebula-agent/

# === macOS .pkg ===
echo ""
echo "=== Building macOS .pkg ==="

# Post-install script — runs after .pkg extracts files
cat > dist/scripts/postinstall << 'POSTINSTALL'
#!/bin/bash
INSTALL_DIR="/usr/local/lib/nebula-agent"
cd "$INSTALL_DIR"

# Install deps
/usr/bin/env npm install --production 2>/dev/null || /usr/local/bin/npm install --production

# Create symlink
ln -sf "$INSTALL_DIR/index.js" /usr/local/bin/nebula-agent
chmod +x "$INSTALL_DIR/index.js"

echo "nebula-agent installed to /usr/local/bin/nebula-agent"
POSTINSTALL
chmod +x dist/scripts/postinstall

# Build .pkg
pkgbuild \
  --root dist/staging/nebula-agent \
  --install-location /usr/local/lib/nebula-agent \
  --scripts dist/scripts \
  --identifier com.nebula.agent-client \
  --version "$VERSION" \
  "dist/nebula-agent-${VERSION}-macos.pkg"

echo "Created dist/nebula-agent-${VERSION}-macos.pkg"

# === Windows install script ===
echo ""
echo "=== Building Windows installer ==="

cat > "dist/nebula-agent-${VERSION}-windows-install.bat" << 'WINBAT'
@echo off
title Nebula Agent Client Installer
echo ==============================
echo  Nebula Agent Client Installer
echo ==============================
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is required. Download from https://nodejs.org/
    echo Install Node.js 20+ and run this installer again.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo Found Node.js %NODE_VER%

:: Set install directory
set INSTALL_DIR=%USERPROFILE%\.nebula-agent-client
echo Installing to %INSTALL_DIR%...

:: Create directory and copy files
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
xcopy /E /Y /Q "%~dp0nebula-agent\*" "%INSTALL_DIR%\" >nul

:: Install dependencies
cd /d "%INSTALL_DIR%"
call npm install --production
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

:: Link globally
call npm link
if %ERRORLEVEL% neq 0 (
    echo WARNING: npm link failed. You can run directly: node %INSTALL_DIR%\index.js
)

echo.
echo ==============================
echo  Installation complete!
echo ==============================
echo.
echo Next steps:
echo   1. In Nebula UI: Agent Settings ^> Remote ^> Generate Token
echo   2. nebula-agent register --server http://YOUR-NAS:8090 --agent-id ID --token TOKEN
echo   3. nebula-agent start
echo.
pause
WINBAT

# Copy source alongside the bat for Windows
mkdir -p "dist/nebula-agent-${VERSION}-windows"
cp "dist/nebula-agent-${VERSION}-windows-install.bat" "dist/nebula-agent-${VERSION}-windows/"
cp -r dist/staging/nebula-agent "dist/nebula-agent-${VERSION}-windows/"

# Zip the Windows installer
(cd dist && zip -r "nebula-agent-${VERSION}-windows.zip" "nebula-agent-${VERSION}-windows")

echo "Created dist/nebula-agent-${VERSION}-windows.zip"

# Cleanup
rm -rf dist/staging dist/scripts dist/nebula-agent-${VERSION}-windows "dist/nebula-agent-${VERSION}-windows-install.bat"

echo ""
echo "=== Done ==="
ls -lh dist/
