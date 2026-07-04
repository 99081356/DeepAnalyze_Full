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
import * as crypto from "node:crypto";
import { query } from "../../store/pg.js";
import { HUB_CONFIG } from "../../core/config.js";
import { encryptString } from "../../core/crypto.js";
import { deployWorker, upgradeWorker, stopWorker, restartWorker, rollbackWorker, resolveHostServerSsh } from "../../domain/worker-deployment.js";
import { allocatePortBlock } from "../../domain/port-allocation.js";
import { getPool } from "../../store/pg.js";
import { workerAuth } from "../middleware/worker-auth.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { generateInstructions, recordSyncAck } from "../../domain/skill-sync-service.js";
import { createJoinToken, listJoinTokens, consumeJoinToken } from "../../domain/join-token.js";
// T18: heartbeat domain — records audit history + updates the 4 worker columns
import { recordHeartbeat } from "../../domain/worker-heartbeat.js";
// T19: worker backup domain — metadata-only backup records
import {
  createBackupRecord,
  listBackups,
  getBackup,
  deleteBackup,
} from "../../domain/worker-backup.js";
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
      const body = await c.req.json<HeartbeatRequest & {
        cached_skills?: CachedSkill[];
        policy_version?: number;
        current_task?: string;
        // T18: 模块健康快照 + DA 版本（DA HubClient.heartbeat 会带上这两个字段）
        moduleHealth?: Record<string, unknown>;
        daVersion?: string;
      }>();

      // ── T18: 委托 domain 处理持久化（写入历史审计表 + 更新 workers 4 列） ──
      // 这取代了原先直接在这里做的 UPDATE workers 语句。
      // 注意：recordHeartbeat 同时更新 last_heartbeat（migration 001 列）以保持向后兼容。
      await recordHeartbeat(getPool, {
        workerId,
        status: body.status,
        activeSessions: body.activeSessions,
        activeTasks: body.activeTasks,
        resourceUsage: body.resourceUsage,
        uptime: body.uptime,
        daVersion: body.daVersion,
        moduleHealth: body.moduleHealth,
        currentTask: body.current_task,
      });

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

  // ─── Deploy (SSH-based orchestration) ──────────────────────────────────
  // IMPORTANT: /deploy and /deploy-jobs/:id must be registered BEFORE /:id
  // to avoid Hono matching "deploy" as a worker ID.

  app.post("/deploy", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const body = await c.req.json();

    // ── 1. Resolve SSH details ────────────────────────────────────────────
    let sshHost: string;
    let sshPort: number;
    let sshUser: string;
    let sshKeyPem: string;
    let hostServerId: string | null = null;
    let hostPort: number | null = null;

    if (body.host_server_id) {
      // New path: resolve via host_servers table
      const resolved = await resolveHostServerSsh(body.host_server_id);
      if (!resolved) {
        return c.json({ error: "host_server not found, inactive, or missing SSH key" }, 400);
      }
      sshHost = resolved.sshHost;
      sshPort = resolved.sshPort;
      sshUser = resolved.sshUser;
      sshKeyPem = resolved.sshKeyPem;
      hostServerId = resolved.hostServerId;

      // Allocate port block (T03 helper)
      const pool = getPool();
      const allocated = await allocatePortBlock(() => pool, hostServerId);
      if (allocated === null) {
        return c.json({ error: "port range exhausted on this host_server" }, 409);
      }
      hostPort = allocated;
    } else {
      // Legacy path: raw SSH fields in body (must all be present)
      const required = ["organization_id", "ssh_host", "ssh_user", "ssh_private_key", "image_tag"];
      for (const f of required) {
        if (!body[f]) return c.json({ error: `${f} required (or provide host_server_id)` }, 400);
      }
      sshHost = body.ssh_host;
      sshPort = body.ssh_port || 22;
      sshUser = body.ssh_user;
      sshKeyPem = body.ssh_private_key;
    }

    // organization_id is always required
    if (!body.organization_id) {
      return c.json({ error: "organization_id required" }, 400);
    }
    if (!body.image_tag) {
      return c.json({ error: "image_tag required" }, 400);
    }

    // ── 2. Dry-run preview ─────────────────────────────────────────────────
    if (body.dry_run) {
      return c.json({
        job_id: `dpl_preview_${Date.now()}`,
        status: "preview",
        summary: {
          target: `${sshUser}@${sshHost}:${sshPort}`,
          host_server_id: hostServerId,
          host_port: hostPort,
          image_tag: body.image_tag,
          source: body.source || "hub_stream",
        },
      });
    }

    // ── 3. Create join token ──────────────────────────────────────────────
    const joinToken = await createJoinToken({
      organizationId: body.organization_id,
      assignedUserId: body.assigned_user_id,
      createdBy: c.get("userId"),
      expiresInHours: 24,
    });

    // ── 4. Pre-create worker record (extend INSERT with host_id/host_port) ─
    const workerId = `wkr_${crypto.randomUUID().replace(/-/g, "")}`;
    await query(
      `INSERT INTO workers (id, name, hostname, endpoint, version, capabilities,
                            worker_token, status, protocol_version, applied_at,
                            organization_id, user_id, ssh_target_host, ssh_target_port,
                            ssh_user, ssh_key_encrypted, current_image_tag,
                            host_id, host_port, gpu_device)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 2, NOW(),
               $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17)`,
      [workerId, body.container_name || `da-${body.assigned_user_id || "default"}`,
       sshHost, `http://${sshHost}:21000`, body.image_tag, JSON.stringify({}),
       `wkt_${crypto.randomUUID().replace(/-/g, "")}`,
       body.organization_id, body.assigned_user_id || null,
       sshHost, sshPort, sshUser,
       encryptString(sshKeyPem), body.image_tag,
       hostServerId,                              // host_id (nullable)
       hostPort,                                  // host_port (nullable)
       body.gpu_device ?? null,                   // gpu_device (nullable)
      ],
    );

    // ── 5. Async trigger deployWorker ──────────────────────────────────────
    const hubBaseUrl = process.env.HUB_EXTERNAL_URL || `http://localhost:${HUB_CONFIG.port}`;
    deployWorker({
      workerId,
      sshHost,
      sshPort,
      sshUser,
      sshPrivateKeyPem: sshKeyPem,
      imageTag: body.image_tag,
      source: body.source || "hub_stream",
      hubBaseUrl,
      containerName: body.container_name || `da-${workerId.slice(0, 12)}`,
      containerPort: 21000,
      envVars: {
        DA_AUTH_MODE: "hub",
        DA_HUB_URL: hubBaseUrl,
        DA_JOIN_TOKEN: joinToken.token,
        DA_ORG_ID: body.organization_id,
        ...(body.cpu_limit != null ? { DA_CPU_LIMIT: String(body.cpu_limit) } : {}),
        ...(body.mem_limit_mb != null ? { DA_MEM_LIMIT_MB: String(body.mem_limit_mb) } : {}),
        ...(body.env_vars || {}),
      },
      volumeMounts: body.volume_mounts || [`da-data-${workerId.slice(0, 12)}:/app/data`],
      initiatedBy: c.get("userId"),
    }).catch((err) => console.error("[deploy] async error:", err));

    return c.json({
      job_id: workerId,
      worker_id: workerId,
      status: "deploying",
      join_token: joinToken.token,
      host_server_id: hostServerId,
      host_port: hostPort,
    }, 202);
  });

  // GET /api/v1/workers/deploy-jobs/:id — query deploy job status
  app.get("/deploy-jobs/:id", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const id = c.req.param("id");
    const result = await query(
      `SELECT * FROM deploy_jobs WHERE id = $1`, [id],
    );
    if (result.rows.length === 0) return c.json({ error: "job not found" }, 404);
    return c.json(result.rows[0]);
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

  // ─── Worker lifecycle: upgrade / stop / restart / rollback ─────────────

  app.post("/:id/upgrade", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const workerId = c.req.param("id");
    const body = await c.req.json<{ to_tag?: string; image_tag?: string; dry_run?: boolean }>().catch(() => ({} as any));
    // T19: 接受 to_tag（新规范）或 image_tag（向后兼容）
    const newTag = body.to_tag ?? body.image_tag;
    if (!newTag) return c.json({ error: "to_tag (or image_tag) required" }, 400);

    if (body.dry_run) {
      // 预检：worker 存在 + host_id 非空 + image_tag 不同
      const { rows } = await getPool().query(
        `SELECT id, current_image_tag, host_id FROM workers WHERE id = $1`,
        [workerId],
      );
      if (rows.length === 0) return c.json({ error: "worker not found" }, 404);
      if (!rows[0].host_id) return c.json({ error: "worker has no host_id (legacy deploy)" }, 400);
      if (rows[0].current_image_tag === newTag) {
        return c.json({ error: "already on this tag" }, 400);
      }
      return c.json({ ok: true, dry_run: true, from_tag: rows[0].current_image_tag, to_tag: newTag });
    }

    try {
      const result = await upgradeWorker(workerId, newTag, c.get("userId"));
      return c.json(result, result.success ? 200 : 500);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/:id/stop", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const workerId = c.req.param("id");
    const result = await stopWorker(workerId, c.get("userId"));
    return c.json(result, result.success ? 200 : 500);
  });

  app.post("/:id/restart", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const workerId = c.req.param("id");
    const result = await restartWorker(workerId, c.get("userId"));
    return c.json(result, result.success ? 200 : 500);
  });

  app.post("/:id/rollback", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const workerId = c.req.param("id");
    const body = await c.req.json<{ backup_id?: string }>().catch(() => ({} as any));

    try {
      const result = await rollbackWorker(workerId, c.get("userId"), body.backup_id);
      return c.json(result, result.success ? 200 : 500);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ─── T19: Worker backup management ─────────────────────────────────────

  app.get("/:id/backups", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const items = await listBackups(getPool, c.req.param("id"));
    return c.json({ items });
  });

  app.post("/:id/backups", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const workerId = c.req.param("id");
    const userId = c.get("userId");
    const body = await c.req.json<{ backup_type?: "manual" | "scheduled" }>().catch(() => ({} as any));

    // Look up worker for from_tag
    const { rows } = await getPool().query(
      `SELECT current_image_tag FROM workers WHERE id = $1`,
      [workerId],
    );
    if (rows.length === 0) return c.json({ error: "worker not found" }, 404);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = await createBackupRecord(getPool, {
      workerId,
      backupType: body.backup_type ?? "manual",
      fromTag: rows[0].current_image_tag,
      pgDumpPath: `/opt/da/${workerId}/backups/${ts}.dump`,
      dataArchivePath: `/opt/da/${workerId}/backups/${ts}-data.tar.gz`,
      createdBy: userId,
    });
    return c.json(backup, 201);
  });

  app.delete("/:id/backups/:backupId", jwtAuth, requirePermission("worker:deploy"), async (c) => {
    const workerId = c.req.param("id");
    const backupId = c.req.param("backupId");

    // Verify backup belongs to this worker
    const backup = await getBackup(getPool, backupId);
    if (!backup) return c.json({ error: "backup not found" }, 404);
    if (backup.worker_id !== workerId) return c.json({ error: "backup does not belong to this worker" }, 403);

    const ok = await deleteBackup(getPool, backupId);
    return c.json({ ok });
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
