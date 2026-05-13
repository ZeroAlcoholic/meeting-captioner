@echo off
title Meeting Audio — Dev Launcher
echo.
echo  ==========================================
echo   Meeting Audio - Starting Dev Services
echo  ==========================================
echo.

:: services/offline  (Port 8000 — FastAPI + WhisperLive on 9090)
start "Offline STT/MT :8000" cmd /k "cd /d C:\Develop\meeting_audio\services\offline && echo [Offline Service] Starting... && .venv\Scripts\uvicorn.exe app.main:app --host 0.0.0.0 --port 8000"

:: services/online  (Port 8787 — Fastify + OpenAI session broker)
start "Online Service :8787" cmd /k "cd /d C:\Develop\meeting_audio\services\online && echo [Online Service] Starting... && pnpm dev"

:: apps/web  (Port 5173 — Vite dev server)
start "Web UI :5173" cmd /k "cd /d C:\Develop\meeting_audio && echo [Web UI] Starting... && pnpm --filter @meeting-audio/web dev"

echo.
echo  3 windows opened. Wait ~60s for Whisper model to load.
echo.
echo  Web UI   : http://localhost:5173
echo  Offline  : http://localhost:8000/healthz
echo  Online   : http://localhost:8787/healthz
echo.
echo  Full Offline path:
echo    Settings ^> Scenario: Physical Meeting
echo    Settings ^> Mode: Full Offline
echo    Wait for [Start Offline] button to enable
echo    Click [Start Offline] ^> allow microphone ^> speak English
echo.
pause
