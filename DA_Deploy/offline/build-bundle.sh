#!/usr/bin/env bash
# DeepAnalyze Hub - Offline bundle builder (run on a networked build host)
# Packs 4 required images + DA_Deploy kit into a single tar.gz.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# ---- args ----
VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)  VERSION="$1"; shift ;;
  esac
done

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

HUB_TAG="deepanalyze-hub:${VERSION}"
PG_TAG="postgres:16-alpine"
WORKER_TAG="deepanalyze/da:${VERSION}"
WORKER_PG_TAG="pgvector/pgvector:pg16"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

command -v docker >/dev/null 2>&1 || { red "docker not found"; exit 1; }
mkdir -p "$IMG_DIR"

# ---- 1. build / pull ----
green "[1/4] build/pull images (version=${VERSION})..."
green "  Hub: $HUB_TAG (build)"
docker build -t "$HUB_TAG" -f Dockerfile .

green "  Hub PG: $PG_TAG (pull)"
docker pull "$PG_TAG"

green "  Worker: $WORKER_TAG (build)"
docker build -t "$WORKER_TAG" -f "$DA_DIR/Dockerfile" "$DA_DIR"

green "  Worker PG: $WORKER_PG_TAG (pull)"
docker pull "$WORKER_PG_TAG"

# ---- 2. docker save ----
green "[2/4] save image tars..."
save_image() {
  local tag="$1" file="$2"
  printf '  Saving %-30s ...' "$tag"
  if docker save "$tag" -o "$IMG_DIR/$file"; then
    printf ' OK (%s)\n' "$(du -h "$IMG_DIR/$file" | cut -f1)"
  else
    printf ' FAIL\n'; red "save failed: $tag"; exit 1
  fi
}
save_image "$HUB_TAG"       "hub.tar"
save_image "$PG_TAG"        "postgres.tar"
save_image "$WORKER_TAG"    "worker.tar"
save_image "$WORKER_PG_TAG" "worker-pg.tar"

# ---- 3. copy DA_Deploy kit ----
green "[3/4] copy DA_Deploy kit..."
cp -r "$REPO_ROOT/DA_Deploy/." "$BUNDLE_DIR/DA_Deploy/"
rm -rf "$BUNDLE_DIR/DA_Deploy/backups" "$BUNDLE_DIR/DA_Deploy/secrets"
rm -f  "$BUNDLE_DIR/DA_Deploy/.env"
rm -rf "$BUNDLE_DIR/DA_Deploy/images"

# VERSION manifest
{
  echo "name=da-hub-deploy"
  echo "version=${VERSION}"
  echo "mode=local-docker"
  echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "[images]"
  echo "hub=${HUB_TAG}"
  echo "postgres=${PG_TAG}"
  echo "worker=${WORKER_TAG}"
  echo "worker-pg=${WORKER_PG_TAG}"
} > "$BUNDLE_DIR/VERSION"

# ---- 4. SHA256 + tar.gz ----
green "[4/4] generate SHA256SUMS + tar.gz..."
( cd "$BUNDLE_DIR" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
( cd "$OUTPUT_DIR" && tar czf "${BUNDLE_NAME}.tar.gz" "$BUNDLE_NAME" )

TARBALL="${BUNDLE_DIR}.tar.gz"
TAR_SHA=$(sha256sum "$TARBALL" | awk '{print $1}')
TAR_SIZE=$(du -h "$TARBALL" | cut -f1)

green "Done."
echo ""
echo "  Bundle:   $TARBALL"
echo "  Size:     $TAR_SIZE"
echo "  SHA256:   $TAR_SHA"
echo ""
echo "  Images (4, all required):"
echo "    - images/hub.tar         $HUB_TAG"
echo "    - images/postgres.tar    $PG_TAG"
echo "    - images/worker.tar      $WORKER_TAG"
echo "    - images/worker-pg.tar   $WORKER_PG_TAG"
echo ""
echo "  Next steps (on the air-gapped target host):"
echo "    1. tar xzf ${BUNDLE_NAME}.tar.gz"
echo "    2. cd ${BUNDLE_NAME}"
echo "    3. sha256sum -c SHA256SUMS"
echo "    4. bash DA_Deploy/offline/load-images.sh images/"
echo "    5. cd DA_Deploy && ./scripts/generate-secrets.sh"
echo "    6. edit .env: HUB_IMAGE=${HUB_TAG} and HUB_EXTERNAL_URL"
echo "    7. docker compose -f docker-compose.prod.yml up -d"
echo ""
