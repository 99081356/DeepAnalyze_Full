import { useState, useEffect } from "react";
import { useChatStore } from "../../store/chat";
import { CheckCircle2, Circle, Loader2, ChevronDown, ChevronRight } from "lucide-react";

/**
 * Displays the agent's real-time task list (todo items).
 * Shown above the chat when the agent has active tasks.
 */
export function TodoPanel() {
  const todos = useChatStore((s) => s.todos);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div
      style={{
        padding: "var(--space-2) var(--space-3)",
        background: "var(--surface-primary)",
        borderBottom: "1px solid var(--border-primary)",
        fontSize: "var(--text-xs)",
      }}
    >
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: todos.length > 0 ? "var(--space-2)" : 0,
      }}>
        <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
          Task Progress
        </span>
        <span style={{ color: "var(--text-tertiary)" }}>
          {completed}/{total}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 3,
        background: "var(--bg-tertiary)",
        borderRadius: 2,
        marginBottom: "var(--space-2)",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${progress}%`,
          background: "linear-gradient(90deg, #3b82f6, #06b6d4)",
          borderRadius: 2,
          transition: "width 0.3s ease",
        }} />
      </div>

      {/* Task list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {todos.map((todo) => (
          <div
            key={todo.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "var(--space-2)",
              padding: "2px 0",
              opacity: todo.status === "completed" ? 0.6 : 1,
            }}
          >
            {todo.status === "completed" ? (
              <CheckCircle2 size={12} style={{ color: "#22c55e", flexShrink: 0, marginTop: 2 }} />
            ) : todo.status === "in_progress" ? (
              <Loader2 size={12} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 2, animation: "spin 1s linear infinite" }} />
            ) : (
              <Circle size={12} style={{ color: "var(--text-tertiary)", flexShrink: 0, marginTop: 2 }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{
                color: todo.status === "completed" ? "var(--text-tertiary)" : "var(--text-primary)",
                textDecoration: todo.status === "completed" ? "line-through" : "none",
                wordBreak: "break-word",
              }}>
                {typeof todo.subject === "string" ? todo.subject : String(todo.subject ?? "")}
              </span>
              {todo.description && (
                <div style={{
                  color: "var(--text-tertiary)",
                  fontSize: "var(--text-xs)",
                  marginTop: 1,
                  lineHeight: 1.3,
                  wordBreak: "break-word",
                }}>
                  {typeof todo.description === "string" ? todo.description : String(todo.description)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Expandable todo panel for the sidebar.
 * Auto-clears when all tasks are completed.
 */
export function TodoMiniPanel() {
  const todos = useChatStore((s) => s.todos);
  const clearTodos = useChatStore((s) => s.clearTodos);
  const [expanded, setExpanded] = useState(false);

  // Auto-clear completed todos after a short delay
  useEffect(() => {
    if (todos.length > 0 && todos.every((t) => t.status === "completed")) {
      const timer = setTimeout(() => {
        clearTodos();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [todos, clearTodos]);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const allDone = completed === total;

  // Find the current in-progress task (or next pending)
  const current = todos.find((t) => t.status === "in_progress")
    ?? todos.find((t) => t.status === "pending");

  return (
    <div
      style={{
        marginTop: "var(--space-2)",
        borderTop: "1px solid var(--border-primary)",
        fontSize: "var(--text-xs)",
        flexShrink: 0,
        opacity: allDone ? 0.5 : 1,
        transition: "opacity 0.5s ease",
      }}
    >
      {/* Header - clickable to expand/collapse */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          padding: "var(--space-1) 0",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: "inherit",
          gap: "var(--space-1)",
        }}
      >
        {expanded ? <ChevronDown size={12} style={{ flexShrink: 0 }} /> : <ChevronRight size={12} style={{ flexShrink: 0 }} />}
        <span style={{ fontWeight: 600, color: "var(--text-secondary)", flex: 1, textAlign: "left" }}>
          任务进度
        </span>
        <span style={{ color: "var(--text-tertiary)" }}>
          {completed}/{total}
        </span>
      </button>

      {/* Progress bar */}
      <div style={{
        height: 2,
        background: "var(--bg-tertiary)",
        borderRadius: 2,
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${progress}%`,
          background: allDone
            ? "linear-gradient(90deg, #22c55e, #4ade80)"
            : "linear-gradient(90deg, #3b82f6, #06b6d4)",
          borderRadius: 2,
          transition: "width 0.3s ease",
        }} />
      </div>

      {/* Collapsed: show current task */}
      {!expanded && current && !allDone && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "var(--space-1) 0 0 0",
          overflow: "hidden",
        }}>
          {current.status === "in_progress" ? (
            <Loader2 size={10} style={{ color: "#3b82f6", flexShrink: 0, animation: "spin 1s linear infinite" }} />
          ) : (
            <Circle size={10} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
          )}
          <span style={{
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: 1.3,
          }}>
            {typeof current.subject === "string" ? current.subject : String(current.subject ?? "")}
          </span>
        </div>
      )}

      {/* Expanded: show all tasks */}
      {expanded && (
        <div style={{
          padding: "var(--space-1) 0 var(--space-1) 0",
          maxHeight: 200,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}>
          {todos.map((todo) => (
            <div
              key={todo.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-1)",
                padding: "2px 0",
                opacity: todo.status === "completed" ? 0.5 : 1,
              }}
            >
              {todo.status === "completed" ? (
                <CheckCircle2 size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />
              ) : todo.status === "in_progress" ? (
                <Loader2 size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1, animation: "spin 1s linear infinite" }} />
              ) : (
                <Circle size={11} style={{ color: "var(--text-tertiary)", flexShrink: 0, marginTop: 1 }} />
              )}
              <span style={{
                color: todo.status === "completed" ? "var(--text-tertiary)" : "var(--text-primary)",
                textDecoration: todo.status === "completed" ? "line-through" : "none",
                wordBreak: "break-word",
                lineHeight: 1.3,
              }}>
                {typeof todo.subject === "string" ? todo.subject : String(todo.subject ?? "")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
