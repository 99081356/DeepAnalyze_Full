// =============================================================================
// DeepAnalyze - Auth Middleware
// =============================================================================
// Three-mode authentication middleware (none / local / hub).
// none: fully skipped (default, backward compatible)
// local: DA self-signed JWT, bcrypt password verification
// hub: proxy Hub login + JWKS public key local verification
// =============================================================================

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifyLocalJwt } from "../../services/auth/local-idp.js";
import { verifyHubJwt } from "../../services/auth/hub-jwks.js";
import { verifyLocalSession } from "../../services/auth/local-session.js";
import { extractBearer } from "../../services/auth/jwt-utils.js";

// Public auth endpoints that bypass the Bearer token check in local/hub mode.
// Without this, login/setup/logout would be unreachable (chicken-and-egg).
// /api/health is public for uptime/load-balancer checks (no sensitive data).
// /api/hub/config/sync-* in non-hub mode return 400 from T16 gating — but the
// global authMiddleware runs FIRST, so making them public lets T16 gate properly.
export const PUBLIC_AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/setup",
  "/api/auth/logout",
  "/api/auth/mode",
  "/api/auth/sso/callback",   // unauthenticated user hits this first (Hub redirect target)
  "/api/setup/state",
  "/api/setup/environment",
  "/api/setup/complete",
  "/api/setup/download",
  "/api/health",              // uptime checks (no sensitive data)
  "/api/hub/config/sync-status",  // T16 status endpoint — gating returns 400 in non-hub mode
  "/api/hub/config/sync-from-hub", // T16 sync endpoint — T16 gating returns 400 in non-hub mode
]);

export type AuthMode = "none" | "local" | "hub";

export interface AuthUser {
  id: string;
  name: string;
  source: "anonymous" | "local" | "hub";
  orgId?: string;
}

// Decided at startup (immutable at runtime)
let cachedMode: AuthMode | null = null;

export function getAuthMode(): AuthMode {
  if (cachedMode) return cachedMode;
  const raw = (process.env.DA_AUTH_MODE || "none").toLowerCase();
  cachedMode = raw === "local" || raw === "hub" ? raw : "none";
  return cachedMode;
}

// For test reset
export function _resetAuthModeCache(): void {
  cachedMode = null;
}

export const authMiddleware: MiddlewareHandler<{
  Variables: { user: AuthUser };
}> = async (c, next) => {
  const mode = getAuthMode();

  if (mode === "none") {
    c.set("user", {
      id: "default-user",
      name: "anonymous",
      source: "anonymous",
    });
    return next();
  }

  // Public auth endpoints bypass token check (login/setup/logout must be
  // accessible without a Bearer token — otherwise no one could ever log in).
  if (PUBLIC_AUTH_PATHS.has(c.req.path)) {
    return next();
  }

  // hub 模式优先认本地 session cookie（由 /sso/callback 签发）→ 再回退到
  // Hub Bearer（API 客户端 / cookie 过期后刷新）→ 浏览器重定向 Hub 登录 → 401
  if (mode === "hub") {
    // 1. Prefer local session cookie
    const sessionCookie = getCookie(c, "da_session");
    if (sessionCookie) {
      const u = await verifyLocalSession(sessionCookie);
      if (u) {
        c.set("user", {
          id: u.sub,
          name: u.name,
          source: "hub",
          orgId: u.orgId ?? undefined,
        });
        return next();
      }
      // Invalid cookie — clear it
      c.header(
        "Set-Cookie",
        "da_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      );
    }

    // 2. Browser request without credentials — redirect to Hub login
    // NOTE: Bearer token fallback 已禁用 — 任何 Hub 用户不能直接用 access_token
    // 访问任意 DA Worker。所有认证必须走 SSO cookie 路径（/sso/callback 签发），
    // 确保用户与 Worker 的一对一绑定。
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      const hubUrl = process.env.DA_HUB_URL ?? "";
      // DA_HUB_EXTERNAL_URL is the browser-reachable URL (e.g. http://localhost:22000)
      // while DA_HUB_URL may be an internal Docker address (e.g. http://host.docker.internal:22000)
      const hubExternalUrl = process.env.DA_HUB_EXTERNAL_URL || hubUrl;
      const loginUrl = hubExternalUrl
        ? `${hubExternalUrl}/login?redirect=${encodeURIComponent(c.req.url)}`
        : "/login";
      return c.redirect(loginUrl);
    }

    // 4. API client without credentials — 401
    return c.json({ error: "unauthorized" }, 401);
  }

  // local mode: parse Bearer token
  const authHeader = c.req.header("Authorization") ?? "";
  const token = extractBearer(authHeader);

  if (!token) {
    return c.json(
      { error: "unauthorized", message: "missing bearer token" },
      401,
    );
  }

  try {
    const user = await verifyToken(token, mode);
    if (!user) {
      return c.json({ error: "invalid_token" }, 401);
    }
    c.set("user", user);
    await next();
  } catch (err) {
    return c.json(
      {
        error: "token_verification_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      401,
    );
  }
};

// Local mode verification (hub mode handles itself above with cookie priority)
async function verifyToken(
  token: string,
  mode: AuthMode,
): Promise<AuthUser | null> {
  if (mode === "local") {
    const u = await verifyLocalJwt(token);
    return u ? { id: u.id, name: u.name, source: "local" } : null;
  }
  return null;
}
