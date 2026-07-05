/**
 * Navigation E2E Tests — page switching, sidebar behavior, URL routing.
 */
import { test, expect } from "@playwright/test";

test.describe("Navigation — Page Switching", () => {
  test("navigate to chat view", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const chatNav = page.locator('button:has-text("对话")').first();
    await chatNav.click();
    await expect(page).toHaveURL(/#\/chat/);
  });

  test("navigate to knowledge view", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const kbNav = page.locator('button:has-text("知识库")').first();
    await kbNav.click();
    // Knowledge navigates to #/knowledge/{kbId} or #/knowledge/_new
    await expect(page).toHaveURL(/#\/knowledge/);
  });

  test("navigate to reports view", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const reportsNav = page.locator('button:has-text("报告")').first();
    await reportsNav.click();
    await expect(page).toHaveURL(/#\/reports/);
  });

  test("navigate to tasks view", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const tasksNav = page.locator('button:has-text("任务")').first();
    await tasksNav.click();
    await expect(page).toHaveURL(/#\/tasks/);
  });

  test("navigate through all views in sequence", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const views = [
      { label: "对话", urlPattern: /#\/chat/ },
      { label: "知识库", urlPattern: /#\/knowledge/ },
      { label: "报告", urlPattern: /#\/reports/ },
      { label: "任务", urlPattern: /#\/tasks/ },
    ];

    for (const view of views) {
      const navBtn = page.locator(`button:has-text("${view.label}")`).first();
      await navBtn.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(view.urlPattern);
    }
  });
});

test.describe("Navigation — Sidebar", () => {
  test("sidebar is visible on load", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Sidebar should be visible (contains "新建对话" button)
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible({ timeout: 5000 });
  });

  test("sidebar collapse/expand toggle works", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Find the collapse toggle button (ChevronLeft icon area)
    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // The collapse button is positioned absolute right of sidebar
    const collapseBtn = sidebar.locator("button[title='收起侧边栏']").first();
    await collapseBtn.click();
    await page.waitForTimeout(500);

    // After collapse, the expand button should be visible
    const expandBtn = sidebar.locator("button[title='展开侧边栏']").first();
    await expect(expandBtn).toBeVisible({ timeout: 3000 });

    // Expand back
    await expandBtn.click();
    await page.waitForTimeout(500);

    // Sidebar should be expanded again
    await expect(collapseBtn).toBeVisible({ timeout: 3000 });
  });

  test("active nav item is highlighted", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Click on "对话" — it should be highlighted
    const chatNav = page.locator('button:has-text("对话")').first();
    await chatNav.click();

    // Wait for React state to propagate and active style to apply
    await page.waitForTimeout(500);

    // The active item should have a non-transparent background
    // Check by polling the style until it changes from transparent
    await expect(async () => {
      const bgStyle = await chatNav.evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
      expect(bgStyle).not.toBe("transparent");
      expect(bgStyle).not.toBe("rgba(0, 0, 0, 0)");
    }).toPass({ timeout: 5000 });
  });
});

test.describe("Navigation — URL Routing", () => {
  test("direct URL to #/chat loads chat view", async ({ page }) => {
    await page.goto("/#/chat");
    await page.waitForLoadState("networkidle");

    // #/chat without an active session shows the welcome screen with DeepAnalyze branding
    // A textarea is only visible when a session is active
    const welcomeHeading = page.locator("text=DeepAnalyze").first();
    await expect(welcomeHeading).toBeVisible({ timeout: 5000 });
  });

  test("direct URL to #/reports loads reports view", async ({ page }) => {
    await page.goto("/#/reports");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/#\/reports/);
  });

  test("direct URL to #/tasks loads tasks view", async ({ page }) => {
    await page.goto("/#/tasks");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/#\/tasks/);
  });

  test("unknown URL redirects to chat", async ({ page }) => {
    await page.goto("/#/nonexistent-page");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/#\/chat/);
  });

  test("session URL loads chat with that session", async ({ page, request }) => {
    // Create a session via API
    const resp = await request.post("/api/sessions", {
      data: { title: "Nav Test Session" },
    });
    const session = await resp.json();

    await page.goto(`/#/sessions/${session.id}`);
    await page.waitForLoadState("networkidle");

    // Should show the session title in the sidebar
    const sessionTitle = page.locator("text=Nav Test Session").first();
    await expect(sessionTitle).toBeVisible({ timeout: 5000 });

    // Clean up
    await request.delete(`/api/sessions/${session.id}`);
  });
});
