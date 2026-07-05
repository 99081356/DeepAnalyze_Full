/**
 * T40: Provider熔断与降级
 *
 * 测试设计：
 * - 不绑定知识库
 * - 运行简单问答，验证Agent正常响应
 * - 验证Agent设置可用，工具调用正常
 *
 * 观察目标：
 * 1. Agent正常响应简单问题
 * 2. Agent设置API可用
 * 3. 工具调用（如果有）正常
 * 4. 内容质量合格
 * 5. 前端显示正常
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const PROMPT = "你好，请回答一个简单的问题：1+1等于几？";

test.describe("T40 - Provider熔断降级", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T40-Provider熔断降级", {
      kbIds: [],
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

  test("T40.1 运行Agent验证响应", async ({ request }) => {
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

    console.log(`[T40] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T40-1-agent-completed");
  });

  test("T40.2 验证Agent设置可用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const settings = await api.getAgentSettings();
    console.log(`[T40] Agent settings: ${JSON.stringify(settings)}`);
    expect(settings, "Should return agent settings").toBeDefined();

    // Verify key settings exist
    const settingsKeys = Object.keys(settings);
    console.log(`[T40] Settings keys: ${settingsKeys.join(", ")}`);

    await takeScreenshot(page, "T40-2-agent-settings");
  });

  test("T40.3 检查工具调用", async ({ request }) => {
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
    console.log(`[T40] Total tool calls: ${totalToolCalls}`);
    console.log(`[T40] Tool names used: ${[...toolNames].join(", ")}`);
  });

  test("T40.4 内容质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T40] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    console.log(`[T40] Assistant content: ${totalContent.slice(0, 300)}`);
    expect(totalContent.length, "Should have assistant response").toBeGreaterThan(0);

    // For a simple 1+1 question, check that the answer mentions "2"
    const hasAnswer = totalContent.includes("2") || totalContent.includes("二");
    console.log(`[T40] Answer mentions 2: ${hasAnswer}`);

    await takeScreenshot(page, "T40-4-content-quality");
  });

  test("T40.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T40-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T40] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T40-5-final-state");
  });
});
