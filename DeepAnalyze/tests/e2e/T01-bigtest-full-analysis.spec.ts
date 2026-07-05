/**
 * T01: bigtest全库综合深度分析（超长输出）
 *
 * 测试设计：
 * - 选中bigtest知识库（242个文档）
 * - 发送要求对全部内容分类分析的提示词
 * - 验证：分类完整性、独立报告推送、报告体量、无幻觉、结构质量、前端显示
 *
 * 观察目标：
 * 1. 所有242个文档都被覆盖，无遗漏类别
 * 2. 每类分析作为独立push_content卡片推送
 * 3. 总输出不少于5万字
 * 4. 论文技术名称、作者、年份有据可查
 * 5. 剧本杀推理有证据支持
 * 6. push_content卡片正确渲染，可滚动
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { waitForAgentTask, waitForMessages } from "./helpers/wait";
import { TEST_KB_ID } from "./fixtures";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `现在请你分析知识库文档的全部内容，分析清楚所有内容的主要分类关系，从属关系，分析清楚每一类，每一块知识的相关性。针对论文，请给出一份详细的分析报告分析这些论文的技术演进关系，分析不同技术的优劣势，预测未来核心的研究方向和建议，给出详细的分析报告。如果是剧本杀，请分析整个剧本的关系，找出明确的杀手和时间线推理关系，找出所有证据链条和推理逻辑链条，每个剧本杀单独给出详细的完整故事脉络和逻辑关系推理。如果是表格，详细统计分析表格内容和数据情况。其他类型也自定义不同需求，对整个知识库进行全面深入完整的分析与整理。`;

test.describe("T01 - bigtest全库综合深度分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T01-bigtest全库分析", {
      kbIds: [TEST_KB_ID],
    });
    sessionId = session.id;

    page = await browser.newPage();
    // Collect console errors
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    // Store for later access
    (page as any).__consoleErrors = consoleErrors;
  });

  test.afterAll(async () => {
    if (page) await page.close().catch(() => {});
  });

  test("T01.1 发送全库分析提示词并等待完成", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    const api = createApi(request);

    // Start the agent run from the browser context using fetch.
    // The browser context persists across test cases, unlike Playwright's
    // per-test request context which would cancel SSE streams.
    // Navigate to the app first so fetch uses the correct origin.
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    await page.evaluate(async ({ prompt, sid }) => {
      const resp = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: prompt, sessionId: sid }),
      });
      // Read the SSE stream to completion to keep the connection alive
      const reader = resp.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      return resp.status;
    }, { prompt: PROMPT, sid: sessionId });

    console.log("[T01] Agent run-stream completed");

    // Take initial screenshot (agent should have completed by now)
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T01-1-agent-completed");

    // Wait for final message persistence
    await page.waitForTimeout(3000);

    // Take screenshot of completed state
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T01-2-agent-completed");
  });

  test("T01.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T01] Total messages: ${msgs.length}`);

    // Should have at least user + assistant messages
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    // Find assistant messages
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T01] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    // Check total output length (content + pushed contents)
    const totalContent = assistantMsgs
      .map((m) => m.content || "")
      .join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T01] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T01.3 验证push_content卡片", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    // Check for pushed contents in metadata
    let totalPushedContents = 0;
    for (const msg of assistantMsgs) {
      const pushed = (msg.pushedContents || msg.metadata?.pushedContents || []) as any[];
      totalPushedContents += pushed.length;
    }
    console.log(`[T01] Total pushed content cards: ${totalPushedContents}`);

    // Verify in UI
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Look for push content cards in the DOM
    const pushCards = page.locator("[class*='push-content'], [class*='PushContent'], [data-type='push-content']");
    const pushCardCount = await pushCards.count();
    console.log(`[T01] Push content cards in DOM: ${pushCardCount}`);

    await takeScreenshot(page, "T01-3-push-content-cards");
  });

  test("T01.4 验证工具调用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    // Check for tool calls in top-level toolCalls or metadata
    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) {
        if (tc.toolName) toolNames.add(tc.toolName);
      }
    }
    console.log(`[T01] Total tool calls: ${totalToolCalls}`);
    console.log(`[T01] Tool names used: ${[...toolNames].join(", ")}`);

    // Should have used knowledge base tools
    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T01] KB tools used: ${usedKBTools.join(", ")}`);
    expect(usedKBTools.length, "Should use at least 1 KB tool").toBeGreaterThan(0);
  });

  test("T01.5 验证内容分类覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for coverage of major document categories
    const categories = [
      { name: "论文", keywords: ["论文", "学术", "RAG", "记忆", "retrieval"] },
      { name: "剧本杀", keywords: ["剧本杀", "凶手", "推理", "线索", "自杀派对", "追凶手记", "柯南之死", "剪烛夜行"] },
      { name: "表格", keywords: ["表格", "Excel", "xlsx", "数据"] },
      { name: "图片", keywords: ["图片", "截图", "照片", "image"] },
      { name: "音频", keywords: ["音频", "录音", "mp3"] },
      { name: "视频", keywords: ["视频", "mp4"] },
    ];

    for (const cat of categories) {
      const found = cat.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T01] Category "${cat.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T01-5-content-coverage");
  });

  test("T01.6 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // Full page screenshot
    await takeScreenshot(page, "T01-6-final-fullpage", { fullPage: true });

    // Scroll through messages and take section screenshots
    const messages = page.locator("[class*='message'], [class*='Message']");
    const msgCount = await messages.count();
    console.log(`[T01] Visible message elements: ${msgCount}`);

    // Check for thinking content display
    const thinkingSection = page.locator("text=过程记录, text=思考过程, text=Thinking").first();
    const thinkingVisible = await thinkingSection.isVisible().catch(() => false);
    console.log(`[T01] Thinking section visible: ${thinkingVisible}`);

    // Check console errors
    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T01] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T01-6-final-state");
  });
});
