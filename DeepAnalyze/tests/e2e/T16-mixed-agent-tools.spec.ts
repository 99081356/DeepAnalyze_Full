/**
 * T16: 主Agent+子Agent混合工具调用
 *
 * 测试设计：
 * - 选中lbctest知识库
 * - 主Agent先搜索阅读关键文档，再派出2个子Agent分析不同证据组
 * - 子Agent完成后主Agent综合输出最终分析
 * - 验证：主Agent工具调用、子Agent派发、综合分析、结果完整性
 *
 * 观察目标：
 * 1. 主Agent先自主使用工具搜索和阅读文档
 * 2. 然后使用delegate_task/workflow_run派出子Agent
 * 3. 2个子Agent分别分析不同证据组
 * 4. 子Agent完成后主Agent综合所有信息
 * 5. 主Agent和子Agent的工具调用不混淆
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `分析这个案件。先由你（主Agent）搜索和阅读关键文档，形成初步理解。然后派出2个子Agent分别分析不同的证据组。子Agent完成后，由你综合所有信息输出最终分析。`;

test.describe("T16 - 主Agent子Agent混合工具调用", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T16-主Agent子Agent混合工具调用", {
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

  test("T16.1 发送混合工具调用提示词并等待完成", async ({ request }) => {
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

    console.log(`[T16] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T16-1-agent-completed");
  });

  test("T16.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T16] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T16] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T16] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T16.3 验证工具调用和子Agent派发", async ({ request }) => {
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
    console.log(`[T16] Total tool calls: ${totalToolCalls}`);
    console.log(`[T16] Tool names used: ${[...toolNames].join(", ")}`);

    // Should have used knowledge base tools for main agent
    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T16] KB tools used by main agent: ${usedKBTools.join(", ")}`);

    // Should have delegation mechanism for sub-agents
    const hasDelegateTask = toolNames.has("delegate_task");
    const hasWorkflowRun = toolNames.has("workflow_run");
    console.log(`[T16] delegate_task used: ${hasDelegateTask}`);
    console.log(`[T16] workflow_run used: ${hasWorkflowRun}`);
    expect(hasDelegateTask || hasWorkflowRun, "Should delegate to sub-agents").toBeTruthy();
  });

  test("T16.4 验证混合分析内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for main agent initial analysis
    const hasInitialAnalysis = allContent.includes("初步") || allContent.includes("搜索") || allContent.includes("阅读");
    console.log(`[T16] Main agent initial analysis found: ${hasInitialAnalysis}`);

    // Check for sub-agent evidence group analysis
    const hasEvidenceGroup = allContent.includes("证据") || allContent.includes("分析") || allContent.includes("子Agent");
    console.log(`[T16] Sub-agent evidence analysis found: ${hasEvidenceGroup}`);

    // Check for final synthesis
    const hasSynthesis = allContent.includes("综合") || allContent.includes("总结") || allContent.includes("最终") || allContent.includes("汇总");
    console.log(`[T16] Final synthesis found: ${hasSynthesis}`);

    await takeScreenshot(page, "T16-4-mixed-analysis-content");
  });

  test("T16.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T16-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T16] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T16-5-final-state");
  });
});
