/**
 * T18: 嵌套工作流——子Agent中再分派子Agent
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 主Agent按主题分3组，每组一个子Agent
 * - 论文组子Agent如果发现论文太多，再使用delegate_task分派更细粒度的分析任务
 * - 验证：嵌套工作流、子Agent再分派、多层任务编排、结果完整性
 *
 * 观察目标：
 * 1. 主Agent使用delegate_task/workflow_run分派3个子Agent
 * 2. 论文组子Agent识别到论文较多后再次分派
 * 3. 嵌套层级正确（主Agent→子Agent→孙Agent）
 * 4. 所有层级的结果都汇聚回主Agent
 * 5. 系统在嵌套工作流中稳定运行
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请将知识库按主题分为3个大组，每组使用一个子Agent分析。其中分析论文组的子Agent如果发现论文太多，应该再使用delegate_task分派更细粒度的分析任务。`;

test.describe("T18 - 嵌套工作流", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T18-嵌套工作流", {
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

  test("T18.1 发送嵌套工作流提示词并等待完成", async ({ request }) => {
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

    console.log(`[T18] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T18-1-agent-completed");
  });

  test("T18.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T18] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T18] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T18] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T18.3 验证工具调用和嵌套分派", async ({ request }) => {
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
    console.log(`[T18] Total tool calls: ${totalToolCalls}`);
    console.log(`[T18] Tool names used: ${[...toolNames].join(", ")}`);

    const hasWorkflowRun = toolNames.has("workflow_run");
    const hasDelegateTask = toolNames.has("delegate_task");
    console.log(`[T18] workflow_run used: ${hasWorkflowRun}`);
    console.log(`[T18] delegate_task used: ${hasDelegateTask}`);

    // Should use delegation for nested workflow
    expect(hasWorkflowRun || hasDelegateTask, "Should use delegation (workflow_run or delegate_task)").toBeTruthy();
  });

  test("T18.4 验证嵌套工作流内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for 3 topic groups
    const topicGroups = [
      { name: "论文组", keywords: ["论文", "学术", "研究", "paper"] },
      { name: "剧本杀组", keywords: ["剧本杀", "剧情", "推理", "剧本"] },
      { name: "其他组", keywords: ["表格", "图片", "音频", "视频", "多媒体"] },
    ];
    for (const group of topicGroups) {
      const found = group.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T18] Topic group "${group.name}" covered: ${found}`);
    }

    // Check for nested delegation indication
    const hasNestedDelegation = allContent.includes("分派") || allContent.includes("子任务") || allContent.includes("再") || allContent.includes("细分");
    console.log(`[T18] Nested delegation indication: ${hasNestedDelegation}`);

    await takeScreenshot(page, "T18-4-nested-workflow-content");
  });

  test("T18.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T18-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T18] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T18-5-final-state");
  });
});
