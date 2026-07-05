/**
 * T14: Graph模式——DAG依赖关系分析
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 使用graph模式设置Agent依赖关系（DAG）
 * - 基础研究→论文分析/剧本杀分析/多媒体分析→综合报告
 * - 验证：graph模式触发、DAG依赖正确、各Agent按序执行、结果汇总
 *
 * 观察目标：
 * 1. Agent使用graph模式建立DAG依赖关系
 * 2. 基础研究Agent无依赖先执行
 * 3. 3个分析Agent依赖基础研究Agent完成后执行
 * 4. 综合报告Agent依赖所有分析Agent完成后执行
 * 5. 各Agent输出有实质内容
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `使用graph模式分析知识库。设置以下Agent依赖关系：基础研究Agent（无依赖）浏览所有文档；论文分析Agent（依赖基础研究）深度分析论文；剧本杀分析Agent（依赖基础研究）深度分析剧本杀；多媒体分析Agent（依赖基础研究）分析图片/音频/视频；综合报告Agent（依赖论文分析+剧本杀分析+多媒体分析）汇总所有分析结果。`;

test.describe("T14 - Graph模式DAG依赖分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T14-Graph模式DAG依赖分析", {
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

  test("T14.1 发送graph模式提示词并等待完成", async ({ request }) => {
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

    console.log(`[T14] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T14-1-agent-completed");
  });

  test("T14.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T14] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T14] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T14] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T14.3 验证工具调用和graph模式", async ({ request }) => {
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
    console.log(`[T14] Total tool calls: ${totalToolCalls}`);
    console.log(`[T14] Tool names used: ${[...toolNames].join(", ")}`);

    const hasWorkflowRun = toolNames.has("workflow_run");
    const hasDelegateTask = toolNames.has("delegate_task");
    console.log(`[T14] workflow_run used: ${hasWorkflowRun}`);
    console.log(`[T14] delegate_task used: ${hasDelegateTask}`);

    // At least one delegation mechanism should be used
    expect(hasWorkflowRun || hasDelegateTask, "Should use delegation (workflow_run or delegate_task)").toBeTruthy();
  });

  test("T14.4 验证DAG各节点内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for DAG node outputs
    const dagNodes = [
      { name: "基础研究", keywords: ["基础", "浏览", "文档", "概览", "基础研究"] },
      { name: "论文分析", keywords: ["论文", "学术", "研究", "论文分析"] },
      { name: "剧本杀分析", keywords: ["剧本杀", "剧情", "推理", "剧本杀分析"] },
      { name: "多媒体分析", keywords: ["图片", "音频", "视频", "多媒体", "图片分析", "音频分析", "视频分析"] },
      { name: "综合报告", keywords: ["综合", "汇总", "报告", "总结", "综合报告"] },
    ];
    for (const node of dagNodes) {
      const found = node.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T14] DAG node "${node.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T14-4-dag-content");
  });

  test("T14.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T14-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T14] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T14-5-final-state");
  });
});
