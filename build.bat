@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js est requis : https://nodejs.org & pause & exit /b 1)
call npm install || (pause & exit /b 1)
call npm run dist || (pause & exit /b 1)
start "" "%~dp0dist"
