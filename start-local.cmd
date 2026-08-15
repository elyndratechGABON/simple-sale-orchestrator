@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
echo.
echo (pressez une touche pour fermer)
pause >nul
