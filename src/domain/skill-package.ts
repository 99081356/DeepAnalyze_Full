/**
 * Skill package domain logic — Phase 2 (no approval workflow yet).
 */

import { randomUUID } from "crypto";
import { query } from "../store/pg.js";
import { createHash } from "crypto";

export interface SkillPackage {
  id: string;
  name: string;
  slug: string;
  display_name: string;
  description: string | null;
  org_id: string | null;
  author_id: string | null;
  scope: "system" | "org" | "user";
  category: string;
  tags: string[];
  stats: { downloads: number; subscriptions: number; rating_avg: number };
  trust_level: string;
  active_version_id: string | null;
  is_kill_switched: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionRow {
  id: string;
  package_id: string;
  version: string;
  content: string | null;
  when_to_use: string | null;
  paths: string[];
  allowed_tools: string[];
  data_classification: string;
  hooks: Record<string, unknown>;
  content_hash: string;
  status: "draft" | "published";
  change_summary: string | null;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

export async function createPackage(params: {
  name: string;
  description?: string;
  scope: "system" | "org" | "user";
  orgId?: string | null;
  authorId?: string | null;
  category?: string;
  tags?: string[];
}): Promise<SkillPackage> {
  const id = `pkg_${randomUUID().replace(/-/g, "")}`;
  const slug = slugify(params.name);
  const tags = JSON.stringify(params.tags ?? []);

  const { rows } = await query(
    `INSERT INTO skill_packages (id, name, slug, description, org_id, author_id, scope, category, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [id, params.name, slug, params.description ?? null, params.orgId ?? null, params.authorId ?? null,
     params.scope, params.category ?? "custom", tags],
  );
  return rows[0] as SkillPackage;
}

export async function getPackage(id: string): Promise<SkillPackage | null> {
  const { rows } = await query<SkillPackage>(
    `SELECT * FROM skill_packages WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getPackageBySlug(slug: string): Promise<SkillPackage | null> {
  const { rows } = await query<SkillPackage>(
    `SELECT * FROM skill_packages WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

/**
 * List packages visible to a given user (system + own org + own user packages).
 */
export async function listPackagesForUser(
  userId: string,
  orgId: string | null,
  opts: { search?: string; scope?: string; limit?: number; offset?: number } = {},
): Promise<{ items: SkillPackage[]; total: number }> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Scope filtering: system packages visible to all; org packages visible within same org;
  // user packages visible only to the owner
  const scopeFilter = `(scope = 'system' OR (scope = 'org' AND org_id = $1) OR (scope = 'user' AND author_id = $2))`;
  params.push(orgId, userId);
  conditions.push(scopeFilter);

  if (opts.search) {
    params.push(`%${opts.search}%`);
    conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  if (opts.scope && ["system", "org", "user"].includes(opts.scope)) {
    params.push(opts.scope);
    conditions.push(`scope = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countResp = await query<{ total: string }>(
    `SELECT COUNT(*)::TEXT as total FROM skill_packages ${where}`,
    params,
  );
  const total = parseInt(countResp.rows[0].total, 10);

  const dataResp = await query<SkillPackage>(
    `SELECT * FROM skill_packages ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return { items: dataResp.rows, total };
}

export async function createVersion(params: {
  package_id: string;
  version: string;
  content: string;
  when_to_use?: string;
  allowed_tools?: string[];
  data_classification?: string;
  created_by?: string | null;
  change_summary?: string;
  autoPublish?: boolean;
}): Promise<SkillVersionRow> {
  const id = `ver_${randomUUID().replace(/-/g, "")}`;
  const hash = hashContent(params.content);
  const tools = JSON.stringify(params.allowed_tools ?? ["*"]);
  const status = params.autoPublish === false ? "draft" : "published";

  const { rows } = await query(
    `INSERT INTO skill_versions
      (id, package_id, version, content, when_to_use, allowed_tools, data_classification, content_hash, status, change_summary, created_by, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${status === "published" ? "NOW()" : "NULL"})
     RETURNING *`,
    [id, params.package_id, params.version, params.content, params.when_to_use ?? null,
     tools, params.data_classification ?? "public", hash, status,
     params.change_summary ?? null, params.created_by ?? null],
  );

  // Set as active version if published
  if (status === "published") {
    await query(
      `UPDATE skill_packages SET active_version_id = $1, updated_at = NOW() WHERE id = $2`,
      [id, params.package_id],
    );
  }

  return rows[0] as SkillVersionRow;
}

export async function getActiveVersion(packageId: string): Promise<SkillVersionRow | null> {
  const { rows } = await query<SkillVersionRow>(
    `SELECT v.* FROM skill_versions v
     JOIN skill_packages p ON p.id = v.package_id
     WHERE v.package_id = $1 AND v.id = p.active_version_id AND v.status = 'published'
     LIMIT 1`,
    [packageId],
  );
  return rows[0] ?? null;
}

export async function listVersions(packageId: string): Promise<SkillVersionRow[]> {
  const { rows } = await query<SkillVersionRow>(
    `SELECT * FROM skill_versions WHERE package_id = $1 ORDER BY created_at DESC`,
    [packageId],
  );
  return rows;
}

export async function killSwitch(
  packageId: string,
  userId: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE skill_packages
     SET is_kill_switched = TRUE, kill_switch_reason = $1, kill_switched_at = NOW(), kill_switched_by = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [reason, userId, packageId],
  );
}

export async function unkillSwitch(packageId: string): Promise<void> {
  await query(
    `UPDATE skill_packages
     SET is_kill_switched = FALSE, kill_switch_reason = NULL, kill_switched_at = NULL, kill_switched_by = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [packageId],
  );
}
