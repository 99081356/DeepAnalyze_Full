/**
 * Worker management routes.
 *
 * POST /api/v1/workers/register   — Register a new Worker
 * POST /api/v1/workers/heartbeat  — Heartbeat from a Worker
 * GET  /api/v1/workers            — List all registered Workers (admin)
 * GET  /api/v1/workers/:id        — Get Worker details (admin)
 */

import { Hono } from "hono";
import { randomUUID } from "crypto";
import { query } from "../../store/pg.js";
import { HUB_CONFIG } from "../../core/config.js";
import { workerAuth } from "../middleware/worker-auth.js";
import type {
  WorkerRegisterRequest,
  WorkerRegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
} from "../../types/index.js";

export function createWorkerRoutes(): Hono {
  const app = new Hono();

  // ─── Register ──────────────────────────────────────────────────────────

  app.post("/register", async (c) => {
    const body = await c.req.json<WorkerRegisterRequest>();

    if (!body.workerId) {
      return c.json({ error: "workerId is required" }, 400);
    }

    // Generate a token for this worker
    const workerToken = `wkt_${randomUUID().replace(/-/g, "")}`;

    // Upsert: if worker already registered, update its info
    const existing = await query(
      "SELECT id FROM workers WHERE id = $1",
      [body.workerId],
    );

    if (existing.rows.length > 0) {
      // Update existing worker
      await query(
        `UPDATE workers SET
          hostname = $2,
          endpoint = $3,
          version = $4,
          capabilities = $5,
          status = 'online',
          worker_token = $6,
          last_heartbeat = now(),
          active_sessions = 0,
          active_tasks = 0
        WHERE id = $1`,
        [
          body.workerId,
          body.hostname || "unknown",
          body.endpoint || "",
          body.version || "",
          JSON.stringify(body.capabilities || {}),
          workerToken,
        ],
      );
    } else {
      // Register new worker
      await query(
        `INSERT INTO workers (id, hostname, endpoint, version, capabilities, status, worker_token, last_heartbeat)
         VALUES ($1, $2, $3, $4, $5, 'online', $6, now())`,
        [
          body.workerId,
          body.hostname || "unknown",
          body.endpoint || "",
          body.version || "",
          JSON.stringify(body.capabilities || {}),
          workerToken,
        ],
      );
    }

    const response: WorkerRegisterResponse = {
      workerId: body.workerId,
      workerToken,
      serverPublicKey: "",
      serverVersion: HUB_CONFIG.version,
    };

    return c.json(response);
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────

  app.post("/heartbeat", workerAuth, async (c) => {
    const workerId = c.get("workerId") as string;
    const body = await c.req.json<HeartbeatRequest>();

    await query(
      `UPDATE workers SET
        status = $2,
        last_heartbeat = now(),
        active_sessions = $3,
        active_tasks = $4,
        resource_usage = $5
      WHERE id = $1`,
      [
        workerId,
        body.status || "online",
        body.activeSessions ?? 0,
        body.activeTasks ?? 0,
        JSON.stringify(body.resourceUsage || {}),
      ],
    );

    const response: HeartbeatResponse = {
      acknowledged: true,
      serverTime: new Date().toISOString(),
      pendingNotifications: [],
    };

    return c.json(response);
  });

  // ─── List workers (admin, no auth yet) ─────────────────────────────────

  app.get("/", async (c) => {
    const { rows } = await query(
      `SELECT id, hostname, endpoint, version, capabilities, status,
              last_heartbeat, active_sessions, active_tasks, registered_at
       FROM workers ORDER BY registered_at DESC`,
    );
    return c.json({ workers: rows });
  });

  // ─── Get worker details ────────────────────────────────────────────────

  app.get("/:id", async (c) => {
    const { id } = c.req.param();
    const { rows } = await query(
      `SELECT id, hostname, endpoint, version, capabilities, status,
              last_heartbeat, active_sessions, active_tasks, resource_usage, registered_at
       FROM workers WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return c.json({ error: "Worker not found" }, 404);
    }
    return c.json(rows[0]);
  });

  return app;
}
