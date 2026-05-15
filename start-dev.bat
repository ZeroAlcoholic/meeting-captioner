@echo off
title Dev Launcher
setlocal

set "PYTHON=C:\Programs\miniforge3\envs\deve\python.exe"
set "ROOT=C:\Develop\meeting_audio"
set "OFFLINE=%ROOT%\services\offline"
set "ONLINE=%ROOT%\services\online"
set "LOGS=%ROOT%\logs"
set "VENV_PY=%OFFLINE%\.venv\Scripts\python.exe"
if not defined WHL_MODEL set WHL_MODEL=distil-large-v3

if not exist "%LOGS%" mkdir "%LOGS%"

:: Kill stale ports
for %%P in (5173 8000 8787 9090) do (
    for /f "tokens=5" %%i in (\'netstat -ano 2^>/dev/null ^| findstr ":%%P "\') do (
        taskkill /PID %%i /F >/dev/null 2>/dev/null
    )
)

:: WhisperLiveKit -- uses .venv Python + explicit launcher script
start "WHL :9090" /min cmd /k ""%VENV_PY%" "%OFFLINE%\run_whl.py" 1>>"%LOGS%\whl.log" 2>&1"

:: FastAPI offline -- uses deve conda Python
start "Offline :8000" /min cmd /k "cd /d "%OFFLINE%" && "%PYTHON%" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --app-dir "%OFFLINE%" 1>>"%LOGS%\offline.log" 2>&1"

:: Online Node.js service
start "Online :8787" /min cmd /k "cd /d "%ONLINE%" && pnpm dev 1>>"%LOGS%\online.log" 2>&1"

:: Web UI
start "Web :5173" /min cmd /k "cd /d "%ROOT%" && pnpm --filter @meeting-audio/web dev 1>>"%LOGS%\web.log" 2>&1"

echo.
echo  Services started in separate windows (minimized).
echo  Close this window freely -- services keep running.
echo.
echo  Web      http://localhost:5173
echo  Offline  http://localhost:8000/healthz
echo  Online   http://localhost:8787/healthz
echo.
echo  Logs: %LOGS%echo    whl.log  offline.log  online.log  web.log
echo.
echo  To stop: close the 4 minimized CMD windows, or re-run this file.
pause
