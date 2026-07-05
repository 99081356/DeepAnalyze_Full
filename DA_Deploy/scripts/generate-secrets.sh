#!/usr/bin/env bash
# =============================================================================
# DeepAnalyze Hub - 密钥/密码生成器
# =============================================================================
# 一次性生成生产环境所需的所有密钥，写入 .env：
#   - PG_PASSWORD / JWT_SECRET / JWT_REFRESH_SECRET / HUB_DATA_KEY / ADMIN_INIT_PASSWORD
#   - RSA keypair（写入 ./secrets/keys/，compose 挂载进容器）
#
# 用法：
#   cd DA_Deploy
#   ./scripts/generate-secrets.sh
#
# 已存在的 .env 会先备份为 .env.bak.<timestamp>，不会覆盖手动配置项。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"
KEYS_DIR="./secrets/keys"
TEMPLATE=".env.production.example"

# ---------- helpers ----------
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

gen_token() {
  # 32 字节随机 -> base64（44 字符），去掉 = 结尾
  openssl rand -base64 32 | tr -d '=' | tr '+/' '-_'
}

gen_password() {
  # 16 字符强随机密码（字母+数字），可读性优先
  openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c "${1:-16}"
}

require_openssl() {
  if ! command -v openssl >/dev/null 2>&1; then
    red "找不到 openssl，请先安装。"
    exit 1
  fi
}

# ---------- preflight ----------
require_openssl

# ---------- 生成密钥值 ----------
JWT_SECRET="$(gen_token)"
JWT_REFRESH_SECRET="$(gen_token)"
PG_PASSWORD="$(gen_password 24)"
HUB_DATA_KEY="$(gen_token)"
ADMIN_INIT_PASSWORD="$(gen_password 16)"

# ---------- RSA keypair ----------
mkdir -p "$KEYS_DIR"
if [[ -f "$KEYS_DIR/priv.pem" ]]; then
  yellow "  ℹ RSA 私钥已存在，跳过生成（复用 $KEYS_DIR/priv.pem）"
else
  green "[1/3] 生成 RSA keypair (RS256, 2048-bit)..."
  openssl genpkey -algorithm RSA -out "$KEYS_DIR/priv.pem" -pkeyopt rsa_keygen_bits:2048
  openssl rsa -pubout -in "$KEYS_DIR/priv.pem" -out "$KEYS_DIR/pub.pem" 2>/dev/null
  chmod 600 "$KEYS_DIR/priv.pem"
  chmod 644 "$KEYS_DIR/pub.pem"
fi

# ---------- 写入 .env ----------
green "[2/3] 写入 $ENV_FILE ..."

# 初始化 .env：基于模板或备份现有
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$TEMPLATE" ]]; then
    cp "$TEMPLATE" "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi
else
  BACKUP=".env.bak.$(date +%Y%m%d_%H%M%S)"
  cp "$ENV_FILE" "$BACKUP"
  yellow "  ℹ 已存在 .env，备份为 $BACKUP"
fi

# 写入函数：若 key 已存在则替换该行，否则追加
set_env() {
  local key="$1" val="$2"
  # 转义 / 用于 sed
  local esc_val; esc_val="${val//\//\\/}"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # macOS sed 与 GNU sed 兼容写法
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' -E "s|^${key}=.*|${key}=${esc_val}|" "$ENV_FILE"
    else
      sed -i -E "s|^${key}=.*|${key}=${esc_val}|" "$ENV_FILE"
    fi
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

set_env PG_PASSWORD          "$PG_PASSWORD"
set_env JWT_SECRET           "$JWT_SECRET"
set_env JWT_REFRESH_SECRET   "$JWT_REFRESH_SECRET"
set_env HUB_DATA_KEY         "$HUB_DATA_KEY"
set_env ADMIN_INIT_PASSWORD  "$ADMIN_INIT_PASSWORD"

# ---------- 完成 ----------
green "[3/3] 完成。生成的密钥已写入 $ENV_FILE（已脱敏展示）"
cat <<EOF

  PG_PASSWORD          = ${PG_PASSWORD:0:4}****（共 ${#PG_PASSWORD} 字符）
  JWT_SECRET           = ${JWT_SECRET:0:4}****（共 ${#JWT_SECRET} 字符）
  JWT_REFRESH_SECRET   = ${JWT_REFRESH_SECRET:0:4}****（共 ${#JWT_REFRESH_SECRET} 字符）
  HUB_DATA_KEY         = ${HUB_DATA_KEY:0:4}****（共 ${#HUB_DATA_KEY} 字符）
  ADMIN_INIT_PASSWORD  = ${ADMIN_INIT_PASSWORD:0:4}****（共 ${#ADMIN_INIT_PASSWORD} 字符）
  RSA keypair          = $KEYS_DIR/{pub,priv}.pem

下一步：
  1. 编辑 $ENV_FILE，确认 HUB_EXTERNAL_URL=http://<内网IP>:22000
  2. 妥善备份 .env 与 $KEYS_DIR/（丢失 RSA 私钥会导致现有 token 全部失效）
  3. 启动：docker compose -f docker-compose.prod.yml up -d
  4. 首次登录用 admin + 上面的 ADMIN_INIT_PASSWORD（已展示截断，请查看 $ENV_FILE 完整值）

EOF
