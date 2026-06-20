// =============================================================================
// 权限检查中间件工厂
// =============================================================================

import type { Context } from "hono";
import { matchPermission } from "../../domain/rbac.js";

/** 返回一个中间件，检查当前用户是否拥有指定权限码 */
export function requirePermission(code: string) {
  return async (c: Context, next: () => Promise<void>) => {
    const isSuperAdmin = c.get("isSuperAdmin");
    const permissions = c.get("userPermissions") as string[];

    if (isSuperAdmin || matchPermission(permissions, code)) {
      await next();
      return;
    }
    return c.json({ error: `Permission denied: requires '${code}'` }, 403);
  };
}
