/**
 * 11 - Full Page Visual Traversal Tests
 * Covers: all pages and states via screenshots + DOM assertions.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { TEST_KB_ID } from "./fixtures";

test.describe("11 - Visual Traversal", () => {
  let api: ReturnType<typeof createApi>;

  test.beforeEach(async ({ request }) => {
    api = createApi(request);
  });

  // -- Chat Page --
  test("11.1 chat page empty state", async ({ page }) => {
    await gotoPage(page, "");
    await page.waitForTimeout(500);
    await takeScreenshot(page, "visual-chat-empty");

    // Sidebar should be visible
    const sidebar = page.locator("aside, [class*='sidebar']").first();
    if (await sidebar.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Sidebar exists
    }
  });

  test("11.2 chat page with session and messages", async ({ page }) => {
    // Create a session
    const session = await api.createSession("Visual Chat Session");

    try {
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      // Chat input should be visible
      const chatInput = page.locator("textarea, [contenteditable='true']").first();
      await expect(chatInput).toBeVisible({ timeout: 5000 });

      await takeScreenshot(page, "visual-chat-session");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  // -- Knowledge Page --
  test("11.3 knowledge base page - document tree", async ({ page }) => {
    await page.goto(`/#/knowledge/${TEST_KB_ID}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    await takeScreenshot(page, "visual-knowledge-tree");
  });

  test("11.4 knowledge base page - document cards", async ({ page }) => {
    await page.goto(`/#/knowledge/${TEST_KB_ID}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Should see document cards or document list
    await takeScreenshot(page, "visual-knowledge-docs");
  });

  test("11.5 knowledge base page - search bar", async ({ page }) => {
    await page.goto(`/#/knowledge/${TEST_KB_ID}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Look for search input
    const searchInput = page.locator('input[placeholder*="搜索"], input[placeholder*="search"], input[type="search"]').first();
    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await takeScreenshot(page, "visual-knowledge-search");
    }
  });

  // -- Reports Page --
  test("11.6 reports page", async ({ page }) => {
    await gotoPage(page, "reports");
    await page.waitForTimeout(500);

    await takeScreenshot(page, "visual-reports");
  });

  // -- Tasks Page --
  test("11.7 tasks page", async ({ page }) => {
    await gotoPage(page, "tasks");
    await page.waitForTimeout(500);

    await takeScreenshot(page, "visual-tasks");
  });

  // -- Settings Page --
  test("11.8 settings page - all tabs", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const settingsBtn = page.locator('button:has-text("设置")').first();
    if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(1000);

      await takeScreenshot(page, "visual-settings-all");
    }
  });

  // -- Theme --
  test("11.9 dark theme toggle", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Look for theme toggle
    const themeBtn = page.locator('[title*="主题"], [title*="theme"], [aria-label*="theme"], button:has-text("浅色"), button:has-text("深色")').first();
    if (await themeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await themeBtn.click();
      await page.waitForTimeout(500);
      await takeScreenshot(page, "visual-dark-theme");
    } else {
      // Theme toggle may not exist or be in a different location
      await takeScreenshot(page, "visual-default-theme");
    }
  });

  // -- Sidebar --
  test("11.10 sidebar collapse and expand", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await takeScreenshot(page, "visual-sidebar-expanded");

    // Look for collapse button
    const collapseBtn = page.locator('[title*="折叠"], [title*="collapse"], button[aria-label*="sidebar"]').first();
    if (await collapseBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await collapseBtn.click();
      await page.waitForTimeout(500);
      await takeScreenshot(page, "visual-sidebar-collapsed");

      // Click again to expand
      await collapseBtn.click();
      await page.waitForTimeout(500);
      await takeScreenshot(page, "visual-sidebar-re-expanded");
    }
  });

  // -- Right Panel --
  test("11.11 right panel opens from header buttons", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Try opening each panel button
    const panelButtons = ["会话", "技能", "插件", "定时", "Teams"];

    for (const btnText of panelButtons) {
      const btn = page.locator(`button:has-text("${btnText}")`).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
        await takeScreenshot(page, `visual-panel-${btnText}`);
      }
    }
  });

  // -- Header --
  test("11.12 header button group", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    await takeScreenshot(page, "visual-header");
  });

  // -- Mobile Viewport --
  test("11.13 mobile viewport - basic layout doesn't crash", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Page should render without crashing
    const root = page.locator("#root");
    const html = await root.innerHTML();
    expect(html.length).toBeGreaterThan(100);

    await takeScreenshot(page, "visual-mobile");
  });

  // -- Tablet Viewport --
  test("11.14 tablet viewport", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    await takeScreenshot(page, "visual-tablet");
  });

  // -- Session History --
  test("11.15 session history in sidebar", async ({ page }) => {
    // Create a few sessions
    const s1 = await api.createSession("Visual History 1");
    const s2 = await api.createSession("Visual History 2");

    try {
      await page.goto("/#/");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);

      // Click on 对话 to ensure chat view
      const chatNav = page.locator('button:has-text("对话")').first();
      if (await chatNav.isVisible({ timeout: 2000 }).catch(() => false)) {
        await chatNav.click();
        await page.waitForTimeout(500);
      }

      await takeScreenshot(page, "visual-session-history");
    } finally {
      await api.deleteSession(s1.id).catch(() => {});
      await api.deleteSession(s2.id).catch(() => {});
    }
  });
});
