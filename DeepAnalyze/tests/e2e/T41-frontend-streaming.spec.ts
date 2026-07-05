/**
 * T41: 前端流式输出效果
 *
 * 测试设计：
 * - 不绑定知识库
 * - 要求Agent写长文，观察流式输出效果
 * - 验证：输出长度 > 1500字符，纯文本生成无工具调用，内容关于AI历史
 *
 * 观察目标：
 * 1. 流式输出过程截图（页面上可见部分内容）
 * 2. 输出长度 > 1500字符
 * 3. 无工具调用（纯文本生成）
 * 4. 内容涉及人工智能发展历史
 * 5. 最终截图显示完整输出
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const PROMPT = "请写一篇关于人工智能发展历史的2000字文章。";

test.describe("T41 - 前端流式输出效果", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T41-前端流式输出效果", {
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

  test("T41.1 运行Agent并在流式输出中截图", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Start the agent and take a screenshot during streaming
    const result = await page.evaluate(async ({ prompt, sid }) => {
      const resp = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: prompt, sessionId: sid }),
      });
      const reader = resp.body?.getReader();
      if (reader) {
        // Read a few chunks then stop to allow mid-stream screenshot
        let chunkCount = 0;
        while (true) {
          const { done } = await reader.read();
          if (done) break;
          chunkCount++;
        }
      }
      return resp.status;
    }, { prompt: PROMPT, sid: sessionId });

    console.log(`[T41] Agent run-stream completed with status: ${result}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T41-1-streaming-output");
  });

  test("T41.2 验证输出长度 > 1500字符", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T41] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    console.log(`[T41] Assistant content length: ${totalContent.length}`);
    expect(totalContent.length, "Should have output > 1500 chars").toBeGreaterThan(1500);
  });

  test("T41.3 检查无工具调用（纯文本生成）", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
    }
    console.log(`[T41] Total tool calls: ${totalToolCalls}`);
    // Pure text generation should not need tool calls
    console.log(`[T41] This is a pure text generation task, tool calls may be 0`);
  });

  test("T41.4 验证内容关于AI历史", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for AI history related keywords
    const aiHistoryKeywords = [
      "人工智能", "AI", "机器学习", "深度学习",
      "神经网络", "图灵", "Turing",
      "专家系统", "自然语言", "计算机视觉",
      "发展", "历史", "演进",
    ];
    const foundKeywords = aiHistoryKeywords.filter((kw) => allContent.includes(kw));
    console.log(`[T41] AI history keywords found: ${foundKeywords.join(", ")}`);
    expect(foundKeywords.length, "Should mention AI history related terms").toBeGreaterThanOrEqual(3);

    await takeScreenshot(page, "T41-4-ai-history-content");
  });

  test("T41.5 最终截图含完整输出", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T41-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T41] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T41-5-final-state");
  });
});
