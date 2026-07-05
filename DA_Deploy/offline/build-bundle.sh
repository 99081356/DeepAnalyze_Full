#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze Hub - 离线打包脚本（在【有外网】的构建机执行）
# =============================================================================
# 打包 Hub + 所有 Worker 必需镜像 + 部署 kit，产出单一 tar.gz：
#
#   da-hub-deploy-<ver>.tar.gz
#     ├── images/
#     │   ├── hub.tar                  deepanalyze-hub:<ver>
#     │   ├── postgres.tar             postgres:16-alpine          (Hub 自己的 PG)
#     │   ├── da-postgres.tar          da-postgres:16-tuned        (Worker 专用调优 PG)
#     │   ├── da-backend.tar           deepanalyze-backend:<ver>   (Worker 应用)
#     │   ├── da-frontend.tar          deepanalyze-frontend:<ver>  (Worker nginx 前端)
#     │   └── da-embedding.tar         deepanalyze-embedding:<ver> (BGE-M3, 可选 --with-embedding)
#     ├── DA_Deploy/                   完整部署 kit
#     ├── VERSION / SHA256SUMS         版本清单 + 完整性校验
#
# 必需镜像（Hub + Worker 全栈，6 个）：
#   Hub 控制面：deepanalyze-hub:<ver>, postgres:16-alpine
#   Worker (SSH stack 模式)：da-postgres:16-tuned
#   Worker (DA 单体)：deepanalyze-backend:<ver> + deepanalyze-frontend:<ver>
#   Worker (语义搜索)：deepanalyze-embedding:<ver> (默认包含)
#
# 可选镜像（GPU AI 子服务，默认不打，需 --with-gpu 显式打开）：
#   glm-ocr / mineru / paddleocr-vl —— 仅 GPU 节点且 profile 启用时才需要
#
# 用法（在仓库根运行）：
#   DA_Deploy/offline/build-bundle.sh                          # 默认版本，含 embedding，不含 GPU
#   DA_Deploy/offline/build-bundle.sh v0.7.8                   # 指定版本
#   DA_Deploy/offline/build-bundle.sh v0.7.8 --no-embedding    # 不要 embedding（无语义搜索）
#   DA_Deploy/offline/build-bundle.sh v0.7.8 --with-gpu        # 额外打包 3 个 GPU 镜像
#   OUTPUT_DIR=/data/bundles DA_Deploy/offline/build-bundle.sh
# =============================================================================
set -euo pipefail

# 切到仓库根（脚本位于 <repo>/DA_Deploy/offline/）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# ---------- 参数解析 ----------
VERSION=""
WITH_EMBEDDING=1
WITH_GPU=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-embedding) WITH_EMBEDDING=0; shift ;;
    --with-gpu)     WITH_GPU=1;        shift ;;
    -*) echo "未知选项: $1" >&2; exit 2 ;;
    *)  VERSION="$1"; shift ;;
  esac
done

# 版本号：参数 > package.json > latest
if [[ -z "$VERSION" ]]; then
  if command -v bun >/dev/null 2>&1; then
    VERSION=$(bun -e 'console.log(require("./package.json").version)' 2>/dev/null || echo "")
  elif command -v node >/dev/null 2>&1; then
    VERSION=$(node -p 'require("./package.json").version' 2>/dev/null || echo "")
  fi
fi
VERSION="${VERSION:-latest}"

OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/dist}"
DA_DIR="$REPO_ROOT/DeepAnalyze"
BUNDLE_NAME="da-hub-deploy-${VERSION}"
BUNDLE_DIR="${OUTPUT_DIR}/${BUNDLE_NAME}"
IMG_DIR="$BUNDLE_DIR/images"

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

# ---------- preflight ----------
for cmd in docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    red "缺少命令: $cmd"
    exit 1
  fi
done

mkdir -p "$IMG_DIR"

# 镜像列表（tag 变量）—— 给 save/load 用
HUB_TAG="deepanalyze-hub:${VERSION}"
PG_TAG="postgres:16-alpine"
DA_PG_TAG="da-postgres:16-tuned"
DA_BACKEND_TAG="deepanalyze-backend:${VERSION}"
DA_FRONTEND_TAG="deepanalyze-frontend:${VERSION}"
DA_EMBEDDING_TAG="deepanalyze-embedding:${VERSION}"
GLM_OCR_TAG="deepanalyze-glm-ocr:${VERSION}"
MINERU_TAG="deepanalyze-mineru:${VERSION}"
PADDLEOCR_VL_TAG="deepanalyze-paddleocr-vl:${VERSION}"

# ---------- 1. 构建 / 拉取镜像 ----------
green "[1/4] 构建镜像（version=${VERSION}）..."

green "  • Hub: $HUB_TAG"
docker build -t "$HUB_TAG" -f Dockerfile .

green "  • Hub PostgreSQL: $PG_TAG (pull)"
docker pull "$PG_TAG"

green "  • Worker PG (tuned): $DA_PG_TAG"
docker build -t "$DA_PG_TAG" -f docker/da-postgres/Dockerfile docker/da-postgres/

green "  • DA Backend: $DA_BACKEND_TAG"
docker build -t "$DA_BACKEND_TAG" -f "$DA_DIR/Dockerfile" "$DA_DIR"

green "  • DA Frontend: $DA_FRONTEND_TAG"
docker build -t "$DA_FRONTEND_TAG" -f "$DA_DIR/frontend/Dockerfile" "$DA_DIR/frontend"

if [[ "$WITH_EMBEDDING" -eq 1 ]]; then
  green "  • DA Embedding (BGE-M3): $DA_EMBEDDING_TAG"
  docker build -t "$DA_EMBEDDING_TAG" -f "$DA_DIR/deploy/embedding.Dockerfile" "$DA_DIR"
fi

if [[ "$WITH_GPU" -eq 1 ]]; then
  green "  • GLM-OCR (GPU): $GLM_OCR_TAG"
  docker build -t "$GLM_OCR_TAG" -f "$DA_DIR/glm-ocr-service/Dockerfile" "$DA_DIR/glm-ocr-service"
  green "  • MinerU (GPU/CPU): $MINERU_TAG"
  docker build -t "$MINERU_TAG" -f "$DA_DIR/mineru-service/Dockerfile" "$DA_DIR/mineru-service"
  green "  • PaddleOCR-VL (GPU): $PADDLEOCR_VL_TAG"
  docker build -t "$PADDLEOCR_VL_TAG" -f "$DA_DIR/paddleocr-vl-service/Dockerfile" "$DA_DIR/paddleocr-vl-service"
fi

# ---------- 2. docker save ----------
green "[2/4] 导出镜像 tar..."
save_image() {
  local tag="$1" file="$2"
  printf '  Saving %-30s -> images/%s ...' "$tag" "$file"
  if docker save "$tag" -o "$IMG_DIR/$file"; then
    printf ' ✓ (%s)\n' "$(du -h "$IMG_DIR/$file" | cut -f1)"
  else
    printf ' ✗\n'; red "保存失败: $tag"; exit 1
  fi
}

save_image "$HUB_TAG"          "hub.tar"
save_image "$PG_TAG"           "postgres.tar"
save_image "$DA_PG_TAG"        "da-postgres.tar"
save_image "$DA_BACKEND_TAG"   "da-backend.tar"
save_image "$DA_FRONTEND_TAG"  "da-frontend.tar"
[[ "$WITH_EMBEDDING" -eq 1 ]] && save_image "$DA_EMBEDDING_TAG" "da-embedding.tar"
if [[ "$WITH_GPU" -eq 1 ]]; then
  save_image "$GLM_OCR_TAG"        "glm-ocr.tar"
  save_image "$MINERU_TAG"         "mineru.tar"
  save_image "$PADDLEOCR_VL_TAG"   "paddleocr-vl.tar"
fi

# ---------- 3. 复制 DA_Deploy kit ----------
green "[3/4] 复制部署 kit..."
cp -r "$REPO_ROOT/DA_Deploy/." "$BUNDLE_DIR/DA_Deploy/"
# 排除开发产物（保险起见）
rm -rf "$BUNDLE_DIR/DA_Deploy/backups" "$BUNDLE_DIR/DA_Deploy/secrets" "$BUNDLE_DIR/DA_Deploy/.env" 2>/dev/null || true

# 版本清单
cat > "$BUNDLE_DIR/VERSION" <<EOF
name=da-hub-deploy
version=${VERSION}
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

[images]
hub=${HUB_TAG}
postgres=${PG_TAG}
da-postgres=${DA_PG_TAG}
da-backend=${DA_BACKEND_TAG}
da-frontend=${DA_FRONTEND_TAG}
da-embedding=${WITH_EMBEDDING:+$DA_EMBEDDING_TAG}
glm-ocr=${WITH_GPU:+$GLM_OCR_TAG}
mineru=${WITH_GPU:+$MINERU_TAG}
paddleocr-vl=${WITH_GPU:+$PADDLEOCR_VL_TAG}
EOF

# ---------- 4. SHA256 + 打包 ----------
green "[4/4] 生成 SHA256SUMS + 打包 tar.gz..."
( cd "$BUNDLE_DIR" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )

( cd "$OUTPUT_DIR" && tar czf "$(basename "${BUNDLE_DIR}.tar.gz")" "$BUNDLE_NAME" )

TARBALL="${BUNDLE_DIR}.tar.gz"
TAR_SHA=$(sha256sum "$TARBALL" | awk '{print $1}')

green "完成。"
cat <<EOF

  打包文件: $TARBALL
  大小:     $(du -h "$TARBALL" | cut -f1)
  SHA256:   $TAR_SHA

  镜像清单:
    MUST (Hub + Worker 全栈):
      - images/hub.tar             $HUB_TAG
      - images/postgres.tar        $PG_TAG
      - images/da-postgres.tar     $DA_PG_TAG
      - images/da-backend.tar      $DA_BACKEND_TAG
      - images/da-frontend.tar     $DA_FRONTEND_TAG
EOF
[[ "$WITH_EMBEDDING" -eq 1 ]] && echo "    SHOULD (语义搜索):" && echo "      - images/da-embedding.tar $DA_EMBEDDING_TAG"
if [[ "$WITH_GPU" -eq 1 ]]; then
  echo "    OPTIONAL (GPU AI):"
  echo "      - images/glm-ocr.tar       $GLM_OCR_TAG"
  echo "      - images/mineru.tar        $MINERU_TAG"
  echo "      - images/paddleocr-vl.tar  $PADDLEOCR_VL_TAG"
fi
cat <<EOF

下一步（拷贝到无外网目标机后）：
  1. tar xzf ${BUNDLE_NAME}.tar.gz
  2. cd ${BUNDLE_NAME}
  3. 校验: sha256sum -c SHA256SUMS
  4. bash DA_Deploy/offline/load-images.sh images/
  5. cd DA_Deploy && ./scripts/generate-secrets.sh
  6. 编辑 .env：HUB_IMAGE=${HUB_TAG} 与 HUB_EXTERNAL_URL
  7. docker compose -f docker-compose.prod.yml up -d

  Worker 镜像（da-backend / da-frontend / da-postgres / da-embedding）
  默认已 docker load 到目标机，Hub 控制台部署 Worker 时直接选用即可。

EOF
