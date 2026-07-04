/**
 * Monitoring routes (T18).
 *
 * Two admin-facing endpoints behind JWT auth + worker:read permission:
 *   GET /api/v1/monitoring/overview          — super_admin only, all approved workers
 *   GET /api/v1/monitoring/workers/:id/history — super_admin only, single worker history
 *
 * Both endpoints additionally gate on isSuperAdmin (the brief explicitly says
 * super_admin only — org_admin should not see other orgs' workers).
 */
import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { getPool } from "../../store/pg.js";
import { getOverview, getHealthHistory } from "../../domain/worker-heartbeat.js";

export function createMonitoringRoutes(): Hono {
  const app = new Hono();

  // GET /api/v1/monitoring/overview — super_admin only
  app.get(
    "/overview",
    jwtAuth,
    requirePermission("worker:read"),
    async (c) => {
      // worker:read 已通过 requirePermission 校验；额外要求 super_admin
      // （org_admin 不应看到其他组织的 worker）
      const isSuperAdmin = c.get("isSuperAdmin") === true;
      if (!isSuperAdmin) {
        return c.json({ error: "super_admin only" }, 403);
      }
      const overview = await getOverview(() => getPool());
      return c.json(overview);
    },
  );

  // GET /api/v1/monitoring/workers/:id/history — super_admin only
  app.get(
    "/workers/:id/history",
    jwtAuth,
    requirePermission("worker:read"),
    async (c) => {
      const isSuperAdmin = c.get("isSuperAdmin") === true;
      if (!isSuperAdmin) {
        return c.json({ error: "super_admin only" }, 403);
      }
      const workerId = c.req.param("id");
      const hours = parseInt(c.req.query("hours") ?? "24", 10);
      const history = await getHealthHistory(() => getPool(), workerId, hours);
      return c.json({ items: history });
    },
  );

  return app;
}
