#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze - Unified Dev Startup Script
#
# Usage:
#   ./scripts/dev.sh          # Start everything
#   ./scripts/dev.sh stop     # Stop everything
#   ./scripts/dev.sh status   # Check status
#
# Equivalent npm scripts:
#   npm run dev:full          # Start everything
#   npm run dev:full:stop     # Stop everything
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.dev.yml"
COMPOSE_CMD="docker compose -f $COMPOSE_FILE"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' RED='' CYAN='' NC=''
fi

log()  { echo -e "${GREEN}[DeepAnalyze]${NC} $1"; }
warn() { echo -e "${YELLOW}[DeepAnalyze]${NC} $1"; }
err()  { echo -e "${RED}[DeepAnalyze]${NC} $1" >&2; }

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------
check_docker() {
  if ! command -v docker &>/dev/null; then
    err "Docker is not installed. Please install Docker first."
    exit 1
  fi
  if ! docker info &>/dev/null 2>&1; then
    err "Docker daemon is not running. Please start Docker."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Stop everything
# ---------------------------------------------------------------------------
do_stop() {
  log "Stopping all services..."
  $COMPOSE_CMD down 2>/dev/null || true
  log "All services stopped."
}

# ---------------------------------------------------------------------------
# Show status
# ---------------------------------------------------------------------------
do_status() {
  echo ""
  $COMPOSE_CMD ps 2>/dev/null || warn "No services running."
  echo ""
}

# ---------------------------------------------------------------------------
# Start infrastructure (PostgreSQL + Ollama)
# ---------------------------------------------------------------------------
start_infra() {
  check_docker

  log "Starting PostgreSQL + Ollama..."
  $COMPOSE_CMD up -d --build 2>&1 | tail -5

  # Wait for PostgreSQL to be healthy
  log "Waiting for PostgreSQL to be ready..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U deepanalyze -d deepanalyze &>/dev/null; then
      break
    fi
    retries=$((retries - 1))
    sleep 1
    printf "."
  done
  echo ""

  if [ $retries -eq 0 ]; then
    err "PostgreSQL failed to start. Check logs: $COMPOSE_CMD logs postgres"
    exit 1
  fi

  log "PostgreSQL is ready."
  log "Ollama is available at http://localhost:11434"
}

# ---------------------------------------------------------------------------
# Start backend
# ---------------------------------------------------------------------------
start_backend() {
  export PG_HOST=localhost
  export PG_PORT="${PG_PORT:-5432}"
  export PG_DATABASE="${PG_DATABASE:-deepanalyze}"
  export PG_USER="${PG_USER:-deepanalyze}"
  export PG_PASSWORD="${PG_PASSWORD:-deepanalyze_dev}"

  log "Starting backend with PG_HOST=$PG_HOST ..."
  log "Press Ctrl+C to stop all services."
  echo ""

  # Trap Ctrl+C to clean up containers
  cleanup() {
    echo ""
    log "Caught interrupt, stopping all services..."
    $COMPOSE_CMD down 2>/dev/null || true
    log "All services stopped. Goodbye!"
    exit 0
  }
  trap cleanup SIGINT SIGTERM

  # Start the backend — tsx watch for hot-reload
  npx tsx watch "$PROJECT_DIR/src/main.ts"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "${1:-}" in
  stop)
    do_stop
    ;;
  status)
    do_status
    ;;
  *)
    log "DeepAnalyze Dev Startup"
    log "========================"
    echo ""
    start_infra
    echo ""
    start_backend
    ;;
esac
