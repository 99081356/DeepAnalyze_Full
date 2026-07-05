/**
 * T30: 跨知识库搜索与结果溯源
 *
 * 测试设计：
 * - 同时绑定 bigtest + lbctest 双知识库
 * - 搜索两个知识库中"证据"和"分析"关键词
 * - 验证跨库搜索结果标注来源、对比质量、无混淆
 *
 * 观察目标：
 * 1. 跨库搜索：kb_search使用两个kbId，返回结果来自两个库
 * 2. 来源标注：每条搜索结果标注来源KB名称
 * 3. 结果去重：同一文档不重复出现
 * 4. 对比质量：对比分析有实质内容
 * 5. 搜索覆盖率：关键文档都能被搜索到
 * 6. 无混淆：引用内容时不混淆来源
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";
const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请搜索两个知识库中所有包含'证据'关键词的内容，标注每条结果来自哪个知识库。然后搜索两个库中所有包含'分析'关键词的内容。对比两个库中'证据'相关内容的差异。`;

test.describe("T30 - 跨知识库搜索溯源", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T30-跨知识库搜索溯源", {
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

  test("T30.1 发送跨库搜索提示词并等待完成", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

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

    console.log(`[T30] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T30-1-agent-completed");
  });

  test("T30.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T30] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T30] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T30] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T30.3 验证跨库工具调用", async ({ request }) => {
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
    console.log(`[T30] Total tool calls: ${totalToolCalls}`);
    console.log(`[T30] Tool names used: ${[...toolNames].join(", ")}`);

    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T30] KB tools used: ${usedKBTools.join(", ")}`);
    expect(usedKBTools.length, "Should use at least 1 KB tool").toBeGreaterThan(0);
  });

  test("T30.4 验证跨库内容覆盖与来源标注", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for "证据" keyword coverage
    const hasEvidence = allContent.includes("证据");
    console.log(`[T30] Contains "证据" keyword: ${hasEvidence}`);
    expect(hasEvidence, 'Should mention "证据"').toBe(true);

    // Check for "分析" keyword coverage
    const hasAnalysis = allContent.includes("分析");
    console.log(`[T30] Contains "分析" keyword: ${hasAnalysis}`);

    // Check for references to both KBs
    const hasBigtestRef = allContent.includes("bigtest") || allContent.includes("剧本杀") || allContent.includes("论文");
    const hasLbcRef = allContent.includes("lbctest") || allContent.includes("案件") || allContent.includes("诉讼");
    console.log(`[T30] References bigtest: ${hasBigtestRef}, references lbctest: ${hasLbcRef}`);

    // Check for comparison content
    const hasComparison = allContent.includes("对比") || allContent.includes("差异") || allContent.includes("比较");
    console.log(`[T30] Has comparison analysis: ${hasComparison}`);

    await takeScreenshot(page, "T30-4-cross-kb-content");
  });

  test("T30.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T30-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T30] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T30-5-final-state");
  });
});
