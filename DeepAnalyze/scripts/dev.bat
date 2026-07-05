@echo off
REM =============================================================================
REM DeepAnalyze - Unified Dev Startup Script (Windows)
REM
REM Usage:
REM   scripts\dev.bat          # Start everything
REM   scripts\dev.bat stop     # Stop everything
REM =============================================================================

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "COMPOSE_FILE=%PROJECT_DIR%\docker-compose.dev.yml"

if "%1"=="stop" goto :stop

echo [DeepAnalyze] Starting all services...
echo.

REM Start infrastructure
echo [DeepAnalyze] Starting PostgreSQL + Ollama...
docker compose -f "%COMPOSE_FILE%" up -d --build
if errorlevel 1 (
    echo [DeepAnalyze] ERROR: Failed to start containers. Is Docker running?
    exit /b 1
)

REM Wait for PostgreSQL
echo [DeepAnalyze] Waiting for PostgreSQL to be ready...
set retries=30
:waitloop
docker compose -f "%COMPOSE_FILE%" exec -T postgres pg_isready -U deepanalyze -d deepanalyze >nul 2>&1
if not errorlevel 1 goto :ready
set /a retries-=1
if !retries! equ 0 (
    echo [DeepAnalyze] ERROR: PostgreSQL failed to start.
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto :waitloop

:ready
echo [DeepAnalyze] PostgreSQL is ready.
echo [DeepAnalyze] Starting backend...
echo [DeepAnalyze] Press Ctrl+C to stop all services.
echo.

set PG_HOST=localhost
set PG_PORT=5432
set PG_DATABASE=deepanalyze
set PG_USER=deepanalyze
set PG_PASSWORD=deepanalyze_dev

npx tsx watch "%PROJECT_DIR%\src\main.ts"

REM Cleanup on exit
echo.
echo [DeepAnalyze] Stopping all services...
docker compose -f "%COMPOSE_FILE%" down 2>nul
echo [DeepAnalyze] All services stopped.
exit /b 0

:stop
echo [DeepAnalyze] Stopping all services...
docker compose -f "%COMPOSE_FILE%" down 2>nul
echo [DeepAnalyze] All services stopped.
exit /b 0
