/**
 * Skills routes — Phase 2 marketplace with org-scoped packages.
 *
 * Endpoints:
 *   GET    /skills                      — List packages visible to caller
 *   GET    /skills/:id                  — Get package detail
 *   POST   /skills                      — Create package (auth required)
 *   GET    /skills/:id/versions         — List versions
 *   POST   /skills/:id/versions         — Create version (auto-publish in Phase 2)
 *   GET    /skills/:id/versions/:vid    — Get version detail
 *   GET    /skills/:id/versions/:vid/download  — Download version content (worker auth)
 *
 *   POST   /skills/:id/subscribe        — Subscribe current user to package
 *   DELETE /skills/:id/subscribe        — Unsubscribe
 *   GET    /skills/subscriptions        — List my subscriptions
 *
 * Admin:
 *   POST   /skills/:id/kill             — Kill switch (requirePermission: skill:kill)
 *   POST   /skills/:id/unkill           — Restore
 *   GET    /skills/admin/all            — Admin: list all packages
 */

import { Hono } from "hono";
import { z } from "zod";
import { query } from "../../store/pg.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { workerAuth } from "../middleware/worker-auth.js";
import * as skillPkg from "../../domain/skill-package.js";
import * as skillSub from "../../domain/skill-subscription.js";
import { createPackageSchema, createVersionSchema } from "../validations/skill-schemas.js";

export function createSkillRoutes(): Hono {
  const app = new Hono();

  // ─── List packages ────────────────────────────────────────────────────

  app.get("/", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const orgId = c.get("userOrgId") as string | null;
    const search = c.req.query("search");
    const scope = c.req.query("scope");
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const result = await skillPkg.listPackagesForUser(userId, orgId, { search, scope, limit, offset });
    return c.json(result);
  });

  // ─── Get package detail ───────────────────────────────────────────────

  app.get("/:id", jwtAuth, async (c) => {
    const id = c.req.param("id");
    const pkg = await skillPkg.getPackage(id);
    if (!pkg) return c.json({ error: "Not found" }, 404);
    return c.json({ package: pkg });
  });

  // ─── Create package ───────────────────────────────────────────────────

  app.post("/", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const userOrgId = c.get("userOrgId") as string | null;
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;

    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = createPackageSchema.safeParse(rawBody);
    if (!parsed.success) {
      const flat = z.flattenError(parsed.error);
      return c.json({
        error: "Validation failed",
        fields: Object.fromEntries(
          Object.entries(flat.fieldErrors).map(([k, v]) => [k, v?.[0]]),
        ),
      }, 400);
    }
    const body = parsed.data;

    // Enforce scope permissions
    const scope = body.scope;
    let orgId: string | null = null;

    if (scope === "system") {
      if (!isSuperAdmin) return c.json({ error: "Only super admin can create system-scoped packages" }, 403);
    } else if (scope === "org") {
      // Super admin can specify any org_id (defaults to root)
      if (isSuperAdmin) {
        orgId = body.org_id ?? "root";
      } else if (userOrgId) {
        orgId = userOrgId;
      } else {
        return c.json({ error: "You don't belong to any org" }, 403);
      }
    }

    try {
      const pkg = await skillPkg.createPackage({
        name: body.name,
        description: body.description,
        scope,
        orgId,
        authorId: userId,
        category: body.category,
        tags: body.tags,
      });
      return c.json({ package: pkg }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique")) {
        return c.json({ error: "Package with this name already exists in this scope" }, 409);
      }
      console.error("[Hub] Create package error:", err);
      return c.json({ error: "Failed to create package" }, 500);
    }
  });

  // ─── List versions ────────────────────────────────────────────────────

  app.get("/:id/versions", jwtAuth, async (c) => {
    const id = c.req.param("id");
    const versions = await skillPkg.listVersions(id);
    return c.json({ versions });
  });

  // ─── Create version ───────────────────────────────────────────────────

  app.post("/:id/versions", jwtAuth, async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;

    const pkg = await skillPkg.getPackage(id);
    if (!pkg) return c.json({ error: "Package not found" }, 404);

    // Only author or admin can create versions
    const isSuperAdmin = c.get("isSuperAdmin") as boolean;
    const userOrgId = c.get("userOrgId") as string | null;
    if (pkg.author_id !== userId && !isSuperAdmin) {
      if (pkg.scope === "org" && pkg.org_id !== userOrgId) {
        return c.json({ error: "Not authorized" }, 403);
      }
      if (pkg.scope === "user") {
        return c.json({ error: "Only the author can create versions" }, 403);
      }
    }

    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = createVersionSchema.safeParse(rawBody);
    if (!parsed.success) {
      const flat = z.flattenError(parsed.error);
      return c.json({
        error: "Validation failed",
        fields: Object.fromEntries(
          Object.entries(flat.fieldErrors).map(([k, v]) => [k, v?.[0]]),
        ),
      }, 400);
    }
    const body = parsed.data;

    try {
      const version = await skillPkg.createVersion({
        package_id: id,
        version: body.version,
        content: body.content,
        when_to_use: body.when_to_use,
        allowed_tools: body.allowed_tools,
        data_classification: body.data_classification,
        created_by: userId,
        change_summary: body.change_summary,
        autoPublish: body.autoPublish,
      });
      return c.json({ version }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique")) {
        return c.json({ error: "Version already exists" }, 409);
      }
      console.error("[Hub] Create version error:", err);
      return c.json({ error: "Failed to create version" }, 500);
    }
  });

  // ─── Download version content (worker auth) ───────────────────────────

  app.get("/:id/versions/:vid/download", workerAuth, async (c) => {
    const id = c.req.param("id");
    const vid = c.req.param("vid");

    const { rows } = await query<{ content: string; content_hash: string; version: string }>(
      `SELECT content, content_hash, version FROM skill_versions WHERE id = $1 AND package_id = $2 AND status = 'published'`,
      [vid, id],
    );
    if (rows.length === 0) return c.json({ error: "Not found or not published" }, 404);

    // Increment download count
    await query(
      `UPDATE skill_packages
       SET stats = jsonb_set(stats, '{downloads}',
         to_jsonb(COALESCE((stats->>'downloads')::int, 0) + 1))
       WHERE id = $1`,
      [id],
    );

    return c.json({
      package_id: id,
      version_id: vid,
      version: rows[0].version,
      content_hash: rows[0].content_hash,
      content: rows[0].content,
    });
  });

  // ─── Subscribe ────────────────────────────────────────────────────────

  app.post("/:id/subscribe", jwtAuth, async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;

    const pkg = await skillPkg.getPackage(id);
    if (!pkg) return c.json({ error: "Not found" }, 404);
    if (pkg.is_kill_switched) return c.json({ error: "Package is kill-switched" }, 403);

    const sub = await skillSub.subscribe({
      package_id: id,
      subscriber_type: "user",
      subscriber_id: userId,
      source: "market",
    });
    return c.json({ subscription: sub }, 201);
  });

  app.delete("/:id/subscribe", jwtAuth, async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;
    const removed = await skillSub.unsubscribe(id, "user", userId);
    return c.json({ success: removed });
  });

  // ─── My subscriptions ─────────────────────────────────────────────────

  app.get("/subscriptions/list", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const subs = await skillSub.listSubscriptions("user", userId);
    return c.json({ subscriptions: subs });
  });

  // ─── Kill Switch (admin only) ─────────────────────────────────────────

  app.post("/:id/kill", jwtAuth, requirePermission("skill:kill"), async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));

    await skillPkg.killSwitch(id, userId, body.reason ?? "Kill switch activated");
    return c.json({ success: true });
  });

  app.post("/:id/unkill", jwtAuth, requirePermission("skill:kill"), async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId") as string;
    await skillPkg.unkillSwitch(id, userId);
    return c.json({ success: true });
  });

  // ─── Admin: list all ──────────────────────────────────────────────────

  app.get("/admin/all", jwtAuth, requirePermission("skill:read"), async (c) => {
    const { rows } = await query(
      `SELECT p.*, u.username as author_name,
        (SELECT COUNT(*) FROM skill_versions WHERE package_id = p.id) as version_count
       FROM skill_packages p
       LEFT JOIN users u ON u.id = p.author_id
       ORDER BY p.created_at DESC`,
    );
    return c.json({ packages: rows });
  });

  return app;
}
