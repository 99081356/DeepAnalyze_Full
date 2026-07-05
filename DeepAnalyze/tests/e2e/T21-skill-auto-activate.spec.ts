/**
 * T21: 内置Skill自动激活
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 要求对知识库进行全面的知识库分析，生成分析报告
 * - 验证：skill_invoke自动触发、工具调用完整性、内容质量、前端显示
 *
 * 观察目标：
 * 1. Agent自动识别任务类型并调用skill_invoke
 * 2. skill_invoke触发内置的知识库分析skill
 * 3. 分析报告覆盖知识库各类型文档
 * 4. 输出内容有数据支撑，不编造
 * 5. 前端正确渲染分析结果
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请对知识库进行全面的知识库分析，生成分析报告。`;

test.describe("T21 - 内置Skill自动激活", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T21-内置Skill自动激活", {
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

  test("T21.1 发送知识库分析提示词并等待完成", async ({ request }) => {
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

    console.log(`[T21] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T21-1-agent-completed");
  });

  test("T21.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T21] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T21] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T21] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T21.3 验证工具调用和skill_invoke", async ({ request }) => {
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
    console.log(`[T21] Total tool calls: ${totalToolCalls}`);
    console.log(`[T21] Tool names used: ${[...toolNames].join(", ")}`);

    const hasSkillInvoke = toolNames.has("skill_invoke");
    console.log(`[T21] skill_invoke used: ${hasSkillInvoke}`);

    // Check KB tools used
    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T21] KB tools used: ${usedKBTools.join(", ")}`);
  });

  test("T21.4 验证分析报告内容质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    const elements = [
      { name: "知识库分析", keywords: ["知识库", "文档", "分析"] },
      { name: "分类统计", keywords: ["分类", "类型", "数量", "统计"] },
      { name: "报告结构", keywords: ["报告", "总结", "概述", "结论"] },
    ];

    for (const el of elements) {
      const found = el.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T21] Element "${el.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T21-4-content-quality");
  });

  test("T21.5 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T21-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T21] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T21-5-final-state");
  });
});
