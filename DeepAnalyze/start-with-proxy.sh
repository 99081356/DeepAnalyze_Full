#!/bin/bash
# Start DeepAnalyze server with HTTP proxy for web_fetch tool
# The proxy env vars are saved before main.ts clears them

export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897

echo "[start] Starting DeepAnalyze with proxy $HTTP_PROXY"
exec npx tsx src/main.ts
