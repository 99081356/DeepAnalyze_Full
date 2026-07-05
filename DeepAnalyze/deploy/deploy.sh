#!/bin/bash
# =============================================================================
# deploy.sh — One-command offline deployment for DeepAnalyze
# =============================================================================
# Usage:
#   ./deploy.sh              # Full deploy: export old config + load images + start
#   ./deploy.sh start        # Start services only (images already loaded)
#   ./deploy.sh stop         # Stop all services
#   ./deploy.sh status       # Show service status
#   ./deploy.sh restart      # Restart all services
#   ./deploy.sh logs [svc]   # Show logs (optional: service name)
#   ./deploy.sh upgrade      # Upgrade: export config -> remove old -> load new -> import
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Detect docker-compose command (v1 uses 'docker-compose', v2 uses 'docker compose')
detect_compose_cmd() {
    if command -v docker-compose &>/dev/null; then
        echo "docker-compose"
    elif docker compose version &>/dev/null 2>&1; then
        echo "docker compose"
    else
        echo "ERROR: docker-compose not found. Please install Docker Compose." >&2
        exit 1
    fi
}

COMPOSE_CMD=$(detect_compose_cmd)
IMAGE_DIR="$SCRIPT_DIR/images"
BACKUP_DIR="$SCRIPT_DIR/backup"

# Color output helpers
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ---------------------------------------------------------------------------
# Export old model configuration (before upgrade)
# ---------------------------------------------------------------------------
export_old_config() {
    if [ ! -f "$SCRIPT_DIR/config/default.yaml" ]; then
        log_warn "No existing config/default.yaml found, skipping export"
        return
    fi

    # Only backup if the file has been customized (differs from template)
    local template_marker="# DeepAnalyze Intranet Configuration Template"
    if head -1 "$SCRIPT_DIR/config/default.yaml" | grep -q "$template_marker"; then
        # Check if it's been modified (has non-TODO endpoint)
        if grep -q "endpoint: http://192.168" "$SCRIPT_DIR/config/default.yaml"; then
            log_warn "Config appears to still have default values, skipping backup"
            return
        fi
    fi

    mkdir -p "$BACKUP_DIR"
    local timestamp=$(date +%Y%m%d_%H%M%S)
    cp "$SCRIPT_DIR/config/default.yaml" "$BACKUP_DIR/default.yaml.$timestamp"
    log_ok "Exported old config to backup/default.yaml.$timestamp"

    # Also backup .env if it exists
    if [ -f "$SCRIPT_DIR/.env" ]; then
        cp "$SCRIPT_DIR/.env" "$BACKUP_DIR/.env.$timestamp"
        log_ok "Exported old .env to backup/.env.$timestamp"
    fi
}

# ---------------------------------------------------------------------------
# Import saved configuration (after upgrade)
# ---------------------------------------------------------------------------
import_config() {
    if [ ! -d "$BACKUP_DIR" ]; then
        return
    fi

    # Find the latest config backup
    local latest_config=$(ls -t "$BACKUP_DIR"/default.yaml.* 2>/dev/null | head -1)
    if [ -n "$latest_config" ] && [ -f "$latest_config" ]; then
        cp "$latest_config" "$SCRIPT_DIR/config/default.yaml"
        log_ok "Imported saved config from $latest_config"
    fi

    # Find the latest .env backup
    local latest_env=$(ls -t "$BACKUP_DIR"/.env.* 2>/dev/null | head -1)
    if [ -n "$latest_env" ] && [ -f "$latest_env" ]; then
        cp "$latest_env" "$SCRIPT_DIR/.env"
        log_ok "Imported saved .env from $latest_env"
    fi
}

# ---------------------------------------------------------------------------
# Load Docker images from tar files
# ---------------------------------------------------------------------------
load_images() {
    if [ ! -d "$IMAGE_DIR" ]; then
        log_error "Image directory not found: $IMAGE_DIR"
        log_error "Please ensure the offline package is complete."
        exit 1
    fi

    local tar_count=$(ls -1 "$IMAGE_DIR"/*.tar 2>/dev/null | wc -l)
    if [ "$tar_count" -eq 0 ]; then
        log_warn "No image tar files found in $IMAGE_DIR"
        return
    fi

    log_info "Loading Docker images..."
    for tar_file in "$IMAGE_DIR"/*.tar; do
        if [ -f "$tar_file" ]; then
            local name=$(basename "$tar_file")
            local size=$(du -h "$tar_file" | cut -f1)
            echo -n "  Loading $name ($size) ... "
            docker load -i "$tar_file" >/dev/null 2>&1 && echo "done" || echo "FAILED"
        fi
    done
    log_ok "All images loaded"
}

# ---------------------------------------------------------------------------
# Remove old containers (clean slate for upgrade)
# ---------------------------------------------------------------------------
remove_old_containers() {
    log_info "Removing old containers..."
    $COMPOSE_CMD down --remove-orphans 2>/dev/null || true
    log_ok "Old containers removed"
}

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------
check_prereqs() {
    log_info "Checking prerequisites..."

    if ! command -v docker &>/dev/null; then
        log_error "Docker not installed"
        exit 1
    fi
    log_ok "Docker: $(docker --version)"

    log_ok "Compose: $COMPOSE_CMD"

    # Check images are loaded
    local missing=0
    for img in deepanalyze-backend:offline deepanalyze-frontend:offline deepanalyze-pg:offline deepanalyze-embedding:offline; do
        if ! docker images --format "{{.Repository}}:{{.Tag}}" | grep -q "^${img}$"; then
            log_warn "Missing image: $img"
            missing=1
        fi
    done

    if [ "$missing" -eq 1 ]; then
        log_info "Some images are missing. Loading from tar files..."
        load_images
    fi

    log_ok "All required images present"
}

# ---------------------------------------------------------------------------
# Initialize environment
# ---------------------------------------------------------------------------
init_env() {
    if [ ! -f .env ]; then
        cp .env.example .env
        log_ok "Created .env from .env.example"
    fi

    # Create models/docling directory if model files need to be mounted
    mkdir -p models/docling
}

# ---------------------------------------------------------------------------
# Start all services
# ---------------------------------------------------------------------------
start_services() {
    echo ""
    echo "============================================"
    echo "  DeepAnalyze Offline Deployment"
    echo "============================================"
    echo ""

    check_prereqs
    init_env

    log_info "Starting services..."
    $COMPOSE_CMD up -d

    echo ""
    log_info "Waiting for services to be ready..."

    # Wait for PostgreSQL
    echo -n "  PostgreSQL: "
    local pg_ready=false
    for i in $(seq 1 30); do
        if $COMPOSE_CMD exec -T postgres pg_isready -U deepanalyze >/dev/null 2>&1; then
            echo "OK"
            pg_ready=true
            break
        fi
        sleep 1
    done
    if [ "$pg_ready" = false ]; then
        echo "TIMEOUT"
        log_error "PostgreSQL failed to start. Check logs: $COMPOSE_CMD logs postgres"
        exit 1
    fi

    # Wait for Embedding (internal service, check via docker exec)
    echo -n "  Embedding: "
    local emb_ready=false
    local emb_container
    emb_container=$($COMPOSE_CMD ps -q embedding 2>/dev/null || true)
    for i in $(seq 1 60); do
        if [ -n "$emb_container" ] && docker exec "$emb_container" curl -sf http://localhost:11435/health >/dev/null 2>&1; then
            echo "OK"
            emb_ready=true
            break
        fi
        # Re-fetch container ID in case it wasn't ready yet
        emb_container=$($COMPOSE_CMD ps -q embedding 2>/dev/null || true)
        sleep 2
    done
    if [ "$emb_ready" = false ]; then
        echo "TIMEOUT (may still be loading model, will retry automatically)"
    fi

    # Wait for Backend (internal service, check via frontend proxy or docker exec)
    echo -n "  Backend: "
    local be_ready=false
    local be_container
    for i in $(seq 1 60); do
        # Try through frontend proxy first (the normal user path)
        if curl -sf http://localhost:${FRONTEND_PORT:-21000}/api/health >/dev/null 2>&1; then
            echo "OK"
            be_ready=true
            break
        fi
        # Fallback: check via docker exec
        be_container=$($COMPOSE_CMD ps -q backend 2>/dev/null || true)
        if [ -n "$be_container" ] && docker exec "$be_container" curl -sf http://localhost:21000/api/health >/dev/null 2>&1; then
            echo "OK"
            be_ready=true
            break
        fi
        sleep 2
    done
    if [ "$be_ready" = false ]; then
        echo "TIMEOUT"
        log_error "Backend failed to start. Check logs: $COMPOSE_CMD logs backend"
        exit 1
    fi

    # Wait for Frontend
    echo -n "  Frontend: "
    local fe_ready=false
    for i in $(seq 1 30); do
        if curl -sf http://localhost:${FRONTEND_PORT:-21000}/ >/dev/null 2>&1; then
            echo "OK"
            fe_ready=true
            break
        fi
        sleep 1
    done
    if [ "$fe_ready" = false ]; then
        echo "TIMEOUT"
        log_warn "Frontend not responding yet. Check logs: $COMPOSE_CMD logs frontend"
    fi

    echo ""
    echo "============================================"
    echo -e "  ${GREEN}DeepAnalyze is running!${NC}"
    echo "============================================"
    echo ""
    echo "  Web UI:    http://localhost:${FRONTEND_PORT:-21000}"
    echo ""
    echo "  Next steps:"
    echo "    1. Open the Web UI in your browser"
    echo "    2. Go to Settings to configure your LLM provider"
    echo "       (or edit config/default.yaml and restart backend)"
    echo ""
    echo "  Commands:"
    echo "    ./deploy.sh status    # Check service status"
    echo "    ./deploy.sh logs      # View logs"
    echo "    ./deploy.sh stop      # Stop services"
    echo "    ./deploy.sh upgrade   # Upgrade to new version"
    echo ""
}

# ---------------------------------------------------------------------------
# Full upgrade: export config -> remove old -> load new -> import config -> start
# ---------------------------------------------------------------------------
upgrade_services() {
    echo ""
    echo "============================================"
    echo "  DeepAnalyze Upgrade"
    echo "============================================"
    echo ""

    # Step 1: Export old config
    log_info "Step 1/5: Exporting current configuration..."
    export_old_config

    # Step 2: Remove old containers
    log_info "Step 2/5: Removing old containers..."
    remove_old_containers

    # Step 3: Load new images
    log_info "Step 3/5: Loading new images..."
    load_images

    # Step 4: Import saved config
    log_info "Step 4/5: Importing saved configuration..."
    import_config

    # Step 5: Start services
    log_info "Step 5/5: Starting services..."
    start_services
}

# ---------------------------------------------------------------------------
# Stop all services
# ---------------------------------------------------------------------------
stop_services() {
    log_info "Stopping services..."
    $COMPOSE_CMD down
    log_ok "All services stopped. Data is preserved in Docker volumes."
    echo "  To start again: ./deploy.sh"
    echo "  To remove all data: $COMPOSE_CMD down -v"
}

# ---------------------------------------------------------------------------
# Show status
# ---------------------------------------------------------------------------
show_status() {
    echo ""
    echo "DeepAnalyze Service Status:"
    echo ""
    $COMPOSE_CMD ps
    echo ""

    # Quick health check
    local fe_port=${FRONTEND_PORT:-21000}

    echo -n "  Frontend (${fe_port}): "
    curl -sf http://localhost:${fe_port}/ >/dev/null 2>&1 && echo "OK" || echo "NOT RESPONDING"

    echo -n "  Backend (via proxy): "
    curl -sf http://localhost:${fe_port}/api/health >/dev/null 2>&1 && echo "OK" || echo "NOT RESPONDING"

    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "${1:-}" in
    start)
        init_env
        log_info "Starting services..."
        $COMPOSE_CMD up -d
        ;;
    stop)
        stop_services
        ;;
    restart)
        $COMPOSE_CMD restart
        log_ok "Services restarted"
        ;;
    status)
        show_status
        ;;
    logs)
        shift
        $COMPOSE_CMD logs --tail=100 ${1:-}
        ;;
    load)
        load_images
        ;;
    upgrade)
        upgrade_services
        ;;
    *)
        start_services
        ;;
esac
