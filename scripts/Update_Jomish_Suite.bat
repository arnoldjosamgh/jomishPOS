@echo off
TITLE Jomish Business Suite 2026 1.0 - Secure Update Utility
SETLOCAL EnableDelayedExpansion
color 0B
:: Always run from the project root
cd /d "%~dp0.."

echo =================================================================
echo         JOMISH BUSINESS SUITE 2026 1.0 - FORTRESS UPDATE SYSTEM
echo =================================================================
echo.

:: 1. PRE-FLIGHT PORT CHECK
echo [1/4] Checking Port 8080 Integrity...
netstat -ano | findstr :8080 > tmp_port.txt
for /f "tokens=5" %%a in (tmp_port.txt) do (
    set PID=%%a
    if not "!PID!"=="" (
        :: Check if the PID belongs to Docker
        tasklist /FI "PID eq !PID!" | findstr /I "docker" > nul
        if errorlevel 1 (
            color 0C
            echo.
            echo [CRITICAL ERROR] Port 8080 is being used by another device or service.
            echo Conflict PID: !PID!
            echo Please close the conflicting service to prevent system crash.
            del tmp_port.txt
            pause
            exit /b
        )
    )
)
del tmp_port.txt
echo SUCCESS: Port 8080 lane is clear.
echo.

:: 2. LOAD UPDATE
echo [2/4] Loading encrypted update archive (update.tar)...
if not exist "update.tar" (
    color 0C
    echo [ERROR] update.tar not found! Please place the update file in this folder.
    pause
    exit /b
)
docker load -i update.tar
echo.

:: 3. STOP OLD CONTAINER
echo [3/4] Safely decommissioning old version...
docker stop hr-pos-security >nul 2>&1
docker rm hr-pos-security >nul 2>&1
echo.

:: 4. RESTART WITH FORTRESS FLAGS
echo [4/4] Launching JOMISH-FORTRESS...
docker run -d ^
  --name hr-pos-security ^
  -p 8080:3005 ^
  --restart always ^
  --read-only ^
  -v hr_data_volume:/usr/src/app/data ^
  -v /tmp ^
  --network jomish-bridge ^
  hr-pos-security:latest

if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Failed to start container. Check Docker Desktop status.
) else (
    echo.
    echo =================================================================
    echo         UPDATE COMPLETE - SYSTEM IS LIVE AND SECURE
    echo =================================================================
    echo  Address: http://localhost:8080
    echo =================================================================
    start http://localhost:8080
)

pause
