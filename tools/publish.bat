@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo.
echo  PaperPal - publish to GitHub Pages
echo  =================================
echo  Needs a GitHub token with "public_repo" scope.
echo  Create one at: https://github.com/settings/tokens
echo.
if "%~1"=="" (
  set /p TOKEN=Paste token: 
) else (
  set TOKEN=%~1
)
if "%TOKEN%"=="" (
  echo No token, aborted.
  pause
  exit /b 1
)
python tools\publish_to_github.py --token "%TOKEN%"
echo.
pause
