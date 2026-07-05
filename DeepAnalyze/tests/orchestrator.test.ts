// =============================================================================
// DeepAnalyze - Orchestrator Tests
// =============================================================================
// Tests the Orchestrator with a mock AgentRunner.
//
// Since the Orchestrator depends on PG repos which require a database connection,
// we write Orchestrator-level tests that verify the orchestration logic (agent
// type routing, error handling, cancellation, etc.) without depending on the
// database. Database-dependent tests (getTaskStatus, listSessionTasks) would
// need a running PG instance.
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import type { AgentResult } from "../src/services/agent/types.js";

// ---------------------------------------------------------------------------
// Types for our mock objects
// ---------------------------------------------------------------------------

interface AgentRunOptions {
  input: string;
  agentType?: string;
  parentTaskId?: string;
  sessionId?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (event: any) => void;
}

// ---------------------------------------------------------------------------
// We cannot import Orchestrator directly because it imports PG repos which
// require a database connection. Instead, we create a lightweight test harness
// that replicates the Orchestrator logic we want to test, without the DB
// dependency.
//
// For FULL integration tests including DB, run with a running PG instance.
// ---------------------------------------------------------------------------

/**
 * Minimal Orchestrator-like class for testing orchestration logic.
 * This mirrors the real Orchestrator but uses an in-memory task store
 * instead of the database.
 */
class TestOrchestrator {
  private runner: any;
  private activeControllers = new Map<string, AbortController>();
  private tasks = new Map<string, any>();

  constructor(runner: any) {
    this.runner = runner;
  }

  async runSingle(options: AgentRunOptions): Promise<AgentResult> {
    const taskId = crypto.randomUUID();
    const agentType = options.agentType ?? "general";

    // Record the task as pending
    this.tasks.set(taskId, {
      id: taskId,
      agentType,
      status: "pending",
      input: options.input,
      parentId: options.parentTaskId ?? null,
      sessionId: options.sessionId ?? null,
    });

    // Create an AbortController
    const controller = new AbortController();
    this.activeControllers.set(taskId, controller);

    // Update status to running
    this.tasks.get(taskId).status = "running";

    const runOptions: AgentRunOptions = {
      ...options,
      agentType,
      signal: controller.signal,
    };

    try {
      const result = await this.runner.run(runOptions);
      this.tasks.get(taskId).status = "completed";
      this.tasks.get(taskId).output = result.output;
      // Override taskId with the orchestrator's taskId (matching real Orchestrator behavior)
      return { ...result, taskId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.tasks.get(taskId).status = "failed";
      this.tasks.get(taskId).error = errorMsg;

      return {
        taskId,
        output: `Agent failed: ${errorMsg}`,
        toolCallsCount: 0,
        turnsUsed: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } finally {
      this.activeControllers.delete(taskId);
    }
  }

  cancel(taskId: string): boolean {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(taskId);
      if (this.tasks.has(taskId)) {
        this.tasks.get(taskId).status = "cancelled";
      }
      return true;
    }
    return false;
  }

  getTaskStatus(taskId: string): any | null {
    return this.tasks.get(taskId) ?? null;
  }

  listSessionTasks(sessionId: string): any[] {
    const results: any[] = [];
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId) {
        results.push(task);
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Mock AgentRunner factory
// ---------------------------------------------------------------------------

function createMockRunner() {
  return {
    run: async (options: any): Promise<AgentResult> => ({
      taskId: "mock-task-" + Math.random().toString(36).substring(7),
      output: `Mock result for: ${options.input}`,
      toolCallsCount: 0,
      turnsUsed: 1,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    registerAgent: () => {},
    registerAgents: () => {},
    getAgentDefinition: () => undefined,
    getAgentTypes: () => ["general"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
  let orchestrator: TestOrchestrator;

  beforeEach(() => {
    orchestrator = new TestOrchestrator(createMockRunner());
  });

  test("runSingle executes a task and returns a result", async () => {
    const result = await orchestrator.runSingle({
      input: "Test task",
    });

    expect(result).toBeDefined();
    expect(result.output).toContain("Mock result for");
    expect(result.taskId).toBeDefined();
    expect(typeof result.taskId).toBe("string");
    expect(result.taskId.length).toBeGreaterThan(0);
  });

  test("runSingle tracks the task in store", async () => {
    const result = await orchestrator.runSingle({
      input: "Tracked task",
      agentType: "general",
    });

    const task = orchestrator.getTaskStatus(result.taskId);
    expect(task).not.toBeNull();
    expect(task.status).toBe("completed");
    expect(task.agentType).toBe("general");
    expect(task.input).toBe("Tracked task");
  });

  test("runSingle records the correct agent type", async () => {
    const mockRunner = createMockRunner();
    let capturedAgentType: string | undefined;

    mockRunner.run = async (options: any): Promise<AgentResult> => {
      capturedAgentType = options.agentType;
      return {
        taskId: "mock-task",
        output: "Custom agent result",
        toolCallsCount: 0,
        turnsUsed: 1,
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    };

    const customOrchestrator = new TestOrchestrator(mockRunner);
    await customOrchestrator.runSingle({
      input: "Test agent type",
      agentType: "analyzer",
    });

    expect(capturedAgentType).toBe("analyzer");
  });

  test("runSingle defaults agentType to 'general'", async () => {
    const mockRunner = createMockRunner();
    let capturedAgentType: string | undefined;

    mockRunner.run = async (options: any): Promise<AgentResult> => {
      capturedAgentType = options.agentType;
      return {
        taskId: "mock-task",
        output: "Result",
        toolCallsCount: 0,
        turnsUsed: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    };

    const customOrchestrator = new TestOrchestrator(mockRunner);
    await customOrchestrator.runSingle({
      input: "No agent type specified",
    });

    expect(capturedAgentType).toBe("general");
  });

  test("cancel returns false for non-existent task", () => {
    expect(orchestrator.cancel("non-existent-id")).toBe(false);
  });

  test("getTaskStatus returns null for non-existent task", () => {
    const task = orchestrator.getTaskStatus("does-not-exist");
    expect(task).toBeNull();
  });

  test("runSingle passes sessionId through to the task record", async () => {
    const result = await orchestrator.runSingle({
      input: "Session test",
      sessionId: "test-session-123",
    });

    const task = orchestrator.getTaskStatus(result.taskId);
    expect(task).not.toBeNull();
    expect(task.sessionId).toBe("test-session-123");
  });

  test("runSingle handles runner errors gracefully", async () => {
    const errorRunner = createMockRunner();
    errorRunner.run = async () => {
      throw new Error("Runner crashed");
    };

    const errorOrchestrator = new TestOrchestrator(errorRunner);
    const result = await errorOrchestrator.runSingle({
      input: "This will fail",
    });

    expect(result.output).toContain("Agent failed");
    expect(result.output).toContain("Runner crashed");
    expect(result.taskId).toBeDefined();
    expect(result.toolCallsCount).toBe(0);
    expect(result.turnsUsed).toBe(0);

    const task = errorOrchestrator.getTaskStatus(result.taskId);
    expect(task).not.toBeNull();
    expect(task.status).toBe("failed");
    expect(task.error).toContain("Runner crashed");
  });

  test("listSessionTasks returns tasks for a given session", async () => {
    const sessionId = "session-list-test-" + Date.now();

    await orchestrator.runSingle({
      input: "Task 1",
      sessionId,
    });
    await orchestrator.runSingle({
      input: "Task 2",
      sessionId,
    });
    // Create a task in a different session
    await orchestrator.runSingle({
      input: "Other session task",
      sessionId: "other-session",
    });

    const tasks = orchestrator.listSessionTasks(sessionId);
    expect(tasks.length).toBe(2);
    for (const t of tasks) {
      expect(t.sessionId).toBe(sessionId);
    }
  });

  test("cancel aborts an active task", async () => {
    let resolveRun: () => void;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });

    const slowRunner = createMockRunner();
    slowRunner.run = async (options: any): Promise<AgentResult> => {
      // Wait for the signal to abort or for manual resolution
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          resolve();
        };
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        // Also resolve after timeout
        setTimeout(resolve, 5000);
      });
      return {
        taskId: "slow-task",
        output: "Slow result",
        toolCallsCount: 0,
        turnsUsed: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    };

    const slowOrchestrator = new TestOrchestrator(slowRunner);

    // Start a task
    const taskPromise = slowOrchestrator.runSingle({
      input: "Slow task",
    });

    // Cancel it while it's running
    // We need to get the task ID somehow - let's check the active controllers
    // Since we can't get the ID before runSingle returns, let's use a different approach
    // Actually, we can get the task from the store since runSingle records it before awaiting
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Find the task that was just started
    let taskId: string | null = null;
    // The task should be in pending or running state
    // Since TestOrchestrator stores tasks internally, we can find it
    for (const [id, task] of (slowOrchestrator as any).tasks) {
      if (task.input === "Slow task") {
        taskId = id;
        break;
      }
    }

    expect(taskId).not.toBeNull();
    const cancelResult = slowOrchestrator.cancel(taskId!);
    expect(cancelResult).toBe(true);

    // The task should be cancelled
    const task = slowOrchestrator.getTaskStatus(taskId!);
    expect(task.status).toBe("cancelled");

    await taskPromise;
  });

  test("runSingle stores parent task ID", async () => {
    const parentId = "parent-task-" + Date.now();
    const result = await orchestrator.runSingle({
      input: "Child task",
      parentTaskId: parentId,
    });

    const task = orchestrator.getTaskStatus(result.taskId);
    expect(task).not.toBeNull();
    expect(task.parentId).toBe(parentId);
  });
});
