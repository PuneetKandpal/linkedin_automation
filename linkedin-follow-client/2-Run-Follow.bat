@echo off
REM Double-click to run.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
node cli\li-follow.js %*
echo.
echo Finished.
pause
