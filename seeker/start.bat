@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\ws call npm install --no-audit --no-fund
node launch.js config.json
pause
