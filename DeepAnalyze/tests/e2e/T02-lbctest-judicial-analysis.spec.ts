/**
 * T02: lbctest全案司法分析（证据链+时间线+量刑）
 *
 * 测试设计：
 * - 选中lbctest知识库（110个文档）
 * - 发送司法分析提示词，要求证据链、时间线、量刑等完整分析
 * - 验证：案件人物完整、时间线连贯、资金流向清晰、量刑标准、证据链、无幻觉、前端展示
 *
 * 观察目标：
 * 1. 所有涉案人员（嫌疑人、受害人、证人等）均被列出，无遗漏
 * 2. 时间线覆盖案件全过程，每个时间节点有对应文档证据支撑
 * 3. 资金转移路径明确，金额与原文一致
 * 4. 引用的法条条文号和量刑区间与中国现行刑法条文一致
 * 5. 使用evidence-chain skill后，每条证据有链接
 * 6. 所有金额、日期、人名、地址与原文严格一致
 * 7. 证据链接可点击、跳转到原文档对应位置
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `1. 详细分析整个案件，按人、时、地、事、物的关键信息梳理，整理完整的案件介绍。
2. 还原整个案件完整的时间线关系，给出所有案件推理和证据证明材料。
3. 梳理资金关系和流向，明确分析资金转移情况，核对受害人的资金损失情况。
4. 给出量刑标准和法规指引，并对每个量刑项目给出全部证据关联材料信息。
5. 使用司法证据链标准的skill，输出符合司法证据链要求的文档报告。`;

test.describe("T02 - lbctest全案司法分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T02-lbctest司法分析", {
      kbIds: [LBC_KB_ID],
    });
    sessionId = session.id;

    page = await browser.newPage();
    // Collect console errors
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

  test("T02.1 发送司法分析提示词并等待完成", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    const api = createApi(request);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    await page.evaluate(async ({ prompt, sid }) => {
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

    console.log("[T02] Agent run-stream completed");

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T02-1-agent-completed");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T02-2-agent-completed");
  });

  test("T02.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T02] Total messages: ${msgs.length}`);

    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T02] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs
      .map((m) => m.content || "")
      .join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T02] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T02.3 验证push_content卡片", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalPushedContents = 0;
    for (const msg of assistantMsgs) {
      const pushed = (msg.pushedContents || msg.metadata?.pushedContents || []) as any[];
      totalPushedContents += pushed.length;
    }
    console.log(`[T02] Total pushed content cards: ${totalPushedContents}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    const pushCards = page.locator("[class*='push-content'], [class*='PushContent'], [data-type='push-content']");
    const pushCardCount = await pushCards.count();
    console.log(`[T02] Push content cards in DOM: ${pushCardCount}`);

    await takeScreenshot(page, "T02-3-push-content-cards");
  });

  test("T02.4 验证工具调用", async ({ request }) => {
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
    console.log(`[T02] Total tool calls: ${totalToolCalls}`);
    console.log(`[T02] Tool names used: ${[...toolNames].join(", ")}`);

    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T02] KB tools used: ${usedKBTools.join(", ")}`);
    expect(usedKBTools.length, "Should use at least 1 KB tool").toBeGreaterThan(0);
  });

  test("T02.5 验证司法分析内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    // Check for coverage of judicial analysis key elements
    const elements = [
      { name: "案件人物", keywords: ["嫌疑人", "受害人", "被告人", "被害人", "证人"] },
      { name: "时间线", keywords: ["时间线", "时间节点", "案发", "时间顺序"] },
      { name: "资金流向", keywords: ["资金", "转账", "金额", "损失"] },
      { name: "量刑标准", keywords: ["量刑", "刑法", "条文", "法条"] },
      { name: "证据链", keywords: ["证据", "证据链", "证据材料"] },
    ];

    for (const el of elements) {
      const found = el.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T02] Element "${el.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T02-5-content-coverage");
  });

  test("T02.6 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T02-6-final-fullpage", { fullPage: true });

    const messages = page.locator("[class*='message'], [class*='Message']");
    const msgCount = await messages.count();
    console.log(`[T02] Visible message elements: ${msgCount}`);

    const thinkingSection = page.locator("text=过程记录, text=思考过程, text=Thinking").first();
    const thinkingVisible = await thinkingSection.isVisible().catch(() => false);
    console.log(`[T02] Thinking section visible: ${thinkingVisible}`);

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T02] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T02-6-final-state");
  });
});
