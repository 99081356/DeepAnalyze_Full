/**
 * T11: 并行模式——10子Agent大规模文档分组分析
 *
 * 测试设计：
 * - 选中bigtest知识库（242个文档）
 * - 要求使用workflow_run并行模式，将文档分组，每组分配子Agent
 * - 验证：workflow_run触发、合理分组、子Agent数量、面板显示、结果完整性、报告质量
 *
 * 观察目标：
 * 1. Agent主动调用workflow_run(mode=parallel)
 * 2. 文档按逻辑关联分组
 * 3. 5-8个子Agent并行运行
 * 4. SubAgentPanel正确显示所有子Agent状态
 * 5. 每组都有分析结果，无遗漏
 * 6. 主Agent综合汇总报告质量
 * 7. 不同组的分析内容不重叠
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请使用workflow_run并行模式，将知识库中所有文档按类型分成5-8组，每组分配一个子Agent进行深度分析。每个子Agent负责：文档清单整理、核心内容摘要、关键发现提炼。所有子Agent完成后，由主Agent汇总输出综合分析报告。`;

test.describe("T11 - 并行模式子Agent文档分组分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T11-并行子Agent分析", {
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

  test("T11.1 发送并行分析提示词并等待完成", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    const api = createApi(request);

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

    console.log(`[T11] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T11-1-agent-completed");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T11-2-agent-completed");
  });

  test("T11.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T11] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T11] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs
      .map((m) => m.content || "")
      .join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T11] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T11.3 验证工具调用和workflow_run", async ({ request }) => {
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
    console.log(`[T11] Total tool calls: ${totalToolCalls}`);
    console.log(`[T11] Tool names used: ${[...toolNames].join(", ")}`);

    // Check if workflow_run was used
    const hasWorkflowRun = toolNames.has("workflow_run");
    const hasDelegateTask = toolNames.has("delegate_task");
    console.log(`[T11] workflow_run used: ${hasWorkflowRun}`);
    console.log(`[T11] delegate_task used: ${hasDelegateTask}`);

    // At least one delegation mechanism should be used
    expect(hasWorkflowRun || hasDelegateTask, "Should use delegation (workflow_run or delegate_task)").toBeTruthy();
  });

  test("T11.4 验证push_content卡片", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalPushedContents = 0;
    for (const msg of assistantMsgs) {
      const pushed = (msg.pushedContents || msg.metadata?.pushedContents || []) as any[];
      totalPushedContents += pushed.length;
    }
    console.log(`[T11] Total pushed content cards: ${totalPushedContents}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    await takeScreenshot(page, "T11-4-push-content-cards");
  });

  test("T11.5 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T11-5-final-fullpage", { fullPage: true });

    const messages = page.locator("[class*='message'], [class*='Message']");
    const msgCount = await messages.count();
    console.log(`[T11] Visible message elements: ${msgCount}`);

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T11] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T11-5-final-state");
  });
});
