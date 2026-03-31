@echo off
title Nebula Agent - Windows Build
echo ==========================================
echo  Nebula Agent - Windows Build Script
echo ==========================================
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found.
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js %%v

:: Check Rust
where rustc >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Rust not found.
    echo Install from: https://rustup.rs/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('rustc --version') do echo [OK] %%v

:: Check cargo
where cargo >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Cargo not found. Rust installation may be incomplete.
    pause
    exit /b 1
)

:: Navigate to agent-app directory
cd /d "%~dp0.."
echo.
echo [1/3] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
)

echo.
echo [2/3] Building Tauri app (this may take a few minutes on first build)...
call npx tauri build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build failed. Make sure Visual Studio Build Tools are installed.
    echo Download from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo Select "Desktop development with C++" workload.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo  Build complete!
echo ==========================================
echo.

:: Find the MSI
for /r "src-tauri\target\release\bundle\msi" %%f in (*.msi) do (
    echo MSI installer: %%f
    echo.
    echo You can now install it by double-clicking the .msi file,
    echo or upload it to the Gitea release.
)

pause
