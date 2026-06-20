// =============================================================================
// RBAC Routes — 角色/权限查询 + 权限分配
// =============================================================================

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import {
  listRoles,
  listPermissions,
  getRolePermissions,
  setRolePermissions,
} from "../../domain/rbac.js";

export function createRbacRoutes() {
  const router = new Hono();
  router.use("*", jwtAuth);

  // GET /api/v1/rbac/roles
  router.get("/roles", async (c) => {
    const orgId = c.req.query("org_id");
    const roles = await listRoles(orgId);
    return c.json({ roles });
  });

  // GET /api/v1/rbac/roles/:id/permissions
  router.get("/roles/:id/permissions", async (c) => {
    const id = c.req.param("id");
    const codes = await getRolePermissions(id);
    return c.json({ permissions: codes });
  });

  // PUT /api/v1/rbac/roles/:id/permissions
  router.put("/roles/:id/permissions", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ permission_codes: string[] }>();
    if (!Array.isArray(body.permission_codes)) {
      return c.json({ error: "permission_codes must be array" }, 400);
    }

    if (!c.get("isSuperAdmin")) {
      return c.json(
        { error: "Only super admin can modify role permissions" },
        403,
      );
    }

    try {
      await setRolePermissions(id, body.permission_codes);
      return c.json({ success: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Update failed" },
        400,
      );
    }
  });

  // GET /api/v1/rbac/permissions
  router.get("/permissions", async (c) => {
    const permissions = await listPermissions();
    return c.json({ permissions });
  });

  return router;
}
