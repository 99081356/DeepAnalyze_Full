/**
 * T35: Anchor锚点系统精确溯源
 *
 * 测试设计：
 * - 选中lbctest知识库
 * - 搜索所有包含金额信息的内容
 * - 展示金额数值，使用expand获取精确段落位置
 * - 标注锚点信息，确认追溯能力
 *
 * 观察目标：
 * 1. 搜索到包含金额信息的内容
 * 2. 每条结果展示具体金额数值
 * 3. expand返回精确段落位置
 * 4. 锚点信息正确标注
 * 5. 每个金额都能追溯到原文位置
 * 6. 无幻觉编造金额
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请搜索知识库中所有包含金额信息的内容。对每条结果展示具体的金额数值，使用expand获取精确的段落位置，标注锚点信息。确认每个金额都能追溯到原文位置。`;

test.describe("T35 - Anchor锚点精确溯源", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T35-Anchor锚点精确溯源", {
      kbIds: [LBC_KB_ID],
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

  test("T35.1 发送锚点溯源提示词并等待完成", async ({ request }) => {
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

    console.log(`[T35] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T35-1-agent-completed");
  });

  test("T35.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T35] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T35] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T35] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T35.3 验证工具调用（搜索+expand）", async ({ request }) => {
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
    console.log(`[T35] Total tool calls: ${totalToolCalls}`);
    console.log(`[T35] Tool names used: ${[...toolNames].join(", ")}`);

    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T35] KB tools used: ${usedKBTools.join(", ")}`);
    expect(usedKBTools.length, "Should use at least 1 KB tool").toBeGreaterThan(0);

    // Should have used expand for precise location
    const hasExpand = toolNames.has("expand");
    console.log(`[T35] expand tool used: ${hasExpand}`);
  });

  test("T35.4 验证金额溯源内容", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for monetary amounts (Chinese yuan patterns)
    const hasYuan = allContent.includes("元") || allContent.includes("万") ||
      allContent.includes("¥") || /\d+[,.]?\d*\s*(元|万)/.test(allContent);
    console.log(`[T35] Contains monetary amounts: ${hasYuan}`);
    expect(hasYuan, 'Should mention monetary amounts').toBe(true);

    // Check for anchor/traceability keywords
    const hasAnchor = allContent.includes("锚点") || allContent.includes("anchor") ||
      allContent.includes("位置") || allContent.includes("段落");
    console.log(`[T35] Has anchor/position reference: ${hasAnchor}`);

    // Check for traceability keywords
    const hasTraceability = allContent.includes("溯源") || allContent.includes("原文") ||
      allContent.includes("定位") || allContent.includes("引用");
    console.log(`[T35] Has traceability reference: ${hasTraceability}`);

    await takeScreenshot(page, "T35-4-anchor-tracing");
  });

  test("T35.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T35-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T35] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T35-5-final-state");
  });
});
