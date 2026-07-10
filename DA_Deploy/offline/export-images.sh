#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze Hub - 本地镜像导出脚本（local Docker 部署模式）
# =============================================================================
# 导出 4 个必需镜像到 DA_Deploy/images/，方便离线搬运或本地 docker load 测试。
#
# 部署模式：Hub 与 Worker 同机，Hub 通过挂载的 docker.sock 在本机拉起 worker 容器。
#
# 镜像清单：
#   hub.tar        deepanalyze-hub:latest     Hub 控制面（从源码 build，含最新改动）
#   postgres.tar   postgres:16-alpine         Hub 的 PG（关系数据，无 pgvector）
#   worker.tar     deepanalyze/da:latest      DA Worker 单体（你 worker 容器实际用的）
#   worker-pg.tar  pgvector/pgvector:pg16     Worker 的 PG（含 pgvector，DA 向量检索必需）
#
# 用法：
#   DA_Deploy/offline/export-images.sh                # 默认导出现有镜像
#   REBUILD_HUB=1 DA_Deploy/offline/export-images.sh  # 强制重新 build hub 镜像
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

IMG_DIR="$REPO_ROOT/DA_Deploy/images"

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

mkdir -p "$IMG_DIR"

# docker save（BuildKit 构建的镜像输出 OCI 格式，旧版 Docker 无法 load。
# 用 skopeo 转为传统 docker-archive 格式，兼容所有 Docker 版本。）
save_image() {
  local tag="$1" file="$2"
  printf '  Saving %-30s ...' "$tag"
  rm -f "$IMG_DIR/$file"
  if docker run --rm \
      -v //var/run/docker.sock:/var/run/docker.sock \
      -v "$IMG_DIR:/output" \
      quay.io/skopeo/stable:latest \
      copy "docker-daemon:$tag" "docker-archive:/output/$file:$tag" >/dev/null 2>&1; then
    printf ' OK (%s)\n' "$(du -h "$IMG_DIR/$file" | cut -f1)"
  else
    printf ' FAIL (skopeo), fallback docker save ...'
    if docker save "$tag" -o "$IMG_DIR/$file"; then
      printf ' OK (%s)\n' "$(du -h "$IMG_DIR/$file" | cut -f1)"
    else
      printf ' FAIL\n'; red "导出失败: $tag"; exit 1
    fi
  fi
}

# ---------- [1/4] Hub 镜像（可选从源码 rebuild） ----------
if [[ "${REBUILD_HUB:-0}" == "1" ]]; then
  green "[1/4] 重新构建 hub: deepanalyze-hub:latest"
  docker build -t deepanalyze-hub:latest -f Dockerfile .
else
  green "[1/4] 使用现有 hub 镜像（设 REBUILD_HUB=1 强制 rebuild）"
  if ! docker image inspect deepanalyze-hub:latest >/dev/null 2>&1; then
    red "  本地无 deepanalyze-hub:latest，请用 REBUILD_HUB=1 重跑"
    exit 1
  fi
fi
save_image "deepanalyze-hub:latest" "hub.tar"

# ---------- [2/4] Hub PostgreSQL ----------
green "[2/4] Hub PG: postgres:16-alpine"
docker image inspect postgres:16-alpine >/dev/null 2>&1 || docker pull postgres:16-alpine
save_image "postgres:16-alpine" "postgres.tar"

# ---------- [3/4] Worker 单体镜像 ----------
green "[3/4] Worker: deepanalyze/da:latest"
if ! docker image inspect deepanalyze/da:latest >/dev/null 2>&1; then
  red "  本地无 deepanalyze/da:latest。请先 build："
  echo "    docker build -t deepanalyze/da:latest -f DeepAnalyze/Dockerfile DeepAnalyze/"
  exit 1
fi
save_image "deepanalyze/da:latest" "worker.tar"

# ---------- [4/4] Worker PG（含 pgvector）----------
green "[4/4] Worker PG: pgvector/pgvector:pg16"
docker image inspect pgvector/pgvector:pg16 >/dev/null 2>&1 || docker pull pgvector/pgvector:pg16
save_image "pgvector/pgvector:pg16" "worker-pg.tar"

# ---------- 生成 MANIFEST ----------
green "生成 MANIFEST ..."
{
  echo "# DeepAnalyze Hub 部署镜像清单（local Docker 模式）"
  echo "# 生成时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  printf "%-15s %-35s %-10s %s\n" "FILE" "IMAGE_TAG" "SIZE" "SHA256"
  for f in hub.tar postgres.tar worker.tar worker-pg.tar; do
    [[ -f "$IMG_DIR/$f" ]] || continue
    case "$f" in
      hub.tar)       tag="deepanalyze-hub:latest" ;;
      postgres.tar)  tag="postgres:16-alpine" ;;
      worker.tar)    tag="deepanalyze/da:latest" ;;
      worker-pg.tar) tag="pgvector/pgvector:pg16" ;;
    esac
    sz=$(du -h "$IMG_DIR/$f" | cut -f1)
    sha=$(sha256sum "$IMG_DIR/$f" | awk '{print substr($1,1,16)}')
    printf "%-15s %-35s %-10s %s\n" "$f" "$tag" "$sz" "$sha..."
  done
} > "$IMG_DIR/MANIFEST"

green "========================================"
green "完成。镜像清单 ($IMG_DIR):"
cat "$IMG_DIR/MANIFEST"
green "========================================"
