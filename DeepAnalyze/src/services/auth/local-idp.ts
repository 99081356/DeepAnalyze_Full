// =============================================================================
// DeepAnalyze - Local mini-IdP
// =============================================================================
// local 模式：DA 自管账号 + bcrypt 密码 + 本地 RS256 JWT。
// 私钥存 data/auth/da-key.pem，公钥存 data/auth/da-pub.pem。
// =============================================================================

import bcrypt from "bcryptjs";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SignJWT, jwtVerify, importSPKI, importPKCS8 } from "jose";

const ALG = "RS256";
const KID = "da-local-v1";
const ISSUER = "da-local";

let cachedPrivateKey: CryptoKey | null = null;
let cachedPublicKey: CryptoKey | null = null;

function getAuthDir(): string {
  return process.env.DA_AUTH_DIR || resolve(process.cwd(), "data/auth");
}

export async function ensureLocalKeypair(): Promise<void> {
  if (cachedPrivateKey && cachedPublicKey) return;

  const authDir = getAuthDir();
  const keyPath = join(authDir, "da-key.pem");
  const pubPath = join(authDir, "da-pub.pem");

  if (!existsSync(keyPath) || !existsSync(pubPath)) {
    // 生成新 keypair
    mkdirSync(authDir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const privPem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const pubPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    writeFileSync(keyPath, privPem, { mode: 0o600 });
    writeFileSync(pubPath, pubPem, { mode: 0o644 });

    cachedPrivateKey = await importPKCS8(privPem, ALG);
    cachedPublicKey = await importSPKI(pubPem, ALG);
    return;
  }

  // 加载已存在 keypair
  const privPem = readFileSync(keyPath, "utf-8");
  const pubPem = readFileSync(pubPath, "utf-8");
  cachedPrivateKey = await importPKCS8(privPem, ALG);
  cachedPublicKey = await importSPKI(pubPem, ALG);
}

/**
 * Get the cached private key (calling ensureLocalKeypair first if needed).
 * Used by local-session.ts to sign DA-local session cookies with the same
 * RS256 keypair as local-IdP tokens (distinguished by issuer/audience).
 */
export async function getCachedPrivateKey(): Promise<CryptoKey> {
  await ensureLocalKeypair();
  return cachedPrivateKey!;
}

/**
 * Get the cached public key (calling ensureLocalKeypair first if needed).
 */
export async function getCachedPublicKey(): Promise<CryptoKey> {
  await ensureLocalKeypair();
  return cachedPublicKey!;
}

export async function signLocalJwt(
  userId: string,
  name: string,
): Promise<string> {
  await ensureLocalKeypair();
  return new SignJWT({ name, source: "local" })
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(cachedPrivateKey!);
}

export async function verifyLocalJwt(token: string): Promise<{
  id: string;
  name: string;
  source: "local";
} | null> {
  try {
    await ensureLocalKeypair();
    const { payload } = await jwtVerify(token, cachedPublicKey!, {
      issuer: ISSUER,
      algorithms: [ALG],
    });
    if (payload.sub == null) return null;
    return {
      id: payload.sub,
      name: (payload.name as string) ?? "unknown",
      source: "local",
    };
  } catch {
    return null;
  }
}

// --- bcrypt 密码 ---

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
