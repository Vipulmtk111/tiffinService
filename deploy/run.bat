@echo off
REM Double-click this to update + start the Tiffin Bot and Cloudflare tunnel.
REM It just runs run.ps1 (in the same folder) with the execution policy bypassed.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run.ps1"
echo.
echo (launcher finished - press a key to close this window)
pause >nul
