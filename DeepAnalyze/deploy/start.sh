#!/bin/bash
# =============================================================================
# start.sh — 启动 DeepAnalyze 所有服务
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "创建 .env 文件..."
    cp .env.example .env
    echo "已创建 .env，使用默认配置。如需修改请编辑 .env 文件。"
fi

# 检查镜像是否已加载
if ! docker images | grep -q "deepanalyze-backend.*offline"; then
    echo "错误: 未找到 deepanalyze-backend:offline 镜像"
    echo "请先运行: ./load-images.sh"
    exit 1
fi

echo "======================================"
echo "  启动 DeepAnalyze 服务..."
echo "======================================"

# 创建必要的目录
mkdir -p models

# 启动核心服务（不含 Ollama）
docker compose up -d

echo ""
echo "等待服务启动..."

# 等待 PostgreSQL 健康
echo -n "  PostgreSQL: "
for i in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U deepanalyze >/dev/null 2>&1; then
        echo "OK"
        break
    fi
    sleep 1
done

# 等待 Backend 健康
echo -n "  Backend: "
for i in $(seq 1 60); do
    if curl -sf http://localhost:${BACKEND_PORT:-21000}/api/health >/dev/null 2>&1; then
        echo "OK"
        break
    fi
    sleep 2
done

echo ""
echo "======================================"
echo "  DeepAnalyze 已启动!"
echo "======================================"
echo ""
echo "  前端地址:    http://localhost:${FRONTEND_PORT:-3000}"
echo "  后端 API:    http://localhost:${BACKEND_PORT:-21000}/api"
echo "  健康检查:    http://localhost:${BACKEND_PORT:-21000}/api/health"
echo ""
echo "如需启动本地嵌入模型 (Ollama):"
echo "  docker compose --profile embedding up ollama -d"
echo "  然后在容器内拉取模型: docker exec -it <ollama容器名> ollama pull bge-m3"
echo ""
echo "配置推理模型:"
echo "  1. 在前端 '设置' 页面添加/修改 Provider"
echo "  2. 或编辑 config/default.yaml 后运行 docker compose restart backend"
echo ""
echo "停止服务: ./stop.sh"
