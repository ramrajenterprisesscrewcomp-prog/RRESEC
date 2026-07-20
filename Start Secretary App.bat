@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies - first time only, please wait...
  call npm install
)
echo.
echo Starting Appointment Secretary... keep this window open.
echo Open http://localhost:3010 in your browser.
echo.
node server.js
pause
