@echo off
setlocal
cd /d "%~dp0"
node scripts/service.mjs start
exit /b %errorlevel%
