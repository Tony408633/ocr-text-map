@echo off
title PaperPal - Public Tunnel (any network)
cd /d "%~dp0"
for /d %%D in ("%~dp0*") do (
  if exist "%%D\start-tunnel.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%%D\start-tunnel.ps1" %*
    if errorlevel 1 pause
    exit /b
  )
)
echo Could not find backend\start-tunnel.ps1
pause
