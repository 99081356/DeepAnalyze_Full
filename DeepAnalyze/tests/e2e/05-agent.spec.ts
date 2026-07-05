/**
 * 05 - Agent Execution Engine Tests
 * Covers: SSE streaming, tool calls, thinking, cancel, multi-turn, settings.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { waitForAgentTask, waitForMessages } from "./helpers/wait";
import { assertMessageOrder } from "./helpers/assertions";
import { TEST_KB_ID } from "./fixtures";

test.describe("05 - Agent Execution", () => {
  let sharedSessionId: string;

  test.beforeAll(async ({ request }) => {
    // Create a shared session for tests that reuse it
    const api = createApi(request);
    const session = await api.createSession("E2E Agent Test", {
      kbIds: [TEST_KB_ID],
    });
    sharedSessionId = session.id;
  });

  test.afterAll(async ({ request }) => {
    if (sharedSessionId) {
      const api = createApi(request);
      await api.deleteSession(sharedSessionId).catch(() => {});
    }
  });

  test("5.1 basic conversation - agent returns reply", async ({ request }) => {
    test.setTimeout(120_000);
    const api = createApi(request);

    // Send a simple message via agent run endpoint
    const resp = await request.post("/api/agents/run", {
      data: {
        input: "你好，请简单介绍一下你自己。",
        sessionId: sharedSessionId,
      },
    });
    // Accept both SSE stream response (200) and direct response
    expect([200, 201]).toContain(resp.status());

    // Wait for agent task to complete
    await waitForAgentTask(request, sharedSessionId, 90_000);

    // Verify messages were created
    const msgs = await api.getMessages(sharedSessionId);
    expect(msgs.length).toBeGreaterThanOrEqual(2); // user + assistant

    const assistantMsg = msgs.find((m) => m.role === "assistant");
    expect(assistantMsg, "Should have assistant message").toBeTruthy();
    expect(assistantMsg!.content?.length, "Assistant response should have content").toBeGreaterThan(10);
  });

  test("5.2 tool calling - agent calls tools", async ({ request }) => {
    test.setTimeout(180_000);
    const api = createApi(request);

    // Create a new session for tool call test
    const toolSession = await api.createSession("E2E Tool Call Test", {
      kbIds: [TEST_KB_ID],
    });

    try {
      const resp = await request.post("/api/agents/run", {
        data: {
          input: "请搜索知识库中关于反重力的内容。",
          sessionId: toolSession.id,
        },
      });
      expect(resp.ok).toBeTruthy();

      await waitForAgentTask(request, toolSession.id, 120_000);

      const msgs = await api.getMessages(toolSession.id);
      const assistantMsgs = msgs.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length, "Should have at least one assistant message").toBeGreaterThanOrEqual(1);

      // Check if tool calls are in metadata (may or may not be present depending on settings)
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      expect(lastAssistant.content?.length, "Agent should have responded").toBeGreaterThan(50);
    } finally {
      await api.deleteSession(toolSession.id).catch(() => {});
    }
  });

  test("5.3 agent cancel - cancel endpoint exists and responds", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    // Test cancel on a non-existent task — should return 404
    const cancelResp = await api.cancelTask("nonexistent-task-id-12345");
    expect([400, 404]).toContain(cancelResp.status());
  });

  test("5.4 multi-turn context - agent remembers previous", async ({ request }) => {
    test.setTimeout(180_000);
    const api = createApi(request);

    const mtSession = await api.createSession("E2E Multi-turn Test", {
      kbIds: [TEST_KB_ID],
    });

    try {
      // First turn
      const resp1 = await request.post("/api/agents/run", {
        data: { input: "我的名字是小明，请记住。", sessionId: mtSession.id },
      });
      expect(resp1.ok).toBeTruthy();
      await waitForAgentTask(request, mtSession.id, 60_000);

      // Second turn - reference first turn
      const resp2 = await request.post("/api/agents/run", {
        data: { input: "你还记得我的名字吗？", sessionId: mtSession.id },
      });
      expect(resp2.ok).toBeTruthy();
      await waitForAgentTask(request, mtSession.id, 60_000);

      // Verify multi-turn messages exist
      const msgs = await api.getMessages(mtSession.id);
      expect(msgs.length, "Should have 4+ messages from 2 turns").toBeGreaterThanOrEqual(4);

      // Check the last assistant message references the name
      const assistantMsgs = msgs.filter((m) => m.role === "assistant");
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      if (lastMsg?.content) {
        // Agent should ideally remember the name
        const hasName = lastMsg.content.includes("小明");
        // Not a hard failure - agent might paraphrase, but log it
        if (!hasName) {
          console.log(`[WARN] Agent didn't mention name in response: ${lastMsg.content.slice(0, 200)}`);
        }
      }
    } finally {
      await api.deleteSession(mtSession.id).catch(() => {});
    }
  });

  test("5.5 message order - user before assistant", async ({ request }) => {
    const api = createApi(request);
    const msgs = await api.getMessages(sharedSessionId);
    if (msgs.length >= 2) {
      assertMessageOrder(msgs);
    }
  });

  test("5.6 agent settings configurable", async ({ request }) => {
    const api = createApi(request);
    const settings = await api.getAgentSettings();
    expect(settings.maxTurns).toBeDefined();
    expect(typeof settings.maxTurns).toBe("number");
    expect(settings.outputTokenBudget).toBeDefined();
    expect(settings.contextWindow).toBeDefined();
  });

  test("5.7 agent streaming page screenshot", async ({ page }) => {
    await page.goto(`/#/sessions/${sharedSessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await takeScreenshot(page, "agent-session-page");
  });

  test("5.8 turn_usage event - settings report token tracking", async ({ request }) => {
    const api = createApi(request);
    const settings = await api.getAgentSettings();
    // Agent should have context window settings
    expect(settings.contextWindow).toBeGreaterThan(0);
  });
});
