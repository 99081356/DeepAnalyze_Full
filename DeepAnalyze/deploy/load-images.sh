#!/bin/bash
# =============================================================================
# load-images.sh — 加载所有 Docker 镜像
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_DIR="$SCRIPT_DIR/images"

if [ ! -d "$IMAGE_DIR" ]; then
    echo "错误: 镜像目录不存在: $IMAGE_DIR"
    echo "请先在有互联网的机器上运行 build-offline-package.sh 构建镜像"
    exit 1
fi

echo "======================================"
echo "  DeepAnalyze 离线镜像加载"
echo "======================================"
echo ""

for tar_file in "$IMAGE_DIR"/*.tar; do
    if [ -f "$tar_file" ]; then
        echo "加载: $(basename "$tar_file") ..."
        docker load -i "$tar_file"
        echo "完成: $(basename "$tar_file")"
        echo ""
    fi
done

echo "======================================"
echo "  所有镜像加载完成"
echo "======================================"
echo ""
echo "已加载的镜像:"
docker images | grep -E "deepanalyze|ollama" | head -10
echo ""
echo "下一步:"
echo "  1. cp .env.example .env   # 复制并编辑环境变量"
echo "  2. 编辑 config/default.yaml 配置内网推理模型地址"
echo "  3. ./start.sh              # 启动服务"
