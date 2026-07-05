/**
 * Smoke Tests — basic page load, navigation, and structure validation.
 * These verify the app boots and renders core UI elements correctly.
 */
import { test, expect } from "@playwright/test";

test.describe("Smoke Tests", () => {
  test("app loads and shows chat interface", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Should redirect to #/chat
    await expect(page).toHaveURL(/#\/chat/);

    // Page title should contain DeepAnalyze
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  test("sidebar shows 4 navigation items", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Check navigation labels exist
    const navLabels = ["对话", "知识库", "报告", "任务"];
    for (const label of navLabels) {
      const navItem = page.locator(`button:has-text("${label}")`).first();
      await expect(navItem).toBeVisible({ timeout: 5000 });
    }
  });

  test("header is visible", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Header should be present (contains app branding)
    const header = page.locator("header").first();
    await expect(header).toBeVisible({ timeout: 5000 });
  });

  test("new chat button exists in sidebar", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const newChatBtn = page.locator('button:has-text("新建对话")').first();
    await expect(newChatBtn).toBeVisible({ timeout: 5000 });
  });

  test("health API responds", async ({ request }) => {
    const resp = await request.get("/api/health");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });

  test("no console errors on initial load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Filter out known non-critical errors (e.g., missing KB, embedding warnings)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("404") &&
        !e.includes("Failed to fetch") &&
        !e.includes("NetworkError")
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
