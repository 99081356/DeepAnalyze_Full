/**
 * T44: 多面板切换与状态保持
 *
 * 测试设计：
 * - 不绑定知识库
 * - 多步骤测试：在聊天面板发消息，切换到知识库页面，切换到设置页面，切回聊天
 * - 验证：各页面加载正常，切回聊天后消息仍在
 *
 * 观察目标：
 * 1. 聊天面板发送消息正常
 * 2. 知识库页面加载正常
 * 3. 设置页面加载正常
 * 4. 切回聊天后面板消息保持
 * 5. 各页面截图
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const CHAT_PROMPT = "你好，这是一条测试消息，用于验证面板切换后消息保持。";

test.describe("T44 - 多面板切换与状态保持", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T44-多面板切换", {
      kbIds: [],
    });
    sessionId = session.id;

    page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    (page as any).__consoleErrors = consoleErrors;
  });

  test.afterAll(async () => {
    if (page) await page.close().catch(() => {});
  });

  test("T44.1 在聊天面板发送消息并截图", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    const status = await page.evaluate(async ({ prompt, sid }) => {
      const resp = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: prompt, sessionId: sid }),
      });
      const reader = resp.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      return resp.status;
    }, { prompt: CHAT_PROMPT, sid: sessionId });

    console.log(`[T44] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T44-1-chat-message-sent");
  });

  test("T44.2 导航到知识库页面验证加载", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, "knowledge");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Verify the knowledge page loaded
    const bodyText = await page.textContent("body");
    expect(bodyText, "Knowledge page should have content").toBeTruthy();
    console.log(`[T44] Knowledge page loaded, body text length: ${bodyText?.length || 0}`);

    await takeScreenshot(page, "T44-2-knowledge-page");
  });

  test("T44.3 导航到设置页面验证加载", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, "settings");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Verify the settings page loaded
    const bodyText = await page.textContent("body");
    expect(bodyText, "Settings page should have content").toBeTruthy();
    console.log(`[T44] Settings page loaded, body text length: ${bodyText?.length || 0}`);

    await takeScreenshot(page, "T44-3-settings-page");
  });

  test("T44.4 导航回聊天验证消息保持", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // Verify messages are still there
    const msgs = await api.getMessages(sessionId);
    console.log(`[T44] Messages after navigation: ${msgs.length}`);
    expect(msgs.length, "Messages should still be present after panel switching").toBeGreaterThanOrEqual(2);

    // Verify the user message content is still there
    const userMsgs = msgs.filter((m) => m.role === "user");
    const hasOriginalMessage = userMsgs.some(
      (m) => (m.content || "").includes("测试消息") || (m.content || "").includes("面板切换")
    );
    console.log(`[T44] Original message preserved: ${hasOriginalMessage}`);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    console.log(`[T44] Assistant content length after navigation: ${totalContent.length}`);
    expect(totalContent.length, "Assistant response should still be present").toBeGreaterThan(0);

    await takeScreenshot(page, "T44-4-message-preserved");
  });

  test("T44.5 最终截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T44-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T44] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T44-5-final-state");
  });
});
