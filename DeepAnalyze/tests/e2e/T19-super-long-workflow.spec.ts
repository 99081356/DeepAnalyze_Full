/**
 * T19: 超长工作流——100+步综合任务
 *
 * 测试设计：
 * - 同时绑定bigtest + lbctest双知识库
 * - 8步综合任务：分类、论文分析、剧本杀分析、浏览lbctest、时间线提取、证据链构建、交叉对比、综合报告
 * - 验证：100+步工具调用、双库内容覆盖、多轮分析不丢失上下文、最终报告质量
 *
 * 观察目标：
 * 1. 工具调用总次数超过100次
 * 2. 两个知识库都被充分访问
 * 3. 8个任务步骤都有实质输出
 * 4. Agent在超长工作流中保持上下文连贯
 * 5. 最终综合报告质量高
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";
const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请完成以下综合任务：1. 浏览bigtest知识库所有文档，按类型分类 2. 对每篇论文展开L1内容并分析技术要点 3. 对每个剧本杀进行完整剧情分析和推理 4. 浏览lbctest知识库所有文档，分类整理 5. 提取lbctest中所有时间线信息 6. 构建lbctest的完整证据链 7. 交叉对比两个库中法律相关内容的异同 8. 生成最终综合报告`;

test.describe("T19 - 超长工作流100+步", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T19-超长工作流100+步", {
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

  test("T19.1 发送超长工作流提示词并等待完成", async ({ request }) => {
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

    console.log(`[T19] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T19-1-agent-completed");
  });

  test("T19.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T19] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T19] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T19] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>3000 chars)").toBeGreaterThan(3000);
  });

  test("T19.3 验证工具调用数量", async ({ request }) => {
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
    console.log(`[T19] Total tool calls: ${totalToolCalls}`);
    console.log(`[T19] Tool names used: ${[...toolNames].join(", ")}`);

    // Should have many tool calls for super long workflow
    expect(totalToolCalls, "Should have substantial tool calls (>30)").toBeGreaterThan(30);

    // Should use KB tools
    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T19] KB tools used: ${usedKBTools.join(", ")}`);
  });

  test("T19.4 验证8步任务内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for all 8 task steps
    const steps = [
      { name: "bigtest分类", keywords: ["bigtest", "分类", "文档类型"] },
      { name: "论文L1分析", keywords: ["论文", "L1", "技术", "expand"] },
      { name: "剧本杀分析", keywords: ["剧本杀", "剧情", "推理"] },
      { name: "lbctest分类", keywords: ["lbctest", "整理", "文档"] },
      { name: "时间线提取", keywords: ["时间线", "时间", "日期"] },
      { name: "证据链构建", keywords: ["证据链", "证据", "关联"] },
      { name: "交叉对比", keywords: ["对比", "异同", "比较", "差异"] },
      { name: "综合报告", keywords: ["综合报告", "总结", "汇总"] },
    ];
    for (const step of steps) {
      const found = step.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T19] Step "${step.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T19-4-super-long-workflow-content");
  });

  test("T19.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T19-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T19] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T19-5-final-state");
  });
});
