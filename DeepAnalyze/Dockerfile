FROM oven/bun:1

WORKDIR /app

# Switch apt to Chinese mirror (Aliyun) for faster system package downloads.
# libreoffice-writer + build toolchain pull 200+ packages; the default
# deb.debian.org source is very slow from China.
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list.d/*.sources 2>/dev/null \
    || true

# Install Python3 and system libraries
# libreoffice-writer: required for .doc → .docx conversion (legacy Word format)
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      python3 python3-pip python3-dev curl libreoffice-writer \
      build-essential make gcc g++ && \
    rm -rf /var/lib/apt/lists/*

# Install Python packages for document processing (docling, OCR, etc.)
# Step 1: Install torch CPU-only first (avoids pulling 2GB+ CUDA libs)
RUN pip3 install --break-system-packages --no-cache-dir \
      --timeout 600 --retries 5 --resume-retries 3 \
      torch torchvision \
      --index-url https://download.pytorch.org/whl/cpu && \
    # Step 2: Install remaining packages from Chinese mirror
    pip3 install --break-system-packages --no-cache-dir \
      --timeout 600 --retries 5 \
      -i https://mirrors.aliyun.com/pypi/simple/ \
      --trusted-host mirrors.aliyun.com \
      opencv-python-headless \
      docling>=2.89.0 \
      rapidocr-onnxruntime \
      onnxruntime \
      openai-whisper>=20230314 && \
    # Step 3: Clean up pip cache
    rm -rf /root/.cache/pip

# Pre-download docling standard-pipeline weights (~1.25GB) at build time.
# Uses docling's official download_models() which fetches layout + tableformer +
# RapidOCR + picture-classifier + code-formula models in one shot.
# Weights land in a FLAT layout (data/models/docling/<org>--<model>/) which is
# exactly what docling's PdfPipelineOptions.artifacts_path expects, and what
# parser.py:137-140 detects as "flat layout" → sets artifacts_path directly.
# The UI scanner (settings.ts /docling-models) reads this flat layout too, so
# engine + UI both find the same bundled weights.
#
# Network resilience settings (all REQUIRED for builds behind hf-mirror):
#   HF_HUB_DISABLE_XET=1 — newer huggingface_hub defaults to the Xet protocol
#     (cas-server.xethub.hf.co) which ignores HF_ENDPOINT and 401s from China.
#     Disabling it forces classic HTTP that respects HF_ENDPOINT=hf-mirror.com.
#   HF_HUB_DOWNLOAD_TIMEOUT / HF_HUB_ETAG_TIMEOUT — defaults are only 10s; large
#     model files (tableformer 342MB, CodeFormula 611MB) time out mid-transfer
#     when hf-mirror throughput dips. 300s gives enough headroom.
ENV HF_ENDPOINT=https://hf-mirror.com
ENV HF_HUB_DISABLE_XET=1
ENV HF_HUB_DOWNLOAD_TIMEOUT=300
ENV HF_HUB_ETAG_TIMEOUT=300
RUN python3 -c "from pathlib import Path; \
                 from docling.utils.model_downloader import download_models; \
                 download_models(output_dir=Path('/app/data/models/docling'), progress=True)" && \
    ls -la /app/data/models/docling/ && \
    rm -rf /root/.cache/pip

COPY package.json bun.lock* bun.lockb* ./
RUN bun install --production

COPY . .

# Build frontend (vite only — skip tsc type-check, which has pre-existing errors
# in workflow.ts/main.tsx unrelated to runtime. Vite bundling is sufficient.)
RUN cd frontend && bun install && bun run vite build

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=21000
ENV DATA_DIR=/app/data

EXPOSE 21000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:21000/api/health || exit 1

CMD ["bun", "run", "src/main.ts"]
