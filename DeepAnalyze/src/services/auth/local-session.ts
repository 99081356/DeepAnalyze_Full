// =============================================================================
// DeepAnalyze - DA-local Session (RS256 cookie)
// =============================================================================
// 当 Hub SSO callback 成功交换到 user access_token 后，DA 签发自己的本地
// session JWT，写入 HttpOnly cookie。后续 DA 请求不再依赖 Hub 验签。
// 复用 local-idp.ts 的 da-key.pem（同一 RS256 密钥，靠 issuer/audience 区分）。
// =============================================================================

import { SignJWT, jwtVerify } from "jose";
import { ensureLocalKeypair, getCachedPrivateKey, getCachedPublicKey } from "./local-idp.js";

const SESSION_TTL_SECONDS = 8 * 3600; // 8h
const SESSION_ISSUER = "da-local-session";
const SESSION_AUDIENCE = "da-local";

export interface SessionPayload {
  sub: string;          // Hub user id
  name: string;
  orgId: string | null; // camelCase per AuthUser convention
  daWorkerId: string;
  exp?: number;         // for testing override (seconds since epoch)
}

/**
 * Sign a DA-local session JWT using the existing da-key.pem keypair
 * (shared with local-idp.ts — same RS256 key, different issuer/audience).
 */
export async function signLocalSession(payload: SessionPayload): Promise<string> {
  await ensureLocalKeypair();
  const privateKey = await getCachedPrivateKey();

  const jwt = await new SignJWT({
    sub: payload.sub,
    name: payload.name,
    orgId: payload.orgId,
    daWorkerId: payload.daWorkerId,
  })
    .setProtectedHeader({ alg: "RS256", kid: "da-local-session-v1" })
    .setIssuedAt()
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime(payload.exp ?? `${SESSION_TTL_SECONDS}s`)
    .sign(privateKey);

  return jwt;
}

/**
 * Verify a DA-local session JWT. Returns null on invalid/expired/tampered.
 */
export async function verifyLocalSession(jwt: string): Promise<SessionPayload | null> {
  try {
    await ensureLocalKeypair();
    const publicKey = await getCachedPublicKey();

    const { payload } = await jwtVerify(jwt, publicKey, {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ["RS256"],
    });

    return {
      sub: payload.sub as string,
      name: payload.name as string,
      orgId: (payload.orgId as string | null) ?? null,
      daWorkerId: payload.daWorkerId as string,
    };
  } catch {
    return null;
  }
}
