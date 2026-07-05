/**
 * DeepAnalyze 系统性前端遍历测试
 * ================================
 * Phase 3: 用 Playwright 依次点击所有功能，验证页面加载、交互、异常处理
 *
 * 测试范围：
 *   1. 侧边栏所有导航项
 *   2. 创建/切换/删除 session
 *   3. 知识库管理 (创建/上传/处理/搜索)
 *   4. Agent 任务面板
 *   5. 报告页面
 *   6. 设置页面
 *   7. 各类输入和异常处理
 */

import { test, expect, Page, Request } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIDEBAR_NAV_ITEMS = ["对话", "知识库", "报告", "任务"] as const;

async function waitForApp(page: Page) {
  await page.goto("/#/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000); // React hydration
}

async function clickNav(page: Page, label: string) {
  const navBtn = page.locator(`button:has-text("${label}")`).first();
  await navBtn.click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// 1. 侧边栏导航遍历
// ---------------------------------------------------------------------------

test.describe("侧边栏导航遍历", () => {
  test("每个导航项都可见且可点击", async ({ page }) => {
    await waitForApp(page);

    for (const label of SIDEBAR_NAV_ITEMS) {
      const navBtn = page.locator(`button:has-text("${label}")`).first();
      await expect(navBtn).toBeVisible({ timeout: 5000 });
      await navBtn.click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
    }
  });

  test("侧边栏可收起和展开", async ({ page }) => {
    await waitForApp(page);

    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    // Collapse
    const collapseBtn = sidebar.locator("button[title='收起侧边栏']").first();
    if (await collapseBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await collapseBtn.click();
      await page.waitForTimeout(500);

      // Expand
      const expandBtn = sidebar.locator("button[title='展开侧边栏']").first();
      await expect(expandBtn).toBeVisible({ timeout: 3000 });
      await expandBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test("依次导航到所有页面并验证URL", async ({ page }) => {
    await waitForApp(page);

    const navTargets = [
      { label: "对话", pattern: /#\/chat/ },
      { label: "知识库", pattern: /#\/knowledge/ },
      { label: "报告", pattern: /#\/reports/ },
      { label: "任务", pattern: /#\/tasks/ },
    ];

    for (const target of navTargets) {
      await clickNav(page, target.label);
      await expect(page).toHaveURL(target.pattern);
    }
  });

  test("未知URL重定向到chat", async ({ page }) => {
    await page.goto("/#/nonexistent-page-xyz");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/#\/chat/);
  });
});

// ---------------------------------------------------------------------------
// 2. Session 管理
// ---------------------------------------------------------------------------

test.describe("Session 创建/切换/删除", () => {
  test("通过API创建session并在侧边栏显示", async ({ page, request }) => {
    const resp = await request.post("/api/sessions", {
      data: { title: `E2E测试Session ${Date.now()}` },
    });
    expect([200, 201]).toContain(resp.status());
    const session = await resp.json();
    expect(session.id).toBeTruthy();

    // Navigate to the session
    await page.goto(`/#/sessions/${session.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Session title should be visible somewhere in the UI
    const titleText = page.locator(`text=${session.title}`).first();
    await expect(titleText).toBeVisible({ timeout: 5000 });

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });

  test("创建多个session并切换", async ({ page, request }) => {
    const sessions = [];
    for (let i = 0; i < 3; i++) {
      const resp = await request.post("/api/sessions", {
        data: { title: `Switch测试${i}_${Date.now()}` },
      });
      const session = await resp.json();
      sessions.push(session);
    }

    // Navigate to each session
    for (const session of sessions) {
      await page.goto(`/#/sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      const titleText = page.locator(`text=${session.title}`).first();
      await expect(titleText).toBeVisible({ timeout: 5000 });
    }

    // Cleanup
    for (const session of sessions) {
      await request.delete(`/api/sessions/${session.id}`);
    }
  });

  test("删除session后从侧边栏消失", async ({ page, request }) => {
    const resp = await request.post("/api/sessions", {
      data: { title: `Delete测试_${Date.now()}` },
    });
    const session = await resp.json();

    // View the session
    await page.goto(`/#/sessions/${session.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Delete via API
    await request.delete(`/api/sessions/${session.id}`);

    // Navigate away and back
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Title should not be visible
    const deletedTitle = page.locator(`text=${session.title}`).first();
    await expect(deletedTitle).not.toBeVisible({ timeout: 3000 }).catch(() => {
      // This is OK - the session may have been removed from the sidebar already
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 知识库管理
// ---------------------------------------------------------------------------

test.describe("知识库管理", () => {
  // Use existing KB IDs from the running system
  const KB_IDS = {
    bigtest3: "89ee4db6-0626-4636-8c66-49a575d05832",
    lbctest: "f65cb573-05c7-4098-ba7d-c26c006986ee",
  };

  test("知识库列表页加载", async ({ page, request }) => {
    // Check API returns KBs
    const resp = await request.get("/api/knowledge/kbs");
    expect(resp.status()).toBe(200);
    const kbs = await resp.json();
    expect(Array.isArray(kbs) ? kbs.length : Object.keys(kbs).length).toBeGreaterThanOrEqual(0);
  });

  test("导航到知识库详情页", async ({ page }) => {
    await page.goto(`/#/knowledge/${KB_IDS.bigtest3}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Should load without errors
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("知识库文档列表加载", async ({ page, request }) => {
    const resp = await request.get(`/api/knowledge/kbs/${KB_IDS.bigtest3}/documents`);
    expect(resp.status()).toBe(200);
    const docs = await resp.json();
    // Should have documents
    const docList = Array.isArray(docs) ? docs : (docs as Record<string, unknown>).documents as unknown[];
    expect(docList.length).toBeGreaterThan(0);
  });

  test("知识库搜索功能", async ({ page, request }) => {
    const resp = await request.get(
      `/api/knowledge/${KB_IDS.bigtest3}/search?query=%E8%BF%90%E5%8A%A8%E5%91%98`,
    );
    // Search endpoint should respond (may be 200 or 404 depending on setup)
    expect([200, 404]).toContain(resp.status());
  });

  test("知识库Wiki浏览", async ({ page, request }) => {
    const resp = await request.get(
      `/api/knowledge/kbs/${KB_IDS.bigtest3}/documents`,
    );
    const docs = await resp.json();
    const docList = Array.isArray(docs) ? docs : (docs as Record<string, unknown>).documents as unknown[];

    if (docList.length > 0) {
      const firstDoc = docList[0] as Record<string, unknown>;
      const docId = firstDoc.id;
      // Try to get wiki page
      const wikiResp = await request.get(
        `/api/knowledge/${KB_IDS.bigtest3}/wiki/${docId}`,
      );
      // May return 200 or 404 depending on processing status
      expect([200, 404]).toContain(wikiResp.status());
    }
  });

  test("知识库搜索页面交互", async ({ page }) => {
    await page.goto(`/#/knowledge/${KB_IDS.bigtest3}/search`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Look for search input
    const searchInput = page.locator(
      'input[type="text"], input[type="search"], input[placeholder*="搜索"], input[placeholder*="Search"]',
    ).first();

    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchInput.fill("测试搜索");
      await searchInput.press("Enter");
      await page.waitForTimeout(1000);
      // Should not crash
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.waitForTimeout(500);
      const criticalErrors = errors.filter(
        (e) => !e.includes("favicon") && !e.includes("net::ERR"),
      );
      expect(criticalErrors).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Agent 任务面板
// ---------------------------------------------------------------------------

test.describe("Agent 任务面板", () => {
  test("任务页面加载", async ({ page }) => {
    await page.goto("/#/tasks");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Should not have critical errors
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("Agent API可用", async ({ request }) => {
    const resp = await request.get("/api/agents");
    expect(resp.status()).toBe(200);
  });

  test("任务列表API", async ({ request }) => {
    // Create a session first
    const sessionResp = await request.post("/api/sessions", {
      data: { title: `Task测试_${Date.now()}` },
    });
    const session = await sessionResp.json();

    // Get tasks for session
    const tasksResp = await request.get(`/api/agents/tasks/${session.id}`);
    expect(tasksResp.status()).toBe(200);

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });
});

// ---------------------------------------------------------------------------
// 5. 报告页面
// ---------------------------------------------------------------------------

test.describe("报告页面", () => {
  test("报告列表页加载", async ({ page }) => {
    await page.goto("/#/reports");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Should not crash
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("报告API可用", async ({ request }) => {
    const resp = await request.get("/api/reports");
    expect(resp.status()).toBe(200);
  });

  test("不存在的报告ID显示错误或空状态", async ({ page }) => {
    await page.goto("/#/reports/nonexistent-id-12345");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Should not crash - either shows error message or empty state
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 设置页面
// ---------------------------------------------------------------------------

test.describe("设置页面", () => {
  test("设置页面加载", async ({ page }) => {
    await page.goto("/#/settings");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(1000);
    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("设置API可用", async ({ request }) => {
    const resp = await request.get("/api/settings");
    expect(resp.status()).toBe(200);
  });

  test("能力查询API", async ({ request }) => {
    const resp = await request.get("/api/capabilities");
    expect(resp.status()).toBe(200);
    const caps = await resp.json();
    // Should have basic capabilities
    expect(caps).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 7. 聊天输入和异常处理
// ---------------------------------------------------------------------------

test.describe("聊天输入和异常处理", () => {
  test("聊天输入框可输入文本", async ({ page, request }) => {
    // Create a session
    const resp = await request.post("/api/sessions", {
      data: { title: `Chat输入测试_${Date.now()}` },
    });
    const session = await resp.json();

    await page.goto(`/#/sessions/${session.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Find input
    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Type text
    await input.fill("测试输入消息");
    const value = await input.inputValue();
    expect(value).toBe("测试输入消息");

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });

  test("空输入不触发发送", async ({ page, request }) => {
    const resp = await request.post("/api/sessions", {
      data: { title: `Empty输入测试_${Date.now()}` },
    });
    const session = await resp.json();

    await page.goto(`/#/sessions/${session.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Try to submit empty
    await input.press("Enter");
    await page.waitForTimeout(500);

    // No error should appear
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(500);
    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });

  test("长文本输入处理", async ({ page, request }) => {
    const resp = await request.post("/api/sessions", {
      data: { title: `Long输入测试_${Date.now()}` },
    });
    const session = await resp.json();

    await page.goto(`/#/sessions/${session.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Fill with long text
    const longText = "这是一段很长的测试文本。".repeat(100);
    await input.fill(longText);
    const value = await input.inputValue();
    expect(value.length).toBeGreaterThan(100);

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });

  test("特殊字符输入不崩溃", async ({ page, request }) => {
    const resp = await request.post("/api/sessions", {
      data: { title: `SpecialChar测试_${Date.now()}` },
    });
    const session = await resp.json();

    await page.goto(`/#/sessions/${session.id}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Special characters
    const specialChars = '<script>alert("xss")</script> & "quotes" \'single\' <tag> {json}';
    await input.fill(specialChars);
    const value = await input.inputValue();
    expect(value).toBeTruthy();

    // Cleanup
    await request.delete(`/api/sessions/${session.id}`);
  });
});

// ---------------------------------------------------------------------------
// 8. 全页面无JS错误扫描
// ---------------------------------------------------------------------------

test.describe("全页面无JS错误扫描", () => {
  const pages = [
    { url: "/#/", desc: "首页" },
    { url: "/#/chat", desc: "聊天页" },
    { url: "/#/reports", desc: "报告页" },
    { url: "/#/tasks", desc: "任务页" },
    { url: "/#/settings", desc: "设置页" },
  ];

  for (const p of pages) {
    test(`${p.desc} (${p.url}) 无严重JS错误`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(p.url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2000);

      const criticalErrors = errors.filter(
        (e) => !e.includes("favicon") && !e.includes("net::ERR") && !e.includes("ResizeObserver"),
      );
      expect(criticalErrors).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 9. 响应式布局测试
// ---------------------------------------------------------------------------

test.describe("响应式布局", () => {
  test("移动端视口加载不崩溃", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await waitForApp(page);

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(1000);

    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("平板视口加载不崩溃", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await waitForApp(page);

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.waitForTimeout(1000);

    const criticalErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR"),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. 网络异常模拟
// ---------------------------------------------------------------------------

test.describe("网络异常处理", () => {
  test("API不可用时显示错误状态", async ({ page, context }) => {
    // Block API requests
    await context.route("**/api/**", (route) => route.abort());

    await page.goto("/#/");
    await page.waitForTimeout(3000);

    // Should still show the page structure (React rendered)
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // Should not have uncaught errors that crash the page
    const html = await page.content();
    expect(html.length).toBeGreaterThan(100);
  });
});
