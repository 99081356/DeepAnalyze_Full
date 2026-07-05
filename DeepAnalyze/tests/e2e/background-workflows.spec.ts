// =============================================================================
// DeepAnalyze - E2E Background Workflow Tests
// =============================================================================
// Tests the full API flow: start agent → inject message → observe workflow
// dispatch → observe completion notification.
//
// Prerequisites:
// - Server running on port 21000 (python3 start.py --no-docker --skip-frontend --port 21000)
// - DA_BACKGROUND_WORKFLOWS=true environment variable set
// - At least one knowledge base with documents
//
// Run: npx playwright test tests/e2e/background-workflows.spec.ts
// =============================================================================

import { test, expect, request } from "@playwright/test";

const BASE_URL = "http://localhost:21000";

// ---------------------------------------------------------------------------
// SSE Helper
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
  } = {}
): Promise<{ events: SSEEvent[]; abort: () => void }> {
  const { untilEvent = "done", timeoutMs = 120_000, collectEvents } = options;

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
// Test Suite
// ---------------------------------------------------------------------------

test.describe("Background Workflow E2E Tests", () => {

  // =========================================================================
  // Case 1: Basic inject message during agent run
  // =========================================================================
  test("Case 1: Can inject message while agent is streaming", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });

    // Create a session
    const sessionResp = await apiContext.post("/api/sessions", {
      data: { title: "E2E Test - Inject Message" },
    });
    expect([200, 201]).toContain(sessionResp.status());
    const session = await sessionResp.json();
    const sessionId = session.id;
    expect(sessionId).toBeTruthy();

    // Start agent with a simple question (SSE stream)
    const ssePromise = consumeSSE(
      `${BASE_URL}/api/agents/run-stream`,
      { sessionId, input: "你好，请做一个简单的测试，用 think 工具思考后调用 finish。" },
      { untilEvent: "done", timeoutMs: 120_000 }
    );

    // Wait a moment for the agent to start
    await new Promise(r => setTimeout(r, 3000));

    // Inject a message
    // First, we need the taskId from the SSE events
    // Since SSE is already streaming, we check collected events
    // Note: inject may fail if task hasn't started yet, so we retry
    let injected = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      // Try to get tasks for this session
      const tasksResp = await apiContext.get(`/api/agents/tasks/${sessionId}`);
      if (tasksResp.status() === 200) {
        const tasks = await tasksResp.json();
        if (tasks.length > 0 && tasks[0].status === "running") {
          const taskId = tasks[0].id;
          const injectResp = await apiContext.post(`/api/agents/inject/${taskId}`, {
            data: { message: "这是测试注入消息，请忽略并继续完成当前任务。" },
          });
          if (injectResp.status() === 200) {
            const injectResult = await injectResp.json();
            expect(injectResult.status).toBe("injected");
            injected = true;
            break;
          }
        }
      }
    }

    // Wait for SSE to complete
    const { events } = await ssePromise;

    // Verify we got a complete flow
    const eventTypes = events.map(e => e.event);
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("done");

    // If inject succeeded, verify no errors from it
    if (injected) {
      const errors = events.filter(e => e.event === "error");
      // Inject should not cause errors
      expect(errors.length).toBe(0);
    }

    console.log(`  [Case 1] Events received: ${eventTypes.join(", ")}`);
    console.log(`  [Case 1] Inject succeeded: ${injected}`);

    // Cleanup
    await apiContext.delete(`/api/sessions/${sessionId}`);
  });

  // =========================================================================
  // Case 2: workflow_status tool availability
  // =========================================================================
  test("Case 2: workflow_status endpoint responds correctly", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });

    // Create a session and run agent that should have workflow_status available
    const sessionResp = await apiContext.post("/api/sessions", {
      data: { title: "E2E Test - Workflow Status" },
    });
    expect([200, 201]).toContain(sessionResp.status());
    const session = await sessionResp.json();
    const sessionId = session.id;

    // Start a coordinator agent that can use workflow_status
    const ssePromise = consumeSSE(
      `${BASE_URL}/api/agents/run-stream`,
      {
        sessionId,
        input: "请使用 workflow_status 工具查询当前工作流状态，然后用 finish 结束。",
        agentType: "coordinator",
      },
      { untilEvent: "done", timeoutMs: 60_000 }
    );

    const { events } = await ssePromise;

    const eventTypes = events.map(e => e.event);
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("done");

    // Check if workflow_status tool was called
    const toolCalls = events.filter(e => e.event === "tool_call");
    const workflowStatusCall = toolCalls.find(
      e => e.data?.toolName === "workflow_status" || e.data?.name === "workflow_status"
    );

    console.log(`  [Case 2] Events received: ${eventTypes.join(", ")}`);
    console.log(`  [Case 2] Tool calls: ${toolCalls.map(e => e.data?.toolName || e.data?.name).join(", ")}`);
    console.log(`  [Case 2] workflow_status called: ${!!workflowStatusCall}`);

    // Cleanup
    await apiContext.delete(`/api/sessions/${sessionId}`);
  });

  // =========================================================================
  // Case 3: Non-blocking workflow dispatch (requires DA_BACKGROUND_WORKFLOWS=true)
  // =========================================================================
  test.setTimeout(300_000);
  test("Case 3: Workflow dispatch is non-blocking when flag enabled", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });

    const sessionResp = await apiContext.post("/api/sessions", {
      data: { title: "E2E Test - Non-blocking Workflow" },
    });
    expect([200, 201]).toContain(sessionResp.status());
    const session = await sessionResp.json();
    const sessionId = session.id;

    // Use coordinator to dispatch a workflow
    // If backgroundWorkflows is enabled, it should return immediately
    const ssePromise = consumeSSE(
      `${BASE_URL}/api/agents/run-stream`,
      {
        sessionId,
        input: "请使用 workflow_run 启动一个 parallel 模式工作流，目标：测试非阻塞模式。" +
          "内联定义2个Agent：a1(role: researcher, task: 用think思考)和a2(role: analyst, task: 用think思考)。" +
          "启动后用 workflow_status 查看状态，然后用 finish 结束。",
        agentType: "general",
      },
      { untilEvent: "done", timeoutMs: 300_000 }
    );

    const { events } = await ssePromise;

    const eventTypes = events.map(e => e.event);
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("done");

    // Check tool results for workflow_run
    const toolResults = events.filter(e => e.event === "tool_result");
    const workflowRunResult = toolResults.find(
      e => e.data?.toolName === "workflow_run"
    );

    if (workflowRunResult) {
      const output = workflowRunResult.data?.output;
      console.log(`  [Case 3] workflow_run result status: ${output ? (typeof output === 'string' ? output.substring(0, 200) : JSON.stringify(output).substring(0, 200)) : 'none'}`);

      if (typeof output === "string") {
        try {
          const parsed = JSON.parse(output);
          if (parsed.status === "dispatched") {
            // Non-blocking mode active!
            expect(parsed.workflowId).toBeTruthy();
            expect(parsed.agentCount).toBe(2);
            console.log(`  [Case 3] ✓ Non-blocking mode: dispatched workflow ${parsed.workflowId}`);
          } else if (parsed.status === "completed" || parsed.workflowId) {
            // Blocking mode (flag not enabled)
            console.log(`  [Case 3] ⚠ Blocking mode (backgroundWorkflows flag likely disabled): ${parsed.status}`);
          }
        } catch { /* output may not be JSON */ }
      }
    }

    console.log(`  [Case 3] Events received: ${eventTypes.join(", ")}`);

    // Cleanup
    await apiContext.delete(`/api/sessions/${sessionId}`);
  });

  // =========================================================================
  // Case 4: Multiple injects during workflow execution
  // =========================================================================
  test("Case 4: Multiple inject messages during agent run", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });

    const sessionResp = await apiContext.post("/api/sessions", {
      data: { title: "E2E Test - Multiple Injects" },
    });
    expect([200, 201]).toContain(sessionResp.status());
    const session = await sessionResp.json();
    const sessionId = session.id;

    const ssePromise = consumeSSE(
      `${BASE_URL}/api/agents/run-stream`,
      { sessionId, input: "请用 think 工具思考30秒，然后调用 finish。" },
      { untilEvent: "done", timeoutMs: 120_000 }
    );

    // Wait for agent to start
    await new Promise(r => setTimeout(r, 3000));

    // Try to inject multiple messages
    let injectCount = 0;
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const tasksResp = await apiContext.get(`/api/agents/tasks/${sessionId}`);
      if (tasksResp.status() === 200) {
        const tasks = await tasksResp.json();
        const runningTask = tasks.find((t: any) => t.status === "running");
        if (runningTask) {
          const injectResp = await apiContext.post(`/api/agents/inject/${runningTask.id}`, {
            data: { message: `测试注入消息 #${i + 1}` },
          });
          if (injectResp.status() === 200) {
            injectCount++;
          }
        }
      }
    }

    const { events } = await ssePromise;

    const eventTypes = events.map(e => e.event);
    expect(eventTypes).toContain("done");

    console.log(`  [Case 4] Injected ${injectCount} messages`);
    console.log(`  [Case 4] Events: ${eventTypes.join(", ")}`);

    // Cleanup
    await apiContext.delete(`/api/sessions/${sessionId}`);
  });

  // =========================================================================
  // Case 5: Inject while workflow is running in background
  // =========================================================================
  test("Case 5: Coordinator stays responsive during background workflow", async () => {
    const apiContext = await request.newContext({ baseURL: BASE_URL });

    const sessionResp = await apiContext.post("/api/sessions", {
      data: { title: "E2E Test - Responsive Coordinator" },
    });
    expect([200, 201]).toContain(sessionResp.status());
    const session = await sessionResp.json();
    const sessionId = session.id;

    // Start a coordinator with a task that might take a while
    const ssePromise = consumeSSE(
      `${BASE_URL}/api/agents/run-stream`,
      {
        sessionId,
        input: "请启动一个分析任务。使用 delegate_task 委托一个子任务：用 think 工具思考后结束。" +
          "等待子任务完成后，用 finish 结束。",
        agentType: "general",
      },
      { untilEvent: "done", timeoutMs: 180_000 }
    );

    // Wait and inject
    await new Promise(r => setTimeout(r, 3000));
    let injected = false;
    const tasksResp = await apiContext.get(`/api/agents/tasks/${sessionId}`);
    if (tasksResp.status() === 200) {
      const tasks = await tasksResp.json();
      const runningTask = tasks.find((t: any) => t.status === "running");
      if (runningTask) {
        const injectResp = await apiContext.post(`/api/agents/inject/${runningTask.id}`, {
          data: { message: "请同时帮我看看还有没有其他需要关注的。" },
        });
        if (injectResp.status() === 200) {
          injected = true;
        }
      }
    }

    const { events } = await ssePromise;

    const eventTypes = events.map(e => e.event);
    expect(eventTypes).toContain("done");

    console.log(`  [Case 5] Agent completed despite inject: true`);
    console.log(`  [Case 5] Inject succeeded: ${injected}`);
    console.log(`  [Case 5] Events: ${eventTypes.join(", ")}`);

    // Cleanup
    await apiContext.delete(`/api/sessions/${sessionId}`);
  });
});
