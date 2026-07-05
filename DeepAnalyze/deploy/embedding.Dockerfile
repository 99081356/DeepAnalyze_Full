FROM python:3.10-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Install torch CPU-only first
RUN pip install --no-cache-dir \
      torch torchvision \
      --index-url https://download.pytorch.org/whl/cpu

# Install sentence-transformers
RUN pip install --no-cache-dir \
      -i https://mirrors.aliyun.com/pypi/simple/ \
      --trusted-host mirrors.aliyun.com \
      sentence-transformers

# Copy embedding server script
COPY embedding_server.py /app/embedding_server.py

# Copy BGE-M3 model files into the image
ARG MODEL_DIR=data/models/bge-m3
COPY ${MODEL_DIR}/ /app/models/bge-m3/

ENV TOKENIZERS_PARALLELISM=false

EXPOSE 11435

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:11435/health || exit 1

CMD ["python3", "/app/embedding_server.py", "--host", "0.0.0.0", "--port", "11435", "--model-path", "/app/models/bge-m3"]
