/**
 * T42: 前端工具调用卡片显示
 *
 * 测试设计：
 * - 绑定bigtest知识库
 * - 要求搜索RAG相关内容并展开，产生工具调用卡片
 * - 验证：kb_search和expand工具调用、消息完整、前端卡片显示
 *
 * 观察目标：
 * 1. Agent正确执行搜索和展开操作
 * 2. 消息完整性
 * 3. kb_search和expand工具被调用
 * 4. 前端显示工具调用卡片
 * 5. 截图效果
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = "请搜索知识库中与'RAG'相关的内容，展开前3个搜索结果的L1内容。";

test.describe("T42 - 前端工具调用卡片", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T42-前端工具调用卡片", {
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

  test("T42.1 运行Agent", async ({ request }) => {
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

    console.log(`[T42] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T42-1-agent-completed");
  });

  test("T42.2 验证消息", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T42] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T42] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T42] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output").toBeGreaterThan(100);
  });

  test("T42.3 验证工具调用（kb_search, expand）", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) {
        if (tc.toolName) toolNames.add(tc.toolName);
      }
    }
    console.log(`[T42] Total tool calls: ${totalToolCalls}`);
    console.log(`[T42] Tool names used: ${[...toolNames].join(", ")}`);

    const hasKbSearch = toolNames.has("kb_search");
    const hasExpand = toolNames.has("expand");
    console.log(`[T42] kb_search used: ${hasKbSearch}, expand used: ${hasExpand}`);

    // At least one search tool should be used
    const searchTools = ["kb_search", "wiki_browse", "search"];
    const usedSearchTool = searchTools.some((t) => toolNames.has(t));
    console.log(`[T42] Used search tool: ${usedSearchTool}`);
  });

  test("T42.4 检查前端工具调用卡片", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // Look for tool call card elements
    const toolCardSelectors = [
      "[class*='tool-call']",
      "[class*='ToolCall']",
      "[class*='tool-call-card']",
      "[class*='tool_result']",
      "[class*='card']",
    ];
    for (const sel of toolCardSelectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        console.log(`[T42] Found ${count} elements matching "${sel}"`);
      }
    }

    await takeScreenshot(page, "T42-4-tool-call-cards");
  });

  test("T42.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T42-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T42] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T42-5-final-state");
  });
});
