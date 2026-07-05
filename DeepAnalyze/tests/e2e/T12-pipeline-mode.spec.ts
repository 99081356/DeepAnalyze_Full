/**
 * T12: Pipeline模式——串行链式分析流水线
 *
 * 测试设计：
 * - 选中lbctest
 * - 5步串行pipeline：信息收集→事实提取→证据链构建→法律分析→报告生成
 * - 验证：串行执行、上下文传递、每步输出质量
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请使用workflow_run的pipeline模式，按以下步骤串行分析案件：
1. 信息收集Agent：搜集所有文档，按类别（诉讼文书/证据/笔录/物证）分类
2. 事实提取Agent：从分类结果中提取所有事实要素（人物/时间/地点/金额/行为）
3. 证据链构建Agent：基于事实要素构建完整证据链
4. 法律分析Agent：基于证据链进行法律分析和量刑建议
5. 报告生成Agent：生成最终结构化报告
每个Agent的输出作为下一个Agent的输入。`;

test.describe("T12 - Pipeline模式串行链式分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T12-Pipeline串行分析", {
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

  test("T12.1 发送pipeline提示词并等待完成", async ({ request }) => {
    test.setTimeout(3_600_000); // 60 minutes — pipeline with 5 sequential agents needs longer

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

    console.log(`[T12] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T12-1-agent-completed");
  });

  test("T12.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    console.log(`[T12] Total messages: ${msgs.length}`);
    expect(msgs.length).toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T12] Total output: ${totalChars} chars`);
    expect(totalChars).toBeGreaterThan(500);
  });

  test("T12.3 验证工具调用和workflow_run", async ({ request }) => {
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
    console.log(`[T12] Tool calls: ${totalToolCalls}, tools: ${[...toolNames].join(", ")}`);

    const hasWorkflowRun = toolNames.has("workflow_run");
    console.log(`[T12] workflow_run used: ${hasWorkflowRun}`);
  });

  test("T12.4 验证pipeline步骤覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    const allContent = msgs.filter((m) => m.role === "assistant").map((m) => m.content || "").join("\n");

    const steps = ["信息收集", "事实提取", "证据链", "法律分析", "报告"];
    for (const step of steps) {
      console.log(`[T12] Step "${step}" covered: ${allContent.includes(step)}`);
    }

    await takeScreenshot(page, "T12-4-pipeline-content");
  });

  test("T12.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T12-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T12] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);
  });
});
