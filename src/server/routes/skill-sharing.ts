/**
 * Skill sharing routes — Phase 4 cross-org 双边审批.
 *
 * Endpoints:
 *   POST   /sharings                      — Initiate sharing (source org admin)
 *   GET    /sharings                      — List sharings (filter by org role)
 *   GET    /sharings/:id                  — Get sharing detail
 *   POST   /sharings/:id/approve          — Target org admin approves
 *   POST   /sharings/:id/reject           — Target org admin rejects
 *   DELETE /sharings/:id                  — Revoke approved sharing (either side or super_admin)
 */

import { Hono } from "hono";
import { z } from "zod";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { createSharingSchema } from "../validations/skill-schemas.js";
import * as sharing from "../../domain/skill-sharing.js";

export function createSkillSharingRoutes(): Hono {
  const app = new Hono();

  // ─── Initiate sharing ───────────────────────────────────────────────

  app.post("/", jwtAuth, requirePermission("skill:share"), async (c) => {
    const userId = c.get("userId") as string;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const userOrgId = c.get("userOrgId") as string | null;
    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = createSharingSchema.safeParse(rawBody);
    if (!parsed.success) {
      const flat = z.flattenError(parsed.error);
      return c.json({
        error: "Validation failed",
        fields: Object.fromEntries(
          Object.entries(flat.fieldErrors).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
        ),
      }, 400);
    }
    const body = parsed.data;

    // Resolve source_org_id
    let sourceOrgId = body.source_org_id;
    if (!sourceOrgId) {
      if (isSuperAdmin) {
        return c.json({ error: "source_org_id required for super_admin" }, 400);
      }
      sourceOrgId = userOrgId ?? undefined;
    }
    if (!sourceOrgId) {
      return c.json({ error: "You don't belong to any org" }, 403);
    }

    // zod schema already validates restriction types including the enum
    const { sharing: result, error } = await sharing.requestSharing({
      package_id: body.package_id,
      source_org_id: sourceOrgId,
      target_org_id: body.target_org_id,
      initiated_by: userId,
      restrictions: body.restrictions,
      usage_intent: body.usage_intent,
      business_justification: body.business_justification,
    });

    if (error) {
      return c.json({ error }, 400);
    }
    return c.json({ sharing: result }, 201);
  });

  // ─── List sharings ──────────────────────────────────────────────────

  app.get("/", jwtAuth, requirePermission("skill:share"), async (c) => {
    const userOrgId = c.get("userOrgId") as string | null;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const status = c.req.query("status") as sharing.SharingStatus | undefined;
    const orgRole = c.req.query("org_role") as "source" | "target" | "either" | undefined;
    const packageId = c.req.query("package_id");
    const limit = parseInt(c.req.query("limit") || "50", 10);

    // Non-super_admin can only see sharings involving their org
    const filter: sharing.ListSharingsFilter = {
      status,
      package_id: packageId ?? undefined,
    };
    if (!isSuperAdmin) {
      filter.org_id = userOrgId ?? undefined;
      filter.org_role = orgRole ?? "either";
    } else if (userOrgId || orgRole) {
      filter.org_id = userOrgId ?? undefined;
      filter.org_role = orgRole;
    }

    const list = await sharing.listSharings(filter, limit);
    return c.json({ sharings: list });
  });

  // ─── Get sharing detail ─────────────────────────────────────────────

  app.get("/:id", jwtAuth, requirePermission("skill:share"), async (c) => {
    const id = c.req.param("id");
    const s = await sharing.getSharing(id);
    if (!s) return c.json({ error: "Not found" }, 404);
    return c.json({ sharing: s });
  });

  // ─── Approve ────────────────────────────────────────────────────────

  app.post("/:id/approve", jwtAuth, requirePermission("skill:share"), async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const userOrgId = c.get("userOrgId") as string | null;

    const existing = await sharing.getSharing(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    // Only target org admin (or super_admin) can approve
    if (!isSuperAdmin && existing.target_org_id !== userOrgId) {
      return c.json({ error: "Only target org admin can approve" }, 403);
    }

    const { sharing: result, error } = await sharing.approveSharing(id, userId);
    if (error) return c.json({ error }, 400);
    return c.json({ sharing: result });
  });

  // ─── Reject ─────────────────────────────────────────────────────────

  app.post("/:id/reject", jwtAuth, requirePermission("skill:share"), async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const userOrgId = c.get("userOrgId") as string | null;
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });

    const existing = await sharing.getSharing(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    if (!isSuperAdmin && existing.target_org_id !== userOrgId) {
      return c.json({ error: "Only target org admin can reject" }, 403);
    }

    const { sharing: result, error } = await sharing.rejectSharing(
      id,
      userId,
      body.reason ?? "rejected",
    );
    if (error) return c.json({ error }, 400);
    return c.json({ sharing: result });
  });

  // ─── Revoke ─────────────────────────────────────────────────────────

  app.delete("/:id", jwtAuth, requirePermission("skill:share"), async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const userOrgId = c.get("userOrgId") as string | null;
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });

    const existing = await sharing.getSharing(id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    // Either source or target org admin, or super_admin, can revoke
    if (
      !isSuperAdmin &&
      existing.source_org_id !== userOrgId &&
      existing.target_org_id !== userOrgId
    ) {
      return c.json({ error: "Only involved org admins can revoke" }, 403);
    }

    const { sharing: result, error, killed_workers } = await sharing.revokeSharing(
      id,
      userId,
      body.reason ?? "revoked",
    );
    if (error) return c.json({ error }, 400);
    return c.json({ sharing: result, killed_workers });
  });

  return app;
}
