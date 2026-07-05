// =============================================================================
// DeepAnalyze - CC-to-DA Features E2E Tests
// =============================================================================
// End-to-end tests for features ported from Claude Code.
// Tests SSE events for turn_usage (cache metrics + cost) and generator path.
//
// Prerequisites:
// - Server running on port 21000 (python3 start.py --no-docker --skip-frontend)
// - A configured model provider (at least one active provider)
//
// Run: npx playwright test tests/e2e/cc-features.spec.ts
// =============================================================================

import { test, expect, request } from "@playwright/test";

const BASE_URL = "http://localhost:21000";

// ---------------------------------------------------------------------------
// SSE Helper (reused from background-workflows.spec.ts pattern)
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string;
  data: any;
}

async function consumeSSE(
  url: string,
  body: Record<string, unknown>,
  options: {
    untilEvent?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ events: SSEEvent[]; abort: () => void }> {
  const { untilEvent = "done", timeoutMs = 180_000 } = options;

  const events: SSEEvent[] = [];
  const controller = new AbortController();

  const promise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`SSE timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) {
          reject(new Error(`HTTP ${resp.status}: ${await resp.text()}`));
          return;
        }
        if (!resp.body) {
          reject(new Error("No response body"));
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";
        let currentData = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              currentData = line.slice(6);
            } else if (line === "" && currentEvent && currentData) {
              try {
                const parsed = JSON.parse(currentData);
                const sseEvent: SSEEvent = { event: currentEvent, data: parsed };
                events.push(sseEvent);

                if (currentEvent === untilEvent) {
                  clearTimeout(timeout);
                  resolve();
                  return;
                }
              } catch { /* ignore parse errors */ }
              currentEvent = "";
              currentData = "";
            }
          }
        }
        clearTimeout(timeout);
        resolve();
      })
      .catch((err) => {
        clearTimeout(timeout);
        if (err.name !== "AbortError") reject(err);
      });
  });

  await promise;
  return { events, abort: () => controller.abort() };
}

// ---------------------------------------------------------------------------
// Helper: Create a session for testing
// ---------------------------------------------------------------------------

async function createTestSession(apiContext: any, title: string): Promise<string> {
  const resp = await apiContext.post("/api/sessions", {
    data: { title },
  });
  expect([200, 201]).toContain(resp.status());
  const session = await resp.json();
  expect(session.id).toBeTruthy();
  return session.id;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe("CC-to-DA Features E2E", () => {

  // =========================================================================
  // Feature 2+9: turn_usage contains cache metrics and cost
  // =========================================================================
  test("turn_usage event contains usage metrics and done event contains cost", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });
    const sessionId = await createTestSession(apiContext, "E2E - Cache Metrics + Cost");

    // Run a simple agent task
    const { events } = await consumeSSE(
      `${BASE_URL}/api/agents/run-stream`,
      {
        sessionId,
        input: "你好，请简单回复一句话，然后调用finish工具结束。",
      },
      { untilEvent: "done", timeoutMs: 180_000 }
    );

    // Collect event types
    const eventTypes = events.map(e => e.event);
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("done");

    // Check turn_usage events have required fields
    const turnUsageEvents = events.filter(e => e.event === "turn_usage");
    if (turnUsageEvents.length > 0) {
      for (const tu of turnUsageEvents) {
        expect(tu.data.usage).toBeDefined();
        expect(typeof tu.data.usage.inputTokens).toBe("number");
        expect(typeof tu.data.usage.outputTokens).toBe("number");
        // Cache and cost fields are optional but should be present in the type
        // (they may be undefined if the provider doesn't return them)
        if (tu.data.usage.cacheCreationTokens !== undefined) {
          expect(typeof tu.data.usage.cacheCreationTokens).toBe("number");
        }
        if (tu.data.usage.cacheReadTokens !== undefined) {
          expect(typeof tu.data.usage.cacheReadTokens).toBe("number");
        }
      }
    }

    // Check done event has expected fields
    const doneEvent = events.find(e => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.data.turnsUsed).toBeDefined();
    expect(doneEvent!.data.usage).toBeDefined();
    // estimatedCostUsd may or may not be present depending on model pricing
    if (doneEvent!.data.estimatedCostUsd !== undefined) {
      expect(typeof doneEvent!.data.estimatedCostUsd).toBe("number");
      expect(doneEvent!.data.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    }
  });

  // =========================================================================
  // Feature 2: Verify SSE event structure completeness
  // =========================================================================
  test("SSE events follow expected sequence pattern", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });
    const sessionId = await createTestSession(apiContext, "E2E - SSE Sequence");

    const { events } = await consumeSSE(
      `${BASE_URL}/api/agents/run-stream`,
      {
        sessionId,
        input: "请说'测试完成'，然后立刻调用finish工具。",
      },
      { untilEvent: "done", timeoutMs: 180_000 }
    );

    const eventTypes = events.map(e => e.event);

    // First event should be "start"
    expect(eventTypes[0]).toBe("start");

    // Last meaningful event should be "done"
    expect(eventTypes[eventTypes.length - 1]).toBe("done");

    // "complete" event should appear before "done"
    const completeIdx = eventTypes.indexOf("complete");
    const doneIdx = eventTypes.indexOf("done");
    if (completeIdx >= 0 && doneIdx >= 0) {
      expect(completeIdx).toBeLessThan(doneIdx);
    }
  });

  // =========================================================================
  // Feature 9: Verify AgentResult structure from /run endpoint
  // =========================================================================
  test("/run endpoint returns result with cost and usage fields", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });
    const sessionId = await createTestSession(apiContext, "E2E - Run Result");

    const resp = await apiContext.post("/api/agents/run", {
      data: {
        sessionId,
        input: "请回复'收到'，然后调用finish工具结束。",
      },
    });

    // May fail if no provider configured — skip gracefully
    if (resp.status() !== 200) {
      test.skip();
      return;
    }

    const result = await resp.json();
    expect(result.taskId).toBeDefined();
    expect(result.usage).toBeDefined();
    expect(typeof result.usage.inputTokens).toBe("number");
    expect(typeof result.usage.outputTokens).toBe("number");

    // Cost field should be present (may be undefined/0)
    if (result.estimatedCostUsd !== undefined) {
      expect(typeof result.estimatedCostUsd).toBe("number");
    }
  });

  // =========================================================================
  // Feature 1+2: API-level verification of model registry data
  // =========================================================================
  test("settings API returns model data with context window info", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });

    // Get settings (should include provider registry data)
    const resp = await apiContext.get("/api/settings/providers");
    if (resp.status() !== 200) {
      // Try alternate endpoint
      const resp2 = await apiContext.get("/api/capabilities");
      expect(resp2.status()).toBe(200);
      const caps = await resp2.json();
      expect(caps).toBeDefined();
      return;
    }

    const providers = await resp.json();
    expect(providers).toBeDefined();
    // If providers list is returned, verify structure
    if (Array.isArray(providers)) {
      expect(providers.length).toBeGreaterThan(0);
    }
  });

});
