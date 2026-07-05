#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze Hub - 离线镜像加载（在【无外网】的目标机执行）
# =============================================================================
# 用法：
#   ./load-images.sh                       # 默认从同级 images/ 目录加载
#   ./load-images.sh /path/to/images       # 指定镜像 tar 目录
#
# 加载后请：
#   cd DA_Deploy && ./scripts/generate-secrets.sh
#   编辑 .env 中 HUB_IMAGE=deepanalyze-hub:<ver> 与 HUB_EXTERNAL_URL
#   docker compose -f docker-compose.prod.yml up -d
# =============================================================================
set -euo pipefail

IMG_DIR="${1:-$(cd "$(dirname "$0")" && pwd)/images}"

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  red "Docker 未安装，请先安装 Docker。"
  exit 1
fi

if [[ ! -d "$IMG_DIR" ]]; then
  red "镜像目录不存在: $IMG_DIR"
  exit 1
fi

# 可选校验：同级 SHA256SUMS
SUMS_FILE="$(cd "$IMG_DIR/.." && pwd)/SHA256SUMS"
if [[ -f "$SUMS_FILE" ]]; then
  green "[0/2] 校验 SHA256SUMS..."
  ( cd "$(dirname "$SUMS_FILE")" && sha256sum -c SHA256SUMS --quiet ) || yellow "  ⚠ 校验失败或不完整，请确认文件未损坏"
else
  yellow "  ℹ 未找到 SHA256SUMS，跳过完整性校验"
fi

# 加载所有 *.tar
green "[1/2] 加载镜像 tar ($IMG_DIR)..."
COUNT=0
for img in "$IMG_DIR"/*.tar; do
  [[ -e "$img" ]] || continue
  COUNT=$((COUNT + 1))
  printf '  Loading %s ...' "$(basename "$img")"
  if docker load -i "$img" >/dev/null 2>&1; then
    printf ' ✓\n'
  else
    printf ' ✗\n'
    red "加载失败: $img"
    exit 1
  fi
done

if [[ "$COUNT" -eq 0 ]]; then
  red "$IMG_DIR 下没有 *.tar 文件"
  exit 1
fi

green "[2/2] 已加载镜像清单:"
docker images | grep -E 'deepanalyze-hub|postgres' || true

cat <<EOF

下一步：
  1. cd DA_Deploy && ./scripts/generate-secrets.sh
  2. 编辑 .env：
     - HUB_IMAGE=<上面列出的 deepanalyze-hub:tag>
     - HUB_EXTERNAL_URL=http://<本机内网IP>:22000
  3. docker compose -f docker-compose.prod.yml up -d
  4. 浏览器访问 http://<本机IP>:22000 ，用 admin + ADMIN_INIT_PASSWORD 登录

EOF
