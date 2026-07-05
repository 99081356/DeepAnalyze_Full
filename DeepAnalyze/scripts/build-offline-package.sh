#!/bin/bash
# =============================================================================
# build-offline-package.sh — Build complete offline deployment package
# =============================================================================
# Creates a fully self-contained deployment package from the latest source.
# All images are rebuilt with current code and dependencies.
#
# Prerequisites:
#   - deepanalyze-backend:latest  (base image with Python/pip packages)
#   - deepanalyze-frontend:latest (base image with nginx)
#   - deepanalyze-pg:latest       (base image with pgvector+zhparser)
#   - data/models/bge-m3/         (BGE-M3 model weights)
#   - data/models/docling/        (Docling model weights)
#
# Usage:
#   ./scripts/build-offline-package.sh [output_dir]
#
# Default output: /tmp/deepanalyze-offline/
# =============================================================================
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${1:-/tmp/deepanalyze-offline}"

echo "============================================"
echo "  DeepAnalyze Offline Package Builder"
echo "============================================"
echo "  Project:  $PROJECT_ROOT"
echo "  Output:   $OUTPUT_DIR"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Check prerequisites
# ---------------------------------------------------------------------------
echo "[1/10] Checking prerequisites..."

check_image() {
    if ! docker images --format "{{.Repository}}:{{.Tag}}" | grep -q "^$1$"; then
        echo "  ERROR: Required image not found: $1"
        echo "  Please build it first."
        exit 1
    fi
    echo "  OK: $1"
}

check_image "deepanalyze-backend:latest"
check_image "deepanalyze-frontend:latest"
check_image "deepanalyze-pg:latest"

MODELS_SRC="$PROJECT_ROOT/data/models"
if [ ! -d "$MODELS_SRC/bge-m3" ]; then
    echo "  ERROR: BGE-M3 model not found at $MODELS_SRC/bge-m3/"
    exit 1
fi
echo "  OK: BGE-M3 model ($MODELS_SRC/bge-m3/)"

if [ ! -d "$MODELS_SRC/docling" ]; then
    echo "  WARNING: Docling models not found at $MODELS_SRC/docling/"
    echo "  Document processing may not work without these models."
fi

# ---------------------------------------------------------------------------
# Step 2: Prepare output directory (completely separate from dev tree)
# ---------------------------------------------------------------------------
echo "[2/10] Preparing output directory..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{images,config,models}

# ---------------------------------------------------------------------------
# Step 3: Build frontend from current source
# ---------------------------------------------------------------------------
echo "[3/10] Building frontend from current source..."
cd "$PROJECT_ROOT/frontend"
npm install --prefer-offline 2>/dev/null || npm install
npm run build
echo "  Frontend build complete"

# ---------------------------------------------------------------------------
# Step 4: Build backend offline image with ALL latest code and deps
# ---------------------------------------------------------------------------
echo "[4/10] Building backend offline image (with latest code + deps)..."

docker rm -f temp-backend-offline 2>/dev/null || true

# Start container so we can run commands inside it
docker run -d --name temp-backend-offline deepanalyze-backend:latest sleep 600

# Copy latest package.json and install new dependencies
echo "  Installing latest npm dependencies..."
docker cp "$PROJECT_ROOT/package.json" temp-backend-offline:/app/package.json
# Remove old lockfile so bun can regenerate it with new deps
docker exec temp-backend-offline sh -c "rm -f /app/bun.lockb /app/package-lock.json" 2>/dev/null || true
docker exec temp-backend-offline bun install --production 2>&1 | tail -5

# Copy ALL latest source code
echo "  Copying latest source code..."
docker cp "$PROJECT_ROOT/src/." temp-backend-offline:/app/src/

# Copy config files
docker cp "$PROJECT_ROOT/config/." temp-backend-offline:/app/config/ 2>/dev/null || true

# Copy service directories (may have been updated since base image was built)
echo "  Copying service directories..."
for svc_dir in docling-service whisper-service paddleocr-vl-service; do
    if [ -d "$PROJECT_ROOT/$svc_dir" ]; then
        docker exec temp-backend-offline mkdir -p "/app/$svc_dir"
        docker cp "$PROJECT_ROOT/$svc_dir/." "temp-backend-offline:/app/$svc_dir/"
        echo "    Updated: $svc_dir"
    fi
done

# Copy embedding server
if [ -f "$PROJECT_ROOT/embedding_server.py" ]; then
    docker cp "$PROJECT_ROOT/embedding_server.py" temp-backend-offline:/app/embedding_server.py
    echo "    Updated: embedding_server.py"
fi

# Copy plugins
if [ -d "$PROJECT_ROOT/plugins" ]; then
    docker exec temp-backend-offline mkdir -p /app/plugins
    docker cp "$PROJECT_ROOT/plugins/." temp-backend-offline:/app/plugins/
    echo "    Updated: plugins/"
fi

# Ensure LibreOffice is installed (required for .doc → .docx conversion)
echo "  Checking LibreOffice..."
if docker exec temp-backend-offline which libreoffice >/dev/null 2>&1; then
    echo "    OK: LibreOffice already installed"
else
    echo "    Installing libreoffice-writer (required for .doc support)..."
    docker exec temp-backend-offline sh -c \
        "apt-get update -qq && apt-get install -y -qq --no-install-recommends libreoffice-writer && rm -rf /var/lib/apt/lists/*" 2>&1 | tail -3
    echo "    LibreOffice installed"
fi

# Ensure ffmpeg is installed (required for audio/video processing)
echo "  Checking ffmpeg..."
if docker exec temp-backend-offline which ffmpeg >/dev/null 2>&1; then
    echo "    OK: ffmpeg already installed"
else
    echo "    Installing ffmpeg (required for audio/video processing)..."
    docker exec temp-backend-offline sh -c \
        "apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*" 2>&1 | tail -3
    echo "    ffmpeg installed"
fi

# Verify critical new packages are installed
echo "  Verifying npm packages..."
for pkg in excel-xlsx pdf-parse youtube-caption-extractor; do
    if docker exec temp-backend-offline test -d "/app/node_modules/$pkg" 2>/dev/null; then
        echo "    OK: $pkg"
    else
        echo "    WARNING: $pkg not found in node_modules"
    fi
done

# Commit with correct CMD and environment
docker commit \
    --change 'ENV HF_ENDPOINT=' \
    --change 'ENV NODE_ENV=production' \
    --change 'CMD ["bun", "run", "src/main.ts"]' \
    --change 'HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -f http://localhost:21000/api/health || exit 1' \
    temp-backend-offline deepanalyze-backend:offline

docker rm -f temp-backend-offline
echo "  Backend offline image created"

# ---------------------------------------------------------------------------
# Step 4b: Inject Whisper ASR models into backend image
# ---------------------------------------------------------------------------
echo "[4b/10] Injecting Whisper ASR models into backend image..."

WHISPER_CACHE="${HOME}/.cache/whisper"
if [ -d "$WHISPER_CACHE" ] && [ -f "$WHISPER_CACHE/base.pt" ]; then
    docker rm -f temp-backend-whisper 2>/dev/null || true
    docker run -d --name temp-backend-whisper deepanalyze-backend:offline sleep 60

    docker exec temp-backend-whisper mkdir -p /root/.cache/whisper
    for model_file in "$WHISPER_CACHE"/*.pt; do
        if [ -f "$model_file" ]; then
            docker cp "$model_file" "temp-backend-whisper:/root/.cache/whisper/$(basename "$model_file")"
            echo "    Injected: $(basename "$model_file")"
        fi
    done

    # CRITICAL: Must include --change 'CMD ...' or the commit will inherit
    # the 'sleep 60' CMD from the temporary container
    docker commit \
        --change 'ENV HF_ENDPOINT=' \
        --change 'ENV NODE_ENV=production' \
        --change 'CMD ["bun", "run", "src/main.ts"]' \
        --change 'HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD curl -f http://localhost:21000/api/health || exit 1' \
        temp-backend-whisper deepanalyze-backend:offline

    docker rm -f temp-backend-whisper
    echo "  Whisper models injected"
else
    echo "  WARNING: No Whisper models found at $WHISPER_CACHE"
    echo "  ASR (audio transcription) will not work offline."
    echo "  To fix: run 'python3 -c \"import whisper; whisper.load_model(\"base\")\"' first"
fi

# ---------------------------------------------------------------------------
# Step 5: Build frontend offline image with latest dist
# ---------------------------------------------------------------------------
echo "[5/10] Building frontend offline image..."

rm -rf /tmp/fe-build-ctx
mkdir -p /tmp/fe-build-ctx/assets

cp "$PROJECT_ROOT/frontend/dist/index.html" /tmp/fe-build-ctx/
cp -r "$PROJECT_ROOT/frontend/dist/assets/"* /tmp/fe-build-ctx/assets/
cp "$PROJECT_ROOT/frontend/nginx.conf" /tmp/fe-build-ctx/

cat > /tmp/fe-build-ctx/Dockerfile << 'FEEOF'
FROM deepanalyze-frontend:latest
RUN rm -rf /usr/share/nginx/html/assets/* /usr/share/nginx/html/index.html /usr/share/nginx/html/50x.html
COPY assets/ /usr/share/nginx/html/assets/
COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
FEEOF

docker build -t deepanalyze-frontend:offline /tmp/fe-build-ctx/ 2>&1 | tail -5
rm -rf /tmp/fe-build-ctx
echo "  Frontend offline image created"

# ---------------------------------------------------------------------------
# Step 6: Build embedding offline image
# ---------------------------------------------------------------------------
echo "[6/10] Building embedding offline image..."

docker rm -f temp-embedding-offline 2>/dev/null || true
docker run -d --name temp-embedding-offline deepanalyze-backend:latest sleep 3600

# Install sentence-transformers
echo "  Installing sentence-transformers (may take a minute)..."
docker exec temp-embedding-offline pip3 install --break-system-packages --no-cache-dir \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    sentence-transformers 2>&1 | tail -3

# Copy embedding server and model files
docker cp "$PROJECT_ROOT/embedding_server.py" temp-embedding-offline:/app/embedding_server.py
docker exec temp-embedding-offline mkdir -p /app/models/bge-m3
docker cp "$MODELS_SRC/bge-m3/." temp-embedding-offline:/app/models/bge-m3/

# Commit with correct CMD
docker commit \
    --change 'ENV TOKENIZERS_PARALLELISM=false' \
    --change 'EXPOSE 11435' \
    --change 'CMD ["python3", "/app/embedding_server.py", "--host", "0.0.0.0", "--port", "11435", "--model-path", "/app/models/bge-m3"]' \
    --change 'HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD curl -f http://localhost:11435/health || exit 1' \
    temp-embedding-offline deepanalyze-embedding:offline

docker rm -f temp-embedding-offline
echo "  Embedding offline image created"

# Tag postgres
docker tag deepanalyze-pg:latest deepanalyze-pg:offline

echo "  All images built:"
docker images | grep "offline"

# ---------------------------------------------------------------------------
# Step 7: Save Docker images as tar files
# ---------------------------------------------------------------------------
echo "[7/10] Saving Docker images..."

echo "  Saving backend (~900MB)..."
docker save deepanalyze-backend:offline -o "$OUTPUT_DIR/images/backend.tar"

echo "  Saving frontend (~30MB)..."
docker save deepanalyze-frontend:offline -o "$OUTPUT_DIR/images/frontend.tar"

echo "  Saving postgres (~440MB)..."
docker save deepanalyze-pg:offline -o "$OUTPUT_DIR/images/postgres.tar"

echo "  Saving embedding (~2.1GB, includes BGE-M3 model)..."
docker save deepanalyze-embedding:offline -o "$OUTPUT_DIR/images/embedding.tar"

echo "  All images saved"

# ---------------------------------------------------------------------------
# Step 8: Copy model files and deployment configs
# ---------------------------------------------------------------------------
echo "[8/10] Copying model files and deployment configs..."

# Docling models (mounted at runtime, not in any image)
if [ -d "$MODELS_SRC/docling" ]; then
    echo "  Copying docling models (~5.1GB, dereferencing symlinks)..."
    cp -rL "$MODELS_SRC/docling" "$OUTPUT_DIR/models/"
fi

# Deployment files
cp "$PROJECT_ROOT/deploy/docker-compose.yml" "$OUTPUT_DIR/docker-compose.yml"
cp "$PROJECT_ROOT/deploy/deploy.sh" "$OUTPUT_DIR/deploy.sh"
cp "$PROJECT_ROOT/deploy/stop.sh" "$OUTPUT_DIR/stop.sh"
cp "$PROJECT_ROOT/deploy/.env.example" "$OUTPUT_DIR/.env.example"
cp "$PROJECT_ROOT/deploy/config/default.yaml" "$OUTPUT_DIR/config/default.yaml"

chmod +x "$OUTPUT_DIR/deploy.sh" "$OUTPUT_DIR/stop.sh"

# ---------------------------------------------------------------------------
# Step 9: Copy source code (for reference and modification)
# ---------------------------------------------------------------------------
echo "[9/10] Copying source code..."
mkdir -p "$OUTPUT_DIR/source"
rsync -a --exclude='node_modules' \
    --exclude='.git' \
    --exclude='data/' \
    --exclude='frontend/dist' \
    --exclude='frontend/node_modules' \
    --exclude='pip-wheels' \
    --exclude='test-results' \
    --exclude='deploy' \
    --exclude='.claude' \
    --exclude='.env' \
    --exclude='.superpowers' \
    --exclude='logs/' \
    --exclude='cc_test/' \
    "$PROJECT_ROOT/" "$OUTPUT_DIR/source/"

echo "  Source copied"

# ---------------------------------------------------------------------------
# Step 10: Generate README and verify
# ---------------------------------------------------------------------------
echo "[10/10] Generating README and verifying..."

cat > "$OUTPUT_DIR/README.md" << 'READMEEOF'
# DeepAnalyze 离线部署包

## 目录结构

```
deepanalyze-offline-package/
├── images/                 # Docker 镜像 tar 文件
│   ├── backend.tar         # 后端服务 (Bun + Python + docling + whisper)
│   ├── frontend.tar        # 前端 (Nginx + React SPA)
│   ├── postgres.tar        # PostgreSQL 17 + pgvector + zhparser
│   └── embedding.tar       # 嵌入服务 (BGE-M3 模型已内置)
├── models/
│   └── docling/            # 文档处理模型 (运行时挂载到 backend)
├── config/
│   └── default.yaml        # LLM 模型配置 (编辑此文件指定推理服务)
├── source/                 # 完整源代码 (供参考和修改)
├── docker-compose.yml      # Docker Compose 编排配置
├── deploy.sh               # 一键部署脚本
├── stop.sh                 # 停止服务
├── .env.example            # 环境变量模板
└── README.md
```

## 快速部署

### 前置条件
- Docker Engine >= 20.10
- Docker Compose (支持 v1 `docker-compose` 和 v2 `docker compose`)
- 可用磁盘空间 >= 20GB
- 内存 >= 8GB (推荐 16GB)

### 部署步骤

1. **配置 LLM 推理服务**

   编辑 `config/default.yaml`，修改模型配置：

   ```yaml
   models:
     main:
       provider: openai-compatible
       endpoint: http://你的推理服务地址:端口/v1
       model: glm-5.1           # 或 qwen3.6-27b 等
       apiKey: ""                # 内网服务通常不需要
   ```

   如果有多个模型，取消注释 qwen/vlm/asr 角色配置。

   或启动后在 Web UI 的"设置"页面配置。

2. **一键部署**

   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```

   脚本会自动完成：加载镜像 → 创建配置 → 启动所有服务 → 等待健康检查

3. **访问应用**

   - Web UI: http://localhost:21000

### 其他命令

```bash
./deploy.sh status         # 查看服务状态
./deploy.sh logs           # 查看所有日志
./deploy.sh logs backend   # 查看后端日志
./deploy.sh stop           # 停止所有服务
./deploy.sh restart        # 重启服务
```

## 服务说明

| 服务 | 镜像 | 内部端口 | 宿主机端口 | 说明 |
|------|------|---------|-----------|------|
| frontend | deepanalyze-frontend:offline | 3000 | **21000** | Nginx 提供 React SPA |
| backend | deepanalyze-backend:offline | 21000 | 无外部映射 | Bun + Python API 服务 |
| embedding | deepanalyze-embedding:offline | 11435 | 内部 | BGE-M3 嵌入模型 |
| postgres | deepanalyze-pg:offline | 5432 | 内部 | PostgreSQL + pgvector + zhparser |

## 架构

- 前端 (Nginx:3000) 提供 Web UI，将 `/api/*` 和 `/ws` 代理到后端
- 后端连接 PostgreSQL 存储数据，连接嵌入服务进行向量化
- 嵌入服务内置 BGE-M3 模型，无需下载
- 服务间通过 Docker 内部网络通信
- 用户只需访问前端端口 21000

## 故障排除

- **后端无法启动**: 检查 `config/default.yaml` 中的推理服务地址是否可达
- **嵌入服务启动慢**: BGE-M3 模型加载需要 30-60 秒，属于正常现象
- **PostgreSQL 连接失败**: 等待 postgres 健康检查通过 (约 15-30 秒)
- **文件上传失败**: nginx 已配置 500MB 上传限制
- **查看日志**: `./deploy.sh logs <服务名>` 查看详细日志

READMEEOF

echo ""
echo "============================================"
echo "  离线部署包构建完成!"
echo "============================================"
echo ""
echo "  输出目录: $OUTPUT_DIR"
echo ""
du -sh "$OUTPUT_DIR"/* 2>/dev/null
echo ""
echo "  总大小:"
du -sh "$OUTPUT_DIR"
echo ""
echo "  打包为单文件:"
echo "    cd $(dirname "$OUTPUT_DIR") && tar cf deepanalyze-offline.tar $(basename "$OUTPUT_DIR")"
echo ""
