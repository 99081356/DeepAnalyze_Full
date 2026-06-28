/**
 * Marketplace routes — skills and plugins browsing, download, and submission.
 *
 * Skills:
 *   GET  /skills                    — List approved marketplace skills (paginated)
 *   GET  /skills/:slug              — Get skill detail
 *   GET  /skills/:slug/download     — Download skill package
 *   POST /skills/submit             — Submit a skill for review
 *   GET  /skills/:slug/versions     — List skill versions (placeholder)
 *
 * Plugins:
 *   GET  /plugins                   — List approved marketplace plugins
 *   GET  /plugins/:slug             — Get plugin detail
 *   GET  /plugins/:slug/download    — Download plugin package
 *   POST /plugins/submit            — Submit a plugin for review
 *
 * Admin:
 *   GET  /admin/skills              — List all skills (including pending)
 *   POST /admin/skills/:id/approve  — Approve a skill
 *   POST /admin/skills/:id/reject   — Reject a skill
 */

import { Hono } from "hono";
import { randomUUID } from "crypto";
import { query } from "../../store/pg.js";
import { workerAuth } from "../middleware/worker-auth.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { HUB_CONFIG } from "../../core/config.js";
import type {
  SkillSubmitRequest,
  SkillSubmitResponse,
} from "../../types/index.js";

export function createMarketplaceRoutes(): Hono {
  const app = new Hono();

  // ─── Admin routes: require JWT + skill:approve permission ──────────────
  // 所有 /admin/* 路由统一走这个中间件，避免裸奔。
  app.use("/admin/*", jwtAuth, requirePermission("skill:approve"));

  // ─── Skills: browse ────────────────────────────────────────────────────

  app.get("/skills", async (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    const pageSize = Math.min(
      parseInt(c.req.query("pageSize") || String(HUB_CONFIG.marketplace.defaultPageSize), 10),
      HUB_CONFIG.marketplace.maxPageSize,
    );
    const search = c.req.query("search") || "";
    const offset = (page - 1) * pageSize;

    let whereClause = "WHERE review_status = 'approved'";
    const params: unknown[] = [];
    let paramIdx = 1;

    if (search) {
      whereClause += ` AND (name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }

    // Count
    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM marketplace_skills ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Data
    const { rows } = await query(
      `SELECT slug, name, description, version, tags, download_count, rating_avg, review_count,
              published_at, compatibility
       FROM marketplace_skills ${whereClause}
       ORDER BY published_at DESC NULLS LAST
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, pageSize, offset],
    );

    return c.json({
      items: rows.map(mapSkillListItem),
      total,
      page,
      pageSize,
    });
  });

  // ─── Skills: detail ────────────────────────────────────────────────────

  app.get("/skills/:slug", async (c) => {
    const { slug: rawSlug } = c.req.param();
    const slug = decodeURIComponent(rawSlug);
    const { rows } = await query(
      `SELECT id, slug, name, description, prompt, tools, model_role, anti_hallucination_level,
              tags, version, download_count, rating_avg, review_count, published_at, compatibility,
              created_at, updated_at
       FROM marketplace_skills
       WHERE slug = $1 AND review_status = 'approved'`,
      [slug],
    );

    if (rows.length === 0) {
      return c.json({ error: "Skill not found" }, 404);
    }

    return c.json(mapSkillDetail(rows[0]));
  });

  // ─── Skills: download ──────────────────────────────────────────────────

  app.get("/skills/:slug/download", workerAuth, async (c) => {
    const { slug: rawSlug } = c.req.param();
    const slug = decodeURIComponent(rawSlug);
    const { rows } = await query(
      `SELECT id, slug, name, description, prompt, tools, model_role,
              anti_hallucination_level, tags, version, compatibility
       FROM marketplace_skills
       WHERE slug = $1 AND review_status = 'approved'`,
      [slug],
    );

    if (rows.length === 0) {
      return c.json({ error: "Skill not found or not approved" }, 404);
    }

    // Increment download count
    await query(
      "UPDATE marketplace_skills SET download_count = download_count + 1 WHERE slug = $1",
      [slug],
    );

    return c.json(rows[0]);
  });

  // ─── Skills: submit ────────────────────────────────────────────────────

  app.post("/skills/submit", workerAuth, async (c) => {
    try {
    const body = await c.req.json<SkillSubmitRequest>();

    if (!body.name || !body.prompt) {
      return c.json({ error: "name and prompt are required" }, 400);
    }

    // Generate slug from name
    const slug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "");

    // Check if slug already exists
    const existing = await query(
      "SELECT id FROM marketplace_skills WHERE slug = $1",
      [slug],
    );
    if (existing.rows.length > 0) {
      return c.json({ error: "A skill with this name already exists" }, 409);
    }

    const id = randomUUID();
    // Use 'system' as submitter since Workers don't have user accounts
    // (the FK references users table)
    await query(
      `INSERT INTO marketplace_skills
        (id, slug, name, description, prompt, tools, model_role, anti_hallucination_level,
         tags, version, submitter_id, review_status, compatibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '1.0.0', 'system', 'pending', $10)`,
      [
        id,
        slug,
        body.name,
        body.description || "",
        body.prompt,
        body.tools || ["*"],
        body.modelRole || "main",
        null,
        body.tags || [],
        JSON.stringify({ minVersion: "0.1.0" }),
      ],
    );

    const response: SkillSubmitResponse = {
      submissionId: id,
      status: "submitted",
      message: "Skill submitted for review",
    };

    return c.json(response);
    } catch (err) {
      console.error("[Hub] Skill submit error:", err);
      return c.json({ error: "Failed to submit skill" }, 500);
    }
  });

  // ─── Skills: versions (placeholder) ────────────────────────────────────

  app.get("/skills/:slug/versions", async (c) => {
    // Version history is not yet implemented
    return c.json({ versions: [], message: "Version history coming soon" });
  });

  // ─── Plugins: browse ───────────────────────────────────────────────────

  app.get("/plugins", async (c) => {
    const page = parseInt(c.req.query("page") || "1", 10);
    const pageSize = Math.min(
      parseInt(c.req.query("pageSize") || String(HUB_CONFIG.marketplace.defaultPageSize), 10),
      HUB_CONFIG.marketplace.maxPageSize,
    );
    const offset = (page - 1) * pageSize;

    const countResult = await query<{ total: string }>(
      "SELECT COUNT(*) as total FROM marketplace_plugins WHERE review_status = 'approved'",
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const { rows } = await query(
      `SELECT slug, name, description, version, download_count, published_at
       FROM marketplace_plugins
       WHERE review_status = 'approved'
       ORDER BY published_at DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );

    return c.json({ items: rows, total, page, pageSize });
  });

  // ─── Plugins: detail ───────────────────────────────────────────────────

  app.get("/plugins/:slug", async (c) => {
    const { slug: rawSlug } = c.req.param();
    const slug = decodeURIComponent(rawSlug);
    const { rows } = await query(
      `SELECT id, slug, name, description, manifest, version, download_count, published_at
       FROM marketplace_plugins
       WHERE slug = $1 AND review_status = 'approved'`,
      [slug],
    );

    if (rows.length === 0) {
      return c.json({ error: "Plugin not found" }, 404);
    }

    return c.json(rows[0]);
  });

  // ─── Plugins: download ─────────────────────────────────────────────────

  app.get("/plugins/:slug/download", workerAuth, async (c) => {
    const { slug: rawSlug } = c.req.param();
    const slug = decodeURIComponent(rawSlug);
    const { rows } = await query(
      `SELECT id, slug, name, description, manifest, version
       FROM marketplace_plugins
       WHERE slug = $1 AND review_status = 'approved'`,
      [slug],
    );

    if (rows.length === 0) {
      return c.json({ error: "Plugin not found or not approved" }, 404);
    }

    await query(
      "UPDATE marketplace_plugins SET download_count = download_count + 1 WHERE slug = $1",
      [slug],
    );

    return c.json(rows[0]);
  });

  // ─── Plugins: submit ───────────────────────────────────────────────────

  app.post("/plugins/submit", workerAuth, async (c) => {
    const body = await c.req.json<{
      name: string;
      description?: string;
      manifest: Record<string, unknown>;
    }>();

    if (!body.name || !body.manifest) {
      return c.json({ error: "name and manifest are required" }, 400);
    }

    const slug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "");

    const existing = await query(
      "SELECT id FROM marketplace_plugins WHERE slug = $1",
      [slug],
    );
    if (existing.rows.length > 0) {
      return c.json({ error: "A plugin with this name already exists" }, 409);
    }

    const id = randomUUID();

    await query(
      `INSERT INTO marketplace_plugins (id, slug, name, description, manifest, version, author_id, review_status)
       VALUES ($1, $2, $3, $4, $5, '1.0.0', 'system', 'pending')`,
      [id, slug, body.name, body.description || "", JSON.stringify(body.manifest)],
    );

    return c.json({
      submissionId: id,
      status: "submitted",
      message: "Plugin submitted for review",
    });
  });

  // ─── Admin: list all skills (including pending) ────────────────────────

  app.get("/admin/skills", async (c) => {
    const status = c.req.query("status"); // pending/approved/rejected/deprecated/all
    const search = c.req.query("search") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const whereParts: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (status && status !== "all") {
      whereParts.push(`review_status = $${idx++}`);
      params.push(status);
    }
    if (search) {
      whereParts.push(`(name ILIKE $${idx} OR slug ILIKE $${idx} OR description ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const countRes = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM marketplace_skills ${whereClause}`,
      params,
    );
    const total = parseInt(countRes.rows[0].total, 10);

    // pending 状态按 created_at ASC（FIFO 审核），其他状态按 created_at DESC
    const orderBy =
      status === "pending" ? "created_at ASC" : "created_at DESC";

    const { rows } = await query(
      `SELECT id, slug, name, description, prompt, tools, model_role, tags, version,
              review_status, reviewer_id, review_notes, submitter_id,
              download_count, rating_avg, review_count, published_at, created_at, updated_at,
              source_package_id, source_version_id
       FROM marketplace_skills ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    return c.json({ skills: rows, total, limit, offset });
  });

  // ─── Admin: approve skill ──────────────────────────────────────────────

  app.post("/admin/skills/:id/approve", async (c) => {
    const { id } = c.req.param();
    const reviewerId = c.get("userId") as string;

    const { rows } = await query(
      `UPDATE marketplace_skills
       SET review_status = 'approved', reviewer_id = $2, published_at = now(), updated_at = now()
       WHERE id = $1 AND review_status = 'pending'
       RETURNING id, slug, name`,
      [id, reviewerId],
    );

    if (rows.length === 0) {
      return c.json({ error: "Skill not found or not in pending status" }, 404);
    }

    return c.json({ success: true, skill: rows[0] });
  });

  // ─── Admin: reject skill ───────────────────────────────────────────────

  app.post("/admin/skills/:id/reject", async (c) => {
    const { id } = c.req.param();
    const reviewerId = c.get("userId") as string;
    const body = await c.req.json<{ reason?: string }>();

    const { rows } = await query(
      `UPDATE marketplace_skills
       SET review_status = 'rejected', reviewer_id = $2, review_notes = $3, updated_at = now()
       WHERE id = $1 AND review_status = 'pending'
       RETURNING id, slug, name`,
      [id, reviewerId, body.reason || ""],
    );

    if (rows.length === 0) {
      return c.json({ error: "Skill not found or not in pending status" }, 404);
    }

    return c.json({ success: true, skill: rows[0] });
  });

  // ─── Admin: list all plugins (including pending) ───────────────────────

  app.get("/admin/plugins", async (c) => {
    const { rows } = await query(
      `SELECT id, slug, name, description, version, review_status, download_count, published_at, created_at
       FROM marketplace_plugins ORDER BY created_at DESC`,
    );
    return c.json({ plugins: rows });
  });

  // ─── Admin: approve plugin ─────────────────────────────────────────────

  app.post("/admin/plugins/:id/approve", async (c) => {
    const { id } = c.req.param();
    const { rows } = await query(
      `UPDATE marketplace_plugins
       SET review_status = 'approved', reviewer_id = 'system', published_at = now(), updated_at = now()
       WHERE id = $1 AND review_status = 'pending'
       RETURNING id, slug, name`,
      [id],
    );
    if (rows.length === 0) {
      return c.json({ error: "Plugin not found or not in pending status" }, 404);
    }
    return c.json({ success: true, plugin: rows[0] });
  });

  return app;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function mapSkillListItem(row: Record<string, unknown>) {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    tags: row.tags,
    downloadCount: row.download_count,
    ratingAvg: row.rating_avg,
    reviewCount: row.review_count,
    publishedAt: row.published_at,
    compatibility: row.compatibility,
  };
}

function mapSkillDetail(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    tools: row.tools,
    modelRole: row.model_role,
    antiHallucinationLevel: row.anti_hallucination_level,
    tags: row.tags,
    version: row.version,
    downloadCount: row.download_count,
    ratingAvg: row.rating_avg,
    reviewCount: row.review_count,
    publishedAt: row.published_at,
    compatibility: row.compatibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
