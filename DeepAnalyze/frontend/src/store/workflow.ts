// =============================================================================
// DeepAnalyze - Workflow State Store
// Manages active multi-agent workflow state driven by WebSocket events
// =============================================================================

import { create } from "zustand";
import { api } from "../api/client.js";
import type { PanelMode } from "../components/teams/panel-mode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMessageType = "thinking" | "tool_call" | "tool_result" | "chunk" | "output" | "error";

export interface AgentMessage {
  type: AgentMessageType;
  content: string;
  toolName?: string;
  input?: Record<string, unknown>;
}

export interface AgentState {
  agentId: string;
  role: string;
  task: string;
  status: "queued" | "running" | "waiting" | "completed" | "error";
  duration: number;
  toolCallCount: number;
  progress: number;
  messages: AgentMessage[];
}

export interface ActiveWorkflow {
  workflowId: string;
  sessionId: string;
  teamName: string;
  mode: string;
  startedAt: string;
  agents: Map<string, AgentState>;
  /**
   * True when this card was created from REST fallback (reconnectToRunningTask)
   * rather than a real workflow_start event. Placeholder cards can be
   * overwritten by a subsequent real workflow_start event so the user sees
   * the true teamName/mode/agentCount instead of fallback values.
   */
  isPlaceholder?: boolean;
}

export interface WorkflowState {
  // Data – keyed by workflowId
  activeWorkflows: Map<string, ActiveWorkflow>;

  // Event handlers – called by the WebSocket handler in chat.ts
  handleWorkflowStart: (event: {
    workflowId: string;
    sessionId?: string;
    teamName: string;
    mode: string;
    agentCount: number;
    /**
     * True when called from REST fallback (reconnectToRunningTask). The card
     * is marked as a placeholder so a later real workflow_start event can
     * overwrite the fallback teamName/mode with real values.
     */
    isPlaceholder?: boolean;
  }) => void;

  handleAgentStart: (event: {
    workflowId: string;
    agentId: string;
    role: string;
    task: string;
  }) => void;

  handleAgentToolCall: (event: {
    workflowId: string;
    agentId: string;
    toolName: string;
    input: Record<string, unknown>;
  }) => void;

  handleAgentToolResult: (event: {
    workflowId: string;
    agentId: string;
    toolName: string;
    output: string;
  }) => void;

  handleAgentChunk: (event: {
    workflowId: string;
    agentId: string;
    content: string;
  }) => void;

  handleAgentComplete: (event: {
    workflowId: string;
    agentId: string;
    output?: string;
    error?: string;
    duration: number;
  }) => void;

  handleWorkflowComplete: (event: {
    workflowId: string;
    status: string;
    duration: number;
  }) => void;

  // Manual clean-up
  clearWorkflow: (workflowId: string) => void;

  // UI state
  expandedAgentId: string | null;
  panelExpanded: boolean;
  setExpandedAgentId: (id: string | null) => void;
  setPanelExpanded: (expanded: boolean) => void;

  // ----- Compaction UI state (see docs/superpowers/specs/2026-06-27-subagent-panel-compaction-design.md) -----

  /** Global "collapse all panels" toggle. When true, all non-running panels render in compact mode unless userOverride applies. */
  forceCompactAll: boolean;
  /** Per-workflow manual override. Priority: userOverride > forceCompactAll > auto heuristic. */
  userOverride: Map<string, PanelMode>;
  /** Toggle the global collapse-all. */
  setForceCompactAll: (v: boolean) => void;
  /** Set/clear per-workflow override. Pass null to clear. */
  setUserOverride: (workflowId: string, mode: PanelMode | null) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience wrapper to update a single workflow inside the Map immutably. */
function updateWorkflow(
  map: Map<string, ActiveWorkflow>,
  workflowId: string,
  updater: (wf: ActiveWorkflow) => ActiveWorkflow,
): Map<string, ActiveWorkflow> {
  const wf = map.get(workflowId);
  if (!wf) return map;
  const next = new Map(map);
  next.set(workflowId, updater(wf));
  return next;
}

/** Convenience wrapper to update a single agent inside a workflow's agent Map. */
function updateAgent(
  agents: Map<string, AgentState>,
  agentId: string,
  updater: (agent: AgentState) => AgentState,
): Map<string, AgentState> {
  const agent = agents.get(agentId);
  if (!agent) return agents;
  const next = new Map(agents);
  next.set(agentId, updater(agent));
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  activeWorkflows: new Map(),
  expandedAgentId: null,
  panelExpanded: false,
  forceCompactAll: false,
  userOverride: new Map(),

  // ---- Workflow lifecycle ----

  handleWorkflowStart: (event) => {
    set((state) => {
      const next = new Map(state.activeWorkflows);
      const existing = next.get(event.workflowId);
      if (existing) {
        // Don't overwrite a real (non-placeholder) card — prevents duplicate
        // SSE+WebSocket events from resetting agent statuses.
        // BUT: if the existing card is a placeholder (created by REST fallback),
        // allow the real event to overwrite teamName/mode while preserving
        // startedAt and agent state.
        if (!existing.isPlaceholder) {
          return state;
        }
        next.set(event.workflowId, {
          ...existing,
          teamName: event.teamName ?? existing.teamName,
          mode: event.mode ?? existing.mode,
          isPlaceholder: event.isPlaceholder ?? false,
        });
        return { activeWorkflows: next };
      }
      next.set(event.workflowId, {
        workflowId: event.workflowId,
        sessionId: event.sessionId || "",
        teamName: event.teamName,
        mode: event.mode,
        startedAt: new Date().toISOString(),
        agents: new Map(),
        isPlaceholder: event.isPlaceholder ?? false,
      });
      return { activeWorkflows: next };
    });
  },

  handleAgentStart: (event) => {
    set((state) => ({
      activeWorkflows: updateWorkflow(state.activeWorkflows, event.workflowId, (wf) => {
        const nextAgents = new Map(wf.agents);
        // Don't overwrite an agent that already has a final status (completed/error)
        const existing = nextAgents.get(event.agentId);
        if (existing && (existing.status === "completed" || existing.status === "error")) {
          return wf;
        }
        nextAgents.set(event.agentId, {
          agentId: event.agentId,
          role: event.role,
          task: event.task,
          status: "running",
          duration: 0,
          toolCallCount: 0,
          progress: 0,
          messages: [],
        });
        return { ...wf, agents: nextAgents };
      }),
    }));
  },

  handleAgentToolCall: (event) => {
    set((state) => ({
      activeWorkflows: updateWorkflow(state.activeWorkflows, event.workflowId, (wf) => ({
        ...wf,
        agents: updateAgent(wf.agents, event.agentId, (agent) => ({
          ...agent,
          toolCallCount: agent.toolCallCount + 1,
          messages: [
            ...agent.messages,
            { type: "tool_call" as const, content: `${event.toolName}(${JSON.stringify(event.input)})`, toolName: event.toolName, input: event.input },
          ].slice(-200),
        })),
      })),
    }));
  },

  handleAgentToolResult: (event) => {
    set((state) => ({
      activeWorkflows: updateWorkflow(state.activeWorkflows, event.workflowId, (wf) => ({
        ...wf,
        agents: updateAgent(wf.agents, event.agentId, (agent) => ({
          ...agent,
          messages: [
            ...agent.messages,
            { type: "tool_result" as const, content: typeof event.output === "string" ? event.output : JSON.stringify(event.output), toolName: event.toolName },
          ],
        })),
      })),
    }));
  },

  handleAgentChunk: (event) => {
    set((state) => ({
      activeWorkflows: updateWorkflow(state.activeWorkflows, event.workflowId, (wf) => ({
        ...wf,
        agents: updateAgent(wf.agents, event.agentId, (agent) => ({
          ...agent,
          messages: [
            ...agent.messages,
            { type: "chunk" as const, content: event.content },
          ].slice(-200),
        })),
      })),
    }));
  },

  handleAgentComplete: (event) => {
    set((state) => ({
      activeWorkflows: updateWorkflow(state.activeWorkflows, event.workflowId, (wf) => ({
        ...wf,
        agents: updateAgent(wf.agents, event.agentId, (agent) => ({
          ...agent,
          status: event.error ? "error" : "completed",
          duration: event.duration,
          progress: 100,
          messages: event.error
            ? [...agent.messages, { type: "error" as const, content: event.error }]
            : event.output
              ? [...agent.messages, { type: "output" as const, content: event.output }]
              : agent.messages,
        })),
      })),
    }));
  },

  handleWorkflowComplete: (event) => {
    // Mark all remaining "running" agents as completed, then auto-cleanup
    // after a delay so the UI can display the final state briefly.
    set((state) => {
      const wf = state.activeWorkflows.get(event.workflowId);
      console.log(`[UI] handleWorkflowComplete wfId=${event.workflowId} found=${!!wf} status=${event.status}`);
      if (!wf) return state;

      const updatedAgents = new Map(wf.agents);
      for (const [agentId, agent] of updatedAgents) {
        if (agent.status === "running" || agent.status === "waiting" || agent.status === "queued") {
          updatedAgents.set(agentId, { ...agent, status: "completed", duration: event.duration });
        }
      }

      return {
        activeWorkflows: updateWorkflow(state.activeWorkflows, event.workflowId, (wf) => ({
          ...wf,
          agents: updatedAgents,
        })),
      };
    });

    // Auto-cleanup after 30 seconds to prevent memory leak
    setTimeout(() => {
      get().clearWorkflow(event.workflowId);
    }, 30_000);
  },

  clearWorkflow: (workflowId) => {
    console.log(`[UI] clearWorkflow wfId=${workflowId}`);
    set((state) => {
      const next = new Map(state.activeWorkflows);
      next.delete(workflowId);
      // Also clear per-workflow override so the Map doesn't grow unbounded.
      const nextOverride = new Map(state.userOverride);
      nextOverride.delete(workflowId);
      return {
        activeWorkflows: next,
        expandedAgentId: null,
        panelExpanded: false,
        userOverride: nextOverride,
      };
    });
  },

  setForceCompactAll: (v) => {
    set({ forceCompactAll: v });
  },

  setUserOverride: (workflowId, mode) => {
    set((state) => {
      const next = new Map(state.userOverride);
      if (mode === null) {
        next.delete(workflowId);
      } else {
        next.set(workflowId, mode);
      }
      return { userOverride: next };
    });
  },

  setExpandedAgentId: (id) => {
    set({ expandedAgentId: id });
  },

  setPanelExpanded: (expanded) => {
    set({ panelExpanded: expanded });
  },
}));

// Expose store to window for E2E testing
if (typeof window !== "undefined") {
  (window as any).__WORKFLOW_STORE__ = useWorkflowStore;
}

// ---------------------------------------------------------------------------
// Watchdog: periodically checks for stale workflow cards whose events may
// have been lost. If a workflow exceeds expectedMaxDurationMs without
// receiving workflow_complete, the watchdog queries the REST API and
// forces cleanup (handleWorkflowComplete or clearWorkflow).
// ---------------------------------------------------------------------------

const WATCHDOG_INTERVAL_MS = 30_000;
const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes

if (typeof window !== "undefined") {
  const watchdog = setInterval(async () => {
    const state = useWorkflowStore.getState();
    const now = Date.now();
    for (const [wfId, wf] of state.activeWorkflows) {
      const startedAtMs = new Date(wf.startedAt).getTime();
      const elapsed = now - startedAtMs;
      if (elapsed < DEFAULT_MAX_DURATION_MS) continue;

      console.warn(`[UI] watchdog: wfId=${wfId} exceeded max duration (${elapsed}ms); checking server state`);
      try {
        const { workflows } = await api.listSessionWorkflows(wf.sessionId);
        const serverWf = workflows.find((w) => w.workflowId === wfId);
        if (!serverWf) {
          // Workflow no longer on server — event was lost; force cleanup
          console.warn(`[UI] watchdog: wfId=${wfId} not found on server; forcing clearWorkflow`);
          state.clearWorkflow(wfId);
        } else if (
          serverWf.status === "completed" ||
          serverWf.status === "failed" ||
          serverWf.status === "cancelled"
        ) {
          // Workflow finished but complete event was lost — force completion
          console.warn(`[UI] watchdog: wfId=${wfId} server status=${serverWf.status}; forcing handleWorkflowComplete`);
          state.handleWorkflowComplete({
            workflowId: wfId,
            status: serverWf.status,
            duration: serverWf.durationMs ?? elapsed,
          });
        } else {
          // Still running on server — keep waiting but log
          console.warn(`[UI] watchdog: wfId=${wfId} still running on server after ${elapsed}ms`);
        }
      } catch (err) {
        console.warn(`[UI] watchdog: failed to check wfId=${wfId}:`, err);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
  // 注：原代码 if (watchdog.unref) watchdog.unref() 是从 Node 移植的，
  // 但浏览器 setInterval 返回 number，TS 报 TS2339。浏览器定时器无需 unref，删除即可。
}
