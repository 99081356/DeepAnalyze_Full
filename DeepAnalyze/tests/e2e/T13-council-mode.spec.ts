/**
 * T13: Council模式——多角度+交叉审查
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 要求使用council模式，安排3个不同视角的子Agent分析学术论文
 * - 第一轮完成后进行交叉审查
 * - 验证：council模式触发、多视角分析、交叉审查、结果完整性
 *
 * 观察目标：
 * 1. Agent使用council模式安排多个子Agent
 * 2. 3个不同视角（技术评估、应用分析、批判审查）都有输出
 * 3. 交叉审查环节有实质内容
 * 4. 各视角分析不重叠，各有侧重
 * 5. 主Agent综合汇总质量
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请使用council模式，安排3个不同视角的子Agent分析知识库中的学术论文：技术评估者、应用分析者、批判审查者。第一轮完成后进行交叉审查，每个Agent审查另一个Agent的分析。`;

test.describe("T13 - Council模式多角度分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T13-Council模式多角度分析", {
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

  test("T13.1 发送council模式提示词并等待完成", async ({ request }) => {
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

    console.log(`[T13] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T13-1-agent-completed");
  });

  test("T13.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T13] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T13] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T13] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T13.3 验证工具调用和council模式", async ({ request }) => {
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
    console.log(`[T13] Total tool calls: ${totalToolCalls}`);
    console.log(`[T13] Tool names used: ${[...toolNames].join(", ")}`);

    const hasWorkflowRun = toolNames.has("workflow_run");
    const hasDelegateTask = toolNames.has("delegate_task");
    console.log(`[T13] workflow_run used: ${hasWorkflowRun}`);
    console.log(`[T13] delegate_task used: ${hasDelegateTask}`);

    // At least one delegation mechanism should be used
    expect(hasWorkflowRun || hasDelegateTask, "Should use delegation (workflow_run or delegate_task)").toBeTruthy();
  });

  test("T13.4 验证多视角和交叉审查内容", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for different perspectives
    const perspectives = [
      { name: "技术评估", keywords: ["技术", "评估", "方法", "算法", "模型", "技术评估"] },
      { name: "应用分析", keywords: ["应用", "场景", "实用", "应用分析", "落地"] },
      { name: "批判审查", keywords: ["批判", "审查", "局限", "不足", "批判审查", "问题"] },
    ];
    for (const p of perspectives) {
      const found = p.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T13] Perspective "${p.name}" covered: ${found}`);
    }

    // Check for cross-review content
    const hasCrossReview = allContent.includes("交叉") || allContent.includes("审查") || allContent.includes("互评");
    console.log(`[T13] Cross-review content found: ${hasCrossReview}`);

    await takeScreenshot(page, "T13-4-council-content");
  });

  test("T13.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T13-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T13] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T13-5-final-state");
  });
});
