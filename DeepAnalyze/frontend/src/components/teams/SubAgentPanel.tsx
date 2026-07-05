// =============================================================================
// DeepAnalyze - SubAgentPanel Component
// Workflow panel with three display modes:
//   - expanded: title bar + agent status chips row (~88px)
//   - compact:  single thin row with status summary (~28px)
//   - expanded-detail: full SubAgentSlot list (click to toggle)
// Mode selection is driven by the parent via `panelMode` prop, computed from
// the workflow store's forceCompactAll/userOverride + an auto heuristic.
// =============================================================================

import { useState, useMemo, useEffect } from "react";
import { useWorkflowStore } from "../../store/workflow";
import { SubAgentSlot } from "./SubAgentSlot";
import type { PanelMode } from "./panel-mode";
import { Users, Clock, ChevronRight, ChevronDown } from "lucide-react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SubAgentPanelProps {
  /** The workflow ID to display */
  workflowId: string;
  /** Display mode computed by parent (ChatWindow) via selectPanelMode. */
  panelMode: PanelMode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

const MODE_LABELS: Record<string, string> = {
  pipeline: "流水线",
  graph: "图",
  council: "会议",
  parallel: "并行",
};

const STATUS_CHIP_DOT: Record<string, string> = {
  queued: "var(--text-tertiary)",
  running: "var(--success)",
  waiting: "var(--warning)",
  completed: "var(--interactive)",
  error: "var(--error)",
};

/** Status dot color for an entire workflow (worst-case wins). */
function workflowDotColor(
  hasRunning: boolean,
  hasError: boolean,
  allDone: boolean,
): string {
  if (hasError) return STATUS_CHIP_DOT.error;
  if (hasRunning) return STATUS_CHIP_DOT.running;
  if (allDone) return STATUS_CHIP_DOT.completed;
  return STATUS_CHIP_DOT.queued;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SubAgentPanel({ workflowId, panelMode }: SubAgentPanelProps) {
  const [panelExpanded, setPanelExpanded] = useState(false);
  const activeWorkflows = useWorkflowStore((s) => s.activeWorkflows);
  const setUserOverride = useWorkflowStore((s) => s.setUserOverride);
  const userOverride = useWorkflowStore((s) => s.userOverride);

  // Real-time elapsed timer — ticks every second while workflow has running agents
  const [elapsedTick, setElapsedTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setElapsedTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  // Use elapsedTick in a no-op expression to prevent it being unused
  void elapsedTick;

  const workflow = useMemo(
    () => activeWorkflows.get(workflowId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeWorkflows, workflowId, elapsedTick],
  );

  if (!workflow) return null;

  const agents = Array.from(workflow.agents.values());
  const regularAgents = agents.filter((a) => a.agentId !== "synthesis-audit");
  const auditAgent = agents.find((a) => a.agentId === "synthesis-audit");
  const completedCount = agents.filter((a) => a.status === "completed").length;
  const errorCount = agents.filter((a) => a.status === "error").length;
  const runningCount = agents.filter((a) => a.status === "running").length;
  const regularComplete =
    regularAgents.length > 0 &&
    regularAgents.every(
      (a) => a.status === "completed" || a.status === "error",
    );
  const isAuditPhase = regularComplete && !!auditAgent && auditAgent.status === "running";
  const isComplete =
    agents.length > 0 && completedCount + errorCount === agents.length;
  const hasRunning = runningCount > 0 || isAuditPhase;
  const dotColor = workflowDotColor(hasRunning, errorCount > 0, isComplete);

  /** Click handler: behavior depends on mode. */
  const handleTitleClick = () => {
    if (!panelExpanded) {
      // Entering expanded-detail.
      // If we're in compact mode (auto or forced), lock expansion via userOverride
      // so the auto heuristic doesn't immediately re-collapse us on next render.
      if (panelMode === "compact") {
        setUserOverride(workflowId, "expanded");
      }
      setPanelExpanded(true);
    } else {
      // Leaving expanded-detail. Clear any userOverride set on entry so the
      // panel returns to its natural mode (auto/forced).
      if (userOverride.get(workflowId) === "expanded") {
        setUserOverride(workflowId, null);
      }
      setPanelExpanded(false);
    }
  };

  // -------------------------------------------------------------------------
  // Compact mode: single ~28px row
  // -------------------------------------------------------------------------
  if (panelMode === "compact" && !panelExpanded) {
    return (
      <div
        data-workflow-id={workflowId}
        data-panel-mode="compact"
        style={{
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-primary)",
        }}
      >
        <div
          onClick={handleTitleClick}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "4px var(--space-3)",
            cursor: "pointer",
            userSelect: "none",
            height: 28,
            fontSize: 11,
          }}
        >
          {/* Status dot — color reflects workflow-level status */}
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "var(--radius-full)",
              background: dotColor,
              flexShrink: 0,
              animation: hasRunning ? "pulse 1.5s ease-in-out infinite" : "none",
            }}
          />

          {/* teamName (truncated) */}
          <span
            style={{
              color: "var(--text-primary)",
              fontWeight: "var(--font-medium)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 200,
            }}
          >
            {workflow.teamName}
          </span>

          {/* Mode badge */}
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-tertiary)",
              color: "var(--text-secondary)",
              flexShrink: 0,
            }}
          >
            {MODE_LABELS[workflow.mode] ?? workflow.mode}
          </span>

          {/* Elapsed time */}
          <span
            style={{
              fontSize: 10,
              color: "var(--text-tertiary)",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
            }}
          >
            <Clock size={10} />
            {formatTimeSince(workflow.startedAt)}
          </span>

          {/* Completion summary: X/Y (only when agents exist) */}
          {agents.length > 0 && (
            <span
              style={{
                fontSize: 10,
                color: errorCount > 0 ? "var(--error)" : "var(--text-secondary)",
                flexShrink: 0,
              }}
            >
              {isAuditPhase
                ? "审计中"
                : `${completedCount + errorCount}/${agents.length}${
                    errorCount > 0 ? ` (${errorCount}失败)` : ""
                  }`}
            </span>
          )}

          <span style={{ flex: 1 }} />

          <ChevronRight
            size={12}
            style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
          />
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Expanded mode (title bar + chips) or expanded-detail mode (full list)
  // -------------------------------------------------------------------------
  return (
    <div
      data-workflow-id={workflowId}
      data-panel-mode={panelExpanded ? "detail" : "expanded"}
      style={{
        borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}
    >
      {/* ---- Title bar (always visible, clickable) ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={handleTitleClick}
      >
        <Users
          size={14}
          style={{ color: "var(--interactive)", flexShrink: 0 }}
        />

        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-semibold)",
            color: "var(--text-primary)",
            flexShrink: 0,
          }}
        >
          {workflow.teamName}
        </span>

        {/* Mode badge */}
        <span
          style={{
            fontSize: 10,
            fontWeight: "var(--font-medium)",
            padding: "2px 8px",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-tertiary)",
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          {MODE_LABELS[workflow.mode] ?? workflow.mode}
        </span>

        {/* Agent count */}
        <span
          style={{
            fontSize: 10,
            color: "var(--text-tertiary)",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            flexShrink: 0,
          }}
        >
          <Users size={10} />
          {agents.length}
        </span>

        {/* Elapsed time */}
        <span
          style={{
            fontSize: 10,
            color: "var(--text-tertiary)",
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            flexShrink: 0,
          }}
        >
          <Clock size={10} />
          {formatTimeSince(workflow.startedAt)}
        </span>

        {/* Status summary */}
        {isAuditPhase && (
          <span
            style={{
              fontSize: 10,
              color: "var(--warning)",
              flexShrink: 0,
              fontWeight: "var(--font-medium)",
            }}
          >
            综合审计中...
          </span>
        )}
        {!isAuditPhase && isComplete && (
          <span
            style={{
              fontSize: 10,
              color: errorCount > 0 ? "var(--error)" : "var(--success)",
              flexShrink: 0,
            }}
          >
            {errorCount > 0 ? `${errorCount} 失败` : "全部完成"}
          </span>
        )}
        {!isComplete && runningCount > 0 && !isAuditPhase && (
          <span
            style={{
              fontSize: 10,
              color: "var(--success)",
              flexShrink: 0,
            }}
          >
            {runningCount} 运行中
          </span>
        )}

        {/* Spacer */}
        <span style={{ flex: 1 }} />

        {/* Expand chevron */}
        {panelExpanded ? (
          <ChevronDown
            size={14}
            style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
          />
        ) : (
          <ChevronRight
            size={14}
            style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
          />
        )}
      </div>

      {/* ---- Collapsed: agent status chips (only when not in detail mode) ---- */}
      {!panelExpanded && agents.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-1)",
            padding: "0 var(--space-3) var(--space-2)",
          }}
        >
          {regularAgents.map((agent) => (
            <span
              key={agent.agentId}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: "var(--radius-full)",
                background: "var(--bg-primary)",
                border: "1px solid var(--border-primary)",
                color: "var(--text-secondary)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "var(--radius-full)",
                  background:
                    STATUS_CHIP_DOT[agent.status] ??
                    STATUS_CHIP_DOT.queued,
                  flexShrink: 0,
                  animation:
                    agent.status === "running"
                      ? "pulse 1.5s ease-in-out infinite"
                      : "none",
                }}
              />
              {agent.role}
            </span>
          ))}
          {auditAgent && (
            <>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>|</span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-full)",
                  background: "color-mix(in srgb, var(--warning) 10%, var(--bg-primary))",
                  border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
                  color: "var(--text-secondary)",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "var(--radius-full)",
                    background:
                      STATUS_CHIP_DOT[auditAgent.status] ??
                      STATUS_CHIP_DOT.queued,
                    flexShrink: 0,
                    animation:
                      auditAgent.status === "running"
                        ? "pulse 1.5s ease-in-out infinite"
                        : "none",
                  }}
                />
                {auditAgent.role}
              </span>
            </>
          )}
        </div>
      )}

      {/* ---- Expanded: agent detail list ---- */}
      {panelExpanded && (
        <div
          style={{
            maxHeight: "calc(100vh - 200px)",
            overflowY: "auto",
            padding: "var(--space-2) var(--space-3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {regularAgents.map((agent) => (
            <SubAgentSlot
              key={agent.agentId}
              agentId={agent.agentId}
              role={agent.role}
              task={agent.task}
              status={agent.status}
              duration={agent.duration}
              toolCallCount={agent.toolCallCount}
              progress={agent.progress}
              messages={agent.messages}
            />
          ))}
          {auditAgent && (
            <>
              <div
                style={{
                  borderTop: "1px dashed var(--border-primary)",
                  margin: "var(--space-1) 0",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  color: "var(--text-tertiary)",
                  fontSize: 10,
                  padding: "2px 0",
                }}
              >
                <span style={{ flex: 1, borderTop: "1px dashed var(--border-primary)" }} />
                <span>第二阶段：综合审计</span>
                <span style={{ flex: 1, borderTop: "1px dashed var(--border-primary)" }} />
              </div>
              <SubAgentSlot
                key={auditAgent.agentId}
                agentId={auditAgent.agentId}
                role={auditAgent.role}
                task={auditAgent.task}
                status={auditAgent.status}
                duration={auditAgent.duration}
                toolCallCount={auditAgent.toolCallCount}
                progress={auditAgent.progress}
                messages={auditAgent.messages}
              />
            </>
          )}

          {agents.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "var(--space-4)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-sm)",
              }}
            >
              等待 Agent 启动...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
