/**
 * T33: 搜索模式对比（向量/BM25/混合）
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 分别使用语义搜索、关键词搜索、混合搜索搜索"记忆机制"
 * - 对比三种模式的结果数量和相关性
 *
 * 观察目标：
 * 1. 三种搜索模式都可用
 * 2. 结果数量有差异
 * 3. 向量搜索倾向语义相关，BM25倾向精确匹配
 * 4. 混合模式综合两者优点
 * 5. Agent能合理评估各模式的优劣
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请分别使用不同的搜索模式搜索'记忆机制'：1. 语义搜索 2. 关键词搜索 3. 混合搜索。对比三种模式的结果数量和相关性。`;

test.describe("T33 - 搜索模式对比", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T33-搜索模式对比", {
      kbIds: [BIGTEST_KB_ID],
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

  test("T33.1 发送搜索模式对比提示词并等待完成", async ({ request }) => {
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

    console.log(`[T33] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T33-1-agent-completed");
  });

  test("T33.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T33] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T33] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T33] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T33.3 验证多模式搜索工具调用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    let searchCallCount = 0;
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) {
        if (tc.toolName) toolNames.add(tc.toolName);
        if (tc.toolName === "kb_search") searchCallCount++;
      }
    }
    console.log(`[T33] Total tool calls: ${totalToolCalls}`);
    console.log(`[T33] Tool names used: ${[...toolNames].join(", ")}`);
    console.log(`[T33] kb_search calls: ${searchCallCount}`);

    // Should have used kb_search tool multiple times for different modes
    const hasKBSearch = toolNames.has("kb_search");
    console.log(`[T33] kb_search used: ${hasKBSearch}`);
    expect(hasKBSearch, "Should use kb_search").toBe(true);
  });

  test("T33.4 验证搜索模式对比内容", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for search mode references
    const hasSemantic = allContent.includes("语义") || allContent.includes("semantic") || allContent.includes("向量");
    const hasKeyword = allContent.includes("关键词") || allContent.includes("keyword") || allContent.includes("BM25");
    const hasHybrid = allContent.includes("混合") || allContent.includes("hybrid");
    console.log(`[T33] Semantic mode: ${hasSemantic}, Keyword mode: ${hasKeyword}, Hybrid mode: ${hasHybrid}`);

    // Check for comparison analysis
    const hasComparison = allContent.includes("对比") || allContent.includes("比较") ||
      allContent.includes("差异") || allContent.includes("优劣");
    console.log(`[T33] Has comparison: ${hasComparison}`);

    // Check for "记忆" keyword coverage
    const hasMemoryKeyword = allContent.includes("记忆");
    console.log(`[T33] Contains '记忆' keyword: ${hasMemoryKeyword}`);

    await takeScreenshot(page, "T33-4-modes-comparison");
  });

  test("T33.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T33-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T33] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T33-5-final-state");
  });
});
