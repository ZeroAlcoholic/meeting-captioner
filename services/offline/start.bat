@echo off
title offline (whl + fastapi, single window)
setlocal enableextensions

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "REPO_ROOT=%ROOT%\..\.."

if not defined PYTHON_CONDA set "PYTHON_CONDA=C:\Programs\miniforge3\envs\deve\python.exe"
if not defined PYTHON_VENV  set "PYTHON_VENV=%ROOT%\.venv\Scripts\python.exe"
if not exist "%PYTHON_VENV%" set "PYTHON_VENV=%PYTHON_CONDA%"
if not defined WHL_MODEL set WHL_MODEL=distil-large-v3

:: NOTE: no space before `|` — cmd would echo it and findstr would false-positive.
echo %PYTHON_CONDA%%PYTHON_VENV%%ROOT%|findstr /C:" " >nul
if not errorlevel 1 (
    echo [error] python or offline path contains a space; concurrently cannot quote it.
    exit /b 1
)

cd /d "%REPO_ROOT%"

echo.
echo  offline only — WHL :9090  +  FastAPI :8000  (single console)
echo  Ctrl+C stops both.
echo.

call npx --yes concurrently --kill-others --names whl,api ^
  --prefix-colors magenta.bold,yellow.bold ^
  "%PYTHON_VENV% %ROOT%\run_whl.py" ^
  "%PYTHON_CONDA% -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload --app-dir %ROOT%"

endlocal
