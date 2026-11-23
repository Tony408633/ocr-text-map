@echo off
title PaperPal - Phone Test Mode (HTTPS)
cd /d "%~dp0"
for /d %%D in ("%~dp0*") do (
  if exist "%%D\start-phone.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%%D\start-phone.ps1" %*
    if errorlevel 1 pause
    exit /b
  )
)
echo Could not find backend\start-phone.ps1
pause
