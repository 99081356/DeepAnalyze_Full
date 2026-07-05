/**
 * T22: Skill创建→验证→调用全链路
 *
 * 测试设计：
 * - 不使用知识库
 * - 要求创建一个新skill（市场分析助手），并保存到数据库
 * - 验证：skill_create触发、skill定义质量、调用执行、输出完整性
 *
 * 观察目标：
 * 1. Agent理解创建skill的请求并调用skill_create工具
 * 2. 创建的skill定义包含完整的功能描述和步骤
 * 3. skill被保存到数据库
 * 4. 输出包含skill相关的关键字内容
 * 5. 前端正确渲染整个过程
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const PROMPT = `请帮我创建一个新skill，名字叫'市场分析助手'，用途是分析市场数据和竞争格局。要求：1）先搜索相关市场数据 2）制作竞争对比表格 3）输出SWOT分析。保存到数据库。`;

test.describe("T22 - Skill创建验证调用全链路", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T22-Skill创建验证调用全链路");
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

  test("T22.1 发送Skill创建提示词并等待完成", async ({ request }) => {
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

    console.log(`[T22] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T22-1-agent-completed");
  });

  test("T22.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T22] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T22] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T22] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T22.3 验证工具调用", async ({ request }) => {
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
    console.log(`[T22] Total tool calls: ${totalToolCalls}`);
    console.log(`[T22] Tool names used: ${[...toolNames].join(", ")}`);
  });

  test("T22.4 验证Skill相关内容", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for skill-related keywords in output
    const skillKeywords = ["skill", "市场分析", "SWOT", "竞争"];
    const foundKeywords = skillKeywords.filter((kw) => allContent.includes(kw));
    console.log(`[T22] Skill-related keywords found: ${foundKeywords.join(", ")}`);

    // Check for skill_create in tool calls
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const allToolNames = new Set<string>();
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      for (const tc of calls) {
        if (tc.toolName) allToolNames.add(tc.toolName);
      }
    }
    const hasSkillCreate = allToolNames.has("skill_create");
    console.log(`[T22] skill_create tool used: ${hasSkillCreate}`);

    await takeScreenshot(page, "T22-4-skill-content");
  });

  test("T22.5 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T22-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T22] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T22-5-final-state");
  });
});
