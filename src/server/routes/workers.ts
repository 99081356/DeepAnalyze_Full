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
import { generateInstructions, recordSyncAck } from "../../domain/skill-sync-service.js";
import { createJoinToken, listJoinTokens, consumeJoinToken } from "../../domain/join-token.js";
import type {
  WorkerRegisterRequest,
  WorkerRegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  SkillSyncInstruction,
  CachedSkill,
} from "../../types/index.js";

export function createWorkerRoutes(): Hono {
  const app = new Hono();

  // ─── Register / Apply ──────────────────────────────────────────────────

  app.post("/register", async (c) => {
    const body = await c.req.json();

    // ── join_token 路径：消费 token，提取 org/user 绑定 ──
    const joinToken: string | undefined = body.join_token;
    let assignedUserId: string | null = null;
    let organizationIdFromJoin: string | null = null;

    if (joinToken) {
      const consumed = await consumeJoinToken(joinToken);
      if (!consumed.valid) {
        return c.json({ error: consumed.reason || "invalid join_token" }, 400);
      }
      organizationIdFromJoin = consumed.meta!.organizationId;
      assignedUserId = consumed.meta!.assignedUserId;
    }

    // 支持两种字段命名：camelCase (v1 DA) 和 snake_case (v2)
    const workerIdParam = body.workerId ?? body.worker_id;
    const hostname = body.hostname ?? "unknown";
    const endpoint = body.endpoint ?? "";
    const version = body.version ?? "";
    const capabilities = body.capabilities ?? {};
    const protocolVersion: number = body.protocol_version ?? 1;
    const workerName: string = body.name ?? hostname ?? `worker-${Date.now()}`;
    // org association — accept both org_id (snake) and organization_id (camel)
    const orgIdParam: string | undefined = body.org_id ?? body.organization_id;

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

    const finalOrgId = organizationIdFromJoin ?? orgIdParam ?? null;
    const finalUserId = assignedUserId ?? body.user_id ?? null;
    const initialStatus = joinToken ? "approved" : "pending";

    await query(
      `INSERT INTO workers (id, name, hostname, endpoint, version, capabilities, worker_token,
                            status, protocol_version, applied_at, organization_id, user_id,
                            approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11,
               CASE WHEN $12 THEN NOW() ELSE NULL END,
               CASE WHEN $12 THEN 'join_token' ELSE NULL END)`,
      [workerId, workerName, hostname, endpoint, version, JSON.stringify(capabilities), workerToken,
       initialStatus, protocolVersion, finalOrgId, finalUserId, joinToken ? true : false],
    );

    await logWorkerEvent(workerId, "apply", `Worker applied: ${workerName} (proto v${protocolVersion})`);

    // join_token 路径：已经 auto-approved，直接返回 token
    if (joinToken) {
      await logWorkerEvent(workerId, "approve", "Auto-approved via join_token");
      return c.json({
        worker_id: workerId,
        worker_token: workerToken,
        status: "approved",
        server_version: HUB_CONFIG.version,
        protocol_version: protocolVersion,
      });
    }

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
      const body = await c.req.json<HeartbeatRequest & { cached_skills?: CachedSkill[]; policy_version?: number; current_task?: string }>();

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

      // v2 SkillSync: compute diff between expected and cached skills
      let instructions: SkillSyncInstruction[] = [];
      if (body.cached_skills && Array.isArray(body.cached_skills)) {
        try {
          instructions = await generateInstructions(workerId, body.cached_skills);
        } catch (err) {
          console.error("[Hub] SkillSync error:", err);
        }
      }

      const response = {
        acknowledged: true,
        message: "OK",
        serverTime: new Date().toISOString(),
        instructions,
        policy_version: body.policy_version ?? 1,
        pendingNotifications: [],
      };

      return c.json(response);
    } catch (err) {
      console.error("[Hub] Heartbeat error:", err);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ─── Self-deactivate (DA 主动退出 Hub) ──────────────────────────────────

  app.post("/me/deactivate", workerAuth, async (c) => {
    const workerId = c.get("workerId") as string;
    await query(
      `UPDATE workers
       SET status = 'deactivated',
           deactivated_at = NOW()
       WHERE id = $1`,
      [workerId],
    );
    // worker_token remains in DB but workerAuth middleware will reject
    // subsequent requests because status is in BLOCKED_STATUSES.
    return c.json({ status: "deactivated", worker_id: workerId });
  });

  // ─── Worker ack (confirm instruction executed) ────────────────────────

  app.post("/ack", workerAuth, async (c) => {
    try {
      const workerId = c.get("workerId") as string;
      const body = await c.req.json<{ instruction_id: string; action?: string; package_id?: string }>();
      if (!body.instruction_id) {
        return c.json({ error: "instruction_id required" }, 400);
      }

      // Look up the instruction we sent — but we don't persist instructions in Phase 2.
      // Workers send back the full instruction shape for now.
      // The ack is purely informational; the real state tracking is worker_skill_cache.

      // If worker reports a successful sync, update worker_skill_cache
      // (The worker should include the full instruction object in the ack body)
      const instruction = body as SkillSyncInstruction;
      if (instruction.action && instruction.package_id) {
        await recordSyncAck(workerId, instruction);
      }

      return c.json({ acknowledged: true });
    } catch (err) {
      console.error("[Hub] Ack error:", err);
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

  // ─── Join-token management (admin) ─────────────────────────────────────

  app.post("/join-tokens", jwtAuth, requirePermission("worker:approve"), async (c) => {
    const body = await c.req.json();
    const count = Math.min(body.count || 1, 50);
    const orgId = body.organization_id;
    if (!orgId) return c.json({ error: "organization_id required" }, 400);

    const creatorId = c.get("userId") as string;
    const tokens: { id: string; token: string; expires_at: Date }[] = [];
    for (let i = 0; i < count; i++) {
      const created = await createJoinToken({
        organizationId: orgId,
        assignedUserId: body.assigned_user_id,
        createdBy: creatorId,
        expiresInHours: body.expires_in_hours ?? 24,
        maxUses: body.max_uses ?? 1,
        notes: body.notes,
      });
      tokens.push({
        id: created.id,
        token: created.token,
        expires_at: created.expiresAt,
      });
    }
    return c.json({ tokens }, 201);
  });

  app.get("/join-tokens", jwtAuth, requirePermission("worker:approve"), async (c) => {
    const orgId = c.req.query("organization_id");
    const rows = await listJoinTokens(orgId);
    return c.json({ tokens: rows });
  });

  app.delete("/join-tokens/:id", jwtAuth, requirePermission("worker:approve"), async (c) => {
    const id = c.req.param("id");
    await query(`DELETE FROM join_tokens WHERE id = $1`, [id]);
    return c.json({ ok: true });
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
