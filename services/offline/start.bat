@echo off
:: Start WhisperLiveKit + offline service as two independent processes.
:: WHL_MODEL env var controls the model (default: distil-large-v3, ~1.5 GB download on first run).

setlocal
set "ROOT=%~dp0"
set "PYTHON=%ROOT%.venv\Scripts\python.exe"
set "UVICORN=%ROOT%.venv\Scripts\uvicorn.exe"

if not exist "%PYTHON%" (
    echo ERROR: venv not found. Run: cd services/offline && python -m venv .venv && pip install -e .
    exit /b 1
)

if not defined WHL_MODEL set WHL_MODEL=distil-large-v3

echo [offline] Starting WhisperLiveKit (model: %WHL_MODEL%) on port 9090...
start "WhisperLiveKit" cmd /k ""%PYTHON%" -m whisper_live.server --port 9090 --backend faster_whisper"

echo [offline] Waiting 3 s for WHL to initialise socket...
timeout /t 3 /nobreak >nul

echo [offline] Starting offline service on port 8000...
"%UVICORN%" app.main:app --host 0.0.0.0 --port 8000 --reload --app-dir "%ROOT%"
