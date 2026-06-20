/**
 * Worker management routes.
 *
 * POST /api/v1/workers/register   — Register/apply (v1 auto-approve, v2 pending)
 * POST /api/v1/workers/heartbeat  — Heartbeat from a Worker
 * GET  /api/v1/workers            — List all registered Workers
 * GET  /api/v1/workers/:id        — Get Worker details
 * GET  /api/v1/workers/pending    — List pending workers (admin)
 * POST /api/v1/workers/:id/approve — Approve a pending worker (admin)
 * POST /api/v1/workers/:id/reject  — Reject a pending worker (admin)
 */

import { Hono } from "hono";
import { randomUUID } from "crypto";
import { query } from "../../store/pg.js";
import { HUB_CONFIG } from "../../core/config.js";
import { workerAuth } from "../middleware/worker-auth.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import type {
  WorkerRegisterRequest,
  WorkerRegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
} from "../../types/index.js";

export function createWorkerRoutes(): Hono {
  const app = new Hono();

  // ─── Register / Apply ──────────────────────────────────────────────────

  app.post("/register", async (c) => {
    const body = await c.req.json();
    // 支持两种字段命名：camelCase (v1 DA) 和 snake_case (v2)
    const workerIdParam = body.workerId ?? body.worker_id;
    const hostname = body.hostname ?? "unknown";
    const endpoint = body.endpoint ?? "";
    const version = body.version ?? "";
    const capabilities = body.capabilities ?? {};
    const protocolVersion: number = body.protocol_version ?? 1;
    const workerName: string = body.name ?? hostname ?? `worker-${Date.now()}`;

    // v1 兼容路径：如果带了 workerId 且已存在，直接返回 token
    if (workerIdParam) {
      const existing = await query<{ id: string; worker_token: string; status: string }>(
        `SELECT id, worker_token, status FROM workers WHERE id = $1`,
        [workerIdParam],
      );
      if (existing.rows.length > 0) {
        const w = existing.rows[0];
        // 更新心跳和能力信息
        await query(
          `UPDATE workers SET
            hostname = $2,
            endpoint = $3,
            version = $4,
            capabilities = $5,
            name = COALESCE(name, $6),
            last_heartbeat = now(),
            protocol_version = $7
          WHERE id = $1`,
          [w.id, hostname, endpoint, version, JSON.stringify(capabilities), workerName, protocolVersion],
        );

        if (w.status === "approved" || w.status === "online" || w.status === "offline") {
          const response: WorkerRegisterResponse = {
            workerId: w.id,
            workerToken: w.worker_token,
            serverPublicKey: "",
            serverVersion: HUB_CONFIG.version,
          };
          return c.json(response);
        }
        // pending 状态
        return c.json({
          worker_id: w.id,
          worker_token: null,
          status: "pending",
          server_version: HUB_CONFIG.version,
          protocol_version: 2,
          message: "Worker application pending approval",
        }, 202);
      }
    }

    // 新 worker 申请
    const workerId = workerIdParam ?? `wkr_${randomUUID().replace(/-/g, "")}`;
    const workerToken = `wkt_${randomUUID().replace(/-/g, "")}`;

    await query(
      `INSERT INTO workers (id, name, hostname, endpoint, version, capabilities, worker_token, status, protocol_version, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW())`,
      [workerId, workerName, hostname, endpoint, version, JSON.stringify(capabilities), workerToken, protocolVersion],
    );

    await logWorkerEvent(workerId, "apply", `Worker applied: ${workerName} (proto v${protocolVersion})`);

    // v1 协议（现有 DA）：自动审批保持兼容
    if (protocolVersion === 1) {
      await query(
        `UPDATE workers SET status = 'approved', approved_at = NOW(), approved_by = 'system' WHERE id = $1`,
        [workerId],
      );
      await logWorkerEvent(workerId, "approve", "Auto-approved (v1 protocol compat)");

      const response: WorkerRegisterResponse = {
        workerId,
        workerToken,
        serverPublicKey: "",
        serverVersion: HUB_CONFIG.version,
      };
      return c.json(response);
    }

    // v2 协议：返回 pending，等待管理员审批
    return c.json({
      worker_id: workerId,
      worker_token: null,
      status: "pending",
      server_version: HUB_CONFIG.version,
      protocol_version: 2,
      message: "Worker application submitted. Waiting for approval.",
    }, 202);
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────

  app.post("/heartbeat", workerAuth, async (c) => {
    try {
      const workerId = c.get("workerId") as string;
      if (!workerId) {
        return c.json({ error: "Worker not authenticated" }, 401);
      }
      const body = await c.req.json<HeartbeatRequest & { cached_skills?: unknown[]; policy_version?: number; current_task?: string }>();

      const dbStatus = "online";

      await query(
        `UPDATE workers SET
          status = $2,
          last_heartbeat = now(),
          active_sessions = $3,
          active_tasks = $4,
          resource_usage = $5,
          current_task = $6
        WHERE id = $1`,
        [
          workerId,
          dbStatus,
          body.activeSessions ?? 0,
          body.activeTasks ?? 0,
          JSON.stringify(body.resourceUsage ?? {}),
          body.current_task ?? null,
        ],
      );

      // v2 心跳响应——Phase 1 不下发 instructions（Phase 2 实现 SkillSync）
      const response = {
        acknowledged: true,
        message: "OK",
        serverTime: new Date().toISOString(),
        instructions: [] as unknown[],
        policy_version: 1,
        pendingNotifications: [],
      };

      return c.json(response);
    } catch (err) {
      console.error("[Hub] Heartbeat error:", err);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ─── List workers ──────────────────────────────────────────────────────

  app.get("/", async (c) => {
    const { rows } = await query(
      `SELECT id, name, hostname, endpoint, version, capabilities, status,
              last_heartbeat, active_sessions, active_tasks, applied_at, approved_at, protocol_version
       FROM workers ORDER BY applied_at DESC`,
    );
    return c.json({ workers: rows });
  });

  // ─── List pending workers (admin) ──────────────────────────────────────

  app.get("/pending", jwtAuth, requirePermission("worker:approve"), async (c) => {
    const { rows } = await query(
      `SELECT id, name, display_name, hostname, version, capabilities, applied_at, protocol_version
       FROM workers WHERE status = 'pending' ORDER BY applied_at DESC`,
    );
    return c.json({ workers: rows });
  });

  // ─── Get worker details ────────────────────────────────────────────────

  app.get("/:id", async (c) => {
    const { id } = c.req.param();
    const { rows } = await query(
      `SELECT id, name, hostname, endpoint, version, capabilities, status,
              last_heartbeat, active_sessions, active_tasks, resource_usage,
              applied_at, approved_at, approved_by, user_id, organization_id, protocol_version
       FROM workers WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return c.json({ error: "Worker not found" }, 404);
    }
    return c.json(rows[0]);
  });

  // ─── Approve worker (admin) ────────────────────────────────────────────

  app.post("/:id/approve", jwtAuth, requirePermission("worker:approve"), async (c) => {
    const id = c.req.param("id");
    const approverId = c.get("userId");

    const rows = await query<{ status: string }>(
      `SELECT status FROM workers WHERE id = $1`,
      [id],
    );
    if (rows.rows.length === 0) return c.json({ error: "Worker not found" }, 404);
    if (rows.rows[0].status === "approved") return c.json({ error: "Already approved" }, 400);

    const newToken = `wkt_${randomUUID().replace(/-/g, "")}`;
    await query(
      `UPDATE workers SET status = 'approved', approved_at = NOW(), approved_by = $1, worker_token = $2 WHERE id = $3`,
      [approverId, newToken, id],
    );
    await logWorkerEvent(id, "approve", `Approved by user ${approverId}`);

    return c.json({ success: true, worker_token: newToken });
  });

  // ─── Reject worker (admin) ─────────────────────────────────────────────

  app.post("/:id/reject", jwtAuth, requirePermission("worker:reject"), async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const rejecterId = c.get("userId");

    const rows = await query<{ status: string }>(
      `SELECT status FROM workers WHERE id = $1`,
      [id],
    );
    if (rows.rows.length === 0) return c.json({ error: "Worker not found" }, 404);

    await query(`UPDATE workers SET status = 'rejected' WHERE id = $1`, [id]);
    await logWorkerEvent(id, "reject", `Rejected by ${rejecterId}: ${body.reason ?? "no reason"}`);

    return c.json({ success: true });
  });

  return app;
}

/** 记录 worker 连接事件 */
async function logWorkerEvent(workerId: string, eventType: string, detail: string): Promise<void> {
  const id = `evt_${randomUUID().replace(/-/g, "")}`;
  await query(
    `INSERT INTO worker_connection_events (id, worker_id, event_type, detail) VALUES ($1, $2, $3, $4)`,
    [id, workerId, eventType, detail],
  );
}
