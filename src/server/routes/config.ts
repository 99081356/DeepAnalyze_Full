/**
 * Config management routes.
 *
 * GET  /api/v1/config/recommended  — Get recommended config for Workers
 * GET  /api/v1/config/versions     — Get config version info
 * POST /api/v1/config              — Create a new config version (admin)
 * GET  /api/v1/config/list         — List all config versions (admin)
 */

import { Hono } from "hono";
import { randomUUID } from "crypto";
import { query } from "../../store/pg.js";
import { workerAuth } from "../middleware/worker-auth.js";
import type { RecommendedConfig, ConfigVersionInfo } from "../../types/index.js";

export function createConfigRoutes(): Hono {
  const app = new Hono();

  // ─── Get recommended config (Worker calls this) ────────────────────────

  app.get("/recommended", workerAuth, async (c) => {
    // Get the latest global config
    const { rows } = await query<{
      version: string;
      config_data: RecommendedConfig;
      created_at: string;
    }>(
      `SELECT version, config_data, created_at
       FROM config_versions
       WHERE scope = 'global'
       ORDER BY created_at DESC
       LIMIT 1`,
    );

    if (rows.length === 0) {
      return c.json({ available: false, message: "No recommended config available" });
    }

    const row = rows[0];
    return c.json({
      ...row.config_data,
      version: row.version,
      updatedAt: row.created_at,
    });
  });

  // ─── Get config version info (lightweight check) ───────────────────────

  app.get("/versions", workerAuth, async (c) => {
    const { rows } = await query<{
      version: string;
      created_at: string;
      description: string | null;
    }>(
      `SELECT version, created_at, description
       FROM config_versions
       WHERE scope = 'global'
       ORDER BY created_at DESC
       LIMIT 1`,
    );

    if (rows.length === 0) {
      return c.json({ available: false });
    }

    const info: ConfigVersionInfo = {
      latestVersion: rows[0].version,
      updatedAt: rows[0].created_at,
      description: rows[0].description || undefined,
    };
    return c.json({ available: true, ...info });
  });

  // ─── Create new config version (admin) ─────────────────────────────────

  app.post("/", async (c) => {
    const body = await c.req.json<{
      version: string;
      configData: RecommendedConfig;
      description?: string;
    }>();

    if (!body.version || !body.configData) {
      return c.json({ error: "version and configData are required" }, 400);
    }

    const id = randomUUID();
    await query(
      `INSERT INTO config_versions (version, scope, config_data, description, created_by)
       VALUES ($1, 'global', $2, $3, 'system')`,
      [body.version, JSON.stringify(body.configData), body.description || null],
    );

    return c.json({
      success: true,
      version: body.version,
      message: "Config version created",
    });
  });

  // ─── List all config versions ──────────────────────────────────────────

  app.get("/list", async (c) => {
    const { rows } = await query(
      `SELECT id, version, scope, description, created_by, created_at
       FROM config_versions ORDER BY created_at DESC LIMIT 50`,
    );
    return c.json({ versions: rows });
  });

  return app;
}
