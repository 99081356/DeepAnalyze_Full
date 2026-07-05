/**
 * T39: 多角色模型配置
 *
 * 测试设计：
 * - 不绑定知识库
 * - 获取defaults和providers，验证多角色模型配置可用
 * - 运行Agent验证工具调用能力
 *
 * 观察目标：
 * 1. Defaults和providers API同时工作正常
 * 2. Agent正常响应
 * 3. 工具调用正常
 * 4. 输出质量良好
 * 5. 前端显示正常
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const PROMPT = "请分析当前系统配置，介绍你的能力和可用的分析工具。";

test.describe("T39 - 多角色模型配置", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T39-多角色模型配置", {
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

  test("T39.1 获取defaults和providers验证", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const defaults = await api.getDefaults();
    const providers = await api.getProviders();

    console.log(`[T39] Defaults: ${JSON.stringify(defaults)}`);
    console.log(`[T39] Providers: ${JSON.stringify(providers)}`);

    expect(defaults, "Should return defaults").toBeDefined();
    expect(providers, "Should return providers").toBeDefined();

    // Check for multi-role configuration
    const defaultsStr = JSON.stringify(defaults);
    const hasRoles = defaultsStr.includes("main") || defaultsStr.includes("sub") || defaultsStr.includes("role") || defaultsStr.includes("agent");
    console.log(`[T39] Has role-related config: ${hasRoles}`);

    const providerList = providers.providers || [];
    console.log(`[T39] Provider count: ${providerList.length}`);
  });

  test("T39.2 运行Agent", async ({ request }) => {
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

    console.log(`[T39] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T39-2-agent-completed");
  });

  test("T39.3 验证工具调用", async ({ request }) => {
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
    console.log(`[T39] Total tool calls: ${totalToolCalls}`);
    console.log(`[T39] Tool names used: ${[...toolNames].join(", ")}`);
  });

  test("T39.4 检查输出质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T39] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    console.log(`[T39] Assistant content length: ${totalContent.length}`);
    expect(totalContent.length, "Should have substantial output").toBeGreaterThan(50);

    // Check for capability/tool descriptions in the output
    const capabilityKeywords = ["工具", "能力", "分析", "搜索", "tool", "search", "expand", "功能"];
    const foundKeywords = capabilityKeywords.filter((kw) => totalContent.toLowerCase().includes(kw.toLowerCase()));
    console.log(`[T39] Capability keywords found: ${foundKeywords.join(", ")}`);

    await takeScreenshot(page, "T39-4-output-quality");
  });

  test("T39.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T39-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T39] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T39-5-final-state");
  });
});
