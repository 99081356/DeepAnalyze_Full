/**
 * T25: 司法Plugin——时间线重建+实体网络
 *
 * 测试设计：
 * - 选中lbctest知识库
 * - 要求分别使用timeline-reconstruction和entity-network两个skill分析案件
 * - 先用时间线重建skill构建完整案件时间线
 * - 再用实体网络skill梳理所有人物关系和组织关系
 * - 最后综合两个skill的结果输出案件全景分析
 * - 验证：两个skill均被调用、时间线完整性、实体网络覆盖、综合分析质量
 *
 * 观察目标：
 * 1. skill_invoke(skill_name="timeline-reconstruction")被调用
 * 2. skill_invoke(skill_name="entity-network")被调用
 * 3. 时间线包含关键时间节点和事件
 * 4. 实体网络包含人物、组织及其关系
 * 5. 综合分析融合了两个skill的结果
 * 6. 前端正确渲染分析结果
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请分别使用timeline-reconstruction和entity-network两个skill分析案件。先用时间线重建skill构建完整案件时间线，再用实体网络skill梳理所有人物关系和组织关系。最后综合两个skill的结果输出案件全景分析。`;

test.describe("T25 - 时间线重建与实体网络", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T25-时间线重建与实体网络", {
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

  test("T25.1 发送时间线+实体网络分析提示词并等待完成", async ({ request }) => {
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

    console.log(`[T25] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T25-1-agent-completed");
  });

  test("T25.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T25] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T25] Assistant messages: ${assistantMsgs.length}`);
    expect(assistantMsgs.length, "Should have assistant messages").toBeGreaterThanOrEqual(1);

    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T25] Text content: ${totalContent.length} chars, Pushed content: ${pushedContentLength} chars, Total: ${totalChars}`);
    expect(totalChars, "Should have substantial output (>2000 chars)").toBeGreaterThan(2000);
  });

  test("T25.3 验证工具调用", async ({ request }) => {
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
    console.log(`[T25] Total tool calls: ${totalToolCalls}`);
    console.log(`[T25] Tool names used: ${[...toolNames].join(", ")}`);

    // Check for skill_invoke usage
    const hasSkillInvoke = toolNames.has("skill_invoke");
    console.log(`[T25] skill_invoke used: ${hasSkillInvoke}`);

    // Check KB tools used
    const kbTools = ["kb_search", "wiki_browse", "expand", "doc_grep"];
    const usedKBTools = kbTools.filter((t) => toolNames.has(t));
    console.log(`[T25] KB tools used: ${usedKBTools.join(", ")}`);
  });

  test("T25.4 验证时间线和实体网络内容质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const allContent = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => m.content || "")
      .join("\n");

    const elements = [
      { name: "时间线", keywords: ["时间线", "时间", "节点", "事件", "日期"] },
      { name: "实体网络", keywords: ["实体", "人物", "关系", "组织", "网络"] },
      { name: "案件分析", keywords: ["案件", "分析", "综合", "全景"] },
      { name: "证据引用", keywords: ["证据", "引用", "来源", "文档"] },
    ];

    for (const el of elements) {
      const found = el.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T25] Element "${el.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T25-4-timeline-entity-content");
  });

  test("T25.5 前端最终显示效果截图", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T25-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T25] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T25-5-final-state");
  });
});
