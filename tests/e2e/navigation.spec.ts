/**
 * Navigation spec — verify nav items, page rendering, banner links.
 *
 * N1: Admin login → nav contains renamed item + new item
 * N2: /worker-skills page renders banner, H1, tabs, search
 * N3: /skills page renders banner with link to /worker-skills
 * N4: Banner link click navigates from /skills → /worker-skills
 */

import { test, expect } from "./fixtures.js";
import { loginFast, captureScreenshot } from "./fixtures.js";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page, request, cleanup }) => {
    await loginFast(page, request, "admin", "admin123");
    await cleanup();
  });

  test("N1: nav contains renamed '企业技能包' and new 'Worker 技能市场'", async ({ page }) => {
    await page.goto("/skills", { waitUntil: "networkidle" });
    await captureScreenshot(page, "navigation", "n1-nav-items");

    // Renamed item
    await expect(page.locator("nav").getByText("企业技能包")).toBeVisible();
    // New item
    await expect(page.locator("nav").getByText("Worker 技能市场")).toBeVisible();
  });

  test("N2: /worker-skills renders banner, H1, 5 tabs, search input", async ({ page }) => {
    await page.goto("/worker-skills", { waitUntil: "networkidle" });
    await captureScreenshot(page, "navigation", "n2-worker-skills-page");

    // Banner
    await expect(page.getByText("管理 DA Worker 可下载安装的 Skill")).toBeVisible();
    // H1
    await expect(page.getByRole("heading", { level: 1, name: "Worker 技能市场" })).toBeVisible();
    // 5 tabs
    for (const label of ["待审核", "已批准", "已拒绝", "已弃用", "全部"]) {
      await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
    }
    // Search input
    await expect(page.getByPlaceholder("搜索 name / slug / description")).toBeVisible();
  });

  test("N3: /skills shows banner with link to /worker-skills", async ({ page }) => {
    await page.goto("/skills", { waitUntil: "networkidle" });
    await captureScreenshot(page, "navigation", "n3-skills-banner");

    // Banner text unique to /skills page
    await expect(page.getByText(/企业内部技能包/)).toBeVisible();
    // Banner link — use exact:true to disambiguate from nav item "🌐 Worker 技能市场"
    const link = page.getByRole("link", { name: "Worker 技能市场", exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/worker-skills");
  });

  test("N4: clicking banner link on /skills navigates to /worker-skills", async ({ page }) => {
    await page.goto("/skills", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Worker 技能市场", exact: true }).click();
    await page.waitForURL("**/worker-skills");
    await expect(page).toHaveURL(/\/worker-skills$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Worker 技能市场" })
    ).toBeVisible();
  });
});
