@echo off
REM Double-click to run.
cd /d "%~dp0"
REM In a client package this file sits next to cli\; in the repository it is two folders down.
if not exist cli\li-generate.js cd ..\..
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
for /f %%v in ('node -p "parseInt(process.versions.node)"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo This tool needs Node.js 22 or newer. Install the LTS version from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
node cli\li-generate.js %*
echo.
echo Finished.
pause
