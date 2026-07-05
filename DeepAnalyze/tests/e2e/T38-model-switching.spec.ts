/**
 * T38: 主模型实时切换
 *
 * 测试设计：
 * - 不绑定知识库
 * - 获取当前模型默认配置，运行Agent，验证输出提及模型信息
 * - 验证providers列表可用
 *
 * 观察目标：
 * 1. 当前模型默认配置API正确返回
 * 2. Agent使用默认模型正常响应
 * 3. 输出可能提及模型信息
 * 4. Providers列表完整
 * 5. 前端显示正常
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const PROMPT = "你好，请简单介绍一下你自己。你使用的是什么模型？";

test.describe("T38 - 主模型实时切换", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T38-主模型实时切换", {
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

  test("T38.1 获取当前模型默认配置", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const defaults = await api.getDefaults();
    console.log(`[T38] Defaults: ${JSON.stringify(defaults)}`);
    expect(defaults, "Should return defaults object").toBeDefined();

    // Log model-related defaults
    const defaultStr = JSON.stringify(defaults);
    const hasModel = defaultStr.includes("model") || defaultStr.includes("provider") || defaultStr.includes("default");
    console.log(`[T38] Has model/provider config: ${hasModel}`);
  });

  test("T38.2 使用默认模型运行Agent", async ({ request }) => {
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

    console.log(`[T38] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T38-2-agent-completed");
  });

  test("T38.3 检查输出是否提及模型信息", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T38] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    console.log(`[T38] Assistant content length: ${totalContent.length}`);
    console.log(`[T38] Assistant content preview: ${totalContent.slice(0, 300)}`);
    expect(totalContent.length, "Should have assistant response").toBeGreaterThan(0);

    // Check for model-related info
    const modelKeywords = ["模型", "model", "GPT", "Claude", "GLM", "Qwen", "DeepSeek", "AI", "人工智能", "助手"];
    const foundKeywords = modelKeywords.filter((kw) => totalContent.includes(kw));
    console.log(`[T38] Model-related keywords found: ${foundKeywords.join(", ")}`);
  });

  test("T38.4 验证providers列表", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const providers = await api.getProviders();
    console.log(`[T38] Providers: ${JSON.stringify(providers)}`);
    expect(providers, "Should return providers object").toBeDefined();

    const providerList = providers.providers || [];
    console.log(`[T38] Provider count: ${providerList.length}`);
    for (const p of providerList) {
      console.log(`[T38] Provider: ${p.name || p.id} (id: ${p.id})`);
    }
    expect(providerList.length, "Should have at least 1 provider").toBeGreaterThanOrEqual(1);

    await takeScreenshot(page, "T38-4-providers");
  });

  test("T38.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T38-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T38] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T38-5-final-state");
  });
});
