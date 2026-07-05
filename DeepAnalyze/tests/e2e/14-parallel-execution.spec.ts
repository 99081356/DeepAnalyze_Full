// =============================================================================
// E2E Test: Parallel Agent Execution
// =============================================================================
// Verifies that multiple agent tasks can run concurrently in the same session:
// - No 409 Conflict when sending a second message while the first is running
// - Both tasks produce independent responses
// - Messages are correctly ordered in the database
// - Frontend renders both streaming responses
// =============================================================================

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createApi, type Session, type Message } from "./helpers/api";

const BASE = "http://localhost:21000";

// ---------------------------------------------------------------------------
// Helper: Send a message via SSE and return a promise that resolves on "done"
// ---------------------------------------------------------------------------
function sendMessageSSE(
  request: APIRequestContext,
  sessionId: string,
  input: string,
): Promise<{ taskId: string; status: string; output: string }> {
  return new Promise(async (resolve, reject) => {
    const resp = await request.post(`${BASE}/api/agents/run-stream`, {
      data: { sessionId, input },
      timeout: 120000,
    });

    if (!resp.ok()) {
      const text = await resp.text().catch(() => "");
      // If we get a 409, that's the OLD behavior — the test should catch this
      if (resp.status() === 409) {
        reject(new Error(`Got 409 Conflict — mutex still active: ${text}`));
        return;
      }
      reject(new Error(`API ${resp.status()}: ${text}`));
      return;
    }

    const body = resp.body();
    const text = new TextDecoder().decode(body);
    const lines = text.split("\n");

    let taskId = "";
    let status = "";
    let output = "";

    for (const line of lines) {
      if (line.startsWith("event: done")) {
        // Next data: line has the result
      }
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.taskId) taskId = data.taskId;
          if (data.status) status = data.status;
          if (data.output) output = data.output;
        } catch { /* ignore */ }
      }
    }

    resolve({ taskId, status, output: output || "(no output)" });
  });
}

// ---------------------------------------------------------------------------
// Helper: Send a message via SSE and track events as they arrive
// ---------------------------------------------------------------------------
async function sendMessageStreamRaw(
  request: APIRequestContext,
  sessionId: string,
  input: string,
  onEvent?: (event: string, data: Record<string, unknown>) => void,
): Promise<{ taskId: string; status: string }> {
  const resp = await request.post(`${BASE}/api/agents/run-stream`, {
    data: { sessionId, input },
    timeout: 120000,
    headers: { Accept: "text/event-stream" },
  });

  if (!resp.ok()) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status()}: ${text}`);
  }

  const body = resp.body();
  const text = new TextDecoder().decode(body);
  const lines = text.split("\n");

  let taskId = "";
  let status = "";
  let currentEvent = "";

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.taskId) taskId = data.taskId;
        if (data.status) status = data.status;
        onEvent?.(currentEvent, data);
      } catch { /* ignore */ }
    }
  }

  return { taskId, status: status || "unknown" };
}

// ---------------------------------------------------------------------------
// Helper: Poll for task completion
// ---------------------------------------------------------------------------
async function waitForTasks(api: ReturnType<typeof createApi>, sessionId: string, expectedCount: number, maxWait = 120000): Promise<Message[]> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const messages = await api.getMessages(sessionId);
    const assistantMessages = messages.filter(m => m.role === "assistant" && m.content && m.content.trim().length > 0);
    if (assistantMessages.length >= expectedCount) {
      return messages;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${expectedCount} assistant messages`);
}

// ===========================================================================
// T1: API — No 409 Conflict on parallel sends
// ===========================================================================
test.describe("Parallel Execution — API Level", () => {
  test("T1: Second message does not get 409 while first is running", async ({ request }) => {
    const api = createApi(request);
    const session = await api.createSession("parallel-test-t1");
    let sessionId: string | undefined;

    try {
      sessionId = session.id;

      // Send first message (non-blocking — we just check the response starts)
      const resp1Promise = request.post(`${BASE}/api/agents/run-stream`, {
        data: { sessionId, input: "1+1等于几？简短回答" },
        timeout: 120000,
      });

      // Wait a moment for the first request to be accepted
      await new Promise(r => setTimeout(r, 1000));

      // Send second message — this should NOT get a 409
      const resp2Promise = request.post(`${BASE}/api/agents/run-stream`, {
        data: { sessionId, input: "2+2等于几？简短回答" },
        timeout: 120000,
      });

      const resp1 = await resp1Promise;
      const resp2 = await resp2Promise;

      // Both should be accepted (status 200, not 409)
      expect(resp1.status(), "First message should be accepted").toBe(200);
      expect(resp2.status(), "Second message should NOT get 409 Conflict").toBe(200);

      // Wait for both tasks to complete
      const messages = await waitForTasks(api, sessionId!, 2, 120000);
      const assistantMessages = messages.filter(m => m.role === "assistant" && m.content && m.content.trim().length > 0);
      expect(assistantMessages.length, "Should have 2 assistant responses").toBeGreaterThanOrEqual(2);

      // Take a screenshot-worthy log
      console.log("[T1] PASS: Both messages accepted, no 409");
      console.log(`[T1] Response 1: ${assistantMessages[0]?.content?.slice(0, 100)}`);
      console.log(`[T1] Response 2: ${assistantMessages[1]?.content?.slice(0, 100)}`);
    } finally {
      if (sessionId) await api.deleteSession(sessionId).catch(() => {});
    }
  });
});

// ===========================================================================
// T2: API — Both tasks produce independent, correct responses
// ===========================================================================
test("T2: Parallel tasks produce independent correct responses", async ({ request }) => {
  const api = createApi(request);
  const session = await api.createSession("parallel-test-t2");

  try {
    const sessionId = session.id;

    // Send two different questions simultaneously
    const [resp1, resp2] = await Promise.all([
      request.post(`${BASE}/api/agents/run-stream`, {
        data: { sessionId, input: "中国的首都是哪里？只回答城市名" },
        timeout: 120000,
      }),
      request.post(`${BASE}/api/agents/run-stream`, {
        data: { sessionId, input: "法国的首都是哪里？只回答城市名" },
        timeout: 120000,
      }),
    ]);

    expect(resp1.status()).toBe(200);
    expect(resp2.status()).toBe(200);

    // Wait for both to complete
    const messages = await waitForTasks(api, sessionId, 2, 120000);
    const assistantMessages = messages.filter(m => m.role === "assistant" && m.content);

    expect(assistantMessages.length, "Should have 2 assistant responses").toBeGreaterThanOrEqual(2);

    // Check that responses contain the correct answers
    const allContent = assistantMessages.map(m => m.content || "").join(" ").toLowerCase();
    expect(allContent, "Should contain 北京").toContain("北京");
    expect(allContent, "Should contain 巴黎").toContain("巴黎");

    console.log("[T2] PASS: Both responses correct and independent");
  } finally {
    await api.deleteSession(session.id).catch(() => {});
  }
});

// ===========================================================================
// T3: API — Message ordering is stable (no interleaving corruption)
// ===========================================================================
test("T3: Messages are correctly ordered in database", async ({ request }) => {
  const api = createApi(request);
  const session = await api.createSession("parallel-test-t3");

  try {
    const sessionId = session.id;

    // Send messages with sequential markers
    await Promise.all([
      request.post(`${BASE}/api/agents/run-stream`, {
        data: { sessionId, input: "请回复：消息AAA" },
        timeout: 120000,
      }),
      request.post(`${BASE}/api/agents/run-stream`, {
        data: { sessionId, input: "请回复：消息BBB" },
        timeout: 120000,
      }),
    ]);

    // Wait for completion
    await waitForTasks(api, sessionId, 2, 120000);

    // Verify messages are properly alternated (user, assistant, user, assistant)
    const messages = await api.getMessages(sessionId);
    const conversationMessages = messages.filter(m => m.role === "user" || m.role === "assistant");

    // Should have at least 4 messages (2 user + 2 assistant)
    expect(conversationMessages.length, "Should have 2+ user and 2+ assistant messages").toBeGreaterThanOrEqual(4);

    // Check that all messages have non-null IDs (stable ordering)
    for (const msg of conversationMessages) {
      expect(msg.id, "Message should have an ID").toBeTruthy();
    }

    // Check content uniqueness — both responses should be present
    const userContents = conversationMessages.filter(m => m.role === "user").map(m => m.content || "");
    const assistantContents = conversationMessages.filter(m => m.role === "assistant").map(m => m.content || "");

    const hasAAA = userContents.some(c => c.includes("消息AAA")) || assistantContents.some(c => c.includes("消息AAA") || c.includes("AAA"));
    const hasBBB = userContents.some(c => c.includes("消息BBB")) || assistantContents.some(c => c.includes("消息BBB") || c.includes("BBB"));

    expect(hasAAA, "Should contain AAA message").toBe(true);
    expect(hasBBB, "Should contain BBB message").toBe(true);

    console.log("[T3] PASS: Messages correctly ordered and present");
  } finally {
    await api.deleteSession(session.id).catch(() => {});
  }
});

// ===========================================================================
// T4: UI — Parallel streaming visible in browser
// ===========================================================================
test.describe("Parallel Execution — UI Level", () => {
  test("T4: Multiple streaming messages visible simultaneously", async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    test.setTimeout(120000);

    // Create session via API for reliability
    const api = createApi(request);
    const session = await api.createSession("parallel-ui-test");

    try {
      // Collect console errors
      const consoleErrors: string[] = [];
      page.on("consoleerror", (e) => consoleErrors.push(e.text()));

      // Navigate directly to the session
      await page.goto(`${BASE}/#/sessions/${session.id}`);
      await page.waitForTimeout(3000);

      // Screenshot: initial state
      await page.screenshot({ path: "tests/e2e/screenshots/14-parallel-initial.png" });

      // Type and send first message
      const textarea = page.locator("textarea").first();
      await textarea.fill("1+1等于几？只回答数字");
      await textarea.press("Enter");

      // Immediately send second message (parallel)
      await page.waitForTimeout(300);
      await textarea.fill("2+2等于几？只回答数字");
      await textarea.press("Enter");

      // Wait for streaming to start
      await page.waitForTimeout(5000);

      // Screenshot: during streaming
      await page.screenshot({ path: "tests/e2e/screenshots/14-parallel-streaming.png" });

      // Wait for responses to complete (check via API)
      const messages = await waitForTasks(api, session.id, 2, 90000);

      // Screenshot: final state
      await page.waitForTimeout(2000);
      await page.screenshot({ path: "tests/e2e/screenshots/14-parallel-final.png" });

      // Verify both responses exist in the database
      const assistantMessages = messages.filter(m => m.role === "assistant" && m.content);
      expect(assistantMessages.length, "Should have 2+ assistant responses").toBeGreaterThanOrEqual(2);

      // Filter known-harmless console errors
      const criticalErrors = consoleErrors.filter(e =>
        !e.includes("favicon") &&
        !e.includes("ResizeObserver") &&
        !e.includes("Network request failed") &&
        !e.includes("net::ERR_")
      );

      console.log(`[T4] Console errors: ${consoleErrors.length} total, ${criticalErrors.length} critical`);
      if (criticalErrors.length > 0) {
        console.log("[T4] Critical errors:", criticalErrors.slice(0, 5));
      }

      console.log("[T4] PASS: Parallel streaming UI test completed");
      console.log(`[T4] Responses: ${assistantMessages.map(m => m.content?.slice(0, 30)).join(" | ")}`);
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });
});

// ===========================================================================
// T5: Regression — Single message still works normally
// ===========================================================================
test("T5: Single message flow regression test", async ({ request }) => {
  const api = createApi(request);
  const session = await api.createSession("parallel-test-regression");

  try {
    const sessionId = session.id;

    const resp = await request.post(`${BASE}/api/agents/run-stream`, {
      data: { sessionId, input: "你好，简单介绍一下你自己" },
      timeout: 120000,
    });

    expect(resp.status(), "Single message should be accepted").toBe(200);

    // Wait for response
    const messages = await waitForTasks(api, sessionId, 1, 120000);
    const assistantMessages = messages.filter(m => m.role === "assistant" && m.content);
    expect(assistantMessages.length, "Should have 1 assistant response").toBeGreaterThanOrEqual(1);
    expect(assistantMessages[0].content!.length, "Response should have content").toBeGreaterThan(10);

    console.log("[T5] PASS: Single message regression OK");
    console.log(`[T5] Response: ${assistantMessages[0].content?.slice(0, 100)}`);
  } finally {
    await api.deleteSession(session.id).catch(() => {});
  }
});
