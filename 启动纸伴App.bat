@echo off
cd /d "%~dp0"
for /d %%D in ("%~dp0*") do (
  if exist "%%D\start-app.bat" (
    call "%%D\start-app.bat"
    if errorlevel 1 pause
    exit /b
  )
)
echo Could not find the backend start-app.bat
pause
