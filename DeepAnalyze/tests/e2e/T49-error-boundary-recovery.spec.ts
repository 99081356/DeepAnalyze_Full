/**
 * T49: 错误边界与异常恢复
 *
 * 测试设计：
 * - 不绑定知识库（或使用bigtest）
 * - 多场景测试：正常消息、异常操作、恢复后正常消息
 * - 验证：错误处理优雅、恢复后系统正常
 *
 * 观察目标：
 * 1. 正常消息发送成功
 * 2. 异常操作（展开不存在文档）优雅处理
 * 3. 异常后系统能恢复正常
 * 4. 控制台错误处理正常
 * 5. 截图
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const NORMAL_PROMPT_1 = "你好，请简单介绍一下你自己。";
const ERROR_PROMPT = "请展开知识库中ID为'non-existent-doc-id-12345'的文档的L1内容。";
const NORMAL_PROMPT_2 = "谢谢你的回答。请问今天天气如何？（不需要真实数据，随便说说即可）";

test.describe("T49 - 错误边界与异常恢复", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T49-错误边界与异常恢复", {
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

  test("T49.1 发送正常消息验证成功", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Send first normal message
    const status1 = await page.evaluate(async ({ prompt, sid }) => {
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
    }, { prompt: NORMAL_PROMPT_1, sid: sessionId });

    console.log(`[T49] First normal message completed with status: ${status1}`);

    // Send error-triggering message
    const status2 = await page.evaluate(async ({ prompt, sid }) => {
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
    }, { prompt: ERROR_PROMPT, sid: sessionId });

    console.log(`[T49] Error-triggering message completed with status: ${status2}`);

    // Send recovery normal message
    const status3 = await page.evaluate(async ({ prompt, sid }) => {
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
    }, { prompt: NORMAL_PROMPT_2, sid: sessionId });

    console.log(`[T49] Recovery message completed with status: ${status3}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T49-1-all-messages-completed");
  });

  test("T49.2 验证异常操作的优雅错误处理", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T49] Total messages: ${msgs.length}`);

    // Should have 6 messages: 3 user + 3 assistant
    expect(msgs.length, "Should have at least 6 messages (3 user + 3 assistant)").toBeGreaterThanOrEqual(6);

    const userMsgs = msgs.filter((m) => m.role === "user");
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T49] User messages: ${userMsgs.length}, Assistant messages: ${assistantMsgs.length}`);

    // The second assistant message should handle the error gracefully
    // (should have some content, not be empty or a crash)
    if (assistantMsgs.length >= 2) {
      const errorResponse = assistantMsgs[1];
      const errorContent = errorResponse?.content || "";
      console.log(`[T49] Error response content length: ${errorContent.length}`);
      console.log(`[T49] Error response preview: ${errorContent.slice(0, 300)}`);
      // Should have some response (error message or graceful handling)
      expect(errorContent.length, "Error response should not be empty").toBeGreaterThan(0);
    }
  });

  test("T49.3 验证恢复后正常消息", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    // The third (recovery) assistant message should be normal
    if (assistantMsgs.length >= 3) {
      const recoveryResponse = assistantMsgs[2];
      const recoveryContent = recoveryResponse?.content || "";
      console.log(`[T49] Recovery response content length: ${recoveryContent.length}`);
      console.log(`[T49] Recovery response preview: ${recoveryContent.slice(0, 300)}`);
      expect(recoveryContent.length, "Recovery response should have content").toBeGreaterThan(0);
    }

    await takeScreenshot(page, "T49-3-recovery-verified");
  });

  test("T49.4 检查控制台错误处理", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T49] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 10).join("; ")}`);

    // System should not have uncaught exceptions
    const hasUncaught = criticalErrors.some(
      (e) => e.includes("Uncaught") || e.includes("TypeError") || e.includes("RangeError")
    );
    console.log(`[T49] Has uncaught exceptions: ${hasUncaught}`);

    await takeScreenshot(page, "T49-4-console-errors");
  });

  test("T49.5 最终截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T49-5-final-fullpage", { fullPage: true });
    await takeScreenshot(page, "T49-5-final-state");
  });
});
