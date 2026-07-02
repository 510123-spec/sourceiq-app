@echo off
cd /d "D:\search-engine-app"
start "" /min node server.js
timeout /t 4 /nobreak >nul
start "" /min cloudflared tunnel --url http://localhost:3001 --logfile "%USERPROFILE%\Desktop\sourceiq-tunnel.log"
exit
