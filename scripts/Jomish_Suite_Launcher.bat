@echo off
TITLE Jomish Business Suite 2026 2.0 - Enterprise Launcher
SETLOCAL EnableDelayedExpansion
color 0F
:: Always run from the project root regardless of where this script is invoked
cd /d "%~dp0.."

:MENU
cls
echo =================================================================
echo         JOMISH BUSINESS SUITE 2026 2.0 - CONTROL CENTER
echo =================================================================
echo  [ Version 2.0.0 - Auto-Barcode ^& Photo POS ]
echo.
echo  1. START SUITE (Enterprise Mode / Docker-Postgres)
echo  2. START SUITE (Standalone Mode / SQLite)
echo  3. START IN KIOSK MODE (Pinned Fullscreen)
echo  4. INITIALIZE / SEED DATABASE (HR Admin Account)
echo  5. REGISTER AUTO-START (Open on Computer Boot)
echo  6. SYSTEM HEALTH CHECK
echo  7. DATABASE BACKUP
echo  8. STOP ALL SERVICES
echo  9. EXIT
echo.
echo =================================================================
set /p choice="Select an option [1-9]: "

if "%choice%"=="1" goto START_DOCKER
if "%choice%"=="2" goto START_LOCAL
if "%choice%"=="3" goto START_KIOSK
if "%choice%"=="4" goto SEED_DB
if "%choice%"=="5" goto REGISTER_STARTUP
if "%choice%"=="6" goto HEALTH
if "%choice%"=="7" goto BACKUP
if "%choice%"=="8" goto STOP
if "%choice%"=="9" exit
goto MENU

:START_DOCKER
cls
echo [ENTERPRISE MODE] Starting PostgreSQL and Suite...
docker --version >nul 2>&1
if !errorlevel! neq 0 (
    color 0C
    echo [ERROR] Docker is not installed or not running.
    echo Please install Docker Desktop or use Option 2 (SQLite).
    pause
    goto MENU
)
echo.
echo [1/2] Building and starting containers...
docker-compose -f docker\docker-compose.yml up -d --build
echo.
echo [2/2] Waiting for system to stabilize...
timeout /t 5 >nul
start http://localhost:3005
echo SUCCESS: System is live at http://localhost:3005
pause
goto MENU

:START_LOCAL
cls
echo [STANDALONE MODE] Starting Suite with SQLite...

:: Check node_modules
if not exist "node_modules\" (
    echo [!] Dependencies missing. Running npm install...
    npm install --omit=dev
)

:: Firewall Check (Attempt)
echo [SECURITY] Unlocking Windows Firewall for remote access...
powershell -Command "New-NetFirewallRule -DisplayName 'Jomish Business Suite' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3005 -ErrorAction SilentlyContinue" >nul 2>&1

:: Ensure config is set to sqlite
echo [CONFIG] Configuring database engine...
powershell -Command "(Get-Content config\config.json) -replace '\"dbType\": \"postgres\"', '\"dbType\": \"sqlite\"' | Set-Content config\config.json"

:: Display Local IP for Phone Access
echo.
echo =================================================================
echo         REMOTE ACCESS (NETWORK)
echo =================================================================
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4" ^| findstr /V "127.0.0.1"') do (
    set ip=%%a
    set ip=!ip: =!
    echo  Connect from other devices: http://!ip!:3005
)
echo =================================================================
echo.

:: Kill any existing Jomish server to prevent port conflicts
echo [CLEANUP] Stopping any previous server instance...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3005 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 >nul

:: Open browser automatically
echo [LAUNCH] Opening browser...
start http://localhost:3005

:: Start node
echo.
echo [SERVER] Starting Jomish Business Suite...
echo          Press Ctrl+C to stop the server.
echo.
node backend/server.js
pause
goto MENU

:SEED_DB
cls
echo [DATABASE] Initializing and Seeding Database...
if not exist "node_modules\" (
    echo [!] Need dependencies to seed. Installing...
    npm install --omit=dev
)
node backend/seed.js
echo.
echo SUCCESS: Default HR account created.
echo Email: admin@jomish.com | Password: admin123
echo.
pause
goto MENU

:BACKUP
cls
echo [BACKUP] Creating database dump...
if not exist "data\" mkdir data
set timestamp=%DATE:/=-%_%TIME::=-%
set timestamp=%timestamp: =_%

:: Check which DB is active
findstr /C:"\"dbType\": \"postgres\"" config\config.json >nul
if !errorlevel! == 0 (
    echo [DOCKER] Exporting Postgres data...
    set filename=postgres_backup_%timestamp%.sql
    docker exec jomish-db pg_dump -U jomish_admin jomish_suite > "data/!filename!"
) else (
    echo [SQLITE] Copying SQLite file...
    set filename=sqlite_backup_%timestamp%.db
    copy "data\jomish.db" "data\!filename!" >nul
)

if !errorlevel! neq 0 (
    color 0C
    echo [ERROR] Backup failed.
) else (
    echo SUCCESS! Saved to data/!filename!
)
pause
goto MENU

:BUILD
cls
echo [BUILD] Compiling Standalone Windows Executable...
if not exist "dist\" mkdir dist
call npm run build
if !errorlevel! neq 0 (
    color 0C
    echo [ERROR] Build failed! Check if Node.js and 'pkg' are installed.
) else (
    echo SUCCESS! Executable created in dist\
)
pause
goto MENU

:HEALTH
cls
echo =================================================================
echo         SYSTEM ENVIRONMENT HEALTH CHECK
echo =================================================================
echo.
echo [CHECK] Node.js Status:
node -v || echo [!] Node.js NOT FOUND
echo.
echo [CHECK] Docker Status:
docker --version || echo [!] Docker (Enterprise Mode) NOT AVAILABLE
echo.
echo [CHECK] Port 3005 Status:
netstat -ano | findstr :3005 || echo [OK] Port 3005 is free.
echo.
echo [CHECK] Configuration:
type config\config.json
echo.
echo =================================================================
pause
goto MENU

:START_KIOSK
cls
echo [KIOSK MODE] Starting Suite in Locked Fullscreen...
:: Start backend hidden via VBS
start "" wscript "%~dp0..\Start_Jomish_Suite.vbs"
echo.
echo [LAUNCH] Opening interface in Kiosk Mode...
echo (Note: If this fails, ensure Chrome or Edge is installed)
timeout /t 3 >nul
:: Use Chrome App Mode with Kiosk
start chrome --app=http://localhost:3005 --kiosk --user-data-dir="%TEMP%\jomish_kiosk" || start msedge --kiosk http://localhost:3005 --edge-kiosk-type=fullscreen
echo.
echo SUCCESS: System is locked in Kiosk mode.
echo To exit Kiosk, press ALT+F4.
pause
goto MENU

:REGISTER_STARTUP
cls
echo [STARTUP] Configuring Suite to open on Computer Boot...
set SCRIPT_PATH=%~dp0..\Start_Jomish_Suite.vbs
set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
powershell -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP_FOLDER%\JomishSuiteAutoStart.lnk');$s.TargetPath='%SCRIPT_PATH%';$s.Save()"
echo.
echo SUCCESS: Jomish Business Suite is now registered for Auto-Start!
echo The system will now open automatically every time Windows boots.
pause
goto MENU

:STOP
cls
echo Stopping all services...
docker-compose -f docker\docker-compose.yml down >nul 2>&1
taskkill /F /IM node.exe /T >nul 2>&1
echo System safely stopped.
pause
goto MENU

