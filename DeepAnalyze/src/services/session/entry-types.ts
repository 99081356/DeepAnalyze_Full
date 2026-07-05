/**
 * JSONL entry type definitions for lossless session persistence.
 *
 * Each session is stored as one or more JSONL files under:
 *   data/sessions/{sessionId}/transcripts/{taskId}.jsonl
 *
 * Every entry carries:
 *   - uuid        : unique identifier for this entry
 *   - parentUuid  : uuid of the previous entry (null for compact boundaries)
 *   - timestamp   : ISO-8601 timestamp
 *
 * Reference: refcode/claude-code/src/types/logs.ts
 */

// ── Base fields present on every entry ──────────────────────────────

export interface EntryBase {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
}

// ── User input ──────────────────────────────────────────────────────

export interface UserEntry extends EntryBase {
  type: "user";
  content: string;
  sessionId: string;
}

// ── Assistant text output (streamed deltas) ─────────────────────────

export interface AssistantEntry extends EntryBase {
  type: "assistant";
  content: string;
  turn: number;
  taskId: string;
  isDelta?: boolean;
}

// ── Thinking / reasoning content ────────────────────────────────────

export interface ThinkingEntry extends EntryBase {
  type: "thinking";
  content: string;
  turn: number;
  taskId: string;
}

// ── Tool call (full input preserved) ────────────────────────────────

export interface ToolUseEntry extends EntryBase {
  type: "tool_use";
  toolCallId: string;
  toolName: string;
  /** Full input — never truncated */
  input: unknown;
  turn: number;
  taskId: string;
}

// ── Tool result (full output preserved) ─────────────────────────────

export interface ToolResultEntry extends EntryBase {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  /** Full output — never truncated */
  output: string;
  /** If output was large enough to persist separately on disk */
  persistedFilePath?: string;
  error?: boolean;
  turn: number;
  taskId: string;
}

// ── Session metadata ────────────────────────────────────────────────

export interface SessionMetaEntry extends EntryBase {
  type: "session_meta";
  sessionId: string;
  title?: string;
  kbScope?: string;
}

// ── Token usage per turn ────────────────────────────────────────────

export interface TurnUsageEntry extends EntryBase {
  type: "turn_usage";
  turn: number;
  taskId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

// ── Compact boundary (context compression marker) ───────────────────
// parentUuid is always null — breaks the chain for recovery

export interface CompactBoundaryEntry extends EntryBase {
  type: "compact_boundary";
  parentUuid: null;
  sessionId: string;
  meta?: {
    trigger?: string;
    tokensBefore?: number;
    tokensAfter?: number;
  };
  summaryContent?: string;
}

// ── Sub-agent reference ─────────────────────────────────────────────

export interface SubAgentEntry extends EntryBase {
  type: "sub_agent";
  subTaskId: string;
  parentTaskId: string;
  agentType: string;
  /** Relative path to the sub-agent's own JSONL transcript */
  transcriptPath: string;
  output?: string;
}

// ── Union type ──────────────────────────────────────────────────────

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ThinkingEntry
  | ToolUseEntry
  | ToolResultEntry
  | SessionMetaEntry
  | TurnUsageEntry
  | CompactBoundaryEntry
  | SubAgentEntry;

// ── Reconstructed structures ────────────────────────────────────────

export interface ToolCallReconstructed {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: string;
  persistedFilePath?: string;
  error?: boolean;
}

export interface TurnReconstructed {
  turn: number;
  taskId: string;
  firstTimestamp: string;
  userContent: string;
  assistantContent: string;
  thinkingContent: string;
  toolCalls: ToolCallReconstructed[];
  usage?: TurnUsageEntry["usage"];
}

export interface ReconstructedSession {
  sessionId: string;
  meta?: SessionMetaEntry;
  /** The user input that started the session */
  userInput?: string;
  /** Turns sorted chronologically */
  turns: TurnReconstructed[];
  /** Compact boundary positions for recovery */
  compactBoundaries: CompactBoundaryEntry[];
  /** Sub-agent references */
  subAgents: SubAgentEntry[];
  /** All entries in chronological order */
  allEntries: TranscriptEntry[];
}
