// =============================================================================
// JWT 认证中间件
// =============================================================================
// 支持两种方式：
//   1. Authorization: Bearer <jwt>
//   2. X-API-Key: <api_key>
// =============================================================================

import type { MiddlewareHandler } from "hono";
import { verifyAccessToken, verifyApiKey } from "../../domain/auth.js";
import { getUserById, getUserPermissions } from "../../domain/user.js";

export const jwtAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const apiKeyHeader = c.req.header("X-API-Key");

  let userId: string | null = null;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = verifyAccessToken(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    userId = payload.sub;
  } else if (apiKeyHeader) {
    const result = await verifyApiKey(apiKeyHeader);
    if (!result) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    userId = result.userId;
    c.set("apiKeyScope", result.scope);
  } else {
    return c.json({ error: "Authentication required" }, 401);
  }

  const user = await getUserById(userId);
  if (!user || user.status !== "active") {
    return c.json({ error: "User not found or disabled" }, 401);
  }

  const permissions = await getUserPermissions(userId);
  const isSuperAdmin = user.is_super_admin || permissions.includes("*");

  c.set("userId", userId);
  c.set("userPermissions", permissions);
  c.set("userOrgId", user.organization_id);
  c.set("isSuperAdmin", isSuperAdmin);

  // API Key scope enforcement: a read-scoped key may only perform safe (GET/HEAD/OPTIONS)
  // requests. Mutating endpoints are rejected before reaching the handler.
  const scope = c.get("apiKeyScope");
  if (scope === "read") {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      return c.json({ error: `API key scope 'read' forbids ${method} requests` }, 403);
    }
  }

  await next();
};
