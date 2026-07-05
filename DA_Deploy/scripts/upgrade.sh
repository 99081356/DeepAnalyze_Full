#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze Hub - 升级脚本（带自动回滚）
# =============================================================================
# 流程：
#   1. 记录当前 HUB_IMAGE 作为回滚锚点
#   2. 自动备份（pg_dump + data 卷）
#   3. 应用新镜像 tag
#   4. up -d 重启 hub
#   5. 轮询 /api/health 至多 90s
#   6. 失败 → 自动回滚到旧 tag，并打印告警
#
# 用法：
#   ./scripts/upgrade.sh v0.7.8                # 在线：拉 registry 镜像
#   ./scripts/upgrade.sh v0.7.8 --load         # 离线：从本地镜像（已 docker load）切换
#   ./scripts/upgrade.sh v0.7.8 --no-backup    # 跳过备份（不推荐）
#
# 注：升级前请确保新镜像已 docker pull / docker load 到本机。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
HEALTH_URL="http://localhost:${PORT:-22000}/api/health"
HEALTH_TIMEOUT=90

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

NEW_TAG="${1:?用法: ./scripts/upgrade.sh <new-tag> [--load|--no-backup]}"
shift || true
DO_LOAD=0
DO_BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --load)      DO_LOAD=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    *) red "未知参数: $arg"; exit 2 ;;
  esac
done

# 解析当前镜像（先取 repo，再拼新 tag）
CUR_IMAGE=$(grep -E '^HUB_IMAGE=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
CUR_IMAGE="${CUR_IMAGE:-deepanalyze-hub:latest}"
REPO="${CUR_IMAGE%:*}"
NEW_IMAGE="${REPO}:${NEW_TAG}"

green "当前镜像: $CUR_IMAGE"
green "目标镜像: $NEW_IMAGE"

# ---------- 1. 备份 ----------
if [[ "$DO_BACKUP" -eq 1 ]]; then
  green "[1/5] 升级前自动备份..."
  ./scripts/backup.sh
else
  yellow "[1/5] 已通过 --no-backup 跳过备份"
fi

# ---------- 2. 准备新镜像 ----------
if [[ "$DO_LOAD" -eq 1 ]]; then
  green "[2/5] 离线模式：假设镜像已 docker load（新 tag = $NEW_IMAGE）"
else
  green "[2/5] 在线拉取镜像 $NEW_IMAGE ..."
  docker pull "$NEW_IMAGE"
fi

# ---------- 3. 切换 .env ----------
green "[3/5] 切换 HUB_IMAGE -> $NEW_IMAGE"
if grep -qE '^HUB_IMAGE=' "$ENV_FILE"; then
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' -E "s|^HUB_IMAGE=.*|HUB_IMAGE=${NEW_IMAGE}|" "$ENV_FILE"
  else
    sed -i -E "s|^HUB_IMAGE=.*|HUB_IMAGE=${NEW_IMAGE}|" "$ENV_FILE"
  fi
else
  echo "HUB_IMAGE=${NEW_IMAGE}" >> "$ENV_FILE"
fi

# ---------- 4. 滚动重启 ----------
green "[4/5] 重启 hub 容器..."
docker compose -f "$COMPOSE_FILE" up -d hub

# ---------- 5. 健康检查 ----------
green "[5/5] 等待健康检查（至多 ${HEALTH_TIMEOUT}s）..."
HEALTHY=0
for i in $(seq 1 $((HEALTH_TIMEOUT / 3))); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 3
done

if [[ "$HEALTHY" -eq 1 ]]; then
  green "✓ 升级成功，当前运行 $NEW_IMAGE"
  echo
  echo "  观察日志: docker compose -f $COMPOSE_FILE logs -f hub"
  echo "  如发现异常可手动回滚: ./scripts/upgrade.sh <旧tag>"
  exit 0
fi

# ---------- 回滚 ----------
red "✗ 健康检查失败，自动回滚到 $CUR_IMAGE"
if grep -qE '^HUB_IMAGE=' "$ENV_FILE"; then
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' -E "s|^HUB_IMAGE=.*|HUB_IMAGE=${CUR_IMAGE}|" "$ENV_FILE"
  else
    sed -i -E "s|^HUB_IMAGE=.*|HUB_IMAGE=${CUR_IMAGE}|" "$ENV_FILE"
  fi
else
  echo "HUB_IMAGE=${CUR_IMAGE}" >> "$ENV_FILE"
fi
docker compose -f "$COMPOSE_FILE" up -d hub

# 等待回滚就绪
for i in $(seq 1 30); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    yellow "⚠ 已回滚到 $CUR_IMAGE（Hub 可访问）。请检查新版本 $NEW_IMAGE 的日志/兼容性后重试。"
    exit 1
  fi
  sleep 2
done
red "⚠ 回滚后仍未就绪！请手动排查："
echo "  docker compose -f $COMPOSE_FILE logs hub"
echo "  数据库已自动备份，必要时用 ./scripts/restore.sh 恢复"
exit 1
