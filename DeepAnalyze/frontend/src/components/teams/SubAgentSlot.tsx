// =============================================================================
// DeepAnalyze - SubAgentSlot Component
// Single agent card with expand/collapse — shows real-time thinking, tool calls,
// and output for a sub-agent in a parallel workflow.
// =============================================================================

import { useState, useRef, useEffect } from "react";
import { Wrench, ChevronRight, ChevronDown, AlertTriangle } from "lucide-react";
import type { AgentState, AgentMessage } from "../../store/workflow";

// ---------------------------------------------------------------------------
// Status colour mapping
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, { dot: string; bg: string; label: string }> = {
  queued: { dot: "var(--text-tertiary)", bg: "var(--bg-tertiary)", label: "排队中" },
  running: { dot: "var(--success)", bg: "color-mix(in srgb, var(--success) 12%, transparent)", label: "运行中" },
  waiting: { dot: "var(--warning)", bg: "color-mix(in srgb, var(--warning) 12%, transparent)", label: "等待中" },
  completed: { dot: "var(--interactive)", bg: "color-mix(in srgb, var(--interactive) 12%, transparent)", label: "已完成" },
  error: { dot: "var(--error)", bg: "color-mix(in srgb, var(--error) 12%, transparent)", label: "错误" },
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SubAgentSlotProps {
  agentId: string;
  role: string;
  task: string;
  status: AgentState["status"];
  duration: number;
  toolCallCount: number;
  progress: number;
  messages: AgentMessage[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "-";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s}s`;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

// ---------------------------------------------------------------------------
// Message grouping — coalesce consecutive chunks into a single block
// ---------------------------------------------------------------------------

interface MessageGroup {
  type: "chunks" | "tool_call" | "tool_result" | "error" | "output";
  content: string;
  toolName?: string;
  input?: Record<string, unknown>;
}

function groupMessages(messages: AgentMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentChunks: string[] = [];

  const flushChunks = () => {
    if (currentChunks.length > 0) {
      groups.push({ type: "chunks", content: currentChunks.join("") });
      currentChunks = [];
    }
  };

  for (const msg of messages) {
    if (msg.type === "chunk") {
      currentChunks.push(msg.content);
    } else {
      flushChunks();
      switch (msg.type) {
        case "tool_call":
          groups.push({
            type: "tool_call",
            content: msg.content,
            toolName: msg.toolName,
            input: msg.input,
          });
          break;
        case "tool_result":
          groups.push({
            type: "tool_result",
            content: msg.content,
            toolName: msg.toolName,
          });
          break;
        case "error":
          groups.push({ type: "error", content: msg.content });
          break;
        default:
          groups.push({ type: "output", content: msg.content });
          break;
      }
    }
  }
  flushChunks();

  return groups;
}

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

/** Tool call card — tool name badge + expandable JSON input */
function ToolCallBlock({ group }: { group: MessageGroup }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        padding: "var(--space-1) var(--space-2)",
        background: "color-mix(in srgb, var(--interactive) 6%, var(--bg-secondary))",
        borderRadius: "var(--radius-md)",
        border: "1px solid color-mix(in srgb, var(--interactive) 20%, transparent)",
        fontSize: 11,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          cursor: "pointer",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench size={10} style={{ color: "var(--interactive)", flexShrink: 0 }} />
        <span
          style={{
            fontWeight: "var(--font-semibold)",
            color: "var(--interactive)",
            padding: "1px 6px",
            background: "color-mix(in srgb, var(--interactive) 15%, transparent)",
            borderRadius: "var(--radius-sm)",
            fontSize: 10,
          }}
        >
          {group.toolName}
        </span>
        {expanded ? (
          <ChevronDown size={10} style={{ color: "var(--text-tertiary)" }} />
        ) : (
          <ChevronRight size={10} style={{ color: "var(--text-tertiary)" }} />
        )}
      </div>
      {expanded && group.input && (
        <pre
          style={{
            margin: "var(--space-1) 0 0",
            padding: "var(--space-1) var(--space-2)",
            background: "var(--bg-primary)",
            borderRadius: "var(--radius-sm)",
            fontSize: 10,
            lineHeight: 1.4,
            color: "var(--text-secondary)",
            overflow: "auto",
            maxHeight: 120,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {JSON.stringify(group.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Tool result card — tool name + collapsible output */
function ToolResultBlock({ group }: { group: MessageGroup }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = group.content.length > 200;

  return (
    <div
      style={{
        padding: "var(--space-1) var(--space-2)",
        background: "var(--bg-primary)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-primary)",
        fontSize: 11,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          cursor: isLong ? "pointer" : "default",
        }}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
          ↳ {group.toolName}
        </span>
        {isLong &&
          (expanded ? (
            <ChevronDown size={10} style={{ color: "var(--text-tertiary)" }} />
          ) : (
            <ChevronRight size={10} style={{ color: "var(--text-tertiary)" }} />
          ))}
        {!expanded && isLong && (
          <span style={{ color: "var(--text-tertiary)", fontSize: 10 }}>
            {" "}
            ({group.content.length} 字符)
          </span>
        )}
      </div>
      <div
        style={{
          marginTop: 2,
          color: "var(--text-secondary)",
          fontSize: 10,
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          maxHeight: expanded ? 200 : 60,
          overflow: "auto",
        }}
      >
        {expanded ? group.content : truncate(group.content, 200)}
      </div>
    </div>
  );
}

/** Coalesced chunk text block */
function ChunkBlock({ group }: { group: MessageGroup }) {
  return (
    <div
      style={{
        padding: "var(--space-1) var(--space-2)",
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--text-secondary)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 160,
        overflow: "auto",
      }}
    >
      {truncate(group.content, 1000)}
    </div>
  );
}

/** Error message with red highlight */
function ErrorBlock({ group }: { group: MessageGroup }) {
  return (
    <div
      style={{
        padding: "var(--space-1) var(--space-2)",
        background: "color-mix(in srgb, var(--error) 10%, var(--bg-secondary))",
        borderRadius: "var(--radius-md)",
        border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)",
        display: "flex",
        gap: "var(--space-1)",
        alignItems: "flex-start",
        fontSize: 11,
      }}
    >
      <AlertTriangle
        size={12}
        style={{ color: "var(--error)", flexShrink: 0, marginTop: 1 }}
      />
      <span
        style={{
          color: "var(--error)",
          lineHeight: 1.4,
          wordBreak: "break-all",
        }}
      >
        {group.content}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SubAgentSlot({
  agentId,
  role,
  task,
  status,
  duration,
  toolCallCount,
  progress,
  messages,
}: SubAgentSlotProps) {
  const [expanded, setExpanded] = useState(false);
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.queued;
  const isRunning = status === "running";
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll detail area when new messages arrive
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [expanded, messages.length]);

  const messageGroups = expanded ? groupMessages(messages) : [];

  return (
    <div
      style={{
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-secondary)",
        overflow: "hidden",
      }}
    >
      {/* ---- Header row (always visible, clickable to expand) ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          cursor: "pointer",
          userSelect: "none",
          background: expanded ? "var(--bg-tertiary)" : "transparent",
          transition: "background var(--transition-fast)",
        }}
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={(e) => {
          if (!expanded) e.currentTarget.style.background = "var(--bg-tertiary)";
        }}
        onMouseLeave={(e) => {
          if (!expanded) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* Status dot */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "var(--radius-full)",
            background: colors.dot,
            flexShrink: 0,
            animation: isRunning
              ? "pulse 1.5s ease-in-out infinite"
              : "none",
          }}
        />

        {/* Role name */}
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-semibold)",
            color: "var(--text-primary)",
            flexShrink: 0,
          }}
        >
          {role}
        </span>

        {/* Task summary (truncated) */}
        <span
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {truncate(task, 80)}
        </span>

        {/* Tool call count */}
        {toolCallCount > 0 && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              fontSize: 10,
              color: "var(--text-secondary)",
              background: "var(--bg-primary)",
              padding: "1px 6px",
              borderRadius: "var(--radius-sm)",
              flexShrink: 0,
            }}
          >
            <Wrench size={10} />
            {toolCallCount}
          </span>
        )}

        {/* Duration */}
        <span
          style={{
            fontSize: 10,
            color: "var(--text-tertiary)",
            fontFamily: "monospace",
            flexShrink: 0,
          }}
        >
          {formatDuration(duration)}
        </span>

        {/* Status label */}
        <span
          style={{
            fontSize: 10,
            fontWeight: "var(--font-medium)",
            color: colors.dot,
            padding: "1px 6px",
            borderRadius: "var(--radius-sm)",
            background: colors.bg,
            flexShrink: 0,
          }}
        >
          {colors.label}
        </span>

        {/* Expand chevron */}
        {expanded ? (
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

      {/* ---- Expanded detail area ---- */}
      {expanded && (
        <div
          ref={scrollRef}
          style={{
            borderTop: "1px solid var(--border-primary)",
            maxHeight: 400,
            overflowY: "auto",
            padding: "var(--space-2) var(--space-3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {messageGroups.length === 0 && (
            <div
              style={{
                color: "var(--text-tertiary)",
                fontSize: 11,
                textAlign: "center",
                padding: "var(--space-4)",
              }}
            >
              等待中...
            </div>
          )}
          {messageGroups.map((group, i) => {
            switch (group.type) {
              case "tool_call":
                return <ToolCallBlock key={`tc-${i}`} group={group} />;
              case "tool_result":
                return <ToolResultBlock key={`tr-${i}`} group={group} />;
              case "error":
                return <ErrorBlock key={`err-${i}`} group={group} />;
              default:
                // chunks & output both render as text
                return <ChunkBlock key={`${group.type}-${i}`} group={group} />;
            }
          })}
        </div>
      )}
    </div>
  );
}
