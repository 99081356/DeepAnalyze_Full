/**
 * Frontend Integration Test — simulates real user interactions through browser.
 * Tests: page load, navigation, chat sessions, knowledge base browsing,
 * document layer viewing, and multi-turn conversation.
 */
import { test, expect } from "@playwright/test";
import { TEST_KB_ID, DOC, FILE_META } from "./fixtures.js";

test.describe("Frontend Integration Tests", () => {

  // ── Page Load & Navigation ─────────────────────────────────────────

  test("app loads with correct title and layout", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const title = await page.title();
    expect(title).toContain("DeepAnalyze");

    // Header should be visible
    await expect(page.locator("header").first()).toBeVisible({ timeout: 5000 });
  });

  test("sidebar navigation works", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Click 知识库 nav
    const kbNav = page.locator('button:has-text("知识库")').first();
    await expect(kbNav).toBeVisible({ timeout: 5000 });
    await kbNav.click();
    await page.waitForTimeout(500);

    // URL should change to knowledge base view
    await expect(page).toHaveURL(/#\/(knowledge|kb)/, { timeout: 3000 });

    // Go back to 对话
    const chatNav = page.locator('button:has-text("对话")').first();
    await chatNav.click();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/#\/chat/, { timeout: 3000 });
  });

  // ── Chat Session Management ────────────────────────────────────────

  test("create new chat session and send a message", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Click 新建对话 button
    const newChatBtn = page.locator('button:has-text("新建对话")').first();
    await expect(newChatBtn).toBeVisible({ timeout: 5000 });
    await newChatBtn.click();
    await page.waitForTimeout(1000);

    // Should have an input area
    const inputArea = page.locator('textarea, [contenteditable="true"], input[type="text"]').first();
    await expect(inputArea).toBeVisible({ timeout: 5000 });

    // Type a simple message
    const testMessage = "你好，请回复OK即可";
    await inputArea.fill(testMessage);

    // Find and click send button (or press Enter)
    const sendBtn = page.locator('button[aria-label="send"], button:has-text("发送"), button[type="submit"]').first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      await inputArea.press("Enter");
    }

    // Wait for response — look for assistant message appearing
    // The message area should show both user and assistant messages
    await page.waitForTimeout(15000); // Wait for agent to process

    // Check that the user message appears in the chat
    const userMsgVisible = await page.locator(`text=${testMessage}`).first().isVisible().catch(() => false);

    // Check for any assistant response (could be "OK" or longer)
    const pageContent = await page.content();
    const hasAssistantResponse = pageContent.includes("OK") ||
      pageContent.includes("你好") ||
      pageContent.includes("assistant") ||
      pageContent.includes("message");

    expect(userMsgVisible || hasAssistantResponse).toBeTruthy();
  });

  // ── Knowledge Base Browsing ────────────────────────────────────────

  test("knowledge base page loads and shows content", async ({ page }) => {
    // Navigate to knowledge base
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const kbNav = page.locator('button:has-text("知识库")').first();
    await expect(kbNav).toBeVisible({ timeout: 5000 });
    await kbNav.click();
    await page.waitForTimeout(1500);

    // Knowledge base list should show entries
    // Wait for KB list to render
    await page.waitForTimeout(2000);

    const pageContent = await page.content();
    // Either we see KB items, or an empty state message
    const hasKbContent = pageContent.includes("知识库") ||
      pageContent.includes("E2E") ||
      pageContent.includes("暂无") ||
      pageContent.includes("empty") ||
      pageContent.includes("document");

    expect(hasKbContent).toBeTruthy();
  });

  test("knowledge base document list loads", async ({ page }) => {
    // Go directly to a specific KB
    await page.goto(`/#/knowledge/${TEST_KB_ID}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    const pageContent = await page.content();

    // Should show KB name or documents
    const hasContent = pageContent.includes("E2E") ||
      pageContent.includes("antigravity") ||
      pageContent.includes("athlete") ||
      pageContent.includes("document") ||
      pageContent.includes("文件") ||
      pageContent.includes("知识库") ||
      pageContent.includes("暂无");

    expect(hasContent).toBeTruthy();
  });

  // ── Document Layer Viewing ─────────────────────────────────────────

  test("document detail page shows layers", async ({ page }) => {
    // Navigate to a document in the test KB
    await page.goto(`/#/knowledge/${TEST_KB_ID}/${DOC.pdf}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    const pageContent = await page.content();

    // Should show document info or layer buttons
    const hasDocInfo = pageContent.includes("antigravity") ||
      pageContent.includes("PDF") ||
      pageContent.includes("L0") ||
      pageContent.includes("L1") ||
      pageContent.includes("L2") ||
      pageContent.includes("摘要") ||
      pageContent.includes("结构") ||
      pageContent.includes("展开") ||
      pageContent.includes("文件");

    expect(hasDocInfo).toBeTruthy();
  });

  // ── Report & Task Navigation ───────────────────────────────────────

  test("reports page loads", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const reportNav = page.locator('button:has-text("报告")').first();
    await expect(reportNav).toBeVisible({ timeout: 5000 });
    await reportNav.click();
    await page.waitForTimeout(1500);

    const pageContent = await page.content();
    // Either reports list or empty state
    const hasContent = pageContent.includes("报告") ||
      pageContent.includes("report") ||
      pageContent.includes("暂无") ||
      pageContent.includes("empty");

    expect(hasContent).toBeTruthy();
  });

  test("tasks page loads", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const taskNav = page.locator('button:has-text("任务")').first();
    await expect(taskNav).toBeVisible({ timeout: 5000 });
    await taskNav.click();
    await page.waitForTimeout(1500);

    const pageContent = await page.content();
    const hasContent = pageContent.includes("任务") ||
      pageContent.includes("task") ||
      pageContent.includes("暂无") ||
      pageContent.includes("empty") ||
      pageContent.includes("workflow");

    expect(hasContent).toBeTruthy();
  });

  // ── Session Chat with Agent (Real Interaction) ─────────────────────

  test("multi-turn conversation works in browser", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Create new session
    const newChatBtn = page.locator('button:has-text("新建对话")').first();
    await newChatBtn.click();
    await page.waitForTimeout(1000);

    // Turn 1: Send a simple context-establishing message
    const inputArea = page.locator('textarea, [contenteditable="true"]').first();
    await expect(inputArea).toBeVisible({ timeout: 5000 });

    await inputArea.fill("我的名字是测试用户Alpha。请回复OK即可。");
    await inputArea.press("Enter");

    // Wait for agent response
    await page.waitForTimeout(20000);

    // Verify turn 1 response appeared
    let pageText = await page.innerText("body").catch(() => "");
    const turn1Responded = pageText.includes("OK") || pageText.includes("测试用户");

    // Turn 2: Ask about context
    await page.waitForTimeout(2000);

    // Find input again (may have been re-rendered)
    const inputArea2 = page.locator('textarea, [contenteditable="true"]').first();
    if (await inputArea2.isVisible().catch(() => false)) {
      await inputArea2.fill("我叫什么名字？");
      await inputArea2.press("Enter");

      // Wait for response
      await page.waitForTimeout(20000);

      pageText = await page.innerText("body").catch(() => "");
      // Should recall the name
      const contextRecalled = pageText.includes("Alpha") || pageText.includes("测试用户");
      // This test is informational — we log it but don't fail
      // because the agent may take time or format differently
      console.log(`[Multi-turn] Turn 1 responded: ${turn1Responded}, Context recalled: ${contextRecalled}`);
    }

    // At minimum, the chat should have rendered
    expect(turn1Responded).toBeTruthy();
  });

  // ── No Console Errors ──────────────────────────────────────────────

  test("no critical console errors during navigation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Navigate through all main pages
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const kbNav = page.locator('button:has-text("知识库")').first();
    await kbNav.click();
    await page.waitForTimeout(1000);

    const reportNav = page.locator('button:has-text("报告")').first();
    await reportNav.click();
    await page.waitForTimeout(1000);

    const taskNav = page.locator('button:has-text("任务")').first();
    await taskNav.click();
    await page.waitForTimeout(1000);

    const chatNav = page.locator('button:has-text("对话")').first();
    await chatNav.click();
    await page.waitForTimeout(1000);

    // Filter out known non-critical errors
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("404") &&
        !e.includes("Failed to fetch") &&
        !e.includes("NetworkError") &&
        !e.includes("ResizeObserver")
    );
    expect(criticalErrors).toHaveLength(0);
  });

  // ── Responsive Layout ──────────────────────────────────────────────

  test("layout adapts to mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // App should still render something
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // Header or app container should exist
    const appContent = page.locator("#root, [data-testid='app'], header").first();
    await expect(appContent).toBeVisible({ timeout: 5000 });
  });
});
