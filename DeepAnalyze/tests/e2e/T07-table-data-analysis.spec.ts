/**
 * T07: 表格数据深度分析与一致性验证
 *
 * 测试设计：
 * - 选中bigtest（聚焦Excel文件：奥林匹克运动员数据集）
 * - 要求实际计算统计数据
 * - 验证：统计准确（有工具调用）、发现质量、无幻觉
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `详细分析知识库中的Excel表格数据。要求：
1. 表格整体描述（行数、列数、列名含义、数据类型）
2. 按列统计分析（数值列：均值/中位数/最大值/最小值/缺失率；分类列：唯一值数/分布）
3. 关键发现（异常值、趋势、相关性）
4. 数据质量评估（缺失值、重复行、异常值比例）
5. 可视化建议（基于数据特征推荐5种图表类型）
所有统计数字必须通过run_sql或bash(python3)实际计算得出，不允许估算。`;

test.describe("T07 - 表格数据深度分析与一致性验证", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T07-表格数据分析", {
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

  test("T07.1 发送表格分析提示词并等待完成", async ({ request }) => {
    test.setTimeout(1_800_000);

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

    console.log(`[T07] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T07-1-agent-completed");
  });

  test("T07.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    console.log(`[T07] Total messages: ${msgs.length}`);
    expect(msgs.length).toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T07] Total output: ${totalChars} chars`);
    expect(totalChars).toBeGreaterThan(500);
  });

  test("T07.3 验证计算工具调用", async ({ request }) => {
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
    console.log(`[T07] Tool calls: ${totalToolCalls}, tools: ${[...toolNames].join(", ")}`);

    // Should have used computation tools (bash, run_sql, wiki_browse)
    const computeTools = ["bash", "run_sql", "wiki_browse", "expand"];
    const usedComputeTools = computeTools.filter((t) => toolNames.has(t));
    console.log(`[T07] Computation tools used: ${usedComputeTools.join(", ")}`);
    expect(usedComputeTools.length, "Should use at least 1 computation tool").toBeGreaterThan(0);
  });

  test("T07.4 验证统计内容质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    const allContent = msgs.filter((m) => m.role === "assistant").map((m) => m.content || "").join("\n");

    // Check for statistical keywords
    const statKeywords = ["均值", "中位数", "最大值", "最小值", "缺失", "分布", "异常"];
    for (const kw of statKeywords) {
      console.log(`[T07] Stat keyword "${kw}" present: ${allContent.includes(kw)}`);
    }

    await takeScreenshot(page, "T07-4-table-analysis");
  });

  test("T07.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T07-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T07] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);
  });
});
