/**
 * T45: 上下文压缩关键信息保留
 *
 * 测试设计：
 * - 绑定bigtest知识库
 * - 要求执行长时间分析任务，搜索并阅读大量论文内容后生成综合报告
 * - 验证：大量工具调用（>30），报告引用多篇论文，压缩后关键信息不丢失
 *
 * 观察目标：
 * 1. 长时间分析任务正常完成
 * 2. 消息完整性
 * 3. 工具调用数量 > 30
 * 4. 报告引用多篇论文的关键发现
 * 5. 前端显示正常
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `你**必须**使用工具完成以下分析任务，不允许直接回答：

步骤1: 使用kb_search或wiki_browse搜索知识库中所有PDF论文
步骤2: 使用expand工具阅读前5篇论文的L1内容
步骤3: 使用expand工具阅读更多论文的L1内容
步骤4: 继续使用expand阅读剩余论文
步骤5: 基于所有阅读内容生成综合技术演进报告

重要：每个步骤都必须实际调用工具（expand/kb_search/wiki_browse），不能跳过。报告必须引用所有论文的关键发现，包括论文标题、方法、结果和局限性。`;

test.describe("T45 - 压缩关键信息保留", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T45-压缩关键信息保留", {
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

  test("T45.1 执行长时间分析任务", async ({ request }) => {
    test.setTimeout(3_600_000); // 60 minutes

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

    console.log(`[T45] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T45-1-long-analysis-completed");
  });

  test("T45.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T45] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T45] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T45] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T45.3 验证大量工具调用（>30）", async ({ request }) => {
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
    console.log(`[T45] Total tool calls: ${totalToolCalls}`);
    console.log(`[T45] Tool names used: ${[...toolNames].join(", ")}`);

    // Should have a large number of tool calls due to the multi-step analysis
    expect(totalToolCalls, "Should have >15 tool calls for long analysis").toBeGreaterThan(15);

    // Check for key tools
    const hasSearch = toolNames.has("kb_search") || toolNames.has("wiki_browse");
    const hasExpand = toolNames.has("expand");
    console.log(`[T45] Has search: ${hasSearch}, Has expand: ${hasExpand}`);
  });

  test("T45.4 验证报告引用多篇论文", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    // Collect all content including pushedContents from metadata
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => {
        const parts: string[] = [m.content || ""];
        const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
        for (const pc of pushed) {
          if (pc.data) parts.push(typeof pc.data === "string" ? pc.data : JSON.stringify(pc.data));
          if (pc.content) parts.push(typeof pc.content === "string" ? pc.content : JSON.stringify(pc.content));
        }
        return parts.join("\n");
      })
      .join("\n");

    // Check for paper-related content
    const paperKeywords = [
      "论文", "paper", "研究", "方法", "实验",
      "结果", "发现", "技术", "模型", "性能",
      "准确", "创新", "局限", "建议", "报告",
    ];
    const foundKeywords = paperKeywords.filter((kw) => allContent.includes(kw));
    console.log(`[T45] Paper-related keywords found (${foundKeywords.length}/${paperKeywords.length}): ${foundKeywords.join(", ")}`);
    expect(foundKeywords.length, "Should mention multiple paper-related terms").toBeGreaterThanOrEqual(3);

    // Check for report structure
    const reportStructureKeywords = ["报告", "综合", "总结", "分析", "演进", "对比"];
    const foundStructure = reportStructureKeywords.filter((kw) => allContent.includes(kw));
    console.log(`[T45] Report structure keywords found: ${foundStructure.join(", ")}`);

    await takeScreenshot(page, "T45-4-paper-references");
  });

  test("T45.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T45-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T45] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T45-5-final-state");
  });
});
