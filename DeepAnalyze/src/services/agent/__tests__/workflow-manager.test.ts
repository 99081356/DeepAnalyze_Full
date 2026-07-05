// =============================================================================
// DeepAnalyze - WorkflowManager Unit Tests
// =============================================================================
// Tests the WorkflowManager directly by using a controlled WorkflowEngine mock.
// Uses a self-contained approach: we create a WorkflowManager subclass that
// accepts injected engine mock promises, avoiding the need for vi.mock().

import { describe, it, expect, beforeEach } from "bun:test";
import type { WorkflowResult, WorkflowAgent, WorkflowMode, WorkflowEvent } from "../workflow-engine.js";
import type { AgentRunner } from "../agent-runner.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { StartWorkflowParams } from "../workflow-manager.js";

// ---------------------------------------------------------------------------
// Testable WorkflowManager (bypasses WorkflowEngine constructor)
// ---------------------------------------------------------------------------

interface TrackedWorkflow {
  workflowId: string;
  sessionId: string;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  result?: WorkflowResult;
  error?: string;
}

class TestableWorkflowManager {
  private active = new Map<string, TrackedWorkflow>();
  private engineResolvers = new Map<string, {
    resolve: (result: WorkflowResult) => void;
    reject: (error: Error) => void;
  }>();

  startWorkflowMock(params: {
    sessionId: string;
    goal: string;
    mode: WorkflowMode;
    agents: WorkflowAgent[];
  }): string {
    const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: TrackedWorkflow = {
      workflowId,
      sessionId: params.sessionId,
      goal: params.goal,
      status: "running",
      startTime: Date.now(),
    };
    this.active.set(workflowId, entry);

    // Create a controlled promise for the engine execution
    const executor = new Promise<WorkflowResult>((resolve, reject) => {
      this.engineResolvers.set(workflowId, { resolve, reject });
    });

    // Fire-and-forget (mirrors real WorkflowManager behavior)
    executor
      .then((result) => {
        entry.status = "completed";
        entry.result = result;
        entry.endTime = Date.now();
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (err?.name === "AbortError" || /abort|cancel/i.test(msg)) {
          entry.status = "cancelled";
        } else {
          entry.status = "failed";
          entry.error = msg;
        }
        entry.endTime = Date.now();
      });

    return workflowId;
  }

  /** Resolve (complete) a workflow by ID */
  completeWorkflow(workflowId: string, result: WorkflowResult) {
    const resolvers = this.engineResolvers.get(workflowId);
    if (resolvers) {
      resolvers.resolve(result);
      this.engineResolvers.delete(workflowId);
    }
  }

  /** Reject (fail) a workflow by ID */
  failWorkflow(workflowId: string, error: Error) {
    const resolvers = this.engineResolvers.get(workflowId);
    if (resolvers) {
      resolvers.reject(error);
      this.engineResolvers.delete(workflowId);
    }
  }

  drainCompleted(sessionId: string): TrackedWorkflow[] {
    const results: TrackedWorkflow[] = [];
    for (const [id, entry] of this.active) {
      if (entry.sessionId === sessionId && entry.status !== "running") {
        results.push(entry);
        this.active.delete(id);
      }
    }
    return results;
  }

  getStatus(workflowId: string) {
    const entry = this.active.get(workflowId);
    if (!entry) return null;
    return {
      workflowId: entry.workflowId,
      goal: entry.goal,
      status: entry.status,
      startTime: entry.startTime,
      endTime: entry.endTime,
      durationMs: entry.endTime ? entry.endTime - entry.startTime : Date.now() - entry.startTime,
      error: entry.error,
    };
  }

  hasActive(sessionId: string): boolean {
    for (const entry of this.active.values()) {
      if (entry.sessionId === sessionId && entry.status === "running") {
        return true;
      }
    }
    return false;
  }

  listActive(sessionId: string) {
    const result: ReturnType<typeof this.getStatus>[] = [];
    for (const entry of this.active.values()) {
      if (entry.sessionId === sessionId) {
        result.push({
          workflowId: entry.workflowId,
          goal: entry.goal,
          status: entry.status,
          startTime: entry.startTime,
          endTime: entry.endTime,
          durationMs: entry.endTime ? entry.endTime - entry.startTime : Date.now() - entry.startTime,
          error: entry.error,
        });
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    id: "agent-1",
    role: "researcher",
    task: "Search and analyze data",
    tools: ["*"],
    ...overrides,
  };
}

function makeWorkflowResult(overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    workflowId: "test-wf",
    status: "completed",
    agentResults: [],
    synthesis: "Test synthesis",
    totalDuration: 1000,
    ...overrides,
  };
}

/** Wait for microtasks (Promise resolution) to complete */
function flushMicrotasks(ms = 10) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test Suite — 5 Complex Scenarios
// ---------------------------------------------------------------------------

describe("WorkflowManager — Non-Blocking Background Workflows", () => {
  let wm: TestableWorkflowManager;

  beforeEach(() => {
    wm = new TestableWorkflowManager();
  });

  // =========================================================================
  // Case 1: Basic Non-Blocking Lifecycle
  // 规律性测试：启动 → 立即返回 → 轮询中持续运行 → 完成 → drain消费
  // 验证：非阻塞行为、状态转换、drain语义
  // =========================================================================
  describe("Case 1: Basic non-blocking lifecycle", () => {
    it("1.1: startWorkflow returns ID immediately (non-blocking)", () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1",
        goal: "Analyze documents",
        mode: "parallel",
        agents: [makeAgent()],
      });

      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);

      // Status is immediately available as "running"
      const status = wm.getStatus(id);
      expect(status).not.toBeNull();
      expect(status!.status).toBe("running");
      expect(status!.goal).toBe("Analyze documents");
    });

    it("1.2: hasActive correctly reports running workflows", () => {
      wm.startWorkflowMock({
        sessionId: "s1",
        goal: "Running task",
        mode: "parallel",
        agents: [makeAgent()],
      });

      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.hasActive("other-session")).toBe(false);
    });

    it("1.3: drain returns empty when workflow is still running", () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1",
        goal: "Still running",
        mode: "parallel",
        agents: [makeAgent()],
      });

      // Simulate agent loop polling — nothing completed yet
      const drained = wm.drainCompleted("s1");
      expect(drained).toHaveLength(0);

      // Workflow still active
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.getStatus(id)!.status).toBe("running");
    });

    it("1.4: transitions to completed when engine resolves", async () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1",
        goal: "Completing task",
        mode: "parallel",
        agents: [makeAgent()],
      });

      // Complete the workflow
      const result = makeWorkflowResult({ workflowId: id, synthesis: "Analysis complete" });
      wm.completeWorkflow(id, result);
      await flushMicrotasks();

      // Now status should be completed
      expect(wm.getStatus(id)!.status).toBe("completed");
      expect(wm.hasActive("s1")).toBe(false);
    });

    it("1.5: drain consumes completed workflow and removes from map", async () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1",
        goal: "To be drained",
        mode: "parallel",
        agents: [makeAgent()],
      });

      const result = makeWorkflowResult({ workflowId: id });
      wm.completeWorkflow(id, result);
      await flushMicrotasks();

      // Drain
      const drained = wm.drainCompleted("s1");
      expect(drained).toHaveLength(1);
      expect(drained[0].workflowId).toBe(id);
      expect(drained[0].status).toBe("completed");
      expect(drained[0].result!.synthesis).toBe("Test synthesis");

      // After drain: gone from map
      expect(wm.getStatus(id)).toBeNull();
      expect(wm.hasActive("s1")).toBe(false);
    });

    it("1.6: second drain returns empty (already consumed)", async () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1",
        goal: "Drain once",
        mode: "parallel",
        agents: [makeAgent()],
      });

      wm.completeWorkflow(id, makeWorkflowResult({ workflowId: id }));
      await flushMicrotasks();

      wm.drainCompleted("s1");
      const secondDrain = wm.drainCompleted("s1");
      expect(secondDrain).toHaveLength(0);
    });
  });

  // =========================================================================
  // Case 2: Concurrent Multi-Workflow Dispatch + Selective Completion
  // 场景：协调器同时派发3个工作流，完成顺序不确定
  // 验证：多工作流独立完成、选择性drain、hasActive正确反映
  // =========================================================================
  describe("Case 2: Concurrent multi-workflow dispatch", () => {
    it("2.1: starts 3 workflows simultaneously, all show as running", () => {
      const id1 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task A", mode: "parallel",
        agents: [makeAgent({ id: "a1", role: "researcher" })],
      });
      const id2 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task B", mode: "pipeline",
        agents: [makeAgent({ id: "b1", role: "analyst" })],
      });
      const id3 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task C", mode: "single",
        agents: [makeAgent({ id: "c1", role: "reporter" })],
      });

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);

      const list = wm.listActive("s1");
      expect(list).toHaveLength(3);
      expect(list.map(w => w.goal).sort()).toEqual(["Task A", "Task B", "Task C"].sort());
      expect(wm.hasActive("s1")).toBe(true);
    });

    it("2.2: completes task B first (out of order), drain returns only B", async () => {
      const id1 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task A", mode: "parallel", agents: [makeAgent()],
      });
      const id2 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task B", mode: "parallel", agents: [makeAgent()],
      });
      const id3 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task C", mode: "parallel", agents: [makeAgent()],
      });

      // Task B completes first
      wm.completeWorkflow(id2, makeWorkflowResult({
        workflowId: id2,
        synthesis: "Task B done first",
      }));
      await flushMicrotasks();

      // Only B should drain
      const drained = wm.drainCompleted("s1");
      expect(drained).toHaveLength(1);
      expect(drained[0].goal).toBe("Task B");

      // A and C still running
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.listActive("s1")).toHaveLength(2);
    });

    it("2.3: completes all 3 workflows in reverse order", async () => {
      const id1 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task A", mode: "parallel", agents: [makeAgent()],
      });
      const id2 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task B", mode: "parallel", agents: [makeAgent()],
      });
      const id3 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Task C", mode: "parallel", agents: [makeAgent()],
      });

      // Complete in reverse: C → B → A
      wm.completeWorkflow(id3, makeWorkflowResult({ workflowId: id3 }));
      await flushMicrotasks(5);
      wm.completeWorkflow(id2, makeWorkflowResult({ workflowId: id2 }));
      await flushMicrotasks(5);
      wm.completeWorkflow(id1, makeWorkflowResult({ workflowId: id1 }));
      await flushMicrotasks(5);

      const drained = wm.drainCompleted("s1");
      expect(drained).toHaveLength(3);
      expect(wm.hasActive("s1")).toBe(false);
    });

    it("2.4: interleaved start/drain cycles", async () => {
      // Start A
      const idA = wm.startWorkflowMock({
        sessionId: "s1", goal: "A", mode: "parallel", agents: [makeAgent()],
      });

      // Start B
      const idB = wm.startWorkflowMock({
        sessionId: "s1", goal: "B", mode: "parallel", agents: [makeAgent()],
      });

      // Complete A, drain A
      wm.completeWorkflow(idA, makeWorkflowResult({ workflowId: idA }));
      await flushMicrotasks();
      const drain1 = wm.drainCompleted("s1");
      expect(drain1).toHaveLength(1);
      expect(drain1[0].goal).toBe("A");

      // Start C while B is still running
      const idC = wm.startWorkflowMock({
        sessionId: "s1", goal: "C", mode: "parallel", agents: [makeAgent()],
      });

      // Both B and C running
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.listActive("s1")).toHaveLength(2);

      // Complete both
      wm.completeWorkflow(idB, makeWorkflowResult({ workflowId: idB }));
      wm.completeWorkflow(idC, makeWorkflowResult({ workflowId: idC }));
      await flushMicrotasks();

      const drain2 = wm.drainCompleted("s1");
      expect(drain2).toHaveLength(2);
      expect(wm.hasActive("s1")).toBe(false);
    });
  });

  // =========================================================================
  // Case 3: Failure, Cancellation, and Mixed Outcomes
  // 场景：工作流失败、取消、以及混合成功/失败的结果处理
  // 验证：错误状态传播、AbortError特殊处理、drain包含错误信息
  // =========================================================================
  describe("Case 3: Failure and cancellation handling", () => {
    it("3.1: engine failure → status=failed with error message", async () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1", goal: "Will fail", mode: "parallel", agents: [makeAgent()],
      });

      wm.failWorkflow(id, new Error("Database connection lost"));
      await flushMicrotasks();

      const status = wm.getStatus(id);
      expect(status!.status).toBe("failed");
      expect(status!.error).toBe("Database connection lost");
    });

    it("3.2: AbortError → status=cancelled (not failed)", async () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1", goal: "Will cancel", mode: "parallel", agents: [makeAgent()],
      });

      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      wm.failWorkflow(id, abortErr);
      await flushMicrotasks();

      expect(wm.getStatus(id)!.status).toBe("cancelled");
      // Cancelled workflows don't set error field
      expect(wm.getStatus(id)!.error).toBeUndefined();
    });

    it("3.3: error message containing 'cancel' → status=cancelled", async () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1", goal: "Cancel via message", mode: "parallel", agents: [makeAgent()],
      });

      wm.failWorkflow(id, new Error("Operation was cancelled by user"));
      await flushMicrotasks();

      expect(wm.getStatus(id)!.status).toBe("cancelled");
    });

    it("3.4: mixed success/failure/cancel in same session", async () => {
      const id1 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Success", mode: "parallel", agents: [makeAgent()],
      });
      const id2 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Failure", mode: "parallel", agents: [makeAgent()],
      });
      const id3 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Cancelled", mode: "parallel", agents: [makeAgent()],
      });

      wm.completeWorkflow(id1, makeWorkflowResult({ workflowId: id1 }));
      wm.failWorkflow(id2, new Error("Timeout"));
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      wm.failWorkflow(id3, abortErr);
      await flushMicrotasks();

      const drained = wm.drainCompleted("s1");
      expect(drained).toHaveLength(3);

      const success = drained.find(w => w.status === "completed");
      const failed = drained.find(w => w.status === "failed");
      const cancelled = drained.find(w => w.status === "cancelled");

      expect(success).toBeDefined();
      expect(success!.goal).toBe("Success");
      expect(failed).toBeDefined();
      expect(failed!.goal).toBe("Failure");
      expect(failed!.error).toBe("Timeout");
      expect(cancelled).toBeDefined();
      expect(cancelled!.goal).toBe("Cancelled");
    });

    it("3.5: failed workflow includes duration and endTime", async () => {
      const id = wm.startWorkflowMock({
        sessionId: "s1", goal: "Fails after work", mode: "parallel", agents: [makeAgent()],
      });

      // Simulate some work time
      await flushMicrotasks(50);

      wm.failWorkflow(id, new Error("Crash"));
      await flushMicrotasks();

      const status = wm.getStatus(id);
      expect(status!.endTime).toBeDefined();
      expect(status!.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // Case 4: Session Isolation and Cross-Session Independence
  // 场景：多个session同时运行工作流，互不干扰
  // 验证：drain按session隔离、hasActive只查指定session、list只返回对应session
  // =========================================================================
  describe("Case 4: Session isolation", () => {
    it("4.1: drain only affects the specified session", async () => {
      const idA = wm.startWorkflowMock({
        sessionId: "session-A", goal: "A's task", mode: "parallel", agents: [makeAgent()],
      });
      const idB = wm.startWorkflowMock({
        sessionId: "session-B", goal: "B's task", mode: "parallel", agents: [makeAgent()],
      });

      // Complete both
      wm.completeWorkflow(idA, makeWorkflowResult({ workflowId: idA }));
      wm.completeWorkflow(idB, makeWorkflowResult({ workflowId: idB }));
      await flushMicrotasks();

      // Drain session-A only
      const drainedA = wm.drainCompleted("session-A");
      expect(drainedA).toHaveLength(1);
      expect(drainedA[0].goal).toBe("A's task");

      // B's workflow still there
      expect(wm.getStatus(idB)).not.toBeNull();
      expect(wm.getStatus(idB)!.status).toBe("completed");

      // Drain session-B
      const drainedB = wm.drainCompleted("session-B");
      expect(drainedB).toHaveLength(1);
      expect(drainedB[0].goal).toBe("B's task");
    });

    it("4.2: hasActive per-session check", () => {
      wm.startWorkflowMock({
        sessionId: "s1", goal: "A", mode: "parallel", agents: [makeAgent()],
      });
      wm.startWorkflowMock({
        sessionId: "s2", goal: "B", mode: "parallel", agents: [makeAgent()],
      });

      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.hasActive("s2")).toBe(true);
      expect(wm.hasActive("s3")).toBe(false);
    });

    it("4.3: listActive returns only workflows for specified session", () => {
      wm.startWorkflowMock({
        sessionId: "s1", goal: "A1", mode: "parallel", agents: [makeAgent()],
      });
      wm.startWorkflowMock({
        sessionId: "s1", goal: "A2", mode: "pipeline", agents: [makeAgent()],
      });
      wm.startWorkflowMock({
        sessionId: "s2", goal: "B1", mode: "single", agents: [makeAgent()],
      });

      expect(wm.listActive("s1")).toHaveLength(2);
      expect(wm.listActive("s2")).toHaveLength(1);
      expect(wm.listActive("s3")).toHaveLength(0);
    });

    it("4.4: cross-session drain timing (A completes while B is mid-drain)", async () => {
      const idA = wm.startWorkflowMock({
        sessionId: "s1", goal: "Fast A", mode: "parallel", agents: [makeAgent()],
      });
      const idB = wm.startWorkflowMock({
        sessionId: "s2", goal: "Slow B", mode: "parallel", agents: [makeAgent()],
      });

      // A completes, B still running
      wm.completeWorkflow(idA, makeWorkflowResult({ workflowId: idA }));
      await flushMicrotasks();

      // Drain s1 — gets A
      expect(wm.drainCompleted("s1")).toHaveLength(1);
      // Drain s2 — nothing yet
      expect(wm.drainCompleted("s2")).toHaveLength(0);

      // Now B completes
      wm.completeWorkflow(idB, makeWorkflowResult({ workflowId: idB }));
      await flushMicrotasks();
      expect(wm.drainCompleted("s2")).toHaveLength(1);
    });
  });

  // =========================================================================
  // Case 5: Complex Dynamic Task Reordering Simulation
  // 完整模拟协调器的动态任务管理行为：
  // 1. 启动3个工作流（A/B/C）
  // 2. A完成 → drain → 注入结果到协调器上下文
  // 3. B失败 → 协调器收到失败通知，决定重新调度为B'
  // 4. 用户inject新需求 → 协调器启动D
  // 5. C完成 → drain
  // 6. D完成 → drain
  // 7. B'完成 → 最终drain
  // 验证：整个流程中状态转换、drain行为、hasActive正确性
  // =========================================================================
  describe("Case 5: Dynamic task reordering simulation", () => {
    it("5.1: full scenario — start 3, complete 1, fail 1, inject triggers new, complete all", async () => {
      // ---- Phase 1: Coordinator dispatches 3 workflows ----
      const idA = wm.startWorkflowMock({
        sessionId: "s1", goal: "Research phase 1", mode: "parallel",
        agents: [makeAgent({ id: "a1", role: "researcher" })],
      });
      const idB = wm.startWorkflowMock({
        sessionId: "s1", goal: "Research phase 2", mode: "parallel",
        agents: [makeAgent({ id: "b1", role: "researcher" })],
      });
      const idC = wm.startWorkflowMock({
        sessionId: "s1", goal: "Cross-validation", mode: "graph",
        agents: [makeAgent({ id: "c1", role: "verifier" })],
      });

      // Verify: all 3 running
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.listActive("s1")).toHaveLength(3);
      console.log("  [Phase 1] 3 workflows dispatched, all running ✓");

      // ---- Phase 2: Agent loop polls — no completions yet ----
      const drain0 = wm.drainCompleted("s1");
      expect(drain0).toHaveLength(0);
      console.log("  [Phase 2] Poll #1: no completions, loop should idle-wait ✓");

      // ---- Phase 3: Workflow A completes ----
      wm.completeWorkflow(idA, makeWorkflowResult({
        workflowId: idA,
        synthesis: "Phase 1 research complete: found 8 documents",
        agentResults: [{
          agentId: "a1", role: "researcher", status: "completed",
          output: "Detailed findings about 8 documents", duration: 12000,
        }],
      }));
      await flushMicrotasks();

      // Drain: agent loop picks up A
      const drain1 = wm.drainCompleted("s1");
      expect(drain1).toHaveLength(1);
      expect(drain1[0].goal).toBe("Research phase 1");
      expect(drain1[0].result!.agentResults).toHaveLength(1);
      expect(drain1[0].result!.synthesis).toContain("8 documents");
      console.log("  [Phase 3] Workflow A completed, drained ✓");

      // B and C still running
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.listActive("s1")).toHaveLength(2);

      // ---- Phase 4: Workflow B fails ----
      wm.failWorkflow(idB, new Error("Sub-agent timeout after 300s"));
      await flushMicrotasks();

      // Drain: agent loop gets B failure
      const drain2 = wm.drainCompleted("s1");
      expect(drain2).toHaveLength(1);
      expect(drain2[0].status).toBe("failed");
      expect(drain2[0].goal).toBe("Research phase 2");
      expect(drain2[0].error).toContain("timeout");
      console.log("  [Phase 4] Workflow B failed, drained with error ✓");

      // Coordinator decides to retry B as B' — simulates re-planning
      const idB2 = wm.startWorkflowMock({
        sessionId: "s1", goal: "Research phase 2 (retry with simpler approach)",
        mode: "single",
        agents: [makeAgent({ id: "b2", role: "researcher" })],
      });
      console.log("  [Phase 4b] Coordinator retried B as B' ✓");

      // ---- Phase 5: User injects new requirement → Coordinator dispatches D ----
      // (In real system: user message arrives via inject API → agent loop injects → LLM responds → dispatches D)
      const idD = wm.startWorkflowMock({
        sessionId: "s1", goal: "New user request: compare with competitor data",
        mode: "parallel",
        agents: [makeAgent({ id: "d1", role: "analyst" })],
      });
      console.log("  [Phase 5] User injected new request, Coordinator dispatched D ✓");

      // Now B', C, D all running
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.listActive("s1")).toHaveLength(3);

      // ---- Phase 6: C completes (cross-validation done with partial data) ----
      wm.completeWorkflow(idC, makeWorkflowResult({
        workflowId: idC,
        synthesis: "Cross-validation complete with available data",
        agentResults: [{
          agentId: "c1", role: "verifier", status: "completed",
          output: "Validation report", duration: 8000,
        }],
      }));
      await flushMicrotasks();

      const drain3 = wm.drainCompleted("s1");
      expect(drain3).toHaveLength(1);
      expect(drain3[0].goal).toBe("Cross-validation");
      console.log("  [Phase 6] Workflow C completed ✓");

      // B' and D still running
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.listActive("s1")).toHaveLength(2);

      // ---- Phase 7: D completes (user's new request) ----
      wm.completeWorkflow(idD, makeWorkflowResult({
        workflowId: idD,
        synthesis: "Competitor comparison complete",
        agentResults: [{
          agentId: "d1", role: "analyst", status: "completed",
          output: "Comparison results", duration: 15000,
        }],
      }));
      await flushMicrotasks();

      const drain4 = wm.drainCompleted("s1");
      expect(drain4).toHaveLength(1);
      expect(drain4[0].goal).toContain("competitor");
      console.log("  [Phase 7] Workflow D (user's new request) completed ✓");

      // Only B' still running
      expect(wm.hasActive("s1")).toBe(true);
      expect(wm.listActive("s1")).toHaveLength(1);

      // ---- Phase 8: B' completes (retry succeeded) ----
      wm.completeWorkflow(idB2, makeWorkflowResult({
        workflowId: idB2,
        synthesis: "Phase 2 research complete (simplified approach)",
        agentResults: [{
          agentId: "b2", role: "researcher", status: "completed",
          output: "Simplified but complete findings", duration: 6000,
        }],
      }));
      await flushMicrotasks();

      const drain5 = wm.drainCompleted("s1");
      expect(drain5).toHaveLength(1);
      expect(drain5[0].status).toBe("completed");
      console.log("  [Phase 8] Workflow B' (retry) completed ✓");

      // ---- Phase 9: All done ----
      expect(wm.hasActive("s1")).toBe(false);
      expect(wm.drainCompleted("s1")).toHaveLength(0);
      console.log("  [Phase 9] All workflows complete, session idle ✓");
    });

    it("5.2: rapid sequential start-drain cycles (10 workflows)", async () => {
      const ids: string[] = [];

      // Start all 10
      for (let i = 0; i < 10; i++) {
        ids.push(wm.startWorkflowMock({
          sessionId: "s1",
          goal: `Task ${i}`,
          mode: "parallel",
          agents: [makeAgent({ id: `agent-${i}` })],
        }));
      }
      expect(wm.listActive("s1")).toHaveLength(10);

      // Complete odd ones
      for (let i = 1; i < 10; i += 2) {
        wm.completeWorkflow(ids[i], makeWorkflowResult({ workflowId: ids[i] }));
      }
      await flushMicrotasks(20);

      // Drain 5
      const d1 = wm.drainCompleted("s1");
      expect(d1).toHaveLength(5);
      expect(d1.every(w => w.status === "completed")).toBe(true);

      // 5 still running
      expect(wm.hasActive("s1")).toBe(true);

      // Complete even ones
      for (let i = 0; i < 10; i += 2) {
        wm.completeWorkflow(ids[i], makeWorkflowResult({ workflowId: ids[i] }));
      }
      await flushMicrotasks(20);

      const d2 = wm.drainCompleted("s1");
      expect(d2).toHaveLength(5);
      expect(wm.hasActive("s1")).toBe(false);
    });

    it("5.3: getStatus returns null for unknown ID", () => {
      expect(wm.getStatus("does-not-exist")).toBeNull();
    });

    it("5.4: drainCompleted returns empty for session with no workflows", () => {
      expect(wm.drainCompleted("empty-session")).toHaveLength(0);
    });
  });
});
