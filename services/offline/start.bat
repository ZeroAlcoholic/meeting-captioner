@echo off
setlocal
set "PYTHON=C:\Programs\miniforge3\envs\deve\python.exe"
set "ROOT=%~dp0"

if not defined WHL_MODEL set WHL_MODEL=distil-large-v3

echo [WHL] Starting WhisperLiveKit (%WHL_MODEL%) on :9090...
start "WhisperLiveKit :9090" cmd /k ""%PYTHON%" -m whisper_live.server --port 9090 --backend faster_whisper"

timeout /t 3 /nobreak >nul

echo [API] Starting offline service on :8000...
"%PYTHON%" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --app-dir "%ROOT%"
