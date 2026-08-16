@echo off
REM MIDNIGHT MIRROR. Double-click this on the machine driving the projector.
REM
REM That machine is also the server: phones reach it over the venue wifi. There is NO
REM CAMERA anywhere in this build, so no secure context is needed and the whole
REM installation runs on plain http with NO INTERNET. Do not open the html files
REM directly, they load ES modules and need a real origin.
setlocal
title MIDNIGHT MIRROR
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found. Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8400 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo   Starting the mirror server...
  start "MIDNIGHT MIRROR server" /min node server.mjs 8400
  timeout /t 2 /nobreak >nul
) else (
  echo   Server already running on 8400.
)

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

REM The flags matter: fake-ui auto-grants the mic and camera (the venue machine will
REM never show a permission prompt over the projection), autoplay-policy lets the
REM AudioContext start without a click. The mic makes the room dance with the music.
if defined CHROME (
  start "" "%CHROME%" --kiosk --start-fullscreen --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream "http://localhost:8400/mirror"
) else (
  start "" "http://localhost:8400/mirror"
)

echo.
echo   MIRROR is on the projector.
echo   Staff page:  http://localhost:8400/admin    key: midnight2026
echo.
echo   PHONES: the server window lists the address to put on the QR cards.
echo   They must be on the same wifi as this machine. No internet needed.
echo.
echo   R!OT WALL runs on 8300 on the other floor. Different machine, different port,
echo   so the two never collide.
echo.
echo   TO STOP: close this window AND the minimized "MIDNIGHT MIRROR server" window.
echo.
pause
