// =============================================================================
// DeepAnalyze Hub - Auth Domain
// =============================================================================
// JWT 双 Token 签发/验证 + API Key 管理。
// Access Token (7d, body) + Refresh Token (30d, HttpOnly Cookie)。
// =============================================================================

import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { query } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";
import { getKeyPair } from "../core/keys.js";

const ACCESS_SECRET = HUB_CONFIG.auth.jwtSecret;
const REFRESH_SECRET = HUB_CONFIG.auth.jwtRefreshSecret;
const ACCESS_EXPIRY = HUB_CONFIG.auth.jwtExpiry;
const REFRESH_EXPIRY = "30d";
const JWT_ISSUER = process.env.HUB_EXTERNAL_URL || `http://localhost:${HUB_CONFIG.port}`;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** 签发 JWT 双 token */
export function issueTokenPair(userId: string): TokenPair {
  const { privateKeyPem, kid } = getKeyPair();
  const access_token = jwt.sign(
    { sub: userId, type: "access", iss: JWT_ISSUER },
    privateKeyPem,
    { algorithm: "RS256", expiresIn: ACCESS_EXPIRY, keyid: kid } as jwt.SignOptions,
  );
  const refresh_token = jwt.sign(
    { sub: userId, type: "refresh", iss: JWT_ISSUER },
    privateKeyPem,
    { algorithm: "RS256", expiresIn: REFRESH_EXPIRY, keyid: kid } as jwt.SignOptions,
  );

  return {
    access_token,
    refresh_token,
    expires_in: parseExpiryToSeconds(ACCESS_EXPIRY),
  };
}

/** 验证 access token */
export function verifyAccessToken(
  token: string,
): { sub: string; type: string } | null {
  try {
    // 先解析 header 决定算法
    const decoded = jwt.decode(token, { complete: true }) as
      | { header: { alg: string; kid?: string } }
      | null;
    if (!decoded) return null;

    if (decoded.header.alg === "RS256") {
      return verifyAccessTokenRs256(token);
    }
    // 兼容期 HS256 — enforce transition deadline if configured
    if (decoded.header.alg === "HS256") {
      const deadline = HUB_CONFIG.auth.hs256TransitionUntil;
      if (deadline && new Date(deadline).getTime() < Date.now()) {
        return null; // transition window expired — reject HS256
      }
      const payload = jwt.verify(token, ACCESS_SECRET) as {
        sub: string;
        type: string;
      };
      if (payload.type !== "access") return null;
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

/** 验证 RS256 access token */
export function verifyAccessTokenRs256(
  token: string,
): { sub: string; type: string } | null {
  try {
    const { publicKeyPem } = getKeyPair();
    const payload = jwt.verify(token, publicKeyPem, {
      algorithms: ["RS256"],
    }) as { sub: string; type: string };
    if (payload.type !== "access") return null;
    return payload;
  } catch {
    return null;
  }
}

/** 验证 refresh token */
export function verifyRefreshToken(
  token: string,
): { sub: string; type: string } | null {
  try {
    const payload = jwt.verify(token, REFRESH_SECRET) as {
      sub: string;
      type: string;
    };
    if (payload.type !== "refresh") return null;
    return payload;
  } catch {
    return null;
  }
}

/** 生成 API Key（明文只返回一次） */
export async function createApiKey(
  userId: string,
  name: string,
  scope: "read" | "write" | "admin",
  expiresAt?: string,
): Promise<{ apiKey: string; keyId: string }> {
  const keyId = `key_${crypto.randomUUID().replace(/-/g, "")}`;
  const randomPart =
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");
  const apiKey = `dak_${randomPart}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  await query(
    `INSERT INTO user_api_keys (id, user_id, name, key_hash, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [keyId, userId, name, keyHash, scope, expiresAt ?? null],
  );

  return { apiKey, keyId };
}

/** 验证 API Key，返回 user_id + scope */
export async function verifyApiKey(
  apiKey: string,
): Promise<{ userId: string; scope: string } | null> {
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  const rows = await query<{ user_id: string; scope: string; expires_at: string | null }>(
    `SELECT user_id, scope, expires_at FROM user_api_keys
     WHERE key_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [keyHash],
  );
  if (rows.rows.length === 0) return null;

  const row = rows.rows[0];
  await query(
    `UPDATE user_api_keys SET last_used_at = NOW() WHERE key_hash = $1`,
    [keyHash],
  );

  return { userId: row.user_id, scope: row.scope };
}

/** 撤销 API Key */
export async function revokeApiKey(
  userId: string,
  keyId: string,
): Promise<boolean> {
  const result = await query(
    `DELETE FROM user_api_keys WHERE id = $1 AND user_id = $2`,
    [keyId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 列出用户的 API Key（不返回 hash） */
export async function listApiKeys(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    scope: string;
    last_used_at: string | null;
    expires_at: string | null;
    created_at: string;
  }>
> {
  const rows = await query<{
    id: string;
    name: string;
    scope: string;
    last_used_at: string | null;
    expires_at: string | null;
    created_at: string;
  }>(
    `SELECT id, name, scope, last_used_at, expires_at, created_at
     FROM user_api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.rows;
}

function parseExpiryToSeconds(exp: string): number {
  const match = exp.match(/^(\d+)([smhdw])$/);
  if (!match) return 7 * 24 * 3600;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };
  return num * (multipliers[unit] ?? 604800);
}
