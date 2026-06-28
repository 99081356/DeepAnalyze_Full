/**
 * Shared fixtures + helpers for Hub Worker Skills Admin e2e tests.
 *
 * Conventions:
 * - All seeded data uses slug LIKE 'test-%' for traceable cleanup
 * - Standalone pg.Pool — does NOT import Hub's store/pg.ts (avoids ESM coupling)
 * - loginFast: API login + localStorage injection (~200ms, used by 16 tests)
 * - loginAs: UI form fill (~1-2s, used by 2 permission tests where login itself matters)
 */

import { test as base, expect, type Page, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── DB pool ─────────────────────────────────────────────────────────
// Standalone pool — avoids importing Hub's store/pg.ts (ESM specifier coupling)
const pool = new Pool({
  host: process.env.PG_HOST ?? "localhost",
  port: Number(process.env.PG_PORT ?? "5432"),
  user: process.env.PG_USER ?? "deepanalyze",
  password: process.env.PG_PASSWORD ?? "deepanalyze_dev",
  database: process.env.PG_DATABASE ?? "deepanalyze_hub",
});

export interface AdminSkillRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  tools: string[] | null;
  model_role: string | null;
  anti_hallucination_level: string | null;
  tags: string[] | null;
  version: string;
  author_id: string | null;
  submitter_id: string | null;
  review_status: "pending" | "approved" | "rejected" | "deprecated";
  reviewer_id: string | null;
  review_notes: string | null;
  source_package_id: string | null;
  source_version_id: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SkillPackageRow {
  id: string;
  name: string;
  slug: string;
  display_name: string;
  description: string | null;
  org_id: string | null;
  author_id: string | null;
  scope: string;
  category: string;
  tags: unknown;
  icon: string | null;
  trust_level: string;
  active_version_id: string | null;
  is_kill_switched: boolean;
  created_at: Date;
  updated_at: Date;
}

// ─── SQL helper ──────────────────────────────────────────────────────
export async function sqlExec<T = unknown>(
  text: string,
  params?: (string | number | boolean | null | string[])[]
): Promise<T[]> {
  const result = await pool.query<T>(text, params ?? []);
  return result.rows;
}

// ─── Screenshot helper ───────────────────────────────────────────────
export async function captureScreenshot(
  page: Page,
  spec: string,
  testName: string,
  index = 0
): Promise<string> {
  const dir = join(process.cwd(), "tests/e2e/screenshots", spec);
  mkdirSync(dir, { recursive: true });
  const safe = testName.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const path = join(dir, `${safe}-${String(index).padStart(2, "0")}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

// ─── Card locator helper ─────────────────────────────────────────────
// WorkerSkills card structure:
//   <div cardStyle>
//     <div cardTitleStyle><span>{name}</span> ... </div>
//     ...
//     <div actionRowStyle><button>...</button></div>
//   </div>
//
// `page.getByText(name).locator('xpath=../..')` walks from the title <span>
// up two levels to the card root, giving a unique scope for action buttons.
export function cardByName(page: Page, name: string) {
  return page.getByText(name).first().locator("xpath=../..");
}

// ─── API login + token ───────────────────────────────────────────────
export async function getApiToken(
  request: APIRequestContext,
  username = "admin",
  password = "admin123"
): Promise<string> {
  const resp = await request.post("http://localhost:22000/api/v1/auth/login", {
    data: { username, password },
  });
  expect(resp.ok(), `login ${username} should succeed`).toBeTruthy();
  const body = await resp.json();
  return body.access_token as string;
}

// ─── Fast login (API + localStorage injection) ───────────────────────
export async function loginFast(
  page: Page,
  request: APIRequestContext,
  username = "admin",
  password = "admin123"
): Promise<string> {
  const token = await getApiToken(request, username, password);
  // Goto any same-origin page first so we can write localStorage
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => {
    localStorage.setItem("hub_access_token", t);
  }, token);
  return token;
}

// ─── UI form login (for permission tests where login flow matters) ───
export async function loginAs(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  // Login.tsx uses plain inputs without name/id — locate by type + order
  await page.fill('input[autofocus], form input:first-of-type', username);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  // Wait for app shell to load (whichever nav element appears first)
  await page.waitForSelector("nav, [data-testid='app-shell']", { timeout: 10_000 });
}

// ─── Seed: marketplace skill ─────────────────────────────────────────
export async function seedMarketplaceSkill(
  status: "pending" | "approved" | "rejected" | "deprecated" = "pending",
  overrides: Partial<AdminSkillRow> = {}
): Promise<AdminSkillRow> {
  const id = overrides.id ?? randomUUID();
  const slug = overrides.slug ?? `test-${randomUUID().slice(0, 8)}`;
  const rows = await sqlExec<AdminSkillRow>(
    `INSERT INTO marketplace_skills
       (id, slug, name, description, prompt, tools, model_role,
        anti_hallucination_level, tags, version, author_id, submitter_id,
        review_status, reviewer_id, review_notes, source_package_id,
        source_version_id, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11,
             $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      id,
      slug,
      overrides.name ?? `Test Skill ${slug.slice(-4)}`,
      overrides.description ?? "Test description for e2e",
      overrides.prompt ?? "You are a helpful assistant.",
      overrides.tools ?? ["Read", "Edit"],
      overrides.model_role ?? "main",
      overrides.anti_hallucination_level ?? "standard",
      overrides.tags ?? ["test", "e2e"],
      overrides.version ?? "1.0.0",
      // author_id — 'system' user is guaranteed by migration 017
      "system",
      status,
      overrides.reviewer_id ?? null,
      overrides.review_notes ?? null,
      overrides.source_package_id ?? null,
      overrides.source_version_id ?? null,
      status === "approved" ? new Date() : null,
    ]
  );
  return rows[0];
}

// ─── Cleanup ─────────────────────────────────────────────────────────
export async function cleanupTestSkills(): Promise<number> {
  const result = await sqlExec(
    `DELETE FROM marketplace_skills WHERE slug LIKE 'test-%' RETURNING id`
  );
  return result.length;
}

export async function deleteSkillById(id: string): Promise<void> {
  await sqlExec(`DELETE FROM marketplace_skills WHERE id = $1`, [id]);
}

// ─── Phase 2 lookup: promotable package (existing, real seed data) ───
// Excludes packages that have already been promoted to avoid 409 collisions
// with leftover state from prior runs.
export async function promotablePackage(): Promise<SkillPackageRow | null> {
  const rows = await sqlExec<SkillPackageRow>(
    `SELECT p.* FROM skill_packages p
     WHERE p.is_kill_switched = false
       AND p.active_version_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM skill_versions v
         WHERE v.package_id = p.id AND v.status = 'published'
       )
       AND NOT EXISTS (
         SELECT 1 FROM marketplace_skills m
         WHERE m.source_package_id = p.id
       )
     ORDER BY p.created_at
     LIMIT 1`
  );
  return rows[0] ?? null;
}

/**
 * Returns a Phase 2 package with NO published version (for P3 test).
 * Tries to find one first; if none exists, creates one as test-*
 * (which gets cleaned up by cleanupTestSkillPackages).
 */
export async function packageWithoutPublishedVersion(): Promise<{
  pkg: SkillPackageRow;
  created: boolean;
}> {
  const existing = await sqlExec<SkillPackageRow>(
    `SELECT p.* FROM skill_packages p
     WHERE NOT EXISTS (
       SELECT 1 FROM skill_versions v
       WHERE v.package_id = p.id AND v.status = 'published'
     )
     ORDER BY p.created_at LIMIT 1`
  );
  if (existing.length > 0) return { pkg: existing[0], created: false };

  const id = randomUUID();
  const slug = `test-nopub-${randomUUID().slice(0, 8)}`;
  const rows = await sqlExec<SkillPackageRow>(
    `INSERT INTO skill_packages
       (id, name, slug, display_name, description, scope, category,
        tags, trust_level, is_kill_switched)
     VALUES ($1, $2, $3, $4, $5, 'user', 'custom', '[]', 'community', false)
     RETURNING *`,
    [id, `Test NoPub ${slug.slice(-4)}`, slug, "Test", "No published version"]
  );
  return { pkg: rows[0], created: true };
}

// ─── Cleanup: test Phase 2 packages (created by P3 fallback) ─────────
export async function cleanupTestSkillPackages(): Promise<void> {
  await sqlExec(
    `DELETE FROM skill_packages WHERE slug LIKE 'test-nopub-%'`
  );
}

// ─── Close DB pool at end of suite ───────────────────────────────────
export async function closePool(): Promise<void> {
  await pool.end();
}

// ─── Extended test fixture with auto-cleanup ─────────────────────────
interface HubFixtures {
  /** Cleanup helper — runs after each test, removes all test-* skills */
  cleanup: () => Promise<void>;
}

export const test = base.extend<HubFixtures>({
  cleanup: async ({}, use) => {
    await use(async () => {
      await cleanupTestSkills();
    });
  },
});

export { expect, pool };
