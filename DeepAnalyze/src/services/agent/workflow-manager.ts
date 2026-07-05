// =============================================================================
// DeepAnalyze - WorkflowManager (Background Workflow Management)
// =============================================================================
// Singleton that manages all active background workflows.
// Provides non-blocking start, status query, and result draining.
// Workflows are persisted to the `workflows` table on start and on completion,
// so historical workflows can be recovered after service restart.
// =============================================================================

import { randomUUID } from "node:crypto";
import { WorkflowEngine } from "./workflow-engine.js";
import type { WorkflowResult, WorkflowEvent, WorkflowAgent, WorkflowMode, WorkflowInput } from "./workflow-engine.js";
import type { AgentRunner } from "./agent-runner.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { WorkflowRepo } from "../../store/repos/interfaces.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveWorkflow {
  workflowId: string;
  sessionId: string;
  parentTaskId?: string;
  teamName: string;
  mode: WorkflowMode;
  agentCount: number;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled";
  engine: WorkflowEngine;
  startTime: number;
  endTime?: number;
  result?: WorkflowResult;
  error?: string;
}

export interface ActiveWorkflowStatus {
  workflowId: string;
  sessionId?: string;
  parentTaskId?: string;
  goal: string;
  teamName?: string;
  mode?: string;
  agentCount?: number;
  status: ActiveWorkflow["status"];
  startTime: number;
  endTime?: number;
  agentRoles?: string[];
  durationMs?: number;
  error?: string;
}

export interface StartWorkflowParams {
  /** Session ID that owns this workflow. Optional because sub-agents may
   *  invoke workflows without a session in their ALS context. */
  sessionId?: string;
  goal: string;
  mode: WorkflowMode;
  teamName: string;
  agents: WorkflowAgent[];
  crossReview?: boolean;
  runner: AgentRunner;
  toolRegistry: ToolRegistry;
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// WorkflowManager singleton
// ---------------------------------------------------------------------------

class WorkflowManager {
  private active = new Map<string, ActiveWorkflow>();
  private workflowRepo: WorkflowRepo | null = null;

  /** Set the workflow repo for DB persistence. Called once at startup. */
  setWorkflowRepo(repo: WorkflowRepo): void {
    this.workflowRepo = repo;
  }

  /**
   * Start a workflow in the background (fire-and-forget).
   * Returns the workflowId immediately; the engine runs as an unawaited Promise.
   * Also INSERTs a row into the `workflows` table for persistence across restarts.
   */
  startWorkflow(params: StartWorkflowParams): string {
    const workflowId = randomUUID();

    // Read parentTaskId from the current execution context (ALS) so workflow
    // events can be filtered per-task in parallel execution scenarios.
    // This avoids requiring every caller to thread parentTaskId explicitly.
    const execCtx = params.toolRegistry.getExecutionContext();
    const parentTaskId = execCtx?.taskId as string | undefined;

    const input: WorkflowInput = {
      workflowId,
      sessionId: params.sessionId,
      parentTaskId,
      teamName: params.teamName,
      mode: params.mode,
      goal: params.goal,
      agents: params.agents,
      crossReview: params.crossReview,
      dataDir: params.dataDir,
    };

    const engine = new WorkflowEngine(
      input,
      params.runner,
      params.toolRegistry,
      params.onEvent,
      params.signal,
    );

    const entry: ActiveWorkflow = {
      workflowId,
      sessionId: params.sessionId ?? "",
      parentTaskId,
      teamName: params.teamName,
      mode: params.mode,
      agentCount: params.agents.length,
      goal: params.goal,
      status: "running",
      engine,
      startTime: Date.now(),
    };

    this.active.set(workflowId, entry);

    // Persist to DB (fire-and-forget; failure logged but does not block start)
    if (this.workflowRepo && params.sessionId) {
      this.workflowRepo
        .insert({
          id: workflowId,
          sessionId: params.sessionId,
          parentTaskId: parentTaskId ?? null,
          teamName: params.teamName,
          mode: params.mode,
          goal: params.goal,
          agentCount: params.agents.length,
        })
        .catch((err) => {
          console.warn(`[WorkflowManager] DB insert failed for ${workflowId}:`, err instanceof Error ? err.message : String(err));
        });
    }

    // Fire-and-forget: engine.execute() runs in background
    engine.execute()
      .then((result) => {
        entry.status = "completed";
        entry.result = result;
        entry.endTime = Date.now();
        if (this.workflowRepo && params.sessionId) {
          this.workflowRepo
            .updateCompletion(workflowId, "completed", result)
            .catch((err) => console.warn(`[WorkflowManager] DB updateCompletion failed for ${workflowId}:`, err instanceof Error ? err.message : String(err)));
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // AbortError means cancelled — not a failure
        if (err?.name === "AbortError" || /abort|cancel/i.test(msg)) {
          entry.status = "cancelled";
        } else {
          entry.status = "failed";
          entry.error = msg;
        }
        entry.endTime = Date.now();
        if (this.workflowRepo && params.sessionId) {
          this.workflowRepo
            .updateCompletion(workflowId, entry.status, null, entry.error)
            .catch((err) => console.warn(`[WorkflowManager] DB updateCompletion failed for ${workflowId}:`, err instanceof Error ? err.message : String(err)));
        }
      });

    return workflowId;
  }

  /**
   * Drain all completed/failed/cancelled workflow results for a session.
   * Returns results and removes them from the active map.
   */
  drainCompleted(sessionId: string): ActiveWorkflow[] {
    const results: ActiveWorkflow[] = [];
    for (const [id, entry] of this.active) {
      if (entry.sessionId === sessionId && entry.status !== "running") {
        results.push(entry);
        this.active.delete(id);
      }
    }
    return results;
  }

  /**
   * Query a single workflow's status.
   */
  getStatus(workflowId: string): ActiveWorkflowStatus | null {
    const entry = this.active.get(workflowId);
    if (!entry) return null;
    return this.toStatus(entry);
  }

  /**
   * Whether there are any running workflows for a session.
   */
  hasActive(sessionId: string): boolean {
    for (const entry of this.active.values()) {
      if (entry.sessionId === sessionId && entry.status === "running") {
        return true;
      }
    }
    return false;
  }

  /**
   * List all workflows for a session (including running ones).
   */
  listActive(sessionId: string): ActiveWorkflowStatus[] {
    const result: ActiveWorkflowStatus[] = [];
    for (const entry of this.active.values()) {
      if (entry.sessionId === sessionId) {
        result.push(this.toStatus(entry));
      }
    }
    return result;
  }

  /**
   * List ALL workflows for a session: in-memory (running) + DB (historical).
   * Used by GET /api/sessions/:id/workflows for state recovery.
   * In-memory entries take precedence (newer state) over DB rows.
   */
  async listAll(sessionId: string): Promise<ActiveWorkflowStatus[]> {
    const memoryWorkflows = this.listActive(sessionId);
    const memoryIds = new Set(memoryWorkflows.map((w) => w.workflowId));

    if (!this.workflowRepo) {
      return memoryWorkflows;
    }

    let dbWorkflows: Awaited<ReturnType<WorkflowRepo["listBySession"]>> = [];
    try {
      dbWorkflows = await this.workflowRepo.listBySession(sessionId);
    } catch (err) {
      console.warn(`[WorkflowManager] DB listBySession failed for ${sessionId}:`, err instanceof Error ? err.message : String(err));
      return memoryWorkflows;
    }

    // Merge: DB entries that aren't in memory (memory has newest state for running)
    const dbOnly = dbWorkflows
      .filter((w) => !memoryIds.has(w.id))
      .map<ActiveWorkflowStatus>((w) => ({
        workflowId: w.id,
        sessionId: w.sessionId,
        parentTaskId: w.parentTaskId ?? undefined,
        goal: w.goal ?? "",
        teamName: w.teamName ?? undefined,
        mode: w.mode ?? undefined,
        agentCount: w.agentCount ?? undefined,
        status: w.status,
        startTime: new Date(w.startedAt).getTime(),
        endTime: w.completedAt ? new Date(w.completedAt).getTime() : undefined,
        durationMs: w.completedAt
          ? new Date(w.completedAt).getTime() - new Date(w.startedAt).getTime()
          : undefined,
        error: w.error ?? undefined,
      }));

    // Newest first: in-memory (running) + DB newest
    return [...memoryWorkflows, ...dbOnly];
  }

  private toStatus(entry: ActiveWorkflow): ActiveWorkflowStatus {
    return {
      workflowId: entry.workflowId,
      sessionId: entry.sessionId,
      parentTaskId: entry.parentTaskId,
      goal: entry.goal,
      teamName: entry.teamName,
      mode: entry.mode,
      agentCount: entry.agentCount,
      status: entry.status,
      startTime: entry.startTime,
      endTime: entry.endTime,
      durationMs: entry.endTime ? entry.endTime - entry.startTime : Date.now() - entry.startTime,
      error: entry.error,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _instance: WorkflowManager | undefined;

export function getWorkflowManager(): WorkflowManager {
  if (!_instance) {
    _instance = new WorkflowManager();
  }
  return _instance;
}
