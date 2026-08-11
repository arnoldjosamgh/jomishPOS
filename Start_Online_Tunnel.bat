@echo off
TITLE Jomish Business Suite - Online Remote Access
color 0B
cd /d "%~dp0"

:MENU
cls
echo =================================================================
echo        JOMISH BUSINESS SUITE - ONLINE TUNNEL ACTIVATION
echo =================================================================
echo.
echo  This tool will create a secure, private tunnel so the CEO 
echo  can access the business suite from their phone anywhere in 
echo  the world over the internet.
echo.
echo  Starting Jomish Local Server...

:: Start the local server in a separate background window if not already running
netstat -ano | findstr :3005 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo  [INFO] Local server is already running on port 3005.
) else (
    echo  [LAUNCH] Starting Jomish local server...
    if exist "dist\unified-jomish-suite.exe" (
        start "Jomish Server" cmd /c "dist\unified-jomish-suite.exe"
    ) else (
        start "Jomish Server" cmd /c "node backend/server.js"
    )
    timeout /t 3 >nul
)

echo.
echo  Select your preferred Online Tunnel provider:
echo  1. Localtunnel (Free, secure, requires Node.js - RECOMMENDED)
echo  2. Pinggy Tunnel (Free, zero-install, uses built-in Windows SSH)
echo  3. Exit
echo.
set /p opt="Select an option [1-3]: "

if "%opt%"=="1" goto LOCALTUNNEL
if "%opt%"=="2" goto PINGGY
if "%opt%"=="3" exit
goto MENU

:LOCALTUNNEL
cls
echo =================================================================
echo                   LOCALTUNNEL ACTIVATION
echo =================================================================
echo.
echo  Initializing secure tunnel via localtunnel...
echo  (When it loads, it will provide a public URL. Share it with the CEO)
echo.
npx localtunnel --port 3005
pause
goto MENU

:PINGGY
cls
echo =================================================================
echo                    PINGGY SSH TUNNEL
echo =================================================================
echo.
echo  Initializing tunnel via SSH (a.pinggy.io)...
echo  (Accept the host key if prompted)
echo.
ssh -R 80:localhost:3005 a.pinggy.io
pause
goto MENU
