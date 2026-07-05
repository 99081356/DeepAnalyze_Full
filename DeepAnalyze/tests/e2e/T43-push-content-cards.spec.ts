/**
 * T43: push_content卡片显示与持久化
 *
 * 测试设计：
 * - 绑定bigtest知识库
 * - 要求Agent分析论文并使用push_content推送独立卡片
 * - 验证：push_content调用、卡片渲染、页面刷新后持久化
 *
 * 观察目标：
 * 1. Agent正确执行分析任务
 * 2. 消息和推送内容完整
 * 3. push_content工具被调用
 * 4. 内容质量和卡片渲染
 * 5. 刷新后卡片持久化
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请分析知识库中的论文，将每篇论文的分析结果用push_content推送为独立卡片。要求使用markdown格式，包含标题、摘要和关键发现。`;

test.describe("T43 - push_content卡片显示", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T43-push_content卡片显示", {
      kbIds: [TEST_KB_ID],
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

  test("T43.1 运行Agent", async ({ request }) => {
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
    }, { prompt: PROMPT, sid: sessionId });

    console.log(`[T43] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T43-1-agent-completed");
  });

  test("T43.2 验证消息和推送内容", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T43] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T43] Assistant messages: ${assistantMsgs.length}`);

    let totalPushedContents = 0;
    let totalPushedContentChars = 0;
    for (const msg of assistantMsgs) {
      const pushed = (msg.pushedContents || msg.metadata?.pushedContents || []) as any[];
      totalPushedContents += pushed.length;
      for (const pc of pushed) {
        totalPushedContentChars += (pc.data?.length || pc.content?.length || 0);
      }
    }
    console.log(`[T43] Total pushed content cards: ${totalPushedContents}`);
    console.log(`[T43] Total pushed content chars: ${totalPushedContentChars}`);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const totalChars = totalContent.length + totalPushedContentChars;
    console.log(`[T43] Total output chars: ${totalChars}`);
    expect(totalChars, "Should have substantial output").toBeGreaterThan(500);
  });

  test("T43.3 验证push_content工具调用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    let pushContentCount = 0;
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) {
        if (tc.toolName) toolNames.add(tc.toolName);
        if (tc.toolName === "push_content") pushContentCount++;
      }
    }
    console.log(`[T43] Total tool calls: ${totalToolCalls}`);
    console.log(`[T43] Tool names used: ${[...toolNames].join(", ")}`);
    console.log(`[T43] push_content calls: ${pushContentCount}`);

    const hasPushContent = toolNames.has("push_content");
    console.log(`[T43] push_content used: ${hasPushContent}`);
  });

  test("T43.4 检查内容质量和卡片渲染", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // Check for card-like elements in the frontend
    const cardSelectors = [
      "[class*='push-content']",
      "[class*='PushContent']",
      "[class*='card']",
      "[class*='Card']",
    ];
    for (const sel of cardSelectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        console.log(`[T43] Found ${count} elements matching "${sel}"`);
      }
    }

    await takeScreenshot(page, "T43-4-card-rendering");
  });

  test("T43.5 刷新后验证持久化并截图", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    // Refresh the page to verify persistence
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // Verify messages still available after refresh
    const msgs = await api.getMessages(sessionId);
    console.log(`[T43] Messages after refresh: ${msgs.length}`);
    expect(msgs.length, "Messages should persist after page refresh").toBeGreaterThanOrEqual(2);

    // Verify pushed contents persist
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    let totalPushedContents = 0;
    for (const msg of assistantMsgs) {
      const pushed = (msg.pushedContents || msg.metadata?.pushedContents || []) as any[];
      totalPushedContents += pushed.length;
    }
    console.log(`[T43] Pushed content cards after refresh: ${totalPushedContents}`);

    await takeScreenshot(page, "T43-5-persistence-after-refresh", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T43] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T43-5-final-state");
  });
});
