// =============================================================================
// Organization Routes — CRUD + 树形查询
// =============================================================================

import { Hono } from "hono";
import {
  createOrg,
  getOrgById,
  getRootOrg,
  buildOrgTree,
  updateOrg,
  deleteOrg,
  listOrgs,
} from "../../domain/organization.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";

export function createOrgRoutes() {
  const router = new Hono();

  router.use("*", jwtAuth);

  // GET /api/v1/orgs — super_admin 全部，其他看本组织子树
  router.get("/", async (c) => {
    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;

    if (isSuperAdmin) {
      const orgs = await listOrgs();
      return c.json({ organizations: orgs });
    }

    if (!userOrgId) {
      return c.json({ organizations: [] });
    }
    const tree = await buildOrgTree(userOrgId);
    return c.json({ organization: tree });
  });

  // GET /api/v1/orgs/tree — 完整组织树
  router.get("/tree", requirePermission("org:read"), async (c) => {
    const tree = await buildOrgTree("root");
    return c.json({ tree });
  });

  // GET /api/v1/orgs/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id")!;
    const org = await getOrgById(id);
    if (!org) return c.json({ error: "Organization not found" }, 404);

    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;
    if (!isSuperAdmin && userOrgId) {
      const userOrg = await getOrgById(userOrgId);
      if (!userOrg || !org.path.startsWith(userOrg.path)) {
        return c.json({ error: "Access denied" }, 403);
      }
    }

    return c.json({ organization: org });
  });

  // GET /api/v1/orgs/:id/tree
  router.get("/:id/tree", async (c) => {
    const id = c.req.param("id")!;
    const tree = await buildOrgTree(id);
    if (!tree) return c.json({ error: "Organization not found" }, 404);
    return c.json({ tree });
  });

  // POST /api/v1/orgs
  router.post("/", requirePermission("org:create"), async (c) => {
    const body = await c.req.json<{
      name: string;
      code: string;
      description?: string;
      parent_id?: string;
      type: string;
      settings?: Record<string, unknown>;
    }>();

    if (!body.name || !body.code || !body.type) {
      return c.json({ error: "name, code, type required" }, 400);
    }

    try {
      // Resolve parent: if not supplied, attach under the system root org
      // (parent_id IS NULL). Avoids hardcoding "root" string which may not
      // match the actual root id in seed data (e.g. "org_dsi").
      let parentId = body.parent_id;
      if (!parentId) {
        const root = await getRootOrg();
        parentId = root?.id;
      }
      const org = await createOrg({
        name: body.name,
        code: body.code,
        description: body.description,
        parent_id: parentId,
        type: body.type,
        settings: body.settings,
      });
      return c.json({ organization: org }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Create failed" },
        400,
      );
    }
  });

  // PATCH /api/v1/orgs/:id
  router.patch("/:id", requirePermission("org:update"), async (c) => {
    const id = c.req.param("id")!;
    const body = await c.req.json();
    const org = await updateOrg(id, body);
    if (!org) return c.json({ error: "Organization not found" }, 404);
    return c.json({ organization: org });
  });

  // DELETE /api/v1/orgs/:id
  router.delete("/:id", requirePermission("org:delete"), async (c) => {
    const id = c.req.param("id")!;
    const result = await deleteOrg(id);
    if (!result.deleted) {
      return c.json({ error: result.reason ?? "Cannot delete" }, 400);
    }
    return c.json({ success: true });
  });

  return router;
}
