// =============================================================================
// DeepAnalyze Hub - RSA Keypair Loader
// =============================================================================
// 启动时加载 RSA keypair（用于 RS256 JWT 签名）。
// 优先从环境变量指定的 PEM 文件加载；缺失则生成临时对（仅开发环境）。
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { generateKeyPairSync, createPublicKey, randomUUID } from "node:crypto";
import { HUB_CONFIG } from "./config.js";

export interface Jwk {
  kty: "RSA";
  use: "sig";
  alg: "RS256";
  kid: string;
  n: string;
  e: string;
}

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  kid: string;
  jwk: Jwk;
}

let cachedKeyPair: KeyPair | null = null;

export function getKeyPair(): KeyPair {
  if (cachedKeyPair) return cachedKeyPair;

  const pubPath = HUB_CONFIG.auth.rs256.publicKeyPath;
  const privPath = HUB_CONFIG.auth.rs256.privateKeyPath;
  const kid = HUB_CONFIG.auth.rs256.keyId;

  let publicKeyPem: string;
  let privateKeyPem: string;

  if (pubPath && privPath && existsSync(pubPath) && existsSync(privPath)) {
    publicKeyPem = readFileSync(pubPath, "utf-8");
    privateKeyPem = readFileSync(privPath, "utf-8");
  } else if (HUB_CONFIG.env === "development") {
    // 开发环境自动生成临时对（每次重启变化，DA 会触发 JWKS 重拉）
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    console.warn("[keys] development mode: generated ephemeral RSA keypair");
  } else {
    throw new Error(
      "[keys] production requires HUB_JWT_PUBLIC_KEY_PATH and HUB_JWT_PRIVATE_KEY_PATH",
    );
  }

  // 转 JWK 格式（仅公钥）
  const pubKeyObj = createPublicKey(publicKeyPem);
  const jwkObj = pubKeyObj.export({ format: "jwk" }) as {
    n: string;
    e: string;
  };

  const jwk: Jwk = {
    kty: "RSA",
    use: "sig",
    alg: "RS256",
    kid,
    n: jwkObj.n,
    e: jwkObj.e,
  };

  cachedKeyPair = { publicKeyPem, privateKeyPem, kid, jwk };
  return cachedKeyPair;
}
