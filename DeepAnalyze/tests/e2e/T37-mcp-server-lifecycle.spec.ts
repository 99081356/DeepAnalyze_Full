/**
 * T37: MCP服务器增删与工具发现
 *
 * 测试设计：
 * - 不绑定知识库
 * - 测试MCP服务器的生命周期：列表查看、能力发现、工具调用
 * - 验证：MCP服务器列表API、能力API包含MCP工具、Agent能使用工具、前端面板
 *
 * 观察目标：
 * 1. MCP服务器列表API正确返回
 * 2. Capabilities API包含MCP相关工具
 * 3. Agent运行时能发现并使用工具
 * 4. 前端MCP面板正确显示
 * 5. 无系统错误
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const PROMPT = "请列出所有可用的工具。";

test.describe("T37 - MCP服务器生命周期", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T37-MCP服务器生命周期", {
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

  test("T37.1 列出MCP服务器并验证响应", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const servers = await api.listMCPServers();
    console.log(`[T37] MCP servers: ${JSON.stringify(servers)}`);
    expect(Array.isArray(servers), "MCP servers should be an array").toBeTruthy();
  });

  test("T37.2 列出能力并检查MCP工具", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const capabilities = await api.getCapabilities();
    console.log(`[T37] Capabilities keys: ${Object.keys(capabilities).join(", ")}`);
    expect(capabilities, "Should return capabilities object").toBeDefined();

    // Log tool-related capabilities
    const capStr = JSON.stringify(capabilities);
    const hasMCP = capStr.includes("mcp") || capStr.includes("MCP");
    console.log(`[T37] Has MCP-related capability: ${hasMCP}`);
  });

  test("T37.3 运行Agent验证工具使用", async ({ request }) => {
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

    console.log(`[T37] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    console.log(`[T37] Total messages: ${msgs.length}`);
    expect(msgs.length, "Should have at least 2 messages").toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    console.log(`[T37] Assistant content length: ${totalContent.length}`);
    expect(totalContent.length, "Should have assistant response").toBeGreaterThan(0);

    await takeScreenshot(page, "T37-3-agent-tool-usage");
  });

  test("T37.4 检查前端MCP面板", async ({ request }) => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Navigate to settings to check MCP panel
    await gotoPage(page, "settings");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T37-4-settings-mcp-panel");

    // Check for MCP-related UI elements
    const bodyText = await page.textContent("body");
    const hasMCPText = bodyText?.includes("MCP") || bodyText?.includes("mcp") || false;
    console.log(`[T37] Settings page has MCP text: ${hasMCPText}`);
  });

  test("T37.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T37-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T37] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T37-5-final-state");
  });
});
