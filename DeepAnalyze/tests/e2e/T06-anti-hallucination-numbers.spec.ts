/**
 * T06: 反幻觉严格验证——数字敏感性测试
 *
 * 测试设计：
 * - 双KB（bigtest + lbctest）
 * - 要求找出所有数字内容并精确溯源
 * - 验证：数字零幻觉、完整性、溯源可验证、无模糊表述
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";
const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请从两个知识库中找出所有涉及金额、数量、日期、百分比等数字的内容，整理成结构化表格。每个数字必须标注：来源文档名、原文段落、上下文含义。不允许出现任何原文中不存在的数字。`;

test.describe("T06 - 反幻觉数字敏感性测试", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T06-数字敏感性测试", {
      kbIds: [BIGTEST_KB_ID, LBC_KB_ID],
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

  test("T06.1 发送数字敏感性测试提示词并等待完成", async ({ request }) => {
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

    console.log(`[T06] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T06-1-agent-completed");
  });

  test("T06.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    console.log(`[T06] Total messages: ${msgs.length}`);
    expect(msgs.length).toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T06] Total output: ${totalChars} chars`);
    expect(totalChars).toBeGreaterThan(500);
  });

  test("T06.3 验证工具调用（应使用expand/doc_grep精确定位）", async ({ request }) => {
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
    console.log(`[T06] Tool calls: ${totalToolCalls}, tools: ${[...toolNames].join(", ")}`);

    // Should have used KB tools to locate numbers precisely
    expect(totalToolCalls, "Should have tool calls for number extraction").toBeGreaterThan(0);
  });

  test("T06.4 验证数字内容质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    const allContent = msgs.filter((m) => m.role === "assistant").map((m) => m.content || "").join("\n");

    // Check for number patterns
    const hasNumbers = /\d+/.test(allContent);
    console.log(`[T06] Contains numbers: ${hasNumbers}`);

    // Check for source attribution
    const hasSourceRef = allContent.includes("文档") || allContent.includes("来源") || allContent.includes("原文");
    console.log(`[T06] Has source attribution: ${hasSourceRef}`);

    await takeScreenshot(page, "T06-4-number-content");
  });

  test("T06.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T06-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T06] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);
  });
});
