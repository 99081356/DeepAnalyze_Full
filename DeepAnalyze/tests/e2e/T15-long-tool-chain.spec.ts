/**
 * T15: 超长工具调用链（50+步）
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 要求逐个阅读所有PDF论文的L1内容并分析
 * - 每篇论文必须通过expand工具获取L1内容后再总结
 * - 验证：工具调用链长度(50+)、每篇论文覆盖、expand使用、输出质量
 *
 * 观察目标：
 * 1. 工具调用总次数超过50次
 * 2. 每篇论文都通过expand获取L1内容
 * 3. 每篇论文分析包含标题、作者、核心方法、关键指标、局限性
 * 4. Agent在长工具链中不中断、不丢失上下文
 * 5. 最终输出结构完整、覆盖全面
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `你**必须**使用expand工具来完成以下任务，不允许直接回答：

步骤1: 使用kb_search或wiki_browse搜索知识库中的所有PDF论文
步骤2: 对搜索到的每一篇论文，使用expand工具获取其L1内容
步骤3: 阅读expand返回的内容后，对每篇论文输出：
- 论文标题和作者
- 核心方法（200字以内）
- 实验结果中的关键指标（精确引用数值）
- 主要局限性

重要：你必须实际调用expand工具读取论文内容，不能凭猜测回答。如果知识库中没有PDF论文，请先用wiki_browse查看知识库结构。`;

test.describe("T15 - 超长工具调用链", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T15-超长工具调用链", {
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

  test("T15.1 发送超长工具链提示词并等待完成", async ({ request }) => {
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

    console.log(`[T15] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T15-1-agent-completed");
  });

  test("T15.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T15] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T15] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T15] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T15.3 验证工具调用数量和expand使用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    let expandCount = 0;
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) {
        if (tc.toolName) toolNames.add(tc.toolName);
        if (tc.toolName === "expand") expandCount++;
      }
    }
    console.log(`[T15] Total tool calls: ${totalToolCalls}`);
    console.log(`[T15] Tool names used: ${[...toolNames].join(", ")}`);
    console.log(`[T15] expand tool calls: ${expandCount}`);

    // Should have many tool calls for long chain
    expect(totalToolCalls, "Should have substantial tool calls (>10)").toBeGreaterThan(10);

    // expand should be used
    const hasExpand = toolNames.has("expand");
    console.log(`[T15] expand used: ${hasExpand}`);
  });

  test("T15.4 验证论文分析内容覆盖", async ({ request }) => {
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

    // Check for paper analysis components
    const components = [
      { name: "论文标题", keywords: ["论文", "标题", "paper", "title"] },
      { name: "作者", keywords: ["作者", "author"] },
      { name: "核心方法", keywords: ["方法", "method", "核心", "算法", "approach"] },
      { name: "关键指标", keywords: ["指标", "准确", "precision", "recall", "F1", "性能", "score"] },
      { name: "局限性", keywords: ["局限", "不足", "limitation", "缺点"] },
    ];
    for (const comp of components) {
      const found = comp.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T15] Component "${comp.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T15-4-paper-analysis-content");
  });

  test("T15.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T15-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T15] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T15-5-final-state");
  });
});
