@echo off
title meeting-audio online-only dev (web + online)
setlocal enableextensions

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

:: Online-only dev launcher. Skips offline FastAPI and WhisperLiveKit so
:: startup drops from ~30s (WHL model load dominates) to ~5s. Use this when
:: testing the OpenAI Realtime path; switch to start-dev.bat when you need
:: to exercise Full Offline / Hybrid Privacy modes.

:: --- Free dev ports (silent; ignore failures) --------------------------------
for %%P in (5173 8787) do (
    for /f "tokens=5" %%i in ('netstat -ano 2^>nul ^| findstr ":%%P "') do (
        taskkill /PID %%i /F >nul 2>&1
    )
)

echo.
echo  meeting-audio online-only dev launcher
echo  --------------------------------------
echo   web      http://localhost:5173
echo   online   http://localhost:8787/healthz
echo.
echo   Skipped: WhisperLiveKit + offline FastAPI (use start-dev.bat for those).
echo   Streamed below in this single console. Ctrl+C stops every service.
echo.

:: Use pnpm exec (not npx) so the launcher hits the locally-installed
:: concurrently and doesn't trip the npm warnings about pnpm-only .npmrc
:: keys (node-linker / strict-peer-dependencies / auto-install-peers).
call pnpm exec concurrently --kill-others --names web,online ^
  --prefix-colors blue.bold,green.bold ^
  "pnpm --filter @meeting-audio/web dev" ^
  "pnpm --filter @meeting-audio/online dev"

endlocal
