// =============================================================================
// config-templates 路由（T13）
// =============================================================================
// 7 endpoints:
//   - GET/PUT /global (jwtAuth + requirePermission)
//   - GET/PUT /orgs/:orgId (jwtAuth + requirePermission + cross-org check)
//   - GET /merged (jwtAuth + requirePermission)
//   - GET /history (jwtAuth + requirePermission)
//   - GET /by-worker/merged (workerAuth — for DA backend sync, unblocks T15)
// =============================================================================

import { Hono } from "hono";
import {
  upsertGlobalTemplate,
  upsertOrgTemplate,
  getMergedTemplate,
  getHistory,
} from "../../domain/config-template.js";
import type { RecommendedConfig } from "../../domain/config-template.js";
import { getPool } from "../../store/pg.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { workerAuth } from "../middleware/worker-auth.js";
import { requirePermission } from "../middleware/require-permission.js";

export function createConfigTemplateRoutes(): Hono {
  const app = new Hono();

  // ─── User-facing routes (Hub admin UI) ──────────────────────────────────
  // All require jwtAuth. Read routes use requirePermission("config_template:read");
  // write routes use requirePermission("config_template:manage") AND additional role/scope checks.

  // GET /global — any user with config_template:read
  app.get("/global", jwtAuth, requirePermission("config_template:read"), async (c) => {
    const { rows } = await getPool().query(
      `SELECT content, version, updated_at FROM config_templates WHERE scope = 'global' LIMIT 1`,
    );
    if (rows.length === 0) return c.json({ content: null, version: null, updated_at: null });
    return c.json(rows[0]);
  });

  // PUT /global — super_admin only (explicit isSuperAdmin check; org_admin has :manage but is rejected here)
  app.put("/global", jwtAuth, requirePermission("config_template:manage"), async (c) => {
    if (c.get("isSuperAdmin") !== true) {
      return c.json({ error: "Only super admin can edit global template" }, 403);
    }
    const body = await c.req.json<{ content: RecommendedConfig }>();
    const userId = c.get("userId") as string;
    await upsertGlobalTemplate(() => getPool(), {
      content: body.content,
      updatedBy: userId,
    });
    return c.json({ ok: true });
  });

  // GET /orgs/:orgId — super_admin OR same-org user with :read
  app.get(
    "/orgs/:orgId",
    jwtAuth,
    requirePermission("config_template:read"),
    async (c) => {
      const orgId = c.req.param("orgId");
      if (c.get("isSuperAdmin") !== true && c.get("userOrgId") !== orgId) {
        return c.json({ error: "forbidden" }, 403);
      }
      const { rows } = await getPool().query(
        `SELECT content, version, updated_at FROM config_templates
         WHERE scope = 'org' AND org_id = $1 LIMIT 1`,
        [orgId],
      );
      if (rows.length === 0) return c.json({ content: null, version: null, updated_at: null });
      return c.json(rows[0]);
    },
  );

  // PUT /orgs/:orgId — super_admin OR same-org user with :manage
  app.put(
    "/orgs/:orgId",
    jwtAuth,
    requirePermission("config_template:manage"),
    async (c) => {
      const orgId = c.req.param("orgId");
      if (c.get("isSuperAdmin") !== true && c.get("userOrgId") !== orgId) {
        return c.json({ error: "forbidden" }, 403);
      }
      const body = await c.req.json<{ content: RecommendedConfig }>();
      const userId = c.get("userId") as string;
      await upsertOrgTemplate(() => getPool(), {
        orgId,
        content: body.content,
        updatedBy: userId,
      });
      return c.json({ ok: true });
    },
  );

  // GET /merged — returns merged content for the calling user's context
  // (query params optional: workerId or orgId to merge for a different scope)
  app.get("/merged", jwtAuth, requirePermission("config_template:read"), async (c) => {
    const workerId = c.req.query("workerId") ?? null;
    const orgId = c.req.query("orgId") ?? null;
    const content = await getMergedTemplate(() => getPool(), { workerId, orgId });
    return c.json({ content });
  });

  // GET /history — version history (super_admin sees all scopes; org_admin sees own org + global)
  app.get("/history", jwtAuth, requirePermission("config_template:read"), async (c) => {
    const scope = (c.req.query("scope") ?? "global") as "global" | "org";
    const orgId = c.req.query("orgId") ?? null;
    // Scope guard: org_admin querying org history must match own org
    if (
      scope === "org" &&
      orgId &&
      c.get("isSuperAdmin") !== true &&
      c.get("userOrgId") !== orgId
    ) {
      return c.json({ error: "forbidden" }, 403);
    }
    const items = await getHistory(() => getPool(), { scope, orgId });
    return c.json({ items });
  });

  // ─── Worker-facing routes (DA backend sync) ─────────────────────────────
  // Uses workerAuth middleware (validates Bearer worker_token; sets c.get("workerId"))

  app.get("/by-worker/merged", workerAuth, async (c) => {
    const workerId = c.get("workerId") as string;
    const content = await getMergedTemplate(() => getPool(), { workerId });
    return c.json({ content });
  });

  return app;
}
