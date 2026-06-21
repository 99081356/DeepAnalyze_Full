// =============================================================================
// 权限检查中间件工厂
// =============================================================================

import type { Context } from "hono";
import { matchPermission } from "../../domain/rbac.js";

/**
 * Permission codes gated to admin-scoped API keys only. A write-scoped key
 * (e.g. a CI deploy key) must not perform privileged governance/destructive
 * actions even when the underlying user holds the permission.
 */
const ADMIN_PRIVILEGE_CODES = new Set([
  "skill:kill",
  "skill:approve",
  "role:assign",
  "org:delete",
  "user:delete",
]);

/** 返回一个中间件，检查当前用户是否拥有指定权限码 */
export function requirePermission(code: string) {
  return async (c: Context, next: () => Promise<void>) => {
    const isSuperAdmin = c.get("isSuperAdmin");
    const permissions = c.get("userPermissions") as string[];

    // API Key scope gate: write-scoped keys cannot exercise admin-privilege codes.
    const apiKeyScope = c.get("apiKeyScope");
    if (apiKeyScope && apiKeyScope !== "admin" && ADMIN_PRIVILEGE_CODES.has(code)) {
      return c.json(
        { error: `API key scope '${apiKeyScope}' cannot perform admin action '${code}'` },
        403,
      );
    }

    if (isSuperAdmin || matchPermission(permissions, code)) {
      await next();
      return;
    }
    return c.json({ error: `Permission denied: requires '${code}'` }, 403);
  };
}
