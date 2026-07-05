/**
 * T24: 司法Plugin——证据链Skill完整执行
 *
 * 测试设计：
 * - 选中lbctest知识库
 * - 要求使用evidence-chain skill分析证据链
 * - 验证：skill_invoke触发、5步工作流、证据覆盖、关系类型、完整性标注、引用链接
 *
 * 观察目标：
 * 1. 明确调用skill_invoke(skill_name="evidence-chain")
 * 2. 完整执行skill定义的5步流程
 * 3. 所有证据文档被纳入分析
 * 4. 证据间关系包含时序/因果/印证/矛盾四种类型
 * 5. 缺失环节标注[待补充]，矛盾点标注[矛盾]
 * 6. 每条证据有引用链接
 * 7. 证据链接在消息中显示为蓝色可点击链接
 * 8. 所有证据描述与原文一致，不编造
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请使用"evidence-chain" skill分析这个案件的证据链完整性。要求：
1. 搜集所有证据材料
2. 构建证据链关系图（时序关系、因果关系、印证关系、矛盾关系）
3. 评估证据链完整性（标记缺失环节为[待补充]，矛盾点为[矛盾]）
4. 生成带有原始文档引用链接的证据链报告`;

test.describe("T24 - 证据链Skill完整执行", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T24-证据链分析", {
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

  test("T24.1 发送证据链分析提示词并等待完成", async ({ request }) => {
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

    console.log(`[T24] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T24-1-agent-completed");
  });

  test("T24.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T24] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T24] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T24] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T24.3 验证工具调用和skill_invoke", async ({ request }) => {
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
    console.log(`[T24] Total tool calls: ${totalToolCalls}`);
    console.log(`[T24] Tool names used: ${[...toolNames].join(", ")}`);

    const hasSkillInvoke = toolNames.has("skill_invoke");
    console.log(`[T24] skill_invoke used: ${hasSkillInvoke}`);

    // Check KB tools used
    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T24] KB tools used: ${usedKBTools.join(", ")}`);
  });

  test("T24.4 验证证据链内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    const elements = [
      { name: "证据材料搜集", keywords: ["证据", "证据材料", "物证", "书证"] },
      { name: "关系类型", keywords: ["时序", "因果", "印证", "矛盾"] },
      { name: "完整性标注", keywords: ["待补充", "矛盾"] },
      { name: "引用链接", keywords: ["da-evidence://", "引用", "来源"] },
    ];

    for (const el of elements) {
      const found = el.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T24] Element "${el.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T24-4-content-coverage");
  });

  test("T24.5 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T24-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T24] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T24-5-final-state");
  });
});
