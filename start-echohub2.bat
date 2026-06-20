@echo off
cd /d "%~dp0"
set PORT=3002
echo Starting EchoHub 2 on http://localhost:%PORT%
start "" http://127.0.0.1:%PORT%
npm start
pause
