// =============================================================================
// User Routes — CRUD + 角色分配 + 权限隔离
// =============================================================================

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import {
  createUser,
  getUserById,
  listAllUsers,
  listUsersByOrg,
  updateUser,
  getUserRoleIds,
  getUserPermissions,
} from "../../domain/user.js";
import { listRoles, assignRole, removeRole } from "../../domain/rbac.js";

export function createUserRoutes() {
  const router = new Hono();
  router.use("*", jwtAuth);

  // GET /api/v1/users
  router.get("/", requirePermission("user:read"), async (c) => {
    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;
    const page = parseInt(c.req.query("page") ?? "1", 10);
    const pageSize = parseInt(c.req.query("pageSize") ?? "50", 10);

    if (isSuperAdmin) {
      const users = await listAllUsers(pageSize, (page - 1) * pageSize);
      return c.json({ users, page, pageSize });
    }

    if (!userOrgId) return c.json({ users: [] });
    const users = await listUsersByOrg(userOrgId);
    return c.json({ users });
  });

  // GET /api/v1/users/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id")!;
    const user = await getUserById(id);
    if (!user) return c.json({ error: "User not found" }, 404);

    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;
    const requesterId = c.get("userId");
    if (id !== requesterId && !isSuperAdmin && user.organization_id !== userOrgId) {
      return c.json({ error: "Access denied" }, 403);
    }

    const roleIds = await getUserRoleIds(id);
    return c.json({
      user: { ...user, password_hash: undefined, roles: roleIds },
    });
  });

  // POST /api/v1/users
  router.post("/", requirePermission("user:create"), async (c) => {
    const body = await c.req.json<{
      username: string;
      email?: string;
      display_name?: string;
      password: string;
      organization_id?: string;
      is_org_admin?: boolean;
    }>();

    if (!body.username || !body.password) {
      return c.json({ error: "username and password required" }, 400);
    }

    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;
    if (!isSuperAdmin) {
      if (!userOrgId) return c.json({ error: "No organization context" }, 400);
      body.organization_id = userOrgId;
    }

    try {
      const user = await createUser({
        username: body.username,
        email: body.email,
        display_name: body.display_name,
        password: body.password,
        organization_id: body.organization_id,
        is_org_admin: body.is_org_admin,
      });
      return c.json(
        { user: { ...user, password_hash: undefined } },
        201,
      );
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Create failed" },
        400,
      );
    }
  });

  // PATCH /api/v1/users/:id
  router.patch("/:id", requirePermission("user:update"), async (c) => {
    const id = c.req.param("id")!;
    const body = await c.req.json();

    const isSuperAdmin = c.get("isSuperAdmin");
    if (!isSuperAdmin && body.is_super_admin !== undefined) {
      delete body.is_super_admin;
    }

    const user = await updateUser(id, body);
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ user: { ...user, password_hash: undefined } });
  });

  // POST /api/v1/users/:id/roles
  router.post("/:id/roles", requirePermission("role:assign"), async (c) => {
    const id = c.req.param("id")!;
    const body = await c.req.json<{ role_id: string }>();
    if (!body.role_id) return c.json({ error: "role_id required" }, 400);

    await assignRole(id, body.role_id);
    const roleIds = await getUserRoleIds(id);
    return c.json({ roles: roleIds });
  });

  // DELETE /api/v1/users/:id/roles/:roleId
  router.delete(
    "/:id/roles/:roleId",
    requirePermission("role:assign"),
    async (c) => {
      const id = c.req.param("id")!;
      const roleId = c.req.param("roleId")!;

      if (roleId === "role_super_admin") {
        return c.json({ error: "Cannot remove super_admin role" }, 400);
      }

      await removeRole(id, roleId);
      const roleIds = await getUserRoleIds(id);
      return c.json({ roles: roleIds });
    },
  );

  // GET /api/v1/users/:id/permissions
  router.get("/:id/permissions", async (c) => {
    const id = c.req.param("id")!;
    const requesterId = c.get("userId");
    const isSuperAdmin = c.get("isSuperAdmin");
    if (id !== requesterId && !isSuperAdmin) {
      return c.json({ error: "Access denied" }, 403);
    }
    const permissions = await getUserPermissions(id);
    return c.json({ permissions });
  });

  return router;
}
