@echo off
cd /d "%~dp0"
call npm install || pause & exit /b 1
call npm run dist:win || pause & exit /b 1
echo.
echo Installer created in the release folder.
pause
