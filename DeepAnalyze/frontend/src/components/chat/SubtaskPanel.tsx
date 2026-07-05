// =============================================================================
// DeepAnalyze - SubtaskPanel Component
// Collapsible panel showing agent task progress
// =============================================================================

import { useState } from "react";
import { useChatStore } from "../../store/chat";
import type { AgentTaskInfo } from "../../types/index";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  ChevronDown,
} from "lucide-react";

function StatusIcon({ status }: { status: string }) {
  const iconStyle: React.CSSProperties = {
    width: 14,
    height: 14,
    flexShrink: 0,
  };
  switch (status) {
    case "running":
      return <Loader2 size={14} style={{ ...iconStyle, color: "var(--warning)", animation: "spin 1s linear infinite" }} />;
    case "completed":
      return <CheckCircle2 size={14} style={{ ...iconStyle, color: "var(--success)" }} />;
    case "failed":
      return <XCircle size={14} style={{ ...iconStyle, color: "var(--error)" }} />;
    case "pending":
      return <Clock size={14} style={{ ...iconStyle, color: "var(--text-tertiary)" }} />;
    case "cancelled":
      return <Ban size={14} style={{ ...iconStyle, color: "var(--text-tertiary)" }} />;
    default:
      return null;
  }
}

interface TaskTreeNode {
  task: AgentTaskInfo;
  children: TaskTreeNode[];
}

function buildTaskTree(tasks: AgentTaskInfo[]): TaskTreeNode[] {
  const map = new Map<string, TaskTreeNode>();
  const roots: TaskTreeNode[] = [];

  for (const task of tasks) {
    map.set(task.id, { task, children: [] });
  }

  for (const task of tasks) {
    const node = map.get(task.id)!;
    if (task.parentId && map.has(task.parentId)) {
      map.get(task.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function TaskItem({ node }: { node: TaskTreeNode }) {
  const [expanded, setExpanded] = useState(false);
  const cancelAgentTask = useChatStore((s) => s.cancelAgentTask);

  return (
    <div style={{
      border: "1px solid var(--border-primary)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          transition: "background var(--transition-fast)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <StatusIcon status={node.task.status} />
        <span style={{
          fontSize: 10,
          fontWeight: "var(--font-medium)",
          padding: "2px 6px",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-tertiary)",
          color: "var(--text-secondary)",
        }}>
          {node.task.agentType}
        </span>
        {node.task.status === "running" && node.task.progress != null && node.task.progress > 0 && (
          <div style={{ flex: "0 0 60px", height: 3, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${node.task.progress}%`, height: "100%", background: "var(--interactive)", borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        )}
        <span style={{
          fontSize: "var(--text-xs)",
          color: "var(--text-secondary)",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {node.task.input.slice(0, 50)}
        </span>
        {node.task.status === "running" && (
          <button
            onClick={(e) => { e.stopPropagation(); cancelAgentTask(node.task.id); }}
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-tertiary)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              transition: "color var(--transition-fast)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            取消
          </button>
        )}
        <ChevronDown
          size={12}
          style={{
            color: "var(--text-tertiary)",
            transition: `transform var(--transition-fast)`,
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            flexShrink: 0,
          }}
        />
      </button>

      {expanded && (
        <div style={{
          borderTop: "1px solid var(--border-primary)",
          padding: "var(--space-2) var(--space-3)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          background: "color-mix(in srgb, var(--bg-primary) 50%, transparent)",
        }}>
          {node.task.input && (
            <div>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>输入:</span>
              <pre style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                marginTop: 2,
                whiteSpace: "pre-wrap",
                margin: 0,
              }}>{node.task.input}</pre>
            </div>
          )}
          {node.task.output && (
            <div>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>输出:</span>
              <pre style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                marginTop: 2,
                whiteSpace: "pre-wrap",
                maxHeight: 128,
                overflowY: "auto",
                margin: 0,
              }}>
                {node.task.output.length > 500 ? node.task.output.slice(0, 500) + "..." : node.task.output}
              </pre>
            </div>
          )}
          {node.task.error && (
            <div>
              <span style={{ fontSize: 10, color: "var(--error)" }}>错误:</span>
              <pre style={{
                fontSize: "var(--text-xs)",
                color: "var(--error)",
                marginTop: 2,
                whiteSpace: "pre-wrap",
                margin: 0,
              }}>{node.task.error}</pre>
            </div>
          )}
          {node.children.length > 0 && (
            <div style={{ marginLeft: 16, marginTop: "var(--space-2)", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              {node.children.map((child) => (
                <TaskItem key={child.task.id} node={child} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SubtaskPanel() {
  const agentTasks = useChatStore((s) => s.agentTasks);
  const hasRunning = agentTasks.some((t) => t.status === "running" || t.status === "pending");
  // Default: collapsed when no running tasks, expanded when there are running tasks
  const [collapsed, setCollapsed] = useState(!hasRunning);

  if (agentTasks.length === 0) return null;

  // Auto-collapse when all tasks finish
  const allDone = agentTasks.every((t) =>
    t.status === "completed" || t.status === "failed" || t.status === "cancelled",
  );

  const running = agentTasks.filter((t) => t.status === "running" || t.status === "pending").length;
  const completed = agentTasks.filter((t) => t.status === "completed").length;
  const failed = agentTasks.filter((t) => t.status === "failed").length;

  // When all done, show collapsed by default and hide if desired
  const shouldHide = allDone && collapsed;

  return (
    <div style={{
      flexShrink: 0,
      borderTop: "1px solid var(--border-primary)",
      background: "var(--bg-secondary)",
      maxHeight: collapsed ? undefined : 192,
    }}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-4)",
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          transition: "background var(--transition-fast)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <ChevronDown
          size={12}
          style={{
            color: "var(--text-tertiary)",
            transition: `transform var(--transition-fast)`,
            transform: collapsed ? "rotate(0deg)" : "rotate(180deg)",
            flexShrink: 0,
          }}
        />
        <span style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--font-medium)",
          color: "var(--text-secondary)",
        }}>
          Agent 任务
        </span>
        {running > 0 && (
          <span style={{
            width: 8,
            height: 8,
            borderRadius: "var(--radius-full)",
            background: "var(--interactive)",
            flexShrink: 0,
          }} />
        )}
        {completed > 0 && (
          <span style={{
            width: 8,
            height: 8,
            borderRadius: "var(--radius-full)",
            background: "var(--success)",
            flexShrink: 0,
          }} />
        )}
        {failed > 0 && (
          <span style={{
            width: 8,
            height: 8,
            borderRadius: "var(--radius-full)",
            background: "var(--error)",
            flexShrink: 0,
          }} />
        )}
        <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
          {running > 0 ? `${running} 运行中` : allDone ? `全部完成` : `${completed} 完成`}
        </span>
      </button>

      {!collapsed && (
        <div style={{
          padding: "0 var(--space-4) var(--space-2)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          overflowY: "auto",
          maxHeight: 144,
        }}>
          {buildTaskTree(agentTasks).map((node) => (
            <TaskItem key={node.task.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}
