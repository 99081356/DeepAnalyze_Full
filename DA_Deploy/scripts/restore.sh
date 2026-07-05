#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze Hub - 恢复脚本
# =============================================================================
# 从指定备份目录恢复 Hub。
# 备份目录需包含一对文件：
#   hub-db-<date>.sql.gz
#   hub-data-<date>.tar.gz
#
# 用法：
#   ./scripts/restore.sh ./backups                                # 自动选最新
#   ./scripts/restore.sh ./backups hub-db-20260101_030000.sql.gz
#
# 警告：会覆盖现有数据库与数据卷内容，不可逆。请先确认备份完整性。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${1:?用法: ./scripts/restore.sh <backup-dir> [sql-gz-file]}"
SQL_GZ="${2:-}"

COMPOSE_FILE="docker-compose.prod.yml"
PG_USER="${PG_USER:-deepanalyze_hub}"
PG_DATABASE="${PG_DATABASE:-deepanalyze_hub}"
DATA_VOLUME="da-hub-data"

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

if [[ ! -d "$BACKUP_DIR" ]]; then
  red "备份目录不存在: $BACKUP_DIR"
  exit 1
fi

# 自动选最新 sql.gz
if [[ -z "$SQL_GZ" ]]; then
  SQL_GZ=$(ls -1t "$BACKUP_DIR"/hub-db-*.sql.gz 2>/dev/null | head -1 || true)
  if [[ -z "$SQL_GZ" ]]; then
    red "未在 $BACKUP_DIR 找到 hub-db-*.sql.gz"
    exit 1
  fi
fi
SQL_GZ_ABS="$(cd "$(dirname "$SQL_GZ")" && pwd)/$(basename "$SQL_GZ")"
DATE_TAG=$(basename "$SQL_GZ_ABS" | sed -E 's/^hub-db-(.+)\.sql\.gz$/\1/')
DATA_TAR_ABS="$(cd "$BACKUP_DIR" && pwd)/hub-data-${DATE_TAG}.tar.gz"

if [[ ! -f "$SQL_GZ_ABS" ]]; then
  red "SQL 备份不存在: $SQL_GZ_ABS"
  exit 1
fi
if [[ ! -f "$DATA_TAR_ABS" ]]; then
  yellow "⚠ 数据卷备份不存在: $DATA_TAR_ABS（将仅恢复数据库）"
  DATA_TAR_ABS=""
fi

cat <<EOF

将执行以下恢复操作（不可逆）：
  SQL    : $SQL_GZ_ABS
  DATA   : ${DATA_TAR_ABS:-（无，仅恢复数据库）}
  TARGET : 卷 $DATA_VOLUME + 数据库 $PG_DATABASE

EOF
read -rp "$(yellow '确认恢复？输入 yes 继续: ')" CONFIRM
[[ "$CONFIRM" == "yes" ]] || { red "已取消"; exit 1; }

# ---------- 1. 停 hub ----------
green "[1/4] 停止 hub 容器（保留 postgres）..."
docker compose -f "$COMPOSE_FILE" stop hub || true
docker compose -f "$COMPOSE_FILE" rm -f hub || true

# ---------- 2. 恢复数据库 ----------
green "[2/4] 恢复 PostgreSQL 数据库..."
gunzip -c "$SQL_GZ_ABS" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1

# ---------- 3. 恢复数据卷 ----------
if [[ -n "$DATA_TAR_ABS" ]]; then
  green "[3/4] 恢复 hub-data 数据卷..."
  BACKUP_DIR_HOST="$(cd "$(dirname "$DATA_TAR_ABS")" && pwd)"
  docker run --rm \
    -v "${DATA_VOLUME}:/data" \
    -v "${BACKUP_DIR_HOST}:/backup" \
    alpine sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/$(basename "$DATA_TAR_ABS") -C /data"
else
  yellow "[3/4] 跳过数据卷恢复"
fi

# ---------- 4. 起 hub ----------
green "[4/4] 重启 hub..."
docker compose -f "$COMPOSE_FILE" up -d hub

# 健康检查
green "等待 Hub 就绪..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:${PORT:-22000}/api/health >/dev/null 2>&1; then
    green "✓ Hub 已就绪"
    exit 0
  fi
  sleep 2
done
red "✗ 60s 内未就绪，请查看日志：docker compose -f $COMPOSE_FILE logs hub"
exit 1
