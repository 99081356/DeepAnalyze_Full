# MinerU local service — based on opendatalab/MinerU.
# Two build args: DEVICE=cuda|cpu controls torch wheel variant.
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

ARG DEVICE=cpu

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_ENDPOINT=https://hf-mirror.com

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 libglib2.0-0 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install torch based on device variant
RUN if [ "$DEVICE" = "cuda" ]; then \
        pip3 install --extra-index-url https://download.pytorch.org/whl/cu121 torch torchvision; \
    else \
        pip3 install torch torchvision --index-url https://download.pytorch.org/whl/cpu; \
    fi

# Install MinerU (magic-pdf CLI + library)
RUN pip3 install -U "magic-pdf[full]" || pip3 install -U magic-pdf

# Pre-download models to /app/models (overridden by volume mount at runtime)
ENV MODEL_SOURCE=HF

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8001/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
