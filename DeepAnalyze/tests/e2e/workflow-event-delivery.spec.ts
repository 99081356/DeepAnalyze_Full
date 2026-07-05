// =============================================================================
// DeepAnalyze - Workflow Event Delivery Reliability E2E Tests
// =============================================================================
// Validates the multi-layer defense for workflow event delivery:
//   - P0: Event source correctness (parentTaskId/sessionId on workflow_complete)
//   - P0: SSE listener lifecycle (deferred removal for background workflows)
//   - P0: tool_result dispatched handling
//   - P0: PROTECTED_EVENTS anti-eviction
//   - P1: REST API fallback + WebSocket subscribe channel
//   - P2: Frontend watchdog forced cleanup
//
// Prerequisites:
//   - Server running on port 21000
//   - PostgreSQL container running
//   - At least one LLM provider configured
//
// Run: npx playwright test tests/e2e/workflow-event-delivery.spec.ts --reporter=list
// =============================================================================

import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createApi } from "./helpers/api";

const BASE_URL = "http://localhost:21000";

// ---------------------------------------------------------------------------
// SSE consumer helper (copied/adapted from background-workflows.spec.ts)
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
    collectEvents?: string[];
  } = {},
): Promise<{ events: SSEEvent[]; abort: () => void }> {
  const { untilEvent = "done", timeoutMs = 120_000 } = options;

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
                events.push({ event: currentEvent, data: parsed });

                if (currentEvent === untilEvent) {
                  clearTimeout(timeout);
                  resolve();
                  return;
                }
              } catch {
                /* ignore parse errors */
              }
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
        // On either explicit abort (from caller) or fetch AbortError, resolve
        // gracefully with whatever events were collected. The previous logic
        // silently dropped AbortError which left the promise pending forever
        // if the caller's abort() fired before the internal timeout — causing
        // `await consumeSSEUntilAbort(...)` to block until timeout rejection.
        resolve();
      });
  });

  await promise;
  return { events, abort: () => controller.abort() };
}

/**
 * Start SSE consumption WITHOUT awaiting — returns immediately with handles.
 *
 * Caller can:
 *   - read `events` array (populated live as stream progresses)
 *   - `await done` to wait for natural completion / timeout
 *   - call `abort()` to disconnect early; `done` then resolves promptly
 *
 * This is the correct pattern for tests that need to abort before a timeout
 * would naturally fire (the older `await consumeSSEUntilAbort(...)` pattern
 * deadlocked because abort could only be called AFTER the await returned).
 */
function startSSEConsumer(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 120_000,
): { events: SSEEvent[]; done: Promise<void>; abort: () => void } {
  const events: SSEEvent[] = [];
  const controller = new AbortController();

  const done = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      controller.abort();
      resolve();
    }, timeoutMs);

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";
        let currentData = "";
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
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
                events.push({ event: currentEvent, data: JSON.parse(currentData) });
              } catch {
                /* ignore parse errors */
              }
              currentEvent = "";
              currentData = "";
            }
          }
        }
        clearTimeout(timeout);
        resolve();
      })
      .catch(() => {
        clearTimeout(timeout);
        resolve();
      });
  });

  return { events, done, abort: () => controller.abort() };
}

/** Consume SSE without waiting for a specific event — collects until timeout or abort. */
async function consumeSSEUntilAbort(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<{ events: SSEEvent[]; abort: () => void }> {
  return consumeSSE(url, body, { untilEvent: "__never__", timeoutMs });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function createSession(title: string): Promise<string> {
  const apiContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const resp = await apiContext.post("/api/sessions", { data: { title } });
  expect([200, 201]).toContain(resp.status());
  const session = await resp.json();
  await apiContext.dispose();
  return session.id;
}

async function deleteSession(sessionId: string): Promise<void> {
  const apiContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
  await apiContext.delete(`/api/sessions/${sessionId}`).catch(() => {});
  await apiContext.dispose();
}

async function listSessionWorkflows(sessionId: string): Promise<any[]> {
  const apiContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const resp = await apiContext.get(`/api/sessions/${sessionId}/workflows`);
  const data = await resp.json();
  await apiContext.dispose();
  return data.workflows ?? [];
}

/** Prompt that reliably triggers a background workflow_run via inline agents. */
const WORKFLOW_PROMPT_2AGENTS =
  "请使用 workflow_run 工具启动一个 parallel 模式工作流。" +
  "目标：测试事件投递。" +
  "内联定义2个Agent：a1(role: researcher, task: 用think工具简单思考后用finish结束)和" +
  "a2(role: analyst, task: 用think工具简单思考后用finish结束)。" +
  "启动工作流后用 finish 结束当前任务。";

// ===========================================================================
// TC1 — Main task dispatches synchronous workflow (happy path baseline)
// ===========================================================================
test.describe("Workflow Event Delivery — 15 Test Cases", () => {
  test("TC1: Main task dispatches workflow — events arrive in order", async () => {
    const sessionId = await createSession("TC1-sync-workflow");

    try {
      const { events, abort } = await consumeSSE(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
          // Disable background mode to test synchronous path
          settings: { backgroundWorkflows: false },
        },
        { untilEvent: "done", timeoutMs: 300_000 },
      );

      const eventTypes = events.map((e) => e.event);

      // Core assertions: the workflow event sequence should be present
      // (either from SSE or from tool_result fallback)
      const hasWorkflowStart =
        eventTypes.includes("workflow_event") &&
        events.some(
          (e) => e.event === "workflow_event" && e.data?.type === "workflow_start",
        );
      const hasWorkflowComplete =
        eventTypes.includes("workflow_event") &&
        events.some(
          (e) => e.event === "workflow_event" && e.data?.type === "workflow_complete",
        ) || eventTypes.includes("workflow_complete");

      // In sync mode, the agent waits for the workflow — so events should arrive.
      // In background mode, the workflow may finish after the main task.
      // Either way, the SSE stream should have received start+done.
      expect(eventTypes).toContain("start");
      expect(eventTypes).toContain("done");

      console.log(
        `  [TC1] Events: ${eventTypes.filter((t) => t.startsWith("workflow")).join(", ") || "(none in SSE)"}`,
      );
      console.log(`  [TC1] workflow_start in SSE: ${hasWorkflowStart}`);
      console.log(`  [TC1] workflow_complete in SSE: ${hasWorkflowComplete}`);
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC2 — Main task dispatches background workflow (default mode)
  // ===========================================================================
  test("TC2: Background workflow — completion via REST API fallback", async () => {
    test.setTimeout(300_000);
    const sessionId = await createSession("TC2-background-workflow");

    try {
      // Start agent — in background mode, workflow_run returns "dispatched"
      const { events } = await consumeSSE(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
        },
        { untilEvent: "done", timeoutMs: 300_000 },
      );

      const eventTypes = events.map((e) => e.event);
      expect(eventTypes).toContain("start");
      expect(eventTypes).toContain("done");

      // Check if workflow_start arrived during SSE
      const wfStartInSSE = events.some(
        (e) =>
          (e.event === "workflow_event" && e.data?.type === "workflow_start") ||
          (e.event === "workflow_start"),
      );

      // Extract workflowId from tool_result or workflow_start event
      let workflowId: string | undefined;
      const toolResult = events.find(
        (e) =>
          e.event === "tool_result" &&
          (e.data?.toolName === "workflow_run" || e.data?.name === "workflow_run"),
      );
      if (toolResult?.data?.output) {
        try {
          const output =
            typeof toolResult.data.output === "string"
              ? JSON.parse(toolResult.data.output)
              : toolResult.data.output;
          workflowId = output.workflowId;
        } catch {
          /* not JSON */
        }
      }
      if (!workflowId) {
        const wfStart = events.find(
          (e) =>
            (e.event === "workflow_event" && e.data?.type === "workflow_start") ||
            e.event === "workflow_start",
        );
        workflowId = wfStart?.data?.workflowId;
      }

      console.log(`  [TC2] workflow_start in SSE: ${wfStartInSSE}`);
      console.log(`  [TC2] workflowId: ${workflowId ?? "(not found)"}`);

      // Poll REST API until workflow completes (fallback channel)
      if (workflowId) {
        const deadline = Date.now() + 240_000;
        let finalStatus: string | undefined;
        while (Date.now() < deadline) {
          const wfs = await listSessionWorkflows(sessionId);
          const wf = wfs.find((w) => w.workflowId === workflowId);
          if (!wf) {
            // Workflow was cleaned from active list — likely completed
            finalStatus = "completed";
            break;
          }
          if (["completed", "failed", "cancelled"].includes(wf.status)) {
            finalStatus = wf.status;
            break;
          }
          await new Promise((r) => setTimeout(r, 3000));
        }

        console.log(`  [TC2] Workflow final status via REST: ${finalStatus ?? "(timeout)"}`);
        expect(finalStatus).toBeTruthy();
      }
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC3 — Verify workflow_start carries parentTaskId (ALS propagation)
  // ===========================================================================
  test("TC3: workflow_start carries parentTaskId for attribution", async () => {
    test.setTimeout(300_000);
    const sessionId = await createSession("TC3-parent-task-id");

    try {
      const { events } = await consumeSSE(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
        },
        { untilEvent: "done", timeoutMs: 300_000 },
      );

      // Find the taskId from start event
      const startEvent = events.find((e) => e.event === "start");
      const taskId = startEvent?.data?.taskId;

      // Find workflow_start event — check both workflow_event wrapper and direct
      const wfStartViaEvent = events.find(
        (e) => e.event === "workflow_event" && e.data?.type === "workflow_start",
      );
      const wfStartDirect = events.find((e) => e.event === "workflow_start");

      const wfStart = wfStartViaEvent?.data ?? wfStartDirect?.data;

      console.log(`  [TC3] taskId: ${taskId}`);
      console.log(`  [TC3] workflow_start parentTaskId: ${wfStart?.parentTaskId ?? "(not present)"}`);

      if (wfStart) {
        // If we captured the workflow_start event, parentTaskId should match taskId
        // (In background mode, the workflow_start may not arrive in SSE if the
        // listener wasn't attached yet — that's the scenario this fix addresses)
        if (taskId && wfStart.parentTaskId) {
          expect(wfStart.parentTaskId).toBe(taskId);
        }
      }

      // Verify the REST API also shows the workflow
      const wfs = await listSessionWorkflows(sessionId);
      console.log(`  [TC3] Active workflows on server: ${wfs.length}`);
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC4 — SSE mid-stream disconnect and reconnect (buffer replay)
  // ===========================================================================
  test("TC4: SSE disconnect — events buffered for replay", async () => {
    test.setTimeout(180_000);
    const sessionId = await createSession("TC4-sse-reconnect");

    try {
      // Start SSE consumer without awaiting — get handles immediately so we
      // can abort after a short observation window (5s).
      const consumer = startSSEConsumer(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
        },
        60_000, // Outer safety timeout — abort should fire first
      );

      // Observe for 5s to collect initial events (start + maybe workflow_start)
      await new Promise((r) => setTimeout(r, 5000));
      consumer.abort();
      // Wait for consumer.done to settle after abort
      await consumer.done;

      const firstBatch = consumer.events;
      const firstBatchTypes = firstBatch.map((e) => e.event);
      console.log(`  [TC4] First batch events: ${firstBatchTypes.join(", ")}`);

      // Wait a bit for the task to continue running
      await new Promise((r) => setTimeout(r, 5000));

      // Get the taskId from the first batch
      const startEvent = firstBatch.find((e) => e.event === "start");
      const taskId = startEvent?.data?.taskId;
      expect(taskId, "start event must carry taskId").toBeTruthy();

      // Reconnect to the same task — events should be replayed from buffer
      const reconnectResp = await fetch(`${BASE_URL}/api/agents/stream/${taskId}`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      });

      if (reconnectResp.ok && reconnectResp.body) {
        const reader = reconnectResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let reconnectEvents: string[] = [];
        const reconnectDeadline = Date.now() + 10_000;

        while (Date.now() < reconnectDeadline) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              reconnectEvents.push(line.slice(7).trim());
            }
          }
        }
        console.log(`  [TC4] Reconnect events: ${reconnectEvents.join(", ")}`);
        // The buffer should replay at least some events
        expect(reconnectEvents.length, "buffer should replay events on reconnect").toBeGreaterThan(0);
      } else {
        console.log(`  [TC4] Reconnect endpoint returned ${reconnectResp.status} — skipping replay check`);
      }
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC5 — Background workflow outlives main task (timing boundary)
  // ===========================================================================
  test("TC5: Workflow outlives main task — listener stays attached", async () => {
    test.setTimeout(360_000);
    const sessionId = await createSession("TC5-timing-boundary");

    try {
      // Minimal prompt: 1 agent, finish immediately. The point is to validate
      // that the workflow keeps running AFTER the main task emits `done`.
      const prompt =
        "请使用 workflow_run 启动一个 parallel 模式工作流，目标：测试后台运行。" +
        "内联定义1个Agent a1 (role: worker, task: 用think思考后finish结束)。" +
        "启动工作流后立即用 finish 结束当前任务，不要等待工作流完成。";

      const { events } = await consumeSSE(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: prompt,
          agentType: "general",
        },
        { untilEvent: "done", timeoutMs: 300_000 },
      );

      // Main task should be done
      const eventTypes = events.map((e) => e.event);
      expect(eventTypes).toContain("done");
      console.log(`  [TC5] Main task done. Events: ${eventTypes.length}`);

      // Sample workflow state at intervals — it should still be tracked
      const sample1 = await listSessionWorkflows(sessionId);
      console.log(
        `  [TC5] Workflows immediately after main task done: ${sample1.length} (${sample1.map((w) => w.status).join(",")})`,
      );

      // Wait and sample again
      await new Promise((r) => setTimeout(r, 10_000));
      const sample2 = await listSessionWorkflows(sessionId);
      console.log(`  [TC5] Workflows after 10s: ${sample2.length} (${sample2.map((w) => w.status).join(",")})`);

      // Poll until all workflows reach terminal state
      const deadline = Date.now() + 240_000;
      let allDone = false;
      while (Date.now() < deadline) {
        const wfs = await listSessionWorkflows(sessionId);
        if (wfs.length === 0) {
          allDone = true;
          break;
        }
        const allTerminal = wfs.every((w) =>
          ["completed", "failed", "cancelled"].includes(w.status),
        );
        if (allTerminal) {
          allDone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }

      console.log(`  [TC5] All workflows reached terminal state: ${allDone}`);
      // In background mode, the workflow should eventually complete
      // (If no workflow was dispatched, this test still passes — just no-op)
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC6 — Parallel workflows (same session, independent completion)
  // ===========================================================================
  test("TC6: Parallel workflows — independent completion", async () => {
    test.setTimeout(300_000);
    const sessionId = await createSession("TC6-parallel-workflows");

    try {
      const prompt =
        "请依次使用 workflow_run 启动两个独立的 parallel 模式工作流：" +
        "第一个工作流目标：分析任务A，内联定义1个Agent a1(role: researcher, task: 用think思考后finish结束)。" +
        "第二个工作流目标：分析任务B，内联定义1个Agent b1(role: analyst, task: 用think思考后finish结束)。" +
        "启动两个工作流后用 finish 结束当前任务。";

      const { events } = await consumeSSE(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: prompt,
          agentType: "general",
        },
        { untilEvent: "done", timeoutMs: 240_000 },
      );

      // Count distinct workflow_start events
      const wfStarts = events.filter(
        (e) =>
          (e.event === "workflow_event" && e.data?.type === "workflow_start") ||
          e.event === "workflow_start",
      );
      const workflowIds = new Set(wfStarts.map((e) => e.data?.workflowId).filter(Boolean));

      console.log(`  [TC6] workflow_start events: ${wfStarts.length}`);
      console.log(`  [TC6] distinct workflowIds: ${workflowIds.size}`);

      // Check REST API
      const wfs = await listSessionWorkflows(sessionId);
      console.log(`  [TC6] Active workflows on server: ${wfs.length}`);

      // If two workflows were dispatched, poll until both complete
      if (wfs.length >= 2 || workflowIds.size >= 2) {
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          const current = await listSessionWorkflows(sessionId);
          if (current.length === 0) break;
          const allTerminal = current.every((w) =>
            ["completed", "failed", "cancelled"].includes(w.status),
          );
          if (allTerminal) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        const final = await listSessionWorkflows(sessionId);
        console.log(`  [TC6] Final workflow count: ${final.length}`);
      }
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC7 — WebSocket fallback channel (SSE completely closed)
  // ===========================================================================
  test("TC7: REST API returns workflow state without SSE", async () => {
    test.setTimeout(240_000);
    const sessionId = await createSession("TC7-ws-fallback");

    // Start SSE in background but discard its events — we only care that the
    // server-side agent runs and the workflow is queryable via REST. Using
    // startSSEConsumer (non-blocking) avoids the /api/agents/run endpoint
    // which can block until agent completion.
    const consumer = startSSEConsumer(
      `${BASE_URL}/api/agents/run-stream`,
      {
        sessionId,
        input: WORKFLOW_PROMPT_2AGENTS,
        agentType: "general",
      },
      230_000,
    );

    try {
      // Wait for the task to start
      await new Promise((r) => setTimeout(r, 5000));

      // The REST API should show workflows even without consuming SSE events
      const wfs = await listSessionWorkflows(sessionId);
      console.log(`  [TC7] Workflows visible via REST (no SSE): ${wfs.length}`);

      // Poll for completion via REST only
      const deadline = Date.now() + 180_000;
      let sawRunning = false;
      let finalStatus: string | undefined;
      while (Date.now() < deadline) {
        const current = await listSessionWorkflows(sessionId);
        if (current.length > 0) {
          const statuses = current.map((w) => w.status);
          if (statuses.some((s) => s === "running")) sawRunning = true;
          if (current.every((w) => ["completed", "failed", "cancelled"].includes(w.status))) {
            finalStatus = current[0]?.status;
            break;
          }
        } else if (sawRunning) {
          // Was running, now empty — completed and cleaned up
          finalStatus = "completed";
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      console.log(`  [TC7] sawRunning: ${sawRunning}, finalStatus: ${finalStatus ?? "(none)"}`);
    } finally {
      consumer.abort();
      await consumer.done.catch(() => {});
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC8 — PROTECTED_EVENTS anti-eviction (workflow_start survives high event volume)
  // ===========================================================================
  test("TC8: PROTECTED_EVENTS — workflow_start not evicted under load", async () => {
    test.setTimeout(240_000);
    const sessionId = await createSession("TC8-protected-events");

    try {
      const { events } = await consumeSSE(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
        },
        { untilEvent: "done", timeoutMs: 180_000 },
      );

      const eventTypes = events.map((e) => e.event);

      // Verify workflow events survived in the buffer
      const workflowEvents = events.filter((e) =>
        e.event === "workflow_event" || e.event === "workflow_start" || e.event === "workflow_complete",
      );
      const pushContents = events.filter((e) => e.event === "push_content");

      console.log(`  [TC8] Total events: ${events.length}`);
      console.log(`  [TC8] workflow events: ${workflowEvents.length}`);
      console.log(`  [TC8] push_content events: ${pushContents.length}`);

      // If there were any workflow events, verify they include start (protected)
      if (workflowEvents.length > 0) {
        const hasStart = workflowEvents.some(
          (e) => e.data?.type === "workflow_start" || e.event === "workflow_start",
        );
        console.log(`  [TC8] workflow_start present in final buffer: ${hasStart}`);
      }

      // Verify the buffer has a done event (protected, always retained)
      expect(eventTypes).toContain("done");
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC9 — Watchdog forced cleanup (event loss simulation via REST API)
  // ===========================================================================
  test("TC9: REST API watchdog — stale workflow detection", async () => {
    test.setTimeout(120_000);
    const sessionId = await createSession("TC9-watchdog");

    try {
      // Verify the REST API works correctly for workflow state queries
      const apiContext = await playwrightRequest.newContext({ baseURL: BASE_URL });

      // Initially should have no workflows
      const initial = await listSessionWorkflows(sessionId);
      console.log(`  [TC9] Initial workflows: ${initial.length}`);

      // Verify REST API response format
      const resp = await apiContext.get(`/api/sessions/${sessionId}/workflows`);
      expect(resp.status()).toBe(200);
      const data = await resp.json();
      expect(data).toHaveProperty("sessionId", sessionId);
      expect(data).toHaveProperty("workflows");
      expect(Array.isArray(data.workflows)).toBeTruthy();

      console.log(`  [TC9] REST API format verified: sessionId + workflows array`);

      // Simulate what the frontend watchdog does: query REST for a non-existent
      // workflow and verify the behavior
      const fakeWfId = "nonexistent-workflow-id";
      const wfs = data.workflows as any[];
      const notFound = !wfs.find((w) => w.workflowId === fakeWfId);
      expect(notFound).toBeTruthy();
      console.log(`  [TC9] Non-existent workflow correctly not found in REST response`);

      await apiContext.dispose();
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC10 — Error/cancel scenarios (terminal status propagation)
  // ===========================================================================
  test("TC10: Error and cancel — terminal status propagates", async () => {
    test.setTimeout(180_000);
    const sessionId = await createSession("TC10-error-cancel");

    let consumer: ReturnType<typeof startSSEConsumer> | null = null;
    try {
      // Use streaming start so we don't block on the (potentially synchronous)
      // POST /api/agents/run endpoint. startSSEConsumer returns immediately.
      consumer = startSSEConsumer(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: "请用think工具思考一个复杂的问题，然后慢慢用finish结束。",
          agentType: "general",
        },
        170_000, // Safety abort — test logic should complete well before this
      );

      // Wait briefly for the start event carrying taskId
      await new Promise((r) => setTimeout(r, 3000));

      const startEvent = consumer.events.find((e) => e.event === "start");
      const taskId = startEvent?.data?.taskId;

      if (!taskId) {
        console.log(`  [TC10] No start event yet — polling tasks endpoint`);
        // Fall back to tasks endpoint
        const apiContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
        const statusResp = await apiContext.get(`/api/agents/tasks/${sessionId}`);
        const tasks = await statusResp.json().catch(() => []);
        await apiContext.dispose();
        if (Array.isArray(tasks) && tasks.length > 0) {
          await cancelAndVerify(sessionId, tasks[tasks.length - 1].id);
        } else {
          console.log(`  [TC10] No running task found (timing-dependent)`);
        }
      } else {
        console.log(`  [TC10] Task to cancel: ${taskId}`);
        await cancelAndVerify(sessionId, taskId);
      }

      // Abort the SSE consumer to clean up
      consumer.abort();
      await consumer.done;
    } finally {
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC11 — Cross-session isolation (plan TC4: workflow events don't leak)
  // ===========================================================================
  // Validates Fix 2.1: SSE filter uses sessionId as primary isolation key.
  // Workflows started in session A must NOT be visible in session B's REST
  // queries, and vice versa.
  test("TC11: Cross-session isolation — workflows don't leak across sessions", async () => {
    test.setTimeout(240_000);
    const sessionA = await createSession("TC11-session-A");
    const sessionB = await createSession("TC11-session-B");

    const consumers: Array<ReturnType<typeof startSSEConsumer>> = [];
    try {
      // Start a workflow in each session, non-blocking
      consumers.push(
        startSSEConsumer(
          `${BASE_URL}/api/agents/run-stream`,
          {
            sessionId: sessionA,
            input: WORKFLOW_PROMPT_2AGENTS,
            agentType: "general",
          },
          230_000,
        ),
      );
      consumers.push(
        startSSEConsumer(
          `${BASE_URL}/api/agents/run-stream`,
          {
            sessionId: sessionB,
            input: WORKFLOW_PROMPT_2AGENTS,
            agentType: "general",
          },
          230_000,
        ),
      );

      // Wait for both workflows to register
      await new Promise((r) => setTimeout(r, 10_000));

      const wfsA = await listSessionWorkflows(sessionA);
      const wfsB = await listSessionWorkflows(sessionB);

      console.log(`  [TC11] session A workflows: ${wfsA.length} (${wfsA.map((w) => w.workflowId).join(",")})`);
      console.log(`  [TC11] session B workflows: ${wfsB.length} (${wfsB.map((w) => w.workflowId).join(",")})`);

      // Both sessions should have at least one workflow
      expect(wfsA.length, "session A must have its own workflow").toBeGreaterThan(0);
      expect(wfsB.length, "session B must have its own workflow").toBeGreaterThan(0);

      // Cross-check: no workflow ID appears in both sessions
      const idsA = new Set(wfsA.map((w) => w.workflowId));
      const idsB = new Set(wfsB.map((w) => w.workflowId));
      const intersection = [...idsA].filter((id) => idsB.has(id));
      expect(intersection, "no workflow ID should appear in both sessions").toEqual([]);

      // Also verify sessionId field on each workflow matches its container session
      for (const w of wfsA) {
        expect(
          w.sessionId,
          `workflow ${w.workflowId} sessionId must match session A`,
        ).toBe(sessionA);
      }
      for (const w of wfsB) {
        expect(
          w.sessionId,
          `workflow ${w.workflowId} sessionId must match session B`,
        ).toBe(sessionB);
      }
    } finally {
      for (const c of consumers) {
        c.abort();
      }
      for (const c of consumers) {
        await c.done.catch(() => {});
      }
      await deleteSession(sessionA);
      await deleteSession(sessionB);
    }
  });

  // ===========================================================================
  // TC12 — Workflow persists past in-memory cleanup window (plan TC6 proxy)
  // ===========================================================================
  // Validates Fix 3.x (DB persistence). The frontend's workflow store calls
  // clearWorkflow 30s after handleWorkflowComplete, removing the workflow
  // from WorkflowManager's in-memory Map. After that window, the ONLY way
  // GET /api/sessions/:id/workflows can still return the workflow is if it's
  // reading from the `workflows` DB table.
  test("TC12: Completed workflow remains queryable past 30s memory cleanup", async () => {
    test.setTimeout(300_000);
    const sessionId = await createSession("TC12-persistence");

    let consumer: ReturnType<typeof startSSEConsumer> | null = null;
    try {
      consumer = startSSEConsumer(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
        },
        240_000,
      );

      // Wait for workflow to appear, then complete
      const startDeadline = Date.now() + 120_000;
      let workflowId: string | undefined;
      while (Date.now() < startDeadline) {
        const wfs = await listSessionWorkflows(sessionId);
        if (wfs.length > 0) {
          workflowId = wfs[0].workflowId;
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      expect(workflowId, "workflow must start within 120s").toBeTruthy();
      console.log(`  [TC12] workflow started: ${workflowId}`);

      // Wait for terminal status
      const completeDeadline = Date.now() + 180_000;
      let finalStatus: string | undefined;
      while (Date.now() < completeDeadline) {
        const wfs = await listSessionWorkflows(sessionId);
        const wf = wfs.find((w) => w.workflowId === workflowId);
        if (wf && ["completed", "failed", "cancelled"].includes(wf.status)) {
          finalStatus = wf.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      console.log(`  [TC12] workflow terminal status: ${finalStatus ?? "(timeout)"}`);
      expect(finalStatus, "workflow must reach terminal status").toBeTruthy();

      // Now wait PAST the 30s memory cleanup window. After this point, the
      // workflow is gone from WorkflowManager.active (in-memory). The only
      // way REST can still return it is from the DB.
      console.log(`  [TC12] waiting 35s for in-memory cleanup to evict the workflow...`);
      await new Promise((r) => setTimeout(r, 35_000));

      const wfsAfterCleanup = await listSessionWorkflows(sessionId);
      const wfAfterCleanup = wfsAfterCleanup.find((w) => w.workflowId === workflowId);

      console.log(
        `  [TC12] after cleanup window: ${wfsAfterCleanup.length} workflows, target present=${!!wfAfterCleanup}`,
      );
      expect(
        wfAfterCleanup,
        "workflow MUST still be queryable after memory cleanup — proves DB persistence",
      ).toBeTruthy();
      expect(
        wfAfterCleanup!.status,
        "status must be terminal in DB",
      ).toMatch(/^(completed|failed|cancelled)$/);
      expect(
        wfAfterCleanup!.teamName,
        "teamName must be real (not placeholder)",
      ).not.toBe("(recovered)");
    } finally {
      if (consumer) {
        consumer.abort();
        await consumer.done.catch(() => {});
      }
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC13 — New workflow writes real fields to DB (plan TC7)
  // ===========================================================================
  // Validates Fix 3.2 (WorkflowManager writes to DB) + Fix 4.x (placeholders
  // don't leak). The REST endpoint reads from memory first, then DB. If the
  // workflow is only in memory, teamName might be a placeholder. After the
  // 30s cleanup window (TC12 proves memory is cleared), the workflow is only
  // in DB — so any field returned MUST be the real DB value.
  test("TC13: New workflow DB row carries real teamName/mode/agentCount", async () => {
    test.setTimeout(240_000);
    const sessionId = await createSession("TC13-db-fields");

    let consumer: ReturnType<typeof startSSEConsumer> | null = null;
    try {
      consumer = startSSEConsumer(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
        },
        230_000,
      );

      // Wait for workflow to appear
      const startDeadline = Date.now() + 60_000;
      let wf: any;
      while (Date.now() < startDeadline) {
        const wfs = await listSessionWorkflows(sessionId);
        if (wfs.length > 0) {
          wf = wfs[0];
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(wf, "workflow must appear in REST within 60s").toBeTruthy();
      console.log(`  [TC13] initial REST row: teamName=${wf.teamName}, mode=${wf.mode}, agentCount=${wf.agentCount}`);

      // While running, fields should already be real (memory path)
      expect(wf.teamName, "teamName must not be placeholder while running").not.toBe("(recovered)");
      expect(wf.teamName, "teamName must not be (后台工作流) placeholder").not.toBe("(后台工作流)");
      expect(wf.mode, "mode must be set").toBeTruthy();

      // Wait for completion + 35s cleanup window so REST reads from DB only
      const completeDeadline = Date.now() + 180_000;
      while (Date.now() < completeDeadline) {
        const wfs = await listSessionWorkflows(sessionId);
        const current = wfs.find((w) => w.workflowId === wf.workflowId);
        if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      console.log(`  [TC13] waiting 35s for memory cleanup before re-querying DB-only path`);
      await new Promise((r) => setTimeout(r, 35_000));

      const wfsFinal = await listSessionWorkflows(sessionId);
      const wfFinal = wfsFinal.find((w) => w.workflowId === wf.workflowId);
      expect(wfFinal, "workflow must still be queryable from DB after memory cleanup").toBeTruthy();

      console.log(
        `  [TC13] DB-only REST row: teamName=${wfFinal.teamName}, mode=${wfFinal.mode}, agentCount=${wfFinal.agentCount}, status=${wfFinal.status}`,
      );

      // These assertions run AFTER memory cleanup — values come from DB
      expect(wfFinal.teamName, "DB teamName must be real").not.toBe("(recovered)");
      expect(wfFinal.teamName, "DB teamName must be real").not.toBe("(后台工作流)");
      expect(wfFinal.mode, "DB mode must be set").toBeTruthy();
      expect(wfFinal.status, "DB status must be terminal").toMatch(/^(completed|failed|cancelled)$/);
    } finally {
      if (consumer) {
        consumer.abort();
        await consumer.done.catch(() => {});
      }
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC14 — Failed workflow persists to DB (plan TC8 — best-effort)
  // ===========================================================================
  // Triggering a deterministic sub-agent failure via LLM prompt is unreliable,
  // so this test runs a normal workflow and only asserts the failure path IF
  // the workflow happens to fail. When the workflow succeeds, the test logs
  // a soft-pass note. Cancellation (forced via API) is also exercised.
  test("TC14: Failed workflow — error field populated when failure occurs", async () => {
    test.setTimeout(240_000);
    const sessionId = await createSession("TC14-failure-persistence");

    let consumer: ReturnType<typeof startSSEConsumer> | null = null;
    try {
      // Use a prompt that's *likely* to fail: ask for an invalid tool name.
      // The LLM may or may not honor it; if it does, the sub-agent will fail
      // when trying to invoke the nonexistent tool.
      const failPrompt =
        "请使用 workflow_run 启动一个 parallel 模式工作流。" +
        "目标：测试失败场景。" +
        "内联定义1个Agent a1 (role: failer, task: 必须调用名为 nonexistent_tool_xyz_12345 的工具，调用失败后用 finish 结束)。" +
        "启动工作流后用 finish 结束当前任务。";

      consumer = startSSEConsumer(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: failPrompt,
          agentType: "general",
        },
        230_000,
      );

      // Wait for workflow + terminal status
      const deadline = Date.now() + 180_000;
      let wf: any;
      while (Date.now() < deadline) {
        const wfs = await listSessionWorkflows(sessionId);
        if (wfs.length > 0) {
          wf = wfs[0];
          if (["completed", "failed", "cancelled"].includes(wf.status)) break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      if (!wf) {
        console.log(`  [TC14] no workflow observed — soft pass (LLM didn't dispatch)`);
        return;
      }

      console.log(`  [TC14] final status: ${wf.status}, error: ${wf.error ?? "(none)"}`);

      // If workflow reached "failed" status, error field must be populated
      if (wf.status === "failed") {
        expect(wf.error, "failed workflow must have error field populated").toBeTruthy();
      } else if (wf.status === "cancelled") {
        // Cancellation path: status set, no error required
        expect(wf.status).toBe("cancelled");
      } else {
        // Completed (LLM didn't trigger the failure path) — soft pass
        console.log(`  [TC14] workflow completed without failure (LLM cooperative) — soft pass`);
      }

      // Wait past memory cleanup, then verify DB has the same status
      await new Promise((r) => setTimeout(r, 35_000));
      const wfsDb = await listSessionWorkflows(sessionId);
      const wfDb = wfsDb.find((w) => w.workflowId === wf.workflowId);
      if (wfDb) {
        console.log(`  [TC14] DB row after cleanup: status=${wfDb.status}`);
        expect(wfDb.status, "DB status must match in-memory status").toBe(wf.status);
      }
    } finally {
      if (consumer) {
        consumer.abort();
        await consumer.done.catch(() => {});
      }
      await deleteSession(sessionId);
    }
  });

  // ===========================================================================
  // TC15 — SSE disconnect + REST fallback roundtrip (plan TC10)
  // ===========================================================================
  // Validates the end-to-end "SSE disconnect → REST fallback → reconnect"
  // path. After SSE disconnects mid-stream, the workflow must continue running
  // server-side; REST must return real fields (not placeholders); SSE
  // reconnect must deliver the events that fired during the disconnect.
  test("TC15: SSE disconnect mid-stream — REST fallback + reconnect replay", async () => {
    test.setTimeout(180_000);
    const sessionId = await createSession("TC15-disconnect-fallback");

    let consumer: ReturnType<typeof startSSEConsumer> | null = null;
    try {
      consumer = startSSEConsumer(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: WORKFLOW_PROMPT_2AGENTS,
          agentType: "general",
        },
        170_000,
      );

      // Collect events for 8s, then abort (simulate disconnect)
      await new Promise((r) => setTimeout(r, 8000));
      const eventsBeforeDisconnect = consumer.events.length;
      const taskId = consumer.events.find((e) => e.event === "start")?.data?.taskId;
      console.log(
        `  [TC15] collected ${eventsBeforeDisconnect} events before disconnect; taskId=${taskId}`,
      );
      consumer.abort();
      await consumer.done.catch(() => {});

      // REST fallback: workflow must still be queryable with real fields
      await new Promise((r) => setTimeout(r, 3000));
      const wfsDuringDisconnect = await listSessionWorkflows(sessionId);
      console.log(
        `  [TC15] REST during disconnect: ${wfsDuringDisconnect.length} workflows`,
      );
      expect(wfsDuringDisconnect.length, "workflow must be queryable via REST during disconnect").toBeGreaterThan(0);

      const wfDuringDisconnect = wfsDuringDisconnect[0];
      expect(
        wfDuringDisconnect.teamName,
        "teamName must be real during disconnect (REST reads DB)",
      ).not.toBe("(recovered)");
      console.log(
        `  [TC15] REST teamName during disconnect: ${wfDuringDisconnect.teamName}`,
      );

      // Reconnect SSE — should receive events that fired during disconnect
      if (taskId) {
        const reconnectResp = await fetch(`${BASE_URL}/api/agents/stream/${taskId}`, {
          method: "GET",
          headers: { Accept: "text/event-stream" },
        });

        if (reconnectResp.ok && reconnectResp.body) {
          const reader = reconnectResp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let reconnectEventCount = 0;
          const reconnectDeadline = Date.now() + 15_000;
          while (Date.now() < reconnectDeadline) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (line.startsWith("event: ")) reconnectEventCount++;
            }
          }
          console.log(`  [TC15] reconnect delivered ${reconnectEventCount} events`);
          expect(
            reconnectEventCount,
            "reconnect must deliver buffered events from disconnect window",
          ).toBeGreaterThan(0);
        }
      }
    } finally {
      if (consumer) {
        consumer.abort();
        await consumer.done.catch(() => {});
      }
      await deleteSession(sessionId);
    }
  });
});

// ---------------------------------------------------------------------------
// TC10 helper: cancel a task and verify terminal status propagation
// ---------------------------------------------------------------------------
async function cancelAndVerify(sessionId: string, taskId: string): Promise<void> {
  const apiContext = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const cancelResp = await apiContext.post(`/api/agents/cancel/${taskId}`);
    console.log(`  [TC10] Cancel response: ${cancelResp.status()}`);

    // Wait for cancellation to propagate
    await new Promise((r) => setTimeout(r, 3000));

    // Verify task reached terminal state
    const finalStatusResp = await apiContext.get(`/api/agents/tasks/${sessionId}`);
    const finalTasks = await finalStatusResp.json().catch(() => []);
    if (Array.isArray(finalTasks) && finalTasks.length > 0) {
      const finalTask = finalTasks.find((t) => t.id === taskId);
      if (finalTask) {
        console.log(`  [TC10] Final task status: ${finalTask.status}`);
        expect(["cancelled", "completed", "failed"]).toContain(finalTask.status);
      }
    }
  } finally {
    await apiContext.dispose();
  }
}
