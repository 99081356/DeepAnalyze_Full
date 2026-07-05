# PaddleOCR-VL-1.5 Inference Service
# Standalone FastAPI service exposing OpenAI-compatible API for document OCR.
#
# Build:
#   docker build -t paddleocr-vl-service .
#
# Run (GPU):
#   docker run --gpus all -p 8600:8600 -v ./data/models:/app/models paddleocr-vl-service
#
# Run (CPU, not recommended):
#   docker run -p 8600:8600 -v ./data/models:/app/models paddleocr-vl-service

FROM python:3.10-slim

WORKDIR /app

# Install system dependencies (use Chinese mirror for apt)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list 2>/dev/null || true && \
    apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      libgl1-mesa-glx libglib2.0-0 curl && \
    rm -rf /var/lib/apt/lists/*

# Install PyTorch with CUDA support (use Chinese mirror for pip)
ARG TORCH_INDEX=https://mirrors.aliyun.com/pytorch-wheels/cu121
RUN pip install --no-cache-dir torch torchvision -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com --extra-index-url ${TORCH_INDEX}

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com

# Copy service code
COPY main.py .

# Model directory — mount local models here to avoid re-downloading
RUN mkdir -p /app/models

ENV MODEL_PATH=/app/models/docling/vlm/PaddlePaddle--PaddleOCR-VL-1.5
ENV TORCH_DTYPE=bfloat16
ENV MAX_TOKENS=8192
ENV PORT=8600

EXPOSE 8600

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8600/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8600", "--workers", "1"]
