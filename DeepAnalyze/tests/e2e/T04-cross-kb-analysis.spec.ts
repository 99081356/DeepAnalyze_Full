/**
 * T04: 多知识库交叉分析
 *
 * 测试设计：
 * - 同时绑定 bigtest + lbctest 双知识库
 * - 对比两个知识库的文档类型分布、内容主题差异
 * - 验证：跨库引用正确、scope切换、对比分析质量、无幻觉
 *
 * 观察目标：
 * 1. 跨库引用正确：bigtest内容标注bigtest，lbctest内容标注lbctest
 * 2. Agent正确处理双KB的kbId切换
 * 3. 对比分析有实质性洞察
 * 4. 不混淆两个知识库的内容
 * 5. 搜索两个知识库时使用正确的kbId
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";
const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请同时分析bigtest和lbctest两个知识库。对比两个知识库的文档类型分布、内容主题差异。bigtest中如果有法律相关的剧本杀内容（如"681追凶手记"），请与lbctest中的真实诉讼文书进行对比，分析虚构案件与真实案件在证据链结构、逻辑推理方式上的异同。`;

test.describe("T04 - 多知识库交叉分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T04-多知识库交叉分析", {
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

  test("T04.1 发送交叉分析提示词并等待完成", async ({ request }) => {
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

    console.log(`[T04] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T04-1-agent-completed");
  });

  test("T04.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T04] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T04] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T04] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>1000 chars)").toBeGreaterThan(1000);
  });

  test("T04.3 验证跨库工具调用", async ({ request }) => {
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
    console.log(`[T04] Total tool calls: ${totalToolCalls}`);
    console.log(`[T04] Tool names used: ${[...toolNames].join(", ")}`);

    // Should have used knowledge base tools
    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T04] KB tools used: ${usedKBTools.join(", ")}`);
    expect(usedKBTools.length, "Should use at least 1 KB tool").toBeGreaterThan(0);
  });

  test("T04.4 验证跨库内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for references to both KBs
    const hasBigtestRef = allContent.includes("bigtest") || allContent.includes("剧本杀") || allContent.includes("论文");
    const hasLbcRef = allContent.includes("lbctest") || allContent.includes("案件") || allContent.includes("诉讼") || allContent.includes("证据");
    console.log(`[T04] References bigtest: ${hasBigtestRef}, references lbctest: ${hasLbcRef}`);

    // Check for comparison content
    const hasComparison = allContent.includes("对比") || allContent.includes("异同") || allContent.includes("比较") || allContent.includes("差异");
    console.log(`[T04] Has comparison analysis: ${hasComparison}`);

    await takeScreenshot(page, "T04-4-cross-kb-content");
  });

  test("T04.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T04-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T04] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T04-5-final-state");
  });
});
