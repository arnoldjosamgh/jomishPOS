@echo off
TITLE Stop Jomish Suite Background Services
:: Always run from the project root
cd /d "%~dp0.."
echo =================================================================
echo         STOPPING JOMISH BUSINESS SUITE BACKGROUND SERVICES
echo =================================================================
echo.
echo [1/2] Terminating Background Node.js engines...
taskkill /F /IM node.exe /T 2>nul
if %errorlevel% == 0 (
    echo [OK] Node.js services stopped.
) else (
    echo [!] No active services were found.
)

echo [2/2] Cleaning up Docker instances (if any)...
docker-compose -f docker\docker-compose.yml down 2>nul
echo Successfully shut down.
echo.
echo =================================================================
timeout /t 3 >nul
exit
