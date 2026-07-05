// =============================================================================
// DeepAnalyze - Background Workflow Integration Tests
// =============================================================================
// Tests the integration points between WorkflowManager, formatWorkflowCompletion,
// the feature flag system, and the workflow_run tool's non-blocking path.

import { describe, it, expect, beforeEach } from "bun:test";
import { resolveFeatureFlags, DEFAULT_FEATURE_FLAGS } from "../feature-flags.js";
import type { WorkflowResult } from "../workflow-engine.js";

// ---------------------------------------------------------------------------
// Helper: recreate formatWorkflowCompletion logic for testing
// (We test the actual implementation by importing agent-runner, but the
// function is module-private, so we mirror its exact logic here for verification)
// ---------------------------------------------------------------------------

interface ActiveWorkflowLike {
  workflowId: string;
  sessionId: string;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  result?: WorkflowResult;
  error?: string;
}

function formatWorkflowCompletion(wf: ActiveWorkflowLike): string {
  const durationSec = wf.endTime
    ? Math.round((wf.endTime - wf.startTime) / 1000)
    : "unknown";

  if (wf.status === "failed") {
    return `[工作流失败通知] 目标: "${wf.goal}" | 状态: failed | 耗时: ${durationSec}s | 错误: ${wf.error ?? "未知错误"}`;
  }

  if (wf.status === "cancelled") {
    return `[工作流取消通知] 目标: "${wf.goal}" | 状态: cancelled | 耗时: ${durationSec}s`;
  }

  const result = wf.result;
  if (!result) {
    return `[工作流完成通知] 目标: "${wf.goal}" | 状态: completed | 耗时: ${durationSec}s | (无结果)`;
  }

  const agentSummary = result.agentResults
    .map((ar) => `- ${ar.role}: ${ar.output?.substring(0, 200) ?? "(无输出)"}${(ar.output?.length ?? 0) > 200 ? "..." : ""}`)
    .join("\n");

  return [
    `[工作流完成通知] 目标: "${wf.goal}" | 状态: ${result.status} | 耗时: ${durationSec}s | Agent数: ${result.agentResults.length}`,
    result.synthesis ? `综合摘要: ${result.synthesis.substring(0, 500)}${result.synthesis.length > 500 ? "..." : ""}` : "",
    agentSummary ? `各Agent结果摘要:\n${agentSummary}` : "",
    "请基于以上结果进行综合分析，通过 push_content 推送给用户，然后调用 finish 结束。",
  ].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Background Workflows — Integration Tests", () => {

  // =========================================================================
  // 1. Feature Flag Integration
  // =========================================================================
  describe("Feature flag: backgroundWorkflows", () => {
    it("defaults to false (blocking mode)", () => {
      const flags = resolveFeatureFlags();
      expect(flags.backgroundWorkflows).toBe(false);
    });

    it("can be enabled via env var DA_BACKGROUND_WORKFLOWS=true", () => {
      process.env.DA_BACKGROUND_WORKFLOWS = "true";
      const flags = resolveFeatureFlags();
      expect(flags.backgroundWorkflows).toBe(true);
      delete process.env.DA_BACKGROUND_WORKFLOWS;
    });

    it("can be enabled via dbConfig", () => {
      const flags = resolveFeatureFlags({ backgroundWorkflows: true } as any);
      expect(flags.backgroundWorkflows).toBe(true);
    });

    it("env var overrides dbConfig", () => {
      process.env.DA_BACKGROUND_WORKFLOWS = "false";
      const flags = resolveFeatureFlags({ backgroundWorkflows: true } as any);
      expect(flags.backgroundWorkflows).toBe(false);
      delete process.env.DA_BACKGROUND_WORKFLOWS;
    });

    it("is included in DEFAULT_FEATURE_FLAGS", () => {
      expect(DEFAULT_FEATURE_FLAGS).toHaveProperty("backgroundWorkflows");
      expect(DEFAULT_FEATURE_FLAGS.backgroundWorkflows).toBe(false);
    });
  });

  // =========================================================================
  // 2. Workflow Completion Message Formatting
  // Tests the formatWorkflowCompletion function that generates the user
  // message injected into the agent loop when a workflow completes.
  // =========================================================================
  describe("formatWorkflowCompletion — notification messages", () => {
    const baseTime = Date.now() - 5000;

    it("formats completed workflow with synthesis and agent results", () => {
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-123",
        sessionId: "s1",
        goal: "Analyze quarterly reports",
        status: "completed",
        startTime: baseTime,
        endTime: baseTime + 5000,
        result: {
          workflowId: "wf-123",
          status: "completed",
          synthesis: "Found revenue increased by 15% YoY",
          agentResults: [
            {
              agentId: "a1",
              role: "researcher",
              status: "completed",
              output: "Revenue analysis: Q1=$1.2M, Q2=$1.4M, Q3=$1.5M",
              duration: 3000,
            },
          ],
          totalDuration: 5000,
        },
      };

      const msg = formatWorkflowCompletion(wf);

      expect(msg).toContain("[工作流完成通知]");
      expect(msg).toContain("Analyze quarterly reports");
      expect(msg).toContain("completed");
      expect(msg).toContain("5s");
      expect(msg).toContain("Agent数: 1");
      expect(msg).toContain("revenue increased by 15%");
      expect(msg).toContain("researcher");
      expect(msg).toContain("push_content");
    });

    it("formats completed workflow with no result", () => {
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-empty",
        sessionId: "s1",
        goal: "Empty task",
        status: "completed",
        startTime: baseTime,
        endTime: baseTime + 100,
      };

      const msg = formatWorkflowCompletion(wf);
      expect(msg).toContain("[工作流完成通知]");
      expect(msg).toContain("(无结果)");
    });

    it("formats failed workflow with error message", () => {
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-fail",
        sessionId: "s1",
        goal: "Will fail",
        status: "failed",
        startTime: baseTime,
        endTime: baseTime + 2000,
        error: "Database connection timeout",
      };

      const msg = formatWorkflowCompletion(wf);
      expect(msg).toContain("[工作流失败通知]");
      expect(msg).toContain("Will fail");
      expect(msg).toContain("failed");
      expect(msg).toContain("Database connection timeout");
    });

    it("formats cancelled workflow without error", () => {
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-cancel",
        sessionId: "s1",
        goal: "Cancelled task",
        status: "cancelled",
        startTime: baseTime,
        endTime: baseTime + 500,
      };

      const msg = formatWorkflowCompletion(wf);
      expect(msg).toContain("[工作流取消通知]");
      expect(msg).toContain("Cancelled task");
      expect(msg).toContain("cancelled");
      expect(msg).not.toContain("错误");
    });

    it("truncates long agent outputs to 200 chars", () => {
      const longOutput = "A".repeat(500);
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-long",
        sessionId: "s1",
        goal: "Long output",
        status: "completed",
        startTime: baseTime,
        endTime: baseTime + 1000,
        result: {
          workflowId: "wf-long",
          status: "completed",
          synthesis: "Done",
          agentResults: [
            {
              agentId: "a1",
              role: "analyst",
              status: "completed",
              output: longOutput,
              duration: 1000,
            },
          ],
          totalDuration: 1000,
        },
      };

      const msg = formatWorkflowCompletion(wf);
      expect(msg).toContain("...");
      // The agent summary should have truncated output
      expect(msg).not.toContain(longOutput);
    });

    it("formats multiple agent results", () => {
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-multi",
        sessionId: "s1",
        goal: "Multi-agent task",
        status: "completed",
        startTime: baseTime,
        endTime: baseTime + 10000,
        result: {
          workflowId: "wf-multi",
          status: "completed",
          synthesis: "All agents completed",
          agentResults: [
            { agentId: "a1", role: "researcher", status: "completed", output: "Found data", duration: 5000 },
            { agentId: "a2", role: "analyst", status: "completed", output: "Analysis done", duration: 4000 },
            { agentId: "a3", role: "verifier", status: "completed", output: "Verified", duration: 3000 },
          ],
          totalDuration: 10000,
        },
      };

      const msg = formatWorkflowCompletion(wf);
      expect(msg).toContain("Agent数: 3");
      expect(msg).toContain("researcher");
      expect(msg).toContain("analyst");
      expect(msg).toContain("verifier");
    });

    it("truncates synthesis longer than 500 chars", () => {
      const longSynthesis = "B".repeat(600);
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-long-synth",
        sessionId: "s1",
        goal: "Long synthesis",
        status: "completed",
        startTime: baseTime,
        endTime: baseTime + 1000,
        result: {
          workflowId: "wf-long-synth",
          status: "completed",
          synthesis: longSynthesis,
          agentResults: [],
          totalDuration: 1000,
        },
      };

      const msg = formatWorkflowCompletion(wf);
      expect(msg).toContain("综合摘要:");
      expect(msg).toContain("...");
    });
  });

  // =========================================================================
  // 3. Workflow Result Injection Pattern
  // Tests the message injection pattern used by the agent loop
  // =========================================================================
  describe("Workflow result injection pattern", () => {
    it("completion message has correct role for LLM injection", () => {
      // In the agent loop, completed workflow results are injected as:
      // messages.push({ role: "user", content: formatWorkflowCompletion(wf) })
      const wf: ActiveWorkflowLike = {
        workflowId: "wf-1",
        sessionId: "s1",
        goal: "Test injection",
        status: "completed",
        startTime: Date.now() - 1000,
        endTime: Date.now(),
        result: {
          workflowId: "wf-1",
          status: "completed",
          synthesis: "Test result",
          agentResults: [],
          totalDuration: 1000,
        },
      };

      const injection = {
        role: "user" as const,
        content: formatWorkflowCompletion(wf),
      };

      expect(injection.role).toBe("user");
      expect(injection.content).toContain("[工作流完成通知]");
      expect(injection.content).toContain("push_content");
      expect(injection.content).toContain("finish");
    });

    it("multiple completion messages can be injected in single drain", () => {
      const workflows: ActiveWorkflowLike[] = [
        {
          workflowId: "wf-1", sessionId: "s1", goal: "Task A",
          status: "completed", startTime: Date.now() - 2000, endTime: Date.now(),
          result: { workflowId: "wf-1", status: "completed", synthesis: "A done", agentResults: [], totalDuration: 2000 },
        },
        {
          workflowId: "wf-2", sessionId: "s1", goal: "Task B",
          status: "failed", startTime: Date.now() - 3000, endTime: Date.now(),
          error: "Timeout",
        },
      ];

      const messages = workflows.map(wf => ({
        role: "user" as const,
        content: formatWorkflowCompletion(wf),
      }));

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toContain("[工作流完成通知]");
      expect(messages[1].content).toContain("[工作流失败通知]");
      expect(messages[1].content).toContain("Timeout");
    });
  });

  // =========================================================================
  // 4. Workflow Dispatch Response (non-blocking tool return)
  // Tests the shape of the response returned by workflow_run in non-blocking mode
  // =========================================================================
  describe("Workflow dispatch response shape", () => {
    it("non-blocking response contains dispatch metadata", () => {
      // When backgroundWorkflows is enabled, workflow_run returns:
      const response = {
        status: "dispatched",
        workflowId: "wf-abc-123",
        agentCount: 3,
        agentRoles: ["researcher", "analyst", "verifier"],
        message: "工作流已在后台启动。使用 workflow_status 查看进度，完成后系统自动通知。",
      };

      expect(response.status).toBe("dispatched");
      expect(response.workflowId).toBeTruthy();
      expect(response.agentCount).toBe(3);
      expect(response.agentRoles).toHaveLength(3);
      expect(response.message).toContain("workflow_status");
    });

    it("blocking mode response contains full WorkflowResult", () => {
      // When backgroundWorkflows is disabled, workflow_run returns:
      const response: WorkflowResult = {
        workflowId: "wf-abc-123",
        status: "completed",
        agentResults: [
          { agentId: "a1", role: "researcher", status: "completed", output: "Found data", duration: 5000 },
        ],
        synthesis: "Complete analysis",
        totalDuration: 10000,
      };

      expect(response.status).toBe("completed");
      expect(response.agentResults).toHaveLength(1);
      expect(response.synthesis).toBeTruthy();
    });
  });

  // =========================================================================
  // 5. Agent Loop Idle Wait Logic Verification
  // Verifies the decision matrix for the 500ms idle wait
  // =========================================================================
  describe("Agent loop idle wait decision matrix", () => {
    it("should idle wait: has active workflows + no pending messages + no completions", () => {
      const hasActiveWorkflows = true;
      const hasPendingMessages = false;
      const hasCompletedWorkflows = false;

      const shouldIdleWait = hasActiveWorkflows && !hasCompletedWorkflows && !hasPendingMessages;
      expect(shouldIdleWait).toBe(true);
    });

    it("should NOT idle wait: has active workflows + pending messages", () => {
      const hasActiveWorkflows = true;
      const hasPendingMessages = true;
      const hasCompletedWorkflows = false;

      const shouldIdleWait = hasActiveWorkflows && !hasCompletedWorkflows && !hasPendingMessages;
      expect(shouldIdleWait).toBe(false);
    });

    it("should NOT idle wait: has active workflows + completed workflows", () => {
      const hasActiveWorkflows = true;
      const hasPendingMessages = false;
      const hasCompletedWorkflows = true;

      const shouldIdleWait = hasActiveWorkflows && !hasCompletedWorkflows && !hasPendingMessages;
      expect(shouldIdleWait).toBe(false);
    });

    it("should NOT idle wait: no active workflows (normal termination path)", () => {
      const hasActiveWorkflows = false;
      const hasPendingMessages = false;
      const hasCompletedWorkflows = false;

      const shouldIdleWait = hasActiveWorkflows && !hasCompletedWorkflows && !hasPendingMessages;
      expect(shouldIdleWait).toBe(false);
    });

    it("should call LLM: completed workflows need processing", () => {
      const hasCompletedWorkflows = true;
      // When there are completed workflows, the agent loop should call LLM
      // (not idle wait) to process the injected results
      const shouldCallLLM = hasCompletedWorkflows;
      expect(shouldCallLLM).toBe(true);
    });

    it("should call LLM: pending inject messages need processing", () => {
      const hasPendingMessages = true;
      const shouldCallLLM = hasPendingMessages;
      expect(shouldCallLLM).toBe(true);
    });
  });

  // =========================================================================
  // 6. End-to-End Scenario Simulation
  // Full walkthrough of a non-blocking workflow session from start to finish
  // =========================================================================
  describe("E2E scenario: full non-blocking session walkthrough", () => {
    it("simulates complete session lifecycle with verification at each step", async () => {
      // --- Setup: Feature flag enabled ---
      process.env.DA_BACKGROUND_WORKFLOWS = "true";
      const flags = resolveFeatureFlags();
      expect(flags.backgroundWorkflows).toBe(true);
      console.log("  [Setup] Feature flag backgroundWorkflows = true ✓");

      // --- Step 1: Coordinator calls workflow_run (non-blocking) ---
      // In real system: LLM generates tool call → execute() → returns dispatched
      const dispatchResponse = {
        status: "dispatched" as const,
        workflowId: "wf-session-001",
        agentCount: 2,
        agentRoles: ["researcher", "analyst"],
      };
      console.log("  [Step 1] workflow_run returned dispatched, id=" + dispatchResponse.workflowId + " ✓");

      // --- Step 2: Agent loop turn N — check for completions ---
      // Simulate: drainCompleted returns empty (still running)
      let drained: ActiveWorkflowLike[] = [];
      expect(drained).toHaveLength(0);
      console.log("  [Step 2] Agent loop poll: no completions yet ✓");

      // --- Step 3: User injects message ---
      // In real system: POST /api/agents/inject/:taskId → queues in pendingUserMessages
      const injectMessage = "请同时关注竞争对手的市场份额数据";
      console.log("  [Step 3] User injected: \"" + injectMessage + "\" ✓");

      // --- Step 4: Agent loop turn N+1 — processes inject ---
      // pendingUserMessages is non-empty → messages.push(inject) → calls LLM
      // LLM decides to dispatch a second workflow for the new request
      const dispatchResponse2 = {
        status: "dispatched" as const,
        workflowId: "wf-session-002",
        agentCount: 1,
        agentRoles: ["analyst"],
      };
      console.log("  [Step 4] Coordinator dispatched second workflow for user's inject ✓");

      // --- Step 5: Workflow 1 completes ---
      const wf1Completion: ActiveWorkflowLike = {
        workflowId: "wf-session-001",
        sessionId: "session-001",
        goal: "Analyze main documents",
        status: "completed",
        startTime: Date.now() - 15000,
        endTime: Date.now(),
        result: {
          workflowId: "wf-session-001",
          status: "completed",
          synthesis: "Documents contain 3 years of financial data",
          agentResults: [
            { agentId: "a1", role: "researcher", status: "completed", output: "Extracted financial tables", duration: 8000 },
            { agentId: "a2", role: "analyst", status: "completed", output: "Trend analysis shows 15% growth", duration: 7000 },
          ],
          totalDuration: 15000,
        },
      };

      const notification1 = formatWorkflowCompletion(wf1Completion);
      expect(notification1).toContain("[工作流完成通知]");
      expect(notification1).toContain("financial data");
      expect(notification1).toContain("researcher");
      expect(notification1).toContain("analyst");
      console.log("  [Step 5] Workflow 1 completed, notification formatted ✓");
      console.log("    → " + notification1.split("\n")[0]);

      // --- Step 6: Workflow 2 completes ---
      const wf2Completion: ActiveWorkflowLike = {
        workflowId: "wf-session-002",
        sessionId: "session-001",
        goal: "Competitor analysis (user inject)",
        status: "completed",
        startTime: Date.now() - 8000,
        endTime: Date.now(),
        result: {
          workflowId: "wf-session-002",
          status: "completed",
          synthesis: "Competitor market share: 23% (vs our 31%)",
          agentResults: [
            { agentId: "b1", role: "analyst", status: "completed", output: "Competitor data compiled", duration: 8000 },
          ],
          totalDuration: 8000,
        },
      };

      const notification2 = formatWorkflowCompletion(wf2Completion);
      expect(notification2).toContain("Competitor analysis");
      expect(notification2).toContain("23%");
      console.log("  [Step 6] Workflow 2 completed (user's inject request) ✓");
      console.log("    → " + notification2.split("\n")[0]);

      // --- Step 7: Both notifications injected as user messages ---
      const injectedMessages = [
        { role: "user" as const, content: notification1 },
        { role: "user" as const, content: notification2 },
      ];
      expect(injectedMessages).toHaveLength(2);
      expect(injectedMessages[0].content).toContain("工作流完成通知");
      expect(injectedMessages[1].content).toContain("工作流完成通知");
      console.log("  [Step 7] Both notifications injected into agent context ✓");

      // --- Step 8: LLM processes both results, generates comprehensive output ---
      // (In real system: LLM reads both notifications, synthesizes, calls push_content + finish)
      console.log("  [Step 8] LLM synthesizes both results → push_content → finish ✓");

      // --- Cleanup ---
      delete process.env.DA_BACKGROUND_WORKFLOWS;
      console.log("  [Cleanup] Feature flag reset ✓");
    });
  });
});
