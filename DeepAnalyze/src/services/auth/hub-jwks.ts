// =============================================================================
// DeepAnalyze - Hub JWKS Public Key Sync
// =============================================================================
// hub 模式：DA 启动时从 Hub 拉公钥，缓存到 data/auth/hub-jwks.json。
// 每 6h 后台刷新；Hub 不可达时用最后缓存的公钥继续验签。
// =============================================================================

import { jwtVerify } from "jose";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseJwtHeader } from "./jwt-utils.js";

interface Jwk {
  kty: string;
  kid: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

interface CachedJwks {
  fetchedAt: string;
  hubUrl: string;
  keys: Jwk[];
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours

function getAuthDir(): string {
  return process.env.DA_AUTH_DIR || resolve(process.cwd(), "data/auth");
}

function getCachePath(): string {
  return join(getAuthDir(), "hub-jwks.json");
}

function getHubUrl(): string {
  const url = process.env.DA_HUB_URL;
  if (!url) throw new Error("DA_HUB_URL not set");
  return url;
}

/** 返回用于 JWT issuer 校验的 URL（优先使用浏览器可达的外部地址，与 Hub 的 HUB_EXTERNAL_URL 对应） */
function getHubIssuerUrl(): string {
  return process.env.DA_HUB_EXTERNAL_URL || getHubUrl();
}

// 内存缓存：kid -> JWK
const cachedKeys = new Map<string, Jwk>();
let cacheLoaded = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function loadCacheFromDisk(): void {
  const path = getCachePath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as CachedJwks;
    for (const k of data.keys) {
      cachedKeys.set(k.kid, k);
    }
    console.log(`[hub-jwks] loaded ${data.keys.length} keys from disk cache`);
  } catch (err) {
    console.warn(`[hub-jwks] failed to read cache: ${err instanceof Error ? err.message : err}`);
  }
  cacheLoaded = true;
}

async function fetchAndCacheJwks(): Promise<boolean> {
  const url = `${getHubUrl()}/api/v1/auth/jwks.json`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      console.warn(`[hub-jwks] fetch returned ${resp.status}`);
      return false;
    }
    const data = await resp.json() as { keys: Jwk[] };
    cachedKeys.clear();
    for (const k of data.keys) {
      cachedKeys.set(k.kid, k);
    }

    // 写盘
    const cachePath = getCachePath();
    mkdirSync(getAuthDir(), { recursive: true });
    const cache: CachedJwks = {
      fetchedAt: new Date().toISOString(),
      hubUrl: getHubUrl(),
      keys: data.keys,
    };
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    console.log(`[hub-jwks] fetched ${data.keys.length} keys from ${url}`);
    return true;
  } catch (err) {
    console.warn(`[hub-jwks] fetch failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export async function refreshHubJwks(): Promise<void> {
  if (!cacheLoaded) loadCacheFromDisk();
  await fetchAndCacheJwks();
}

export function startJwksRefreshTimer(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    fetchAndCacheJwks().catch(err => {
      console.warn(`[hub-jwks] background refresh error: ${err}`);
    });
  }, REFRESH_INTERVAL_MS);
  // Don't keep the Node.js event loop alive solely for this timer
  refreshTimer.unref();
}

export function stopJwksRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Reset the in-memory JWKS cache — intended for test isolation only.
 * Clears cached keys, resets the loaded flag, and stops the refresh timer.
 */
export function _resetHubJwksCache(): void {
  cachedKeys.clear();
  cacheLoaded = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function verifyWithJwk(token: string, jwk: Jwk): Promise<{
  id: string;
  name: string;
  source: "hub";
  orgId?: string;
} | null> {
  try {
    const keyObj = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const { payload } = await jwtVerify(token, keyObj, {
      issuer: getHubIssuerUrl(),
      algorithms: ["RS256"],
    });
    return {
      id: payload.sub ?? "unknown",
      name: (payload.name as string) ?? "unknown",
      source: "hub",
      orgId: payload.org_id as string | undefined,
    };
  } catch {
    return null;
  }
}

export async function verifyHubJwt(token: string): Promise<{
  id: string;
  name: string;
  source: "hub";
  orgId?: string;
} | null> {
  if (!cacheLoaded) loadCacheFromDisk();
  if (cachedKeys.size === 0) {
    console.warn("[hub-jwks] no cached keys, attempting refresh");
    await fetchAndCacheJwks();
  }
  if (cachedKeys.size === 0) {
    return null;  // 无法验签
  }

  // O(1) kid 查找：从 token header 提取 kid，直接定位公钥
  const header = parseJwtHeader(token);
  if (header?.kid) {
    const jwk = cachedKeys.get(header.kid);
    if (jwk) {
      const result = await verifyWithJwk(token, jwk);
      if (result) return result;
      // kid 命中但验签失败 -> token 无效，不再尝试其他 key
      return null;
    }
  }

  // kid 缺失或未命中缓存：遍历尝试（兼容 key 轮换期间旧 token）
  for (const [, jwk] of cachedKeys) {
    const result = await verifyWithJwk(token, jwk);
    if (result) return result;
  }

  return null;
}

export async function proxyHubLogin(
  username: string,
  password: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | null> {
  try {
    const resp = await fetch(`${getHubUrl()}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return await resp.json() as { access_token: string };
  } catch {
    return null;
  }
}
