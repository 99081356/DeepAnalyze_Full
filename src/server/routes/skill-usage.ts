/**
 * Skill usage routes — Phase 4.
 *
 * Mounted at /api/v1/skills BEFORE /:id marketplace routes so that
 * /usage/top doesn't conflict with /:id.
 *
 * Endpoints:
 *   GET    /usage/top                        — Admin dashboard: top packages
 *   POST   /:id/usage                         — Worker reports a usage event (worker auth)
 *   GET    /:id/usage/stats                   — Admin views aggregate stats
 *   GET    /:id/usage/recent                  — Admin views recent entries
 */

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { workerAuth } from "../middleware/worker-auth.js";
import * as usage from "../../domain/skill-usage.js";

export function createSkillUsageRoutes(): Hono {
  const app = new Hono();

  // ─── Top packages (dashboard) — registered first to avoid /:id match ──

  app.get("/usage/top", jwtAuth, requirePermission("usage:read"), async (c) => {
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const windowHours = parseInt(c.req.query("window_hours") || (24 * 7).toString(), 10);
    const top = await usage.getTopPackages(limit, windowHours);
    return c.json({ top });
  });

  // ─── Worker reports a usage event ───────────────────────────────────

  app.post("/:id/usage", workerAuth, async (c) => {
    const packageId = c.req.param("id");
    const workerId = c.get("workerId") as string;
    const body = await c.req.json<{
      version_id?: string;
      user_id?: string;
      executor_type?: usage.ExecutorType;
      status: usage.UsageStatus;
      duration_ms?: number;
      session_id?: string;
      details?: Record<string, unknown>;
    }>();

    if (!body.status) {
      return c.json({ error: "status required" }, 400);
    }

    try {
      const entry = await usage.logUsage({
        package_id: packageId,
        version_id: body.version_id,
        worker_id: workerId,
        user_id: body.user_id,
        executor_type: body.executor_type ?? "worker",
        status: body.status,
        duration_ms: body.duration_ms,
        session_id: body.session_id,
        details: body.details,
      });
      return c.json({ entry }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("foreign key") || msg.includes("violates")) {
        return c.json({ error: "Package or referenced entity not found" }, 404);
      }
      console.error("[Hub] logUsage error:", err);
      return c.json({ error: "Failed to log usage" }, 500);
    }
  });

  // ─── Aggregate stats ────────────────────────────────────────────────

  app.get("/:id/usage/stats", jwtAuth, requirePermission("usage:read"), async (c) => {
    const packageId = c.req.param("id");
    const stats = await usage.getStats(packageId);
    return c.json({ stats });
  });

  // ─── Recent entries ─────────────────────────────────────────────────

  app.get("/:id/usage/recent", jwtAuth, requirePermission("usage:read"), async (c) => {
    const packageId = c.req.param("id");
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const entries = await usage.listRecent(packageId, limit);
    return c.json({ entries });
  });

  return app;
}
