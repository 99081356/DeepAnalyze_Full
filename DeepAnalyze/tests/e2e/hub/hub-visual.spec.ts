/**
 * T83: Hub visual regression test.
 *
 * Navigates each redesigned Hub page, captures a screenshot, and verifies
 * no critical console errors occur. Also tests the dark mode toggle.
 *
 * Pages tested:
 *   - dashboard  (/)
 *   - orgs       (/orgs)
 *   - skills     (/skills)
 *   - sharings   (/sharings)
 *   - workers    (/workers)
 *   - security   (/security)
 *
 * Prerequisites:
 *   - Hub backend running on http://localhost:22000
 *   - Seed data present (admin/admin123)
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { HUB_BASE, adminLogin } from "../helpers/hubApi";
import { openHub, hubShot } from "../helpers/hubUi";

test.describe.serial("Hub visual regression — T83", () => {
  let ctx: APIRequestContext;
  let adminToken: string;

  test.beforeAll(async () => {
    ctx = await request.newContext();
    const admin = await adminLogin(ctx);
    adminToken = admin.token!;
  });

  test.afterAll(async () => {
    await ctx.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await openHub(page, adminToken);
  });

  const PAGES = [
    { name: "dashboard", path: "/" },
    { name: "orgs", path: "/orgs" },
    { name: "skills", path: "/skills" },
    { name: "sharings", path: "/sharings" },
    { name: "workers", path: "/workers" },
    { name: "security", path: "/security" },
  ];

  for (const p of PAGES) {
    test(`T83: ${p.name} page renders without console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      // BrowserRouter uses normal paths (no hash)
      await page.goto(`${HUB_BASE}${p.path}`);
      await page.waitForLoadState("networkidle");
      await hubShot(page, `t83-${p.name}-light`);

      // Filter out known benign errors
      const critical = errors.filter(
        (e) =>
          !e.includes("favicon") &&
          !e.includes("ResizeObserver") &&
          !e.includes("ERR_CONNECTION_REFUSED"),
      );
      expect(critical).toEqual([]);
    });
  }

  test("T83: theme toggle switches to dark mode", async ({ page }) => {
    await page.goto(`${HUB_BASE}/`);
    await page.waitForLoadState("networkidle");

    // ThemeToggle renders a button with title="Switch to dark theme" (when in light mode)
    // or title="Switch to light theme" (when in dark mode).
    // It also has class "theme-toggle" and aria-label.
    const toggle = page
      .locator('button[title*="theme"], button[title*="Theme"], button.theme-toggle')
      .first();
    await toggle.click();
    await page.waitForTimeout(500);

    await hubShot(page, "t83-dashboard-dark");

    // useTheme applies dark mode via data-theme attribute on <html>
    const htmlAttr = await page.evaluate(
      () => document.documentElement.dataset.theme || document.documentElement.className,
    );
    expect(htmlAttr).toContain("dark");
  });
});
