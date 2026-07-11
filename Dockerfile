# =============================================================================
# DeepAnalyze Hub - Multi-stage Docker Build
# =============================================================================

# ── Stage 1: Build frontend ─────────────────────────────────────────────────
FROM oven/bun:1 AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json ./
COPY frontend/bun.lock* frontend/package-lock.json* ./
RUN bun install

COPY frontend/ ./
RUN bun run build

# ── Stage 2: Production image ───────────────────────────────────────────────
FROM oven/bun:1-slim

# Switch to Aliyun mirror for faster apt installs in China
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null \
    || true

# Install curl + openssl for healthcheck and RSA keypair generation
RUN apt-get update && apt-get install -y --no-install-recommends curl openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install docker CLI (static binary) for local Worker container management.
# We only need the CLI client, not the daemon — Hub talks to host Docker via mounted socket.
# Use Aliyun mirror for better connectivity in China.
ARG DOCKER_CLI_VERSION=26.1.4
RUN curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
    && chmod +x /usr/local/bin/docker

WORKDIR /app

# Install backend dependencies
COPY package.json ./
RUN bun install --production

# Copy backend source
COPY src/ ./src/
COPY tsconfig.json ./

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Create data directories
RUN mkdir -p /app/data/model-repo /app/data/bundle/images /app/data/backups /app/data/keys

# Copy entrypoint script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Default environment
ENV PORT=22000
ENV NODE_ENV=production
ENV PG_HOST=postgres
ENV PG_PORT=5432
ENV PG_DATABASE=deepanalyze_hub
ENV PG_USER=deepanalyze_hub

EXPOSE 22000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -sf http://localhost:22000/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
