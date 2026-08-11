@echo off
REM ============================================================
REM  Jomish Business Suite — Clean Launcher
REM  - Kills stale processes
REM  - Wipes Electron cache so updated JS/HTML always loads
REM  - Starts backend server loop
REM  - Waits for server, then starts Electron
REM ============================================================
title Jomish Business Suite Launcher

cd /d "%~dp0"
set "APPDIR=%~dp0"

echo [Jomish] Stopping any existing processes...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [Jomish] Clearing Electron disk cache for fresh load...
set "CACHE_DIR=%APPDATA%\Electron\Cache"
set "CODE_CACHE_DIR=%APPDATA%\Electron\Code Cache"
if exist "%CACHE_DIR%" (
    rmdir /s /q "%CACHE_DIR%" 2>nul
    echo [Jomish] Cleared: %CACHE_DIR%
)
if exist "%CODE_CACHE_DIR%" (
    rmdir /s /q "%CODE_CACHE_DIR%" 2>nul
    echo [Jomish] Cleared: %CODE_CACHE_DIR%
)

echo [Jomish] Starting backend server...
start "" /min cmd /c "cd /d ""%APPDIR%"" && node ""%APPDIR%backend\server.js"" >> ""%APPDIR%data\server.log"" 2>&1"

echo [Jomish] Waiting for server to be ready...
set READY=0
for /L %%i in (1,1,40) do (
    ping -n 2 127.0.0.1 >nul 2>&1
    curl -s -o nul -w "%%{http_code}" http://localhost:3005/api/discover 2>nul | findstr "200" >nul
    if not errorlevel 1 (
        set READY=1
        goto :SERVER_READY
    )
)

:SERVER_READY
if "%READY%"=="0" (
    echo [Jomish] WARNING: Server may not be ready, launching anyway...
)

echo [Jomish] Launching Electron UI...
if exist "%APPDIR%node_modules\electron\dist\electron.exe" (
    start "" "%APPDIR%node_modules\electron\dist\electron.exe" "%APPDIR%electron-main.js"
) else (
    echo [Jomish] Electron not found, falling back to browser...
    start "" "http://localhost:3005/login.html"
)

echo [Jomish] Done. App is starting.
