/**
 * Cross-system promote spec — Phase 2 (skill_packages) → Phase 1 (marketplace_skills).
 *
 * P1: promote success via UI (full happy path)
 * P2: slug collision → 409 (via API, double promote)
 * P3: no published version → 400
 * P4: kill-switched package → 400
 *
 * All tests gated on HUB_HAS_SEED_DATA === "1" (real Phase 2 seed packages).
 * When no seed data exists, tests skip with a clear reason.
 */

import { test, expect } from "./fixtures.js";
import {
  loginFast,
  captureScreenshot,
  promotablePackage,
  packageWithoutPublishedVersion,
  sqlExec,
  cleanupTestSkills,
  cleanupTestSkillPackages,
  getApiToken,
} from "./fixtures.js";

const HAS_SEED = process.env.HUB_HAS_SEED_DATA === "1";

test.describe("Cross-system promote", () => {
  test.beforeEach(async ({ page, request, cleanup }) => {
    test.skip(!HAS_SEED, "needs promotable Phase 2 seed packages (run scripts/seed-realistic.ts)");
    await loginFast(page, request, "admin", "admin123");
    await cleanup();
  });

  test.afterEach(async ({ cleanup }) => {
    await cleanup();
    await cleanupTestSkillPackages();
  });

  test("P1: promote Phase 2 package via /skills UI creates Phase 1 skill", async ({ page, request }) => {
    // Verify a promotable package exists before doing the UI dance
    const anyPromotable = await promotablePackage();
    expect(anyPromotable, "no promotable package found").not.toBeNull();
    if (!anyPromotable) return;

    await page.goto("/skills", { waitUntil: "networkidle" });

    // Find any promote button (only visible to super admin)
    const promoteBtn = page.getByRole("button", { name: "推广到 Worker 市场" }).first();
    await expect(promoteBtn).toBeVisible({ timeout: 5_000 });

    // Capture the actual packageId from the outgoing POST (Skills.tsx ordering and
    // scope-filtering make it unreliable to predict which package the first button targets).
    let promotedPackageId: string | undefined;
    page.on("request", (req) => {
      if (req.url().endsWith("/api/v1/marketplace/admin/promote") && req.method() === "POST") {
        try {
          const body = JSON.parse(req.postData() ?? "{}");
          promotedPackageId = body.packageId;
        } catch {
          /* ignore parse errors */
        }
      }
    });

    await promoteBtn.click();

    // ConfirmDialog (Modal)
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await dialog.getByRole("button", { name: "确认推广" }).click();

    // Success toast with slug + version
    await expect(page.getByText(/已推广到 Worker 市场/)).toBeVisible({ timeout: 5_000 });
    await captureScreenshot(page, "promote", "p1-promote-success");

    // DB: row exists with source_package_id matching the package we actually promoted
    expect(promotedPackageId, "captured packageId from promote request").toBeTruthy();
    const rows = await sqlExec<{ id: string; slug: string }>(
      `SELECT id, slug FROM marketplace_skills WHERE source_package_id = $1`,
      [promotedPackageId!]
    );
    expect(rows.length, "promoted skill row should be present in DB").toBeGreaterThan(0);

    // Verify in /worker-skills approved tab — promoted skill with source badge
    await page.goto("/worker-skills", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^已批准/ }).click();
    await expect(page.getByText(rows[0].slug)).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByText(rows[0].slug).locator("xpath=..").getByText("🔗 源自企业包")
    ).toBeVisible();
    await captureScreenshot(page, "promote", "p1-promoted-in-marketplace");

    // Mark for cleanup (slug isn't 'test-*' so the helper won't catch it)
    await sqlExec(`DELETE FROM marketplace_skills WHERE id = $1`, [rows[0].id]);
  });

  test("P2: slug collision — second promote of same package returns 409", async ({ request }) => {
    const pkg = await promotablePackage();
    expect(pkg).not.toBeNull();
    if (!pkg) return;

    const token = await getApiToken(request, "admin", "admin123");
    const url = "http://localhost:22000/api/v1/marketplace/admin/promote";

    // First promote succeeds (or already promoted from prior run)
    const r1 = await request.post(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { packageId: pkg.id },
    });
    expect([200, 409]).toContain(r1.status()); // 409 if already promoted earlier

    // Second promote must collide
    const r2 = await request.post(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { packageId: pkg.id },
    });
    expect(r2.status()).toBe(409);
    const body = await r2.json();
    expect(JSON.stringify(body)).toMatch(/already exists|conflict/i);

    // Cleanup the promoted row so future runs of P1/P2 are deterministic
    await sqlExec(
      `DELETE FROM marketplace_skills WHERE source_package_id = $1`,
      [pkg.id]
    );
  });

  test("P3: package without published version → 400", async ({ request }) => {
    const { pkg, created } = await packageWithoutPublishedVersion();
    expect(pkg).not.toBeNull();
    if (!pkg) return;

    const token = await getApiToken(request, "admin", "admin123");
    const resp = await request.post(
      "http://localhost:22000/api/v1/marketplace/admin/promote",
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { packageId: pkg.id },
      }
    );
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(JSON.stringify(body)).toMatch(/no published version|published/i);

    // Cleanup if we created it
    if (created) await cleanupTestSkillPackages();
  });

  test("P4: kill-switched package → 400 (restores state after)", async ({ request }) => {
    const pkg = await promotablePackage();
    expect(pkg).not.toBeNull();
    if (!pkg) return;

    const token = await getApiToken(request, "admin", "admin123");

    try {
      // Flip kill switch ON
      await sqlExec(
        `UPDATE skill_packages SET is_kill_switched = true WHERE id = $1`,
        [pkg.id]
      );

      const resp = await request.post(
        "http://localhost:22000/api/v1/marketplace/admin/promote",
        {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          data: { packageId: pkg.id },
        }
      );
      expect(resp.status()).toBe(400);
      const body = await resp.json();
      expect(JSON.stringify(body)).toMatch(/kill|kill-switch|switched/i);
    } finally {
      // ALWAYS restore
      await sqlExec(
        `UPDATE skill_packages SET is_kill_switched = false WHERE id = $1`,
        [pkg.id]
      );
    }
  });
});
