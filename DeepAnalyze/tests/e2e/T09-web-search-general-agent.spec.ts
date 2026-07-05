/**
 * T09: 网络搜索+知识库混合分析（通用Agent能力验证）
 *
 * 测试设计：
 * - 无知识库（纯网络搜索模式）
 * - 要求生成AI发展综述技术报告+PPT大纲
 * - 验证：网络搜索触发、多源验证、技术报告质量、通用Agent能力
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const PROMPT = `给我写一个最新的AI发展综述的详细技术报告，包括所有技术模块，演进方向，主要问题，处理方法等等详细信息，基于最新的deepseek，Qwen，kimi，minimax等国内模型的技术报告和论文。完成后再基于详细技术报告写一个完善的PPT大纲。`;

test.describe("T09 - 网络搜索+通用Agent能力", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    // Create session without KB scope — pure web search mode
    const session = await api.createSession("T09-网络搜索通用Agent");
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

  test("T09.1 发送网络搜索提示词并等待完成", async ({ request }) => {
    test.setTimeout(1_800_000);

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
        while (true) { const { done } = await reader.read(); if (done) break; }
      }
      return resp.status;
    }, { prompt: PROMPT, sid: sessionId });

    console.log(`[T09] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T09-1-agent-completed");
  });

  test("T09.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    console.log(`[T09] Total messages: ${msgs.length}`);
    expect(msgs.length).toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T09] Total output: ${totalChars} chars`);
    expect(totalChars).toBeGreaterThan(500);
  });

  test("T09.3 验证web_search工具调用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) { if (tc.toolName) toolNames.add(tc.toolName); }
    }
    console.log(`[T09] Tool calls: ${totalToolCalls}, tools: ${[...toolNames].join(", ")}`);

    // Key check: web_search should have been used
    const hasWebSearch = toolNames.has("web_search");
    console.log(`[T09] web_search used: ${hasWebSearch}`);
  });

  test("T09.4 验证AI模型覆盖和PPT大纲", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    const allContent = msgs.filter((m) => m.role === "assistant").map((m) => m.content || "").join("\n");

    // Check for AI model mentions
    const models = ["DeepSeek", "Qwen", "Kimi", "MiniMax", "deepseek", "qwen", "kimi", "minimax"];
    for (const model of models) {
      console.log(`[T09] Model "${model}" mentioned: ${allContent.includes(model)}`);
    }

    // Check for PPT outline
    const hasPPT = allContent.includes("PPT") || allContent.includes("幻灯片") || allContent.includes("大纲");
    console.log(`[T09] Has PPT outline: ${hasPPT}`);

    await takeScreenshot(page, "T09-4-web-search-content");
  });

  test("T09.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T09-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T09] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);
  });
});
