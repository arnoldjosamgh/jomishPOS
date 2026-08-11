@echo off
title Jomish Business Suite - Server
cd /d "%~dp0"
set "APPDIR=%~dp0"

:START
echo [%date% %time%] Starting Jomish Suite server...
REM Always use live node server.js — compiled exe is kept only as dist\*.bak backup
node "%APPDIR%backend\server.js" >> "%APPDIR%data\server.log" 2>&1
set EXIT_CODE=%ERRORLEVEL%
echo [%date% %time%] Server exited with code %EXIT_CODE%.

REM Exit code 0 = intentional restart (e.g. after database restore)
REM Any other exit code = crash — still restart after a short delay
if %EXIT_CODE% == 0 (
    echo Restarting after intentional shutdown (database restore)...
    timeout /t 2 /nobreak >nul
) else (
    echo Unexpected exit. Restarting in 5 seconds...
    timeout /t 5 /nobreak >nul
)

goto START
