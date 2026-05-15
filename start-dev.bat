@echo off
title meeting-audio dev (single window)
setlocal enableextensions

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "OFFLINE=%ROOT%\services\offline"
set "LOGS=%ROOT%\logs"

:: --- Python interpreter resolution -------------------------------------------
:: WHL needs the venv that has whisper_live + pyaudiowpatch installed.
:: Offline FastAPI uses the conda env (deve) where uvicorn + heavy deps live.
:: Both can be overridden via env. If the venv is missing, fall back to the conda one.
:: NOTE: paths must NOT contain spaces; concurrently child shells cannot
:: reliably re-quote nested paths through cmd.exe.
if not defined PYTHON_CONDA set "PYTHON_CONDA=C:\Programs\miniforge3\envs\deve\python.exe"
if not defined PYTHON_VENV  set "PYTHON_VENV=%OFFLINE%\.venv\Scripts\python.exe"
if not exist "%PYTHON_VENV%" set "PYTHON_VENV=%PYTHON_CONDA%"
if not defined WHL_MODEL set WHL_MODEL=distil-large-v3

if not exist "%LOGS%" mkdir "%LOGS%"

:: Reject space-containing paths early — shell-quoting through concurrently is unreliable.
echo %PYTHON_CONDA%%PYTHON_VENV%%OFFLINE% | findstr /C:" " >nul
if not errorlevel 1 (
    echo [error] PYTHON_CONDA / PYTHON_VENV / OFFLINE path contains a space.
    echo         Please install Python or check out the repo into a path without spaces,
    echo         or set PYTHON_CONDA / PYTHON_VENV to a space-free location.
    exit /b 1
)

:: --- Free dev ports (silent; ignore failures) --------------------------------
for %%P in (5173 8000 8787 9090) do (
    for /f "tokens=5" %%i in ('netstat -ano 2^>nul ^| findstr ":%%P "') do (
        taskkill /PID %%i /F >nul 2>&1
    )
)

echo.
echo  meeting-audio dev launcher
echo  --------------------------
echo   web      http://localhost:5173
echo   online   http://localhost:8787/healthz
echo   offline  http://localhost:8000/healthz
echo   whl      ws://localhost:9090
echo.
echo   Streamed below in this single console. Ctrl+C stops every service.
echo.

call npx --yes concurrently --kill-others --names web,online,whl,offline ^
  --prefix-colors blue.bold,green.bold,magenta.bold,yellow.bold ^
  "pnpm --filter @meeting-audio/web dev" ^
  "pnpm --filter @meeting-audio/online dev" ^
  "%PYTHON_VENV% %OFFLINE%\run_whl.py" ^
  "%PYTHON_CONDA% -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --app-dir %OFFLINE%"

endlocal
