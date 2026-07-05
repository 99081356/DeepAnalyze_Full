/**
 * T17: Agent失败+部分成功混合场景
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 使用workflow_run并行模式分5个子Agent分析不同部分
 * - 某些子Agent可能失败（如分析图片/音频/视频可能超时）
 * - 验证：部分Agent失败不影响其他Agent、失败处理、结果汇总
 *
 * 观察目标：
 * 1. 5个子Agent并行执行
 * 2. 部分子Agent可能失败但系统不崩溃
 * 3. 成功的子Agent输出正常
 * 4. 主Agent汇总时标注失败部分
 * 5. 系统整体稳定运行
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请使用workflow_run并行模式，分5个子Agent分析知识库中的不同部分：Agent 1分析所有PDF论文，Agent 2分析"5241 自杀派对"剧本杀，Agent 3分析所有图片，Agent 4分析Excel表格，Agent 5分析所有音频和视频。如果某个子Agent失败，其他Agent应继续执行并输出结果。`;

test.describe("T17 - Agent失败部分成功混合", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T17-Agent失败部分成功混合", {
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

  test("T17.1 发送部分失败场景提示词并等待完成", async ({ request }) => {
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

    console.log(`[T17] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T17-1-agent-completed");
  });

  test("T17.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T17] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T17] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T17] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>500 chars)").toBeGreaterThan(500);
  });

  test("T17.3 验证工具调用和并行模式", async ({ request }) => {
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
    console.log(`[T17] Total tool calls: ${totalToolCalls}`);
    console.log(`[T17] Tool names used: ${[...toolNames].join(", ")}`);

    const hasWorkflowRun = toolNames.has("workflow_run");
    const hasDelegateTask = toolNames.has("delegate_task");
    console.log(`[T17] workflow_run used: ${hasWorkflowRun}`);
    console.log(`[T17] delegate_task used: ${hasDelegateTask}`);

    // At least one delegation mechanism should be used
    expect(hasWorkflowRun || hasDelegateTask, "Should use delegation (workflow_run or delegate_task)").toBeTruthy();
  });

  test("T17.4 验证部分成功内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for coverage of different agent tasks
    const agentTasks = [
      { name: "PDF论文", keywords: ["论文", "PDF", "学术"] },
      { name: "剧本杀", keywords: ["剧本杀", "自杀派对", "剧情"] },
      { name: "图片", keywords: ["图片", "照片", "image"] },
      { name: "Excel表格", keywords: ["Excel", "表格", "xlsx", "数据"] },
      { name: "音视频", keywords: ["音频", "视频", "mp3", "mp4"] },
    ];
    for (const task of agentTasks) {
      const found = task.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T17] Agent task "${task.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T17-4-partial-success-content");
  });

  test("T17.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T17-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T17] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T17-5-final-state");
  });
});
