/**
 * Skill workflow routes — Phase 3: state machine + approval + audit + force_update.
 *
 * Endpoints:
 *   POST   /skills/:id/versions/:vid/start-test      draft → internal_test
 *   POST   /skills/:id/versions/:vid/canary          → canary
 *   POST   /skills/:id/versions/:vid/request-publish → create approval request
 *   POST   /skills/:id/versions/:vid/publish         → published (requires approval for org/system)
 *   POST   /skills/:id/versions/:vid/deprecate       → deprecated
 *   POST   /skills/:id/versions/:vid/rollback        → rolled_back
 *
 *   GET    /skills/approvals                         — list pending approvals (admin)
 *   GET    /skills/approvals/:aid                    — get approval detail
 *   POST   /skills/approvals/:aid/approve            — approve (admin)
 *   POST   /skills/approvals/:aid/reject             — reject (admin)
 *
 *   POST   /skills/:id/force-update                  — enqueue force_update instruction (admin)
 *   GET    /skills/:id/audit                         — view audit log
 */

import { Hono, type Context } from "hono";
import { randomUUID } from "crypto";
import { query } from "../../store/pg.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import * as skillPkg from "../../domain/skill-package.js";
import * as stateMachine from "../../domain/skill-state-machine.js";
import * as auditLog from "../../domain/skill-audit-log.js";
import * as approval from "../../domain/skill-approval.js";
import { evaluateForPublish } from "../../domain/publish-gate.js";
import type { VersionStatus } from "../../domain/skill-state-machine.js";

type Ctx = Context;

export function createSkillWorkflowRoutes(): Hono {
  const app = new Hono();

  // ─── Helper: check if user can act on this package ────────────────────

  async function authorizePackageAction(
    pkgId: string,
    userId: string,
    isSuperAdmin: boolean,
    userOrgId: string | null,
    requireAdmin: boolean,
  ): Promise<{ ok: boolean; status: 200 | 403 | 404; error?: string; pkg?: Awaited<ReturnType<typeof skillPkg.getPackageWithScope>> }> {
    const pkg = await skillPkg.getPackageWithScope(pkgId);
    if (!pkg) return { ok: false, status: 404, error: "Package not found" };

    if (isSuperAdmin) return { ok: true, status: 200, pkg };

    if (requireAdmin) {
      if (pkg.scope === "org" && pkg.org_id === userOrgId) return { ok: true, status: 200, pkg };
      return { ok: false, status: 403, error: "Admin permission required" };
    }

    if (pkg.author_id === userId) return { ok: true, status: 200, pkg };
    return { ok: false, status: 403, error: "Only the author can perform this action" };
  }

  // ─── State transitions ────────────────────────────────────────────────

  async function transition(
    c: Ctx,
    target: VersionStatus,
    requireAdmin: boolean,
  ) {
    const userId = c.get("userId") as string;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const userOrgId = c.get("userOrgId") as string | null;
    const pkgId = c.req.param("id")!;
    const versionId = c.req.param("vid")!;

    const auth = await authorizePackageAction(pkgId, userId, isSuperAdmin, userOrgId, requireAdmin);
    if (!auth.ok || !auth.pkg) {
      return c.json({ error: auth.error }, auth.status);
    }

    const version = await skillPkg.getVersion(versionId);
    if (!version) return c.json({ error: "Version not found" }, 404);
    if (version.package_id !== pkgId) return c.json({ error: "Version does not belong to package" }, 400);

    const rule = stateMachine.canTransition(version.status as VersionStatus, target);
    if (!rule) {
      return c.json({ error: `Cannot transition from ${version.status} to ${target}` }, 400);
    }

    if (stateMachine.requiresApproval(version.status as VersionStatus, target, auth.pkg.scope as "user" | "org" | "system")) {
      const appr = await query<{ id: string; status: string }>(
        `SELECT id, status FROM skill_approvals WHERE version_id = $1 ORDER BY requested_at DESC LIMIT 1`,
        [versionId],
      );
      if (appr.rows.length === 0 || appr.rows[0].status !== "approved") {
        return c.json({
          error: "Publish requires approval. Call /request-publish first.",
          current_status: version.status,
        }, 400);
      }
    }

    const updated = await skillPkg.setVersionStatus(versionId, target);
    if (target === "published") {
      await skillPkg.setActiveVersion(pkgId, versionId);
    }

    await auditLog.log({
      version_id: versionId,
      package_id: pkgId,
      actor_id: userId,
      action: `transition:${version.status}_to_${target}`,
      from_status: version.status,
      to_status: target,
      details: { rule_admin_only: rule.adminOnly },
    });

    return c.json({ version: updated });
  }

  app.post("/:id/versions/:vid/start-test", jwtAuth, async (c) =>
    transition(c, "internal_test", false));

  app.post("/:id/versions/:vid/canary", jwtAuth, async (c) =>
    transition(c, "canary", true));

  app.post("/:id/versions/:vid/deprecate", jwtAuth, async (c) =>
    transition(c, "deprecated", true));

  app.post("/:id/versions/:vid/rollback", jwtAuth, async (c) =>
    transition(c, "rolled_back", true));

  // ─── Request publish ─────────────────────────────────────────────────

  app.post("/:id/versions/:vid/request-publish", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const userOrgId = c.get("userOrgId") as string | null;
    const pkgId = c.req.param("id")!;
    const versionId = c.req.param("vid")!;

    const auth = await authorizePackageAction(pkgId, userId, isSuperAdmin, userOrgId, false);
    if (!auth.ok || !auth.pkg) return c.json({ error: auth.error }, auth.status);

    const version = await skillPkg.getVersion(versionId);
    if (!version) return c.json({ error: "Version not found" }, 404);

    if (auth.pkg.scope === "user") {
      const gateResult = await evaluateForPublish({
        content: version.content ?? "",
        scope: "user",
      });
      return c.json({
        message: "user-scope publish does not require approval",
        gate_result: gateResult,
        auto_publish_allowed: !gateResult.blocked,
      });
    }

    const { approval: appr, gateResult } = await approval.requestApproval({
      version_id: versionId,
      package_id: pkgId,
      requested_by: userId,
      content: version.content ?? "",
      scope: auth.pkg.scope as "org" | "system",
      trust_level: auth.pkg.trust_level,
    });

    return c.json({ approval: appr, gate_result: gateResult }, 201);
  });

  app.post("/:id/versions/:vid/publish", jwtAuth, async (c) => {
    return transition(c, "published", false);
  });

  // ─── Approvals ────────────────────────────────────────────────────────

  app.get("/approvals", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const pending = await approval.listPending(50);
    return c.json({ approvals: pending });
  });

  app.get("/approvals/:aid", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const aid = c.req.param("aid")!;
    const appr = await approval.getById(aid);
    if (!appr) return c.json({ error: "Not found" }, 404);
    return c.json({ approval: appr });
  });

  app.post("/approvals/:aid/approve", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const aid = c.req.param("aid")!;
    const userId = c.get("userId") as string;
    const body = await c.req.json<{ notes?: string }>().catch(() => ({}) as { notes?: string });
    try {
      const appr = await approval.approve(aid, userId, body.notes);
      return c.json({ approval: appr });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed" }, 400);
    }
  });

  app.post("/approvals/:aid/reject", jwtAuth, requirePermission("skill:approve"), async (c) => {
    const aid = c.req.param("aid")!;
    const userId = c.get("userId") as string;
    const body = await c.req.json<{ reason?: string }>();
    try {
      const appr = await approval.reject(aid, userId, body.reason ?? "rejected");
      return c.json({ approval: appr });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed" }, 400);
    }
  });

  // ─── Force update queue ───────────────────────────────────────────────

  app.post("/:id/force-update", jwtAuth, requirePermission("skill:sync"), async (c) => {
    const pkgId = c.req.param("id")!;
    const userId = c.get("userId") as string;
    const body = await c.req.json<{
      reason?: string;
      deadline_hours?: number;
      target_org_ids?: string[];
    }>().catch(() => ({}) as { reason?: string; deadline_hours?: number; target_org_ids?: string[] });

    const id = `que_${randomUUID().replace(/-/g, "")}`;
    const deadline = body.deadline_hours
      ? `NOW() + INTERVAL '${parseInt(String(body.deadline_hours), 10)} hours'`
      : "NULL";

    await query(
      `INSERT INTO skill_sync_queue
        (id, package_id, action, scope, target_org_ids, reason, priority, deadline, created_by)
       VALUES ($1, $2, 'force_update', 'all', $3, $4, 80, ${deadline}, $5)`,
      [
        id, pkgId,
        JSON.stringify(body.target_org_ids ?? []),
        body.reason ?? "force_update enqueued",
        userId,
      ],
    );

    await auditLog.log({
      package_id: pkgId,
      actor_id: userId,
      action: "force_update_enqueued",
      details: { queue_id: id, deadline_hours: body.deadline_hours },
    });

    return c.json({ queue_id: id, status: "enqueued" }, 201);
  });

  // ─── Audit log ────────────────────────────────────────────────────────

  app.get("/:id/audit", jwtAuth, async (c) => {
    const pkgId = c.req.param("id")!;
    const logs = await auditLog.queryByPackage(pkgId, 100);
    return c.json({ audit_logs: logs });
  });

  return app;
}
