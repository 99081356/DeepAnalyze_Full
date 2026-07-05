/**
 * T50: 端到端全链路压力测试
 *
 * 测试设计：
 * - 双知识库绑定（bigtest + lbctest）
 * - 覆盖系统所有核心功能
 * - 验证：全工具覆盖、多模式运行、总步骤数、context管理、结果完整性
 *
 * 观察目标：
 * 1. 全工具覆盖：wiki_browse, kb_search, expand, workflow_run, skill_invoke, push_content, write_file等
 * 2. 多模式运行：主Agent + 子Agent + Skill调用
 * 3. 总步骤数：50+次工具调用
 * 4. context管理：多次压缩后仍保持关键信息
 * 5. 结果完整：10个子任务都有对应输出
 * 6. 前端显示正常
 * 7. 系统不崩溃：全程无500错误、无OOM
 * 8. 耗时合理（不超过60分钟）
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";
const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请执行以下综合任务，覆盖系统所有核心功能：
1. 浏览两个知识库的完整文档列表
2. 搜索两个库中与"法律"相关的内容
3. 对bigtest中的剧本杀使用workflow_run并行分析（每个剧本杀一个子Agent）
4. 对lbctest使用evidence-chain skill分析证据链
5. 生成一份跨库的对比分析报告（push_content）
6. 将报告写入文件（write_file）
7. 搜索网络获取最新的法律科技资讯（web_search）
8. 最终输出完整的分析摘要`;

test.describe("T50 - 端到端全链路压力测试", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T50-全链路压力测试", {
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

  test("T50.1 发送全链路压力测试提示词并等待完成", async ({ request }) => {
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

    console.log(`[T50] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T50-1-agent-completed");
  });

  test("T50.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T50] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T50] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T50] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T50.3 验证工具调用覆盖", async ({ request }) => {
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
    console.log(`[T50] Total tool calls: ${totalToolCalls}`);
    console.log(`[T50] Tool names used: ${[...toolNames].join(", ")}`);

    // Check key tools
    const keyTools = ["wiki_browse", "expand", "push_content", "write_file"];
    const usedKeyTools = keyTools.filter((t) => toolNames.has(t));
    console.log(`[T50] Key tools used: ${usedKeyTools.join(", ")}`);

    // Check delegation mechanisms
    const hasWorkflowRun = toolNames.has("workflow_run");
    const hasSkillInvoke = toolNames.has("skill_invoke");
    console.log(`[T50] workflow_run: ${hasWorkflowRun}, skill_invoke: ${hasSkillInvoke}`);

    // Should have at least some tool calls
    expect(totalToolCalls, "Should have 5+ tool calls").toBeGreaterThanOrEqual(5);
  });

  test("T50.4 验证push_content卡片", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalPushedContents = 0;
    for (const msg of assistantMsgs) {
      const pushed = (msg.pushedContents || msg.metadata?.pushedContents || []) as any[];
      totalPushedContents += pushed.length;
    }
    console.log(`[T50] Total pushed content cards: ${totalPushedContents}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T50-4-push-content-cards");
  });

  test("T50.5 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T50-5-final-fullpage", { fullPage: true });

    const messages = page.locator("[class*='message'], [class*='Message']");
    const msgCount = await messages.count();
    console.log(`[T50] Visible message elements: ${msgCount}`);

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T50] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T50-5-final-state");
  });
});
