#!/bin/bash
# DeepAnalyze Hub Docker Entrypoint
# Auto-generate RSA keypair for JWT RS256 signing if files don't exist

KEYS_DIR="/app/data/keys"
PUB_KEY="$KEYS_DIR/pub.pem"
PRIV_KEY="$KEYS_DIR/priv.pem"

# Resolve actual paths from env vars or use defaults
PUB_PATH="${HUB_JWT_PUBLIC_KEY_PATH:-$PUB_KEY}"
PRIV_PATH="${HUB_JWT_PRIVATE_KEY_PATH:-$PRIV_KEY}"

# Generate keys if either file is missing
if [ ! -f "$PUB_PATH" ] || [ ! -f "$PRIV_PATH" ]; then
  mkdir -p "$(dirname "$PUB_PATH")"
  echo "[entrypoint] Generating RSA keypair for JWT RS256..."
  openssl genpkey -algorithm RSA -out "$PRIV_PATH" -pkeyopt rsa_keygen_bits:2048
  openssl rsa -pubout -in "$PRIV_PATH" -out "$PUB_PATH"
  echo "[entrypoint] RSA keypair generated"
else
  echo "[entrypoint] Reusing existing RSA keypair"
fi

# Ensure env vars point to the key files
export HUB_JWT_PUBLIC_KEY_PATH="$PUB_PATH"
export HUB_JWT_PRIVATE_KEY_PATH="$PRIV_PATH"

exec bun run src/main.ts
