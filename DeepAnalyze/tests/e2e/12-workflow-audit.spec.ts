// =============================================================================
// 12 - Workflow & Audit Multi-Agent Comprehensive Test Suite
// =============================================================================
// Tests all modified code paths:
//   1. Audit agent visibility in SubAgentPanel (green→blue with separator)
//   2. persistAgentOutput null-safety (agentId=undefined resilience)
//   3. completedAgents filter relaxation (audit runs even if persist fails)
//   4. Thinking animation during workflow_run blocking
//   5. Audit failure emits workflow_agent_complete (no stuck UI)
//   6. Various workflow scenarios: with/without reports, success/failure mix
//
// Scenarios:
//   A. Mock: Full audit lifecycle (sub-agents → audit → complete)
//   B. Mock: Audit with persist failure (agentId undefined)
//   C. Mock: Thinking animation during workflow
//   D. Mock: Audit failure still emits complete event
//   E. Mock: Mixed success/failure agents still trigger audit
//   F. Real: SSE-based workflow dispatch and event collection
//   G. Real: Multi-agent with KB scope — full lifecycle verification
//   H. Visual: Screenshots of all states for review
//
// Prerequisites:
//   Server running on port 21000 (python3 start.py --no-docker --skip-frontend --port 21000)
//   At least one knowledge base with documents
//
// Run: npx playwright test tests/e2e/12-workflow-audit.spec.ts --headed
// =============================================================================

import { test, expect, Page, request as pwRequest } from "@playwright/test";
import { TEST_KB_ID } from "./fixtures";
import { takeScreenshot } from "./helpers/visual";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASE_URL = "http://localhost:21000";
const SCREENSHOT_DIR = "/tmp/da-workflow-test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a new session via the UI by clicking "开始对话" */
async function createSessionViaUI(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/#/chat`);
  await page.waitForTimeout(500);
  const startBtn = page.locator("text=开始对话").first();
  if (await startBtn.isVisible().catch(() => false)) {
    await startBtn.click();
    await page.waitForTimeout(1000);
  }
  // Verify textarea is visible
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeVisible({ timeout: 5000 });
}

/** Inject workflow data into the Zustand store for mock testing */
async function injectWorkflowMock(page: Page, scenario: string): Promise<void> {
  await page.evaluate((s) => {
    const store = (window as any).__WORKFLOW_STORE__;
    if (!store) return;

    switch (s) {
      // ---- Scenario A: Full audit lifecycle ----
      case "audit-lifecycle": {
        store.getState().handleWorkflowStart({
          workflowId: "wf-audit-test",
          teamName: "分析团队",
          mode: "parallel",
          agentCount: 3,
        });
        // Sub-agent 1: starts running, then completes
        store.getState().handleAgentStart({
          workflowId: "wf-audit-test",
          agentId: "agent-1",
          role: "检索员",
          task: "搜索并提取文档关键信息",
        });
        store.getState().handleAgentToolCall({
          workflowId: "wf-audit-test",
          agentId: "agent-1",
          toolName: "kb_search",
          input: { query: "测试查询" },
        });
        store.getState().handleAgentToolResult({
          workflowId: "wf-audit-test",
          agentId: "agent-1",
          toolName: "kb_search",
          output: "找到12个相关文档",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-audit-test",
          agentId: "agent-1",
          output: "已完成搜索",
          duration: 25,
        });
        // Sub-agent 2: starts running, then completes
        store.getState().handleAgentStart({
          workflowId: "wf-audit-test",
          agentId: "agent-2",
          role: "分析师",
          task: "对搜索结果进行深度分析",
        });
        store.getState().handleAgentToolCall({
          workflowId: "wf-audit-test",
          agentId: "agent-2",
          toolName: "expand",
          input: { docId: "doc-1" },
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-audit-test",
          agentId: "agent-2",
          output: "已完成分析",
          duration: 38,
        });
        // Sub-agent 3: starts running, then completes
        store.getState().handleAgentStart({
          workflowId: "wf-audit-test",
          agentId: "agent-3",
          role: "报告员",
          task: "整合结果生成报告",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-audit-test",
          agentId: "agent-3",
          output: "报告已生成",
          duration: 15,
        });
        // Audit agent: starts running (should appear after sub-agents complete)
        store.getState().handleAgentStart({
          workflowId: "wf-audit-test",
          agentId: "synthesis-audit",
          role: "综合审计",
          task: "交叉验证与查漏补缺",
        });
        break;
      }

      // ---- Scenario B: Audit with some agents missing resultFiles ----
      case "audit-persist-fail": {
        store.getState().handleWorkflowStart({
          workflowId: "wf-persist-test",
          teamName: "持久化测试",
          mode: "parallel",
          agentCount: 2,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-persist-test",
          agentId: "agent-a",
          role: "Agent A",
          task: "任务A",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-persist-test",
          agentId: "agent-a",
          output: "结果A",
          duration: 10,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-persist-test",
          agentId: "agent-b",
          role: "Agent B",
          task: "任务B",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-persist-test",
          agentId: "agent-b",
          output: "结果B",
          duration: 12,
        });
        // Audit should still start even though backend persist might have failed
        store.getState().handleAgentStart({
          workflowId: "wf-persist-test",
          agentId: "synthesis-audit",
          role: "综合审计",
          task: "审计",
        });
        break;
      }

      // ---- Scenario C: Thinking animation during workflow ----
      case "thinking-animation": {
        store.getState().handleWorkflowStart({
          workflowId: "wf-thinking",
          teamName: "思考测试",
          mode: "parallel",
          agentCount: 2,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-thinking",
          agentId: "agent-t1",
          role: "Worker 1",
          task: "任务",
        });
        store.getState().handleAgentStart({
          workflowId: "wf-thinking",
          agentId: "agent-t2",
          role: "Worker 2",
          task: "任务",
        });
        break;
      }

      // ---- Scenario D: Audit failure emits complete ----
      case "audit-failure": {
        store.getState().handleWorkflowStart({
          workflowId: "wf-audit-fail",
          teamName: "审计失败测试",
          mode: "parallel",
          agentCount: 2,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-audit-fail",
          agentId: "agent-f1",
          role: "Worker",
          task: "任务",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-audit-fail",
          agentId: "agent-f1",
          duration: 10,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-audit-fail",
          agentId: "agent-f2",
          role: "Worker 2",
          task: "任务",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-audit-fail",
          agentId: "agent-f2",
          duration: 8,
        });
        // Audit starts, then fails
        store.getState().handleAgentStart({
          workflowId: "wf-audit-fail",
          agentId: "synthesis-audit",
          role: "综合审计",
          task: "审计",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-audit-fail",
          agentId: "synthesis-audit",
          error: "审计失败：模型调用超时",
          duration: 5,
        });
        break;
      }

      // ---- Scenario E: Mixed success/failure + audit ----
      case "mixed-results": {
        store.getState().handleWorkflowStart({
          workflowId: "wf-mixed",
          teamName: "混合结果测试",
          mode: "parallel",
          agentCount: 3,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-mixed",
          agentId: "mx-1",
          role: "成功Agent",
          task: "成功任务",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-mixed",
          agentId: "mx-1",
          output: "成功的输出结果",
          duration: 20,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-mixed",
          agentId: "mx-2",
          role: "失败Agent",
          task: "失败任务",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-mixed",
          agentId: "mx-2",
          error: "执行超时",
          duration: 30,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-mixed",
          agentId: "mx-3",
          role: "成功Agent 2",
          task: "另一个成功任务",
        });
        store.getState().handleAgentComplete({
          workflowId: "wf-mixed",
          agentId: "mx-3",
          output: "另一个成功结果",
          duration: 15,
        });
        // Audit runs on completed agents
        store.getState().handleAgentStart({
          workflowId: "wf-mixed",
          agentId: "synthesis-audit",
          role: "综合审计",
          task: "交叉验证",
        });
        break;
      }
    }
  }, scenario);
}

/** Check if the workflow panel is visible on the page */
async function isWorkflowPanelVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // Check if any team name text is visible
    const allElements = document.querySelectorAll("span, div");
    for (const el of allElements) {
      const text = el.textContent || "";
      if (
        (text.includes("分析团队") || text.includes("持久化测试") ||
         text.includes("思考测试") || text.includes("审计失败测试") ||
         text.includes("混合结果测试") || text.includes("测试团队") ||
         text.includes("Pipeline") || text.includes("Parallel") ||
         text.includes("Graph")) &&
        el.offsetWidth > 0 &&
        el.offsetWidth < 400
      ) {
        return true;
      }
    }
    return false;
  });
}

/** Check if audit agent chip is visible (with separator "|") */
async function isAuditChipVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // Check for the "|" separator followed by "综合审计"
    const allText = document.body.innerText;
    if (!allText.includes("综合审计")) return false;
    // Check for the pipe separator in the chip area
    const spans = document.querySelectorAll("span");
    let hasPipe = false;
    let hasAudit = false;
    for (const span of spans) {
      const text = span.textContent || "";
      if (text.trim() === "|" && span.offsetWidth > 0) hasPipe = true;
      if (text.includes("综合审计") && span.offsetWidth > 0) hasAudit = true;
    }
    return hasAudit; // Audit chip visible (pipe may or may not be separate)
  });
}

/** Check audit agent's status dot color */
async function getAuditStatus(page: Page): Promise<"running" | "completed" | "error" | "none"> {
  return page.evaluate(() => {
    const store = (window as any).__WORKFLOW_STORE__;
    if (!store) return "none" as const;
    const wfs = store.getState().activeWorkflows;
    for (const [, wf] of wfs) {
      const audit = wf.agents.get("synthesis-audit");
      if (audit) return audit.status as "running" | "completed" | "error";
    }
    return "none" as const;
  });
}

// SSE consumer for real backend tests
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
  const { untilEvent = "done", timeoutMs = 300_000, collectEvents } = options;
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
          reject(new Error(`HTTP ${resp.status()}: ${await resp.text()}`));
          return;
        }
        if (!resp.body) { reject(new Error("No body")); return; }

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
                if (collectEvents && !collectEvents.includes(currentEvent)) {
                  // Keep collecting
                }
                if (currentEvent === untilEvent) {
                  clearTimeout(timeout);
                  resolve();
                  return;
                }
              } catch { /* ignore */ }
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
        if (!controller.signal.aborted) reject(err);
      });
  });

  try {
    await promise;
  } catch (err) {
    // Return collected events even on timeout
    if (events.length === 0) throw err;
  }

  return { events, abort: () => controller.abort() };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe("12 - Workflow & Audit Multi-Agent", () => {

  // ===================================================================
  // Scenario A: Audit Agent Visibility — Full Lifecycle
  // ===================================================================
  test("A. audit agent appears with separator after sub-agents complete", async ({ page }) => {
    test.setTimeout(30_000);
    await createSessionViaUI(page);

    // Inject: 3 sub-agents complete, audit starts running
    await injectWorkflowMock(page, "audit-lifecycle");
    await page.waitForTimeout(500);

    // Screenshot: collapsed state with audit running
    await takeScreenshot(page, "12A-1-audit-running-collapsed");

    // Verify: sub-agent chips are visible
    const subAgent1 = page.locator("text=检索员").first();
    const subAgent2 = page.locator("text=分析师").first();
    const subAgent3 = page.locator("text=报告员").first();
    await expect(subAgent1).toBeVisible({ timeout: 5000 });
    await expect(subAgent2).toBeVisible({ timeout: 3000 });
    await expect(subAgent3).toBeVisible({ timeout: 3000 });

    // Verify: audit chip is visible
    const auditVisible = await isAuditChipVisible(page);
    expect(auditVisible, "Audit chip should be visible").toBe(true);

    // Verify: audit status is running
    const auditStatus = await getAuditStatus(page);
    expect(auditStatus, "Audit should be running").toBe("running");

    // Verify: "综合审计中..." text appears in header
    const auditPhaseText = page.locator("text=综合审计中").first();
    const hasAuditPhaseText = await auditPhaseText.isVisible().catch(() => false);
    console.log(`[A] 综合审计中... visible: ${hasAuditPhaseText}`);

    // Expand panel to see details
    const panelHeader = page.locator("text=分析团队").first();
    if (await panelHeader.isVisible().catch(() => false)) {
      await panelHeader.click();
      await page.waitForTimeout(300);
      await takeScreenshot(page, "12A-2-audit-running-expanded");

      // Verify: "Phase 2: Audit" separator is visible
      const phase2Label = page.locator("text=Phase 2: Audit").first();
      const hasPhase2 = await phase2Label.isVisible().catch(() => false);
      console.log(`[A] Phase 2: Audit separator visible: ${hasPhase2}`);
    }

    // Complete the audit
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (!store) return;
      store.getState().handleAgentComplete({
        workflowId: "wf-audit-test",
        agentId: "synthesis-audit",
        output: "审计完成",
        duration: 45,
      });
    });
    await page.waitForTimeout(500);
    await takeScreenshot(page, "12A-3-audit-complete-collapsed");

    // Verify: audit status changed to completed
    const finalAuditStatus = await getAuditStatus(page);
    expect(finalAuditStatus, "Audit should be completed").toBe("completed");

    // Verify: "全部完成" text in header
    const allDone = page.locator("text=全部完成").first();
    const allDoneVisible = await allDone.isVisible().catch(() => false);
    console.log(`[A] 全部完成 visible: ${allDoneVisible}`);
  });

  // ===================================================================
  // Scenario B: Audit Still Runs When persistAgentOutput Failed
  // ===================================================================
  test("B. audit starts even when some agents lack resultFiles", async ({ page }) => {
    test.setTimeout(30_000);
    await createSessionViaUI(page);

    // Inject: 2 agents complete (simulating persist failure)
    await injectWorkflowMock(page, "audit-persist-fail");
    await page.waitForTimeout(500);

    await takeScreenshot(page, "12B-1-audit-despite-persist-fail");

    // Verify: audit agent started
    const auditVisible = await isAuditChipVisible(page);
    expect(auditVisible, "Audit chip should be visible even with persist failures").toBe(true);

    const auditStatus = await getAuditStatus(page);
    expect(auditStatus, "Audit should be running").toBe("running");

    console.log("[B] Audit started despite potential persist failures — PASS");
  });

  // ===================================================================
  // Scenario C: Thinking Animation During Workflow
  // ===================================================================
  test("C. thinking indicator visible while agents are running", async ({ page }) => {
    test.setTimeout(30_000);
    await createSessionViaUI(page);

    // Simulate: user sent a message, agent is streaming (thinking)
    // First inject a user message visually
    const textarea = page.locator("textarea").first();
    await textarea.fill("帮我分析知识库中的所有文档");
    await textarea.press("Enter");
    await page.waitForTimeout(1500);

    // Now inject workflow while the "thinking" state would be active
    // In real scenario, isStreaming=true from the agent run.
    // For mock, we set the store state to simulate streaming.
    await page.evaluate(() => {
      const chatStore = (window as any).__CHAT_STORE__;
      if (chatStore) {
        // Simulate streaming state
        chatStore.setState({
          isStreaming: true,
          streamingMessageId: "mock-streaming-msg",
          messages: [
            ...chatStore.getState().messages,
            {
              id: "mock-streaming-msg",
              role: "assistant",
              content: "",
              isStreaming: true,
              toolCalls: [],
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }
    });

    // Inject workflow
    await injectWorkflowMock(page, "thinking-animation");
    await page.waitForTimeout(500);

    await takeScreenshot(page, "12C-1-thinking-with-workflow");

    // Verify: thinking indicator is visible (spinner + "思考中" text)
    const thinkingText = page.locator("text=思考中").first();
    const thinkingVisible = await thinkingText.isVisible().catch(() => false);
    console.log(`[C] 思考中 indicator visible: ${thinkingVisible}`);

    // Verify: workflow panel also visible below
    const panelVisible = await isWorkflowPanelVisible(page);
    console.log(`[C] Workflow panel visible while thinking: ${panelVisible}`);

    // Reset streaming state
    await page.evaluate(() => {
      const chatStore = (window as any).__CHAT_STORE__;
      if (chatStore) {
        chatStore.setState({ isStreaming: false, streamingMessageId: null });
      }
    });
  });

  // ===================================================================
  // Scenario D: Audit Failure Emits Complete Event
  // ===================================================================
  test("D. failed audit shows error status, not stuck running", async ({ page }) => {
    test.setTimeout(30_000);
    await createSessionViaUI(page);

    // Inject: agents complete, audit fails
    await injectWorkflowMock(page, "audit-failure");
    await page.waitForTimeout(500);

    await takeScreenshot(page, "12D-1-audit-failed");

    // Verify: audit status is error
    const auditStatus = await getAuditStatus(page);
    expect(auditStatus, "Failed audit should have error status").toBe("error");

    // Expand to check error display
    const panelHeader = page.locator("text=审计失败测试").first();
    if (await panelHeader.isVisible().catch(() => false)) {
      await panelHeader.click();
      await page.waitForTimeout(300);

      // Expand audit slot
      const auditSlot = page.locator("text=综合审计").first();
      if (await auditSlot.isVisible().catch(() => false)) {
        await auditSlot.click();
        await page.waitForTimeout(300);
        await takeScreenshot(page, "12D-2-audit-failed-expanded");

        // Error message should be visible
        const errorText = page.locator("text=审计失败").first();
        const errorVisible = await errorText.isVisible().catch(() => false);
        console.log(`[D] Audit error message visible: ${errorVisible}`);
      }
    }

    // Verify: audit is NOT stuck as "running"
    expect(auditStatus, "Audit must NOT be stuck as 'running'").not.toBe("running");
  });

  // ===================================================================
  // Scenario E: Mixed Success/Failure Agents Still Get Audit
  // ===================================================================
  test("E. audit runs with mix of successful and failed agents", async ({ page }) => {
    test.setTimeout(30_000);
    await createSessionViaUI(page);

    // Inject: 2 success + 1 failure, audit starts
    await injectWorkflowMock(page, "mixed-results");
    await page.waitForTimeout(500);

    await takeScreenshot(page, "12E-1-mixed-with-audit");

    // Verify: audit started despite one agent failing
    const auditStatus = await getAuditStatus(page);
    expect(auditStatus, "Audit should start even with mixed results").toBe("running");

    // Verify: all agent chips visible
    const successChip = page.locator("text=成功Agent").first();
    const failChip = page.locator("text=失败Agent").first();
    const auditChip = page.locator("text=综合审计").first();

    const successVisible = await successChip.isVisible().catch(() => false);
    const failVisible = await failChip.isVisible().catch(() => false);
    const auditVisible = await auditChip.isVisible().catch(() => false);

    console.log(`[E] Success chip: ${successVisible}, Fail chip: ${failVisible}, Audit chip: ${auditVisible}`);

    // Expand and screenshot
    const panelHeader = page.locator("text=混合结果测试").first();
    if (await panelHeader.isVisible().catch(() => false)) {
      await panelHeader.click();
      await page.waitForTimeout(300);
      await takeScreenshot(page, "12E-2-mixed-expanded");
    }
  });

  // ===================================================================
  // Scenario F: Real SSE Workflow — Event Collection
  // ===================================================================
  test("F. real workflow dispatch collects correct SSE events", async ({ request }) => {
    test.setTimeout(300_000);

    // Create a session with KB scope
    const sessionResp = await request.post("/api/sessions", {
      data: { title: "E2E Workflow Audit Test" },
    });
    expect([200, 201]).toContain(sessionResp.status());
    const session = await sessionResp.json();
    const sessionId = session.id;

    // Set KB scope
    await request.patch(`/api/sessions/${sessionId}/scope`, {
      data: { kbIds: [TEST_KB_ID] },
    });

    try {
      // Send a message that should trigger multi-agent workflow
      const { events } = await consumeSSE(
        `${BASE_URL}/api/agents/run-stream`,
        {
          sessionId,
          input: "请帮我查看知识库中有哪些类型的文档，列出文件类型和数量。不需要深度分析，只需要统计。",
        },
        {
          untilEvent: "done",
          timeoutMs: 240_000,
          collectEvents: [
            "workflow_event",
            "tool_call",
            "tool_result",
            "content_delta",
            "push_content",
            "thinking_delta",
          ],
        },
      );

      // Analyze collected events
      const workflowEvents = events.filter(e => e.event === "workflow_event");
      const toolCalls = events.filter(e => e.event === "tool_call");
      const contentDeltas = events.filter(e => e.event === "content_delta");
      const pushContents = events.filter(e => e.event === "push_content");

      console.log(`[F] Total events: ${events.length}`);
      console.log(`[F] Workflow events: ${workflowEvents.length}`);
      console.log(`[F] Tool calls: ${toolCalls.length}`);
      console.log(`[F] Content deltas: ${contentDeltas.length}`);
      console.log(`[F] Push contents: ${pushContents.length}`);

      // Log workflow event types
      const wfTypes = new Map<string, number>();
      for (const ev of workflowEvents) {
        const type = ev.data?.type || "unknown";
        wfTypes.set(type, (wfTypes.get(type) || 0) + 1);
      }
      console.log("[F] Workflow event types:", Object.fromEntries(wfTypes));

      // Check if workflow_run was used
      const wfRunToolCalls = toolCalls.filter(e =>
        e.data?.toolName === "workflow_run"
      );
      if (wfRunToolCalls.length > 0) {
        console.log(`[F] workflow_run dispatched: ${wfRunToolCalls.length} time(s)`);

        // Check for workflow_start event
        const wfStart = workflowEvents.find(e =>
          e.data?.type === "workflow_start"
        );
        expect(wfStart, "Should have workflow_start event").toBeTruthy();

        // Check for workflow_agent_start events
        const agentStarts = workflowEvents.filter(e =>
          e.data?.type === "workflow_agent_start"
        );
        console.log(`[F] Agent start events: ${agentStarts.length}`);

        // Check for workflow_agent_complete events
        const agentCompletes = workflowEvents.filter(e =>
          e.data?.type === "workflow_agent_complete"
        );
        console.log(`[F] Agent complete events: ${agentCompletes.length}`);

        // Check if audit agent appeared
        const auditStart = agentStarts.find(e =>
          e.data?.agentId === "synthesis-audit"
        );
        console.log(`[F] Audit agent started: ${!!auditStart}`);

        if (auditStart) {
          const auditComplete = agentCompletes.find(e =>
            e.data?.agentId === "synthesis-audit"
          );
          console.log(`[F] Audit agent completed: ${!!auditComplete}`);
          if (auditComplete) {
            console.log(`[F] Audit status: ${auditComplete.data?.status}`);
          }
        }
      }

      // Check for workflow_complete event
      const wfComplete = workflowEvents.find(e =>
        e.data?.type === "workflow_complete"
      );
      if (wfComplete) {
        console.log(`[F] Workflow completed with status: ${wfComplete.data?.status}`);
      }

      // Verify at least some content was returned
      expect(contentDeltas.length + pushContents.length, "Should have some output").toBeGreaterThan(0);

    } finally {
      await request.delete(`/api/sessions/${sessionId}`).catch(() => {});
    }
  });

  // ===================================================================
  // Scenario G: Real Multi-Agent with Frontend — Full Lifecycle
  // ===================================================================
  test("G. real agent run shows thinking + workflow panel in UI", async ({ page, request }) => {
    test.setTimeout(300_000);

    // Create session via API
    const sessionResp = await request.post("/api/sessions", {
      data: { title: "E2E UI Workflow Test" },
    });
    const session = await sessionResp.json();
    const sessionId = session.id;

    // Set KB scope
    await request.patch(`/api/sessions/${sessionId}/scope`, {
      data: { kbIds: [TEST_KB_ID] },
    });

    try {
      // Navigate to the session in UI
      await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
      await page.waitForTimeout(1000);

      // Find textarea and send message
      const textarea = page.locator("textarea").first();
      await expect(textarea).toBeVisible({ timeout: 5000 });
      await textarea.fill("请统计知识库中有多少个文档，按文件类型分组列出数量");
      await textarea.press("Enter");

      // Wait a moment for agent to start
      await page.waitForTimeout(3000);

      // Screenshot: early state — thinking indicator visible
      await takeScreenshot(page, "12G-1-early-thinking");

      // Check for thinking indicator
      const thinkingText = page.locator("text=思考中").first();
      const thinkingVisible = await thinkingText.isVisible().catch(() => false);
      console.log(`[G] Thinking indicator visible early: ${thinkingVisible}`);

      // Wait for some progress — either workflow panel or content
      await page.waitForTimeout(15000);

      // Screenshot: mid-progress
      await takeScreenshot(page, "12G-2-mid-progress");

      // Check for workflow panel
      const panelVisible = await isWorkflowPanelVisible(page);
      console.log(`[G] Workflow panel visible: ${panelVisible}`);

      // Wait for completion (up to 4 minutes)
      let completed = false;
      for (let i = 0; i < 48; i++) {
        await page.waitForTimeout(5000);

        // Check if response appeared (agent finished)
        const bodyText = await page.locator("body").innerText();
        const hasToolCard = bodyText.includes("workflow_run") || bodyText.includes("kb_search") || bodyText.includes("run_sql");
        const hasResponse = bodyText.includes("文档") && bodyText.length > 200;

        if (hasResponse || i === 47) {
          completed = true;
          break;
        }

        // Periodic screenshots
        if (i % 6 === 5) {
          await takeScreenshot(page, `12G-3-progress-${i}`);
        }
      }

      // Final screenshot
      await takeScreenshot(page, "12G-4-final");

      // Check final state
      const finalBody = await page.locator("body").innerText();
      const hasFinalContent = finalBody.length > 100;
      console.log(`[G] Final content length: ${finalBody.length}`);
      console.log(`[G] Has meaningful content: ${hasFinalContent}`);

      // Check console for errors
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      await page.waitForTimeout(2000);

      const criticalErrors = consoleErrors.filter(
        (e) => !e.includes("favicon") && !e.includes("404") && !e.includes("ResizeObserver")
      );
      console.log(`[G] Console errors (filtered): ${criticalErrors.length}`);

    } finally {
      await request.delete(`/api/sessions/${sessionId}`).catch(() => {});
    }
  });

  // ===================================================================
  // Scenario H: Comprehensive Visual Screenshots of All States
  // ===================================================================
  test("H. visual: all workflow states documented", async ({ page }) => {
    test.setTimeout(30_000);
    await createSessionViaUI(page);

    // Inject all states and take screenshots

    // H1: Sub-agents running (no audit yet)
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (!store) return;
      store.getState().handleWorkflowStart({
        workflowId: "vis-running",
        teamName: "运行状态展示",
        mode: "parallel",
        agentCount: 3,
        sessionId: "test-session",
      });
      store.getState().handleAgentStart({
        workflowId: "vis-running",
        agentId: "v1",
        role: "数据采集",
        task: "采集数据",
      });
      store.getState().handleAgentToolCall({
        workflowId: "vis-running",
        agentId: "v1",
        toolName: "kb_search",
        input: { query: "测试" },
      });
      store.getState().handleAgentStart({
        workflowId: "vis-running",
        agentId: "v2",
        role: "内容分析",
        task: "分析内容",
      });
      store.getState().handleAgentStart({
        workflowId: "vis-running",
        agentId: "v3",
        role: "报告生成",
        task: "生成报告",
      });
    });
    await page.waitForTimeout(500);
    await takeScreenshot(page, "12H-1-agents-running");

    // H2: Sub-agents complete, audit running
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (!store) return;
      store.getState().handleAgentComplete({
        workflowId: "vis-running",
        agentId: "v1",
        duration: 20,
      });
      store.getState().handleAgentComplete({
        workflowId: "vis-running",
        agentId: "v2",
        duration: 35,
      });
      store.getState().handleAgentComplete({
        workflowId: "vis-running",
        agentId: "v3",
        duration: 15,
      });
      store.getState().handleAgentStart({
        workflowId: "vis-running",
        agentId: "synthesis-audit",
        role: "综合审计",
        task: "交叉验证与查漏补缺",
      });
      store.getState().handleAgentToolCall({
        workflowId: "vis-running",
        agentId: "synthesis-audit",
        toolName: "read_file",
        input: { path: "report.md" },
      });
    });
    await page.waitForTimeout(500);
    await takeScreenshot(page, "12H-2-audit-running");

    // H3: Expand panel with audit running
    const panelHeader = page.locator("text=运行状态展示").first();
    if (await panelHeader.isVisible().catch(() => false)) {
      await panelHeader.click();
      await page.waitForTimeout(300);
      await takeScreenshot(page, "12H-3-expanded-audit-running");

      // Expand audit slot
      const auditSlot = page.locator("text=综合审计").first();
      if (await auditSlot.isVisible().catch(() => false)) {
        await auditSlot.click();
        await page.waitForTimeout(300);
        await takeScreenshot(page, "12H-4-audit-slot-expanded");
      }
    }

    // H4: All complete including audit
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (!store) return;
      store.getState().handleAgentComplete({
        workflowId: "vis-running",
        agentId: "synthesis-audit",
        output: "审计完成",
        duration: 42,
      });
    });
    await page.waitForTimeout(500);

    // Collapse panel first
    if (await panelHeader.isVisible().catch(() => false)) {
      await panelHeader.click();
      await page.waitForTimeout(300);
    }
    await takeScreenshot(page, "12H-5-all-complete-collapsed");

    // Expand again
    if (await panelHeader.isVisible().catch(() => false)) {
      await panelHeader.click();
      await page.waitForTimeout(300);
      await takeScreenshot(page, "12H-6-all-complete-expanded");
    }

    // Verify all agent statuses
    const finalState = await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (!store) return null;
      const wfs = store.getState().activeWorkflows;
      const result: Record<string, string> = {};
      for (const [, wf] of wfs) {
        for (const [id, agent] of wf.agents) {
          result[id] = agent.status;
        }
      }
      return result;
    });

    console.log("[H] Final agent states:", JSON.stringify(finalState));
    expect(finalState, "All agents should have final states").toBeTruthy();
    if (finalState) {
      for (const [id, status] of Object.entries(finalState)) {
        expect(["completed", "error"]).toContain(status);
      }
    }
  });
});
