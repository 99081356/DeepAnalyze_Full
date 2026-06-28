/**
 * Permissions spec — RBAC boundary checks.
 *
 * A1: non-super-admin on /skills sees NO promote buttons
 * A2: non-admin on /worker-skills sees error banner (API returns 403)
 * A3: anonymous — all 6 admin endpoints return 401 without token
 * E1: network error → error banner
 *
 * A1 + A2 use the controlled `test-noperm` user created by global-setup
 * (no role assignments → no skill:approve permission).
 */

import { test, expect } from "./fixtures.js";
import {
  loginFast,
  loginAs,
  captureScreenshot,
} from "./fixtures.js";

const NON_ADMIN_USER = process.env.HUB_NON_ADMIN_USER ?? "test-noperm";
const NON_ADMIN_PASS = process.env.HUB_NON_ADMIN_PASS ?? "Test1234!";

test.describe("Permissions", () => {
  test.afterEach(async ({ cleanup }) => {
    await cleanup();
  });

  test("A1: non-super-admin on /skills sees no promote buttons", async ({ page, request, cleanup }) => {
    await cleanup();
    await loginFast(page, request, NON_ADMIN_USER, NON_ADMIN_PASS);

    await page.goto("/skills", { waitUntil: "networkidle" });
    // Wait for nav to render (scoped assertion avoids duplicate text in topbar)
    await expect(page.locator("nav").getByText("企业技能包")).toBeVisible({ timeout: 5_000 });

    // No promote buttons should appear (only visible to super_admin)
    await expect(page.getByRole("button", { name: "推广到 Worker 市场" })).toHaveCount(0);

    await captureScreenshot(page, "permissions", "a1-non-admin-skills");
  });

  test("A2: non-admin on /worker-skills sees error banner (403)", async ({ page, cleanup }) => {
    await cleanup();
    // Use UI login to exercise full flow
    await loginAs(page, NON_ADMIN_USER, NON_ADMIN_PASS);

    await page.goto("/worker-skills", { waitUntil: "networkidle" });

    // The WorkerSkills.tsx catch block sets error message from thrown Error.
    // For 403, api/client throws `HTTP 403: ...`. Match broadly to handle browser-specific text.
    await expect(
      page.getByText(/HTTP 403|403|forbidden|Permission denied|权限|加载失败/i).first()
    ).toBeVisible({ timeout: 5_000 });

    await captureScreenshot(page, "permissions", "a2-non-admin-worker-skills");
  });

  test("A3: anonymous — all 6 admin endpoints return 401 without token", async ({ request }) => {
    const endpoints: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "GET", path: "/api/v1/marketplace/admin/skills" },
      { method: "POST", path: "/api/v1/marketplace/admin/skills/fake-id/approve" },
      { method: "POST", path: "/api/v1/marketplace/admin/skills/fake-id/reject", body: { reason: "x" } },
      { method: "POST", path: "/api/v1/marketplace/admin/skills/fake-id/deprecate", body: { reason: "x" } },
      { method: "DELETE", path: "/api/v1/marketplace/admin/skills/fake-id" },
      { method: "POST", path: "/api/v1/marketplace/admin/promote", body: { packageId: "x" } },
    ];

    for (const ep of endpoints) {
      const url = `http://localhost:22000${ep.path}`;
      const resp =
        ep.method === "GET"
          ? await request.get(url)
          : ep.method === "DELETE"
          ? await request.delete(url)
          : await request.post(url, {
              headers: { "Content-Type": "application/json" },
              data: ep.body ?? {},
            });
      expect(resp.status(), `${ep.method} ${ep.path} should be 401`).toBe(401);
    }
  });

  test("E1: simulated network error on admin/skills → error banner", async ({ page, request, cleanup }) => {
    await cleanup();
    await loginFast(page, request, "admin", "admin123");

    // Intercept admin skills list endpoint and force-fail
    await page.route("**/api/v1/marketplace/admin/skills**", (route) =>
      route.abort("failed")
    );

    await page.goto("/worker-skills", { waitUntil: "networkidle" });

    // Error banner should appear (catch block in WorkerSkills.tsx).
    // Browser-specific messages include "Failed to fetch" / "NetworkError" / "Load failed".
    await expect(
      page.getByText(/失败|Failed|Network|Error|网络|加载失败/i).first()
    ).toBeVisible({ timeout: 5_000 });

    await captureScreenshot(page, "permissions", "e1-network-error");

    // Clean up route to avoid affecting later tests
    await page.unrouteAll();
  });
});
