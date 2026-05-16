@echo off
setlocal enableextensions
title meeting-audio (online)

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

:: ── Node 22+ check ─────────────────────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [error] Node.js was not found in PATH.
    echo          Install Node 22 or newer from https://nodejs.org, then re-run this script.
    echo.
    pause
    exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (
    echo.
    echo  [error] Node.js %NODE_MAJOR% is too old. Required: 22 or newer.
    echo          Install from https://nodejs.org, then re-run this script.
    echo.
    pause
    exit /b 1
)

:: ── OPENAI_API_KEY check (system env only — no .env file support) ──────
if "%OPENAI_API_KEY%"=="" (
    echo.
    echo  [error] OPENAI_API_KEY is not set in your environment.
    echo.
    echo  This release reads the key from the system/user environment ONLY.
    echo  Pick one of the methods below, then re-run start.bat:
    echo.
    echo    Persistent (recommended) — survives reboots, applies to all new terminals:
    echo      setx OPENAI_API_KEY "sk-proj-..."
    echo      ^(then close this window and double-click start.bat from a NEW window^)
    echo.
    echo    Session only — applies to this terminal until you close it:
    echo      set OPENAI_API_KEY=sk-proj-...
    echo      start.bat
    echo.
    pause
    exit /b 1
)

:: ── Bundle integrity check ─────────────────────────────────────────────
if not exist "%ROOT%\server\dist\server.bundle.cjs" (
    echo.
    echo  [error] server\dist\server.bundle.cjs missing — the release looks incomplete.
    echo          Re-extract the zip; do not move individual files around.
    echo.
    pause
    exit /b 1
)

set "WEB_DIST_PATH=%ROOT%\web"
set "LOG_FORMAT=json"
cd /d "%ROOT%"

echo.
echo  meeting-audio (online)
echo  ----------------------
echo   Open in browser: http://localhost:8787
echo   Press Ctrl+C to stop.
echo.

node server\dist\server.bundle.cjs
endlocal
