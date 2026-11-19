@echo off
setlocal enableextensions
title meeting-audio (online)
set "ROOT=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [error] Install Node.js 22 or newer from https://nodejs.org
    exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
    echo [error] Node.js 22 or newer is required.
    exit /b 1
)

rem Read credentials inside Node: never expand key values into batch commands.
node -e "process.exit(['OPENAI_API_KEY','OPENAI_API_KEY_AUDIO','GEMINI_API_KEY'].some(name => process.env[name]?.trim()) ? 0 : 1)"
if errorlevel 1 (
    echo [error] No online API key is configured in this process.
    echo Set OPENAI_API_KEY, OPENAI_API_KEY_AUDIO, or GEMINI_API_KEY in your environment.
    echo After changing persistent variables, open a new terminal and restart.
    exit /b 1
)

if not exist "%ROOT%server\dist\server.bundle.cjs" (
    echo [error] server\dist\server.bundle.cjs missing. Re-extract the release.
    exit /b 1
)
set "WEB_DIST_PATH=%ROOT%web"
set "LOG_FORMAT=json"
cd /d "%ROOT%"
node -e "console.log('meeting-audio: http://localhost:' + (process.env.ONLINE_PORT || '8787') + ' - Press Ctrl+C to stop.')"
node server\dist\server.bundle.cjs
exit /b %errorlevel%
