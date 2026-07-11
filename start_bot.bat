@echo off
:: ============================================================
:: UC Stats Bot - Windows Startup Launcher
:: Keep this file in the project root folder.
::
:: To auto-start on boot:
::   1. Press Win+R, type: shell:startup, press Enter
::   2. Copy this file (or a shortcut to it) into that folder
:: ============================================================

set "BOT_DIR=%~dp0"
if "%BOT_DIR:~-1%"=="\" set "BOT_DIR=%BOT_DIR:~0,-1%"

echo ============================================================
echo   UC Stats Tracking Bot for TeamSpeak 3
echo   Folder: %BOT_DIR%
echo ============================================================
echo.

:: --- Check .env exists ---
if not exist "%BOT_DIR%\.env" (
    echo ERROR: No .env file found.
    echo.
    echo Run setup first:
    echo   1. Open PowerShell in this folder
    echo   2. Run: .\setup.ps1
    echo.
    pause
    exit /b 1
)

set "HOST_WEB_PORT=3000"
set "PUBLIC_DASHBOARD_URL=https://uct.aquaweb.cc/"
for /f "usebackq tokens=1,* delims==" %%A in ("%BOT_DIR%\.env") do (
    if /I "%%A"=="HOST_WEB_PORT" set "HOST_WEB_PORT=%%B"
    if /I "%%A"=="PUBLIC_DASHBOARD_URL" set "PUBLIC_DASHBOARD_URL=%%B"
)

:: --- Wait for Docker Desktop ---
echo Waiting for Docker Desktop to be ready...
set /a DOCKER_WAIT=0

:wait_docker
timeout /t 5 /nobreak >nul
docker info >nul 2>&1
if errorlevel 1 (
    set /a DOCKER_WAIT+=5
    echo   Docker not ready yet (waited %DOCKER_WAIT%s), retrying...
    if %DOCKER_WAIT% geq 120 (
        echo.
        echo ERROR: Docker Desktop did not start within 2 minutes.
        echo Please start Docker Desktop manually and try again.
        pause
        exit /b 1
    )
    goto wait_docker
)
echo   Docker is ready.
echo.

:: --- Launch the bot ---
echo Starting UC Stats Bot...
cd /d "%BOT_DIR%"
docker compose up -d --remove-orphans

if errorlevel 1 (
    echo.
    echo ERROR: Failed to start the bot.
    echo.
    echo Common causes:
    echo   - Docker Desktop is not running
    echo   - Image not built yet (run setup.ps1 first)
    echo   - Invalid .env settings
    echo.
    echo Try building manually:
    echo   docker compose up -d --build
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Bot started successfully!
echo.
echo   Web Dashboard  : http://localhost:%HOST_WEB_PORT%
echo   Public Website : %PUBLIC_DASHBOARD_URL%
echo   View bot logs  : docker logs -f uc-stats-bot
echo   Stop the bot   : docker compose down
echo ============================================================
timeout /t 6 /nobreak >nul
