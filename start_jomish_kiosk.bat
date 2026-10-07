@echo off
echo Starting JomishPOS Server...
start "" /b cmd /c "node backend/server.js"
echo Waiting for server to start...
timeout /t 3 /nobreak > nul

echo Launching JomishPOS Kiosk Mode...
:: Launch Chrome with kiosk-printing flag to disable the print dialog
:: It will open http://localhost:3005 in full screen (kiosk) mode, and print silently.
start chrome --kiosk-printing --app=http://localhost:3005
exit
