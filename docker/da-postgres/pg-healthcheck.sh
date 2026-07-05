#!/bin/sh
# HEALTHCHECK 脚本 — docker 用
# 用 pg_isready 检查 PG 是否接受连接
set -e

# POSTGRES_USER env 由 docker run -e 设置
USER="${POSTGRES_USER:-da}"

if pg_isready -U "$USER" -d "${POSTGRES_DB:-deepanalyze}" >/dev/null 2>&1; then
  exit 0
else
  exit 1
fi
