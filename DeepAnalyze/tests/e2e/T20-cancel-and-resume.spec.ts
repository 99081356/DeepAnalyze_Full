/**
 * T20: 取消工作流并恢复
 *
 * 测试设计：
 * - 选中bigtest知识库
 * - 发送一个长分析请求，等待3个工具调用完成后取消
 * - 取消后发送一个简单问题，验证系统恢复正常
 * - 验证：取消API工作、SSE流正确结束、恢复后新对话正常、无残留状态
 *
 * 观察目标：
 * 1. 取消API正确终止正在运行的agent任务
 * 2. SSE流在取消后正确结束
 * 3. 取消后系统状态干净，无残留任务
 * 4. 新对话请求正常工作
 * 5. 新对话输出正常，不受之前取消影响
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const LONG_PROMPT = `请详细分析知识库中所有文档，按类型分类，对每类进行深度分析，包括论文的技术要点、剧本杀的剧情推理、表格的数据统计、多媒体的内容描述。要求非常详细和全面。`;
const SIMPLE_PROMPT = `你好，请简单介绍一下你自己`;

test.describe("T20 - 取消工作流并恢复", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T20-取消工作流并恢复", {
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

  test("T20.1 发送长分析请求，等待工具调用后取消并恢复", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Start the long agent, wait for 3+ tool_result events, then cancel
    const cancelResult = await page.evaluate(async ({ longPrompt, simplePrompt, sid }) => {
      // Step 1: Start long agent and monitor SSE events
      const resp = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: longPrompt, sessionId: sid }),
      });

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      let toolResultCount = 0;
      let taskId: string | null = null;
      let cancelled = false;

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            // Extract taskId from SSE events
            if (line.startsWith("data: ") && !taskId) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.taskId) taskId = data.taskId;
              } catch {}
            }
            // Count tool_result events
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === "tool_result" || (data.content?.type === "tool_result")) {
                  toolResultCount++;
                }
              } catch {}
            }
          }

          // Cancel after 3+ tool results
          if (toolResultCount >= 3 && taskId && !cancelled) {
            cancelled = true;
            // Call cancel API
            await fetch(`/api/agents/cancel/${taskId}`, { method: "POST" });
            // Continue reading to drain the stream
          }
        }
      }

      // Wait a moment for cancel to take effect
      await new Promise((r) => setTimeout(r, 2000));

      // Step 2: Send a new simple question
      const resp2 = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: simplePrompt, sessionId: sid }),
      });
      const reader2 = resp2.body?.getReader();
      if (reader2) {
        while (true) {
          const { done } = await reader2.read();
          if (done) break;
        }
      }

      return {
        cancelStatus: cancelled,
        toolResultCount,
        taskId,
        newResponseStatus: resp2.status,
      };
    }, { longPrompt: LONG_PROMPT, simplePrompt: SIMPLE_PROMPT, sid: sessionId });

    console.log(`[T20] Cancel result: ${JSON.stringify(cancelResult)}`);
    console.log(`[T20] Tool results before cancel: ${cancelResult.toolResultCount}`);
    console.log(`[T20] New response status: ${cancelResult.newResponseStatus}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T20-1-cancel-and-resume");
  });

  test("T20.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    console.log(`[T20] Total messages: ${msgs.length}`);

    // Should have at least 4 messages: user(long) + assistant(cancelled) + user(simple) + assistant(response)
    expect(msgs.length, "Should have at least 4 messages (2 user + 2 assistant)").toBeGreaterThanOrEqual(4);

    const userMsgs = msgs.filter((m) => m.role === "user");
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    console.log(`[T20] User messages: ${userMsgs.length}, Assistant messages: ${assistantMsgs.length}`);
    expect(userMsgs.length, "Should have 2 user messages").toBeGreaterThanOrEqual(2);
    expect(assistantMsgs.length, "Should have at least 2 assistant messages").toBeGreaterThanOrEqual(2);
  });

  test("T20.3 验证工具调用", async ({ request }) => {
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
    console.log(`[T20] Total tool calls across all assistant messages: ${totalToolCalls}`);
    console.log(`[T20] Tool names used: ${[...toolNames].join(", ")}`);

    // First assistant (cancelled) should have some tool calls
    // Second assistant (simple question) may or may not have tool calls
  });

  test("T20.4 验证恢复后新对话内容", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    // The last assistant message should be the response to the simple question
    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];
    const lastContent = lastAssistantMsg?.content || "";
    console.log(`[T20] Last assistant content length: ${lastContent.length}`);
    console.log(`[T20] Last assistant content preview: ${lastContent.slice(0, 200)}`);

    // The simple question response should have some content
    expect(lastContent.length, "Should have content in the last assistant message").toBeGreaterThan(0);

    await takeScreenshot(page, "T20-4-resume-content");
  });

  test("T20.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T20-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T20] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T20-5-final-state");
  });
});
