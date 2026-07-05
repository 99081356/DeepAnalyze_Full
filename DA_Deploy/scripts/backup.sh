#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze Hub - 备份脚本
# =============================================================================
# 备份内容：
#   1. PostgreSQL 数据库（pg_dump）
#   2. hub-data 数据卷（含 RSA keys、model-repo、bundle、backups、config）
#
# 用法：
#   ./scripts/backup.sh                       # 默认 ./backups/，保留 14 天
#   RETENTION_DAYS=30 ./scripts/backup.sh     # 自定义保留期
#   BACKUP_DIR=/data/backups ./scripts/backup.sh
#
# 推荐：配合 scripts/hub-backup.timer 每日定时运行。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
COMPOSE_FILE="docker-compose.prod.yml"
DATE="$(date +%Y%m%d_%H%M%S)"
PG_USER="${PG_USER:-deepanalyze_hub}"
PG_DATABASE="${PG_DATABASE:-deepanalyze_hub}"
DATA_VOLUME="da-hub-data"

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

mkdir -p "$BACKUP_DIR"

# ---------- 1. pg_dump ----------
green "[1/2] 导出 PostgreSQL 数据库..."
SQL_DUMP="$BACKUP_DIR/hub-db-${DATE}.sql.gz"
docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="${PG_PASSWORD:-}" postgres \
  pg_dump -U "$PG_USER" -d "$PG_DATABASE" --clean --if-exists --no-owner \
  | gzip > "$SQL_DUMP"
green "  ✓ $SQL_DUMP ($(du -h "$SQL_DUMP" | cut -f1))"

# ---------- 2. data volume tar ----------
green "[2/2] 备份 hub-data 数据卷..."
DATA_TAR="$BACKUP_DIR/hub-data-${DATE}.tar.gz"
docker run --rm \
  -v "${DATA_VOLUME}:/data:ro" \
  -v "$(cd "$BACKUP_DIR" && pwd):/backup" \
  alpine \
  tar czf "/backup/hub-data-${DATE}.tar.gz" -C /data .
green "  ✓ $DATA_TAR ($(du -h "$DATA_TAR" | cut -f1))"

# ---------- 清理过期备份 ----------
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  green "清理 ${RETENTION_DAYS} 天前的备份..."
  find "$BACKUP_DIR" -maxdepth 1 -name 'hub-db-*.sql.gz'   -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
  find "$BACKUP_DIR" -maxdepth 1 -name 'hub-data-*.tar.gz' -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
fi

green "完成。备份位置：$BACKUP_DIR"
