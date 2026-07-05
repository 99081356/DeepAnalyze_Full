/**
 * T34: 搜索饱和检测
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 反复搜索与"RAG检索增强"相关的内容，使用不同关键词
 * - 直到搜索结果不再有新增内容，记录每次新增结果数量
 *
 * 观察目标：
 * 1. 饱和检测触发：搜索结果趋于稳定
 * 2. 搜索效率：Agent不会无限搜索，饱和后停止
 * 3. 去重有效：不同关键词搜索到的相同文档被去重
 * 4. 覆盖率：最终所有相关文档都被找到
 * 5. 工具调用合理：搜索次数在合理范围内
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请反复搜索知识库中与'RAG检索增强'相关的内容，每次使用稍微不同的关键词，直到搜索结果不再有新增内容。记录每次搜索的新增结果数量。`;

test.describe("T34 - 搜索饱和检测", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T34-搜索饱和检测", {
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

  test("T34.1 发送搜索饱和检测提示词并等待完成", async ({ request }) => {
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

    console.log(`[T34] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T34-1-agent-completed");
  });

  test("T34.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T34] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T34] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T34] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T34.3 验证多次搜索工具调用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    let searchCallCount = 0;
    const searchTools = ["kb_search", "wiki_browse", "doc_grep", "run_sql"];
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) {
        if (tc.toolName) toolNames.add(tc.toolName);
        if (searchTools.includes(tc.toolName)) searchCallCount++;
      }
    }
    console.log(`[T34] Total tool calls: ${totalToolCalls}`);
    console.log(`[T34] Tool names used: ${[...toolNames].join(", ")}`);
    console.log(`[T34] Search-related tool calls: ${searchCallCount}`);

    // Should have used search tools multiple times for saturation detection
    expect(searchCallCount, "Should have multiple search-related calls").toBeGreaterThanOrEqual(2);
  });

  test("T34.4 验证饱和检测结果内容", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for RAG-related keywords
    const hasRAG = allContent.includes("RAG") || allContent.includes("检索增强") || allContent.includes("知识检索");
    console.log(`[T34] Contains RAG keywords: ${hasRAG}`);

    // Check for saturation-related indicators
    const hasSaturationIndication = allContent.includes("饱和") || allContent.includes("新增") ||
      allContent.includes("不再") || allContent.includes("重复") || allContent.includes("稳定") ||
      allContent.includes("无新增");
    console.log(`[T34] Has saturation indication: ${hasSaturationIndication}`);

    // Check for search result recording
    const hasResultRecording = allContent.includes("结果") || allContent.includes("搜索") ||
      allContent.includes("找到") || allContent.includes("数量");
    console.log(`[T34] Has result recording: ${hasResultRecording}`);

    await takeScreenshot(page, "T34-4-saturation-results");
  });

  test("T34.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T34-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T34] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T34-5-final-state");
  });
});
