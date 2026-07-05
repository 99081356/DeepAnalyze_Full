// =============================================================================
// DeepAnalyze - Agent Type Definitions
// =============================================================================
// Core types for the standalone agent execution system.
// =============================================================================

import type { ChatMessage } from "../../models/provider.js";

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

/**
 * Defines a type of agent with its capabilities, system prompt, and tool access.
 */
export interface AgentDefinition {
  /** Unique identifier for this agent type */
  agentType: string;
  /** Human-readable description of when to use this agent */
  description: string;
  /** System prompt for this agent */
  systemPrompt: string;
  /** Tools this agent can use (tool names). Use ["*"] for all tools. */
  tools: string[];
  /** Model role to use (defaults to "main") */
  modelRole?: "main" | "summarizer" | "embedding" | "vlm";
  /** Maximum turns before stopping (default 20) */
  maxTurns?: number;
  /** Whether this agent runs in read-only mode */
  readOnly?: boolean;
  /**
   * C3.4: Maximum output tokens for this agent type.
   * Overrides the default maxTokens calculation.
   * - Analysis/report agents: 32768+ (detailed reports need more space)
   * - Simple Q&A agents: 8192 (concise answers)
   * - Undefined: use system default (16384)
   */
  outputTokenBudget?: number;
}

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

/**
 * A tool that can be used by an agent.
 * Follows the same pattern as the existing DeepAnalyze tools (KBSearchTool, etc.).
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  execute(input: Record<string, unknown>): Promise<unknown>;
  /** Optional JSON schema for input validation */
  inputSchema?: Record<string, unknown>;

  /**
   * Whether this tool is read-only for the given input. Read-only tools
   * don't modify state and can safely run in parallel.
   * Default: false
   */
  isReadOnly?(input: Record<string, unknown>): boolean;

  /**
   * Whether this tool can run concurrently with other tools for the given input.
   * Default: same as isReadOnly
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean;

  /**
   * Whether this tool performs destructive operations (delete, overwrite, send).
   * Default: false
   */
  isDestructive?(input: Record<string, unknown>): boolean;

  /**
   * Max chars before tool result gets persisted to disk.
   * Infinity = never persist. Default: 50_000
   */
  maxResultSizeChars?: number;

  /**
   * Whether this tool should be deferred (not sent in initial tool definitions).
   * Discovered via tool_discover at runtime.
   * Default: false
   */
  shouldDefer?: boolean;

  /**
   * Whether this tool requires KB scope to be useful.
   * If true, the tool is excluded from LLM tool definitions when no KB is
   * associated with the current session (no scopeKbIds in execution context).
   * Saves ~2000-3000 tokens/request in non-KB sessions.
   */
  requiresKbScope?: boolean;
}

// ---------------------------------------------------------------------------
// Execution status
// ---------------------------------------------------------------------------

/** Status of an agent task */
export type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

// ---------------------------------------------------------------------------
// Task tracking
// ---------------------------------------------------------------------------

/**
 * An instance of an agent execution. Tracks the full lifecycle of a task
 * from creation through completion.
 */
export interface AgentTask {
  id: string;
  agentType: string;
  status: AgentStatus;
  /** The original prompt/task input */
  input: string;
  /** Final result text */
  output: string | null;
  /** Error message if failed */
  error: string | null;
  /** Parent task ID for sub-agents */
  parentId: string | null;
  /** Associated chat session */
  sessionId: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Turn-by-turn progress messages */
  progress: AgentProgressEntry[];
}

/**
 * A single progress entry recording activity during an agent turn.
 */
export interface AgentProgressEntry {
  turn: number;
  timestamp: string;
  type: "thinking" | "tool_call" | "tool_result" | "text" | "error";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Events emitted during agent execution. Used for real-time progress
 * reporting via callbacks and WebSocket.
 */
export type AgentEvent =
  | { type: "start"; taskId: string; agentType: string }
  | { type: "text_delta"; taskId: string; turn: number; delta: string }
  | { type: "thinking_delta"; taskId: string; turn: number; delta: string }
  | { type: "content_reset"; taskId: string; turn: number; reason: string }
  | { type: "turn"; taskId: string; turn: number; content: string }
  | { type: "turn_usage"; taskId: string; turn: number; usage: { inputTokens: number; outputTokens: number; cachedTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number; estimatedCostUsd?: number } }
  | { type: "tool_call"; taskId: string; turn: number; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; taskId: string; turn: number; toolName: string; result: unknown }
  | { type: "progress"; taskId: string; progress: AgentProgressEntry }
  | { type: "complete"; taskId: string; output: string }
  | { type: "error"; taskId: string; error: string }
  | { type: "cancelled"; taskId: string }
  | { type: "compaction"; taskId: string; turn: number; method: string; tokensSaved: number }
  | { type: "advisory_limit_reached"; taskId: string; turn: number }
  | { type: "budget_state"; taskId: string; turn: number; previousState: string; newState: string; info: unknown };

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The result of a completed agent execution.
 */
export interface AgentResult {
  taskId: string;
  output: string;
  toolCallsCount: number;
  turnsUsed: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Tokens served from prompt cache (Anthropic cache_read_input_tokens). */
    cachedTokens?: number;
    /** Explicit alias for cachedTokens — same value, kept for naming clarity. */
    cacheReadTokens?: number;
    /** Tokens written into the prompt cache (Anthropic cache_creation_input_tokens). */
    cacheCreationTokens?: number;
  };
  compactionEvents?: Array<{ turn: number; method: string; tokensSaved: number }>;
  /** Path to transcript file for sub-agent debugging (absolute path on disk) */
  transcriptPath?: string;
  /** Estimated total cost in USD for this run */
  estimatedCostUsd?: number;
  /** Summary from the agent's finish tool call — the agent's own concise summary of its work */
  finishSummary?: string;
  /** File paths written by the agent via write_file tool calls */
  filesWritten?: string[];
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

/**
 * Options for running an agent task.
 */
export interface AgentRunOptions {
  /** Pre-generated task ID (used for persistence/reconnect). If omitted, a random UUID is used. */
  taskId?: string;
  /** The task/prompt for the agent */
  input: string;
  /** Media attachment IDs to include with the request */
  mediaIds?: string[];
  /** Agent type to use (default: "general") */
  agentType?: string;
  /** Parent task ID for sub-agents */
  parentTaskId?: string;
  /** Session ID for context */
  sessionId?: string;
  /** Maximum turns override */
  maxTurns?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Event callback for real-time progress */
  onEvent?: (event: AgentEvent) => void;
  /** Additional context messages to prepend before the user input */
  contextMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Model role override */
  modelRole?: "main" | "summarizer" | "embedding" | "vlm";
  /** Optional system prompt override (used for skill execution). */
  systemPromptOverride?: string;
  /** Optional tool override (used for skill execution). */
  toolsOverride?: string[];
  /** Whether this run is a skill invocation (allows workflow_run and agent_todo access). */
  isSkillInvocation?: boolean;
  /** Enable continuous running mode (default: true). When true, uses while(true) loop. */
  continuous?: boolean;
  /** Knowledge base ID for auto-compounding results after task completion. */
  kbId?: string;
  /** Analysis scope to constrain agent to specific knowledge bases or documents. */
  scope?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Re-export provider types needed by the agent system
// ---------------------------------------------------------------------------

// These are imported from our provider module but also re-exported here
// for convenience of agent consumers.

export type { ToolCall } from "../../models/provider.js";
export type { ChatMessage, ChatResponse } from "../../models/provider.js";

// ---------------------------------------------------------------------------
// Compact Boundary
// ---------------------------------------------------------------------------

/**
 * Metadata stored in a compact boundary message.
 * Compact boundaries mark where context was compressed, allowing the
 * context loader to skip pre-boundary messages on subsequent requests.
 */
export interface CompactBoundaryMeta {
  type: "compact_boundary";
  method: "sm-compact" | "legacy-compact" | "hierarchical-compact" | "emergency-sm-compact" | "emergency-legacy-compact" | "proactive-sm-compact" | "proactive-legacy-compact" | "proactive-hierarchical-compact";
  preCompactTokens: number;
  turnNumber: number;
  timestamp: string;
}

/** SM-compact token budget configuration */
export interface SMCompactConfig {
  /** Minimum tokens of recent context to keep. Default: 10_000 */
  minTokens: number;
  /** Maximum tokens of recent context to keep. Default: 40_000 */
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Session Memory
// ---------------------------------------------------------------------------

/**
 * A structured memory note extracted from a conversation session.
 * Stored in the session_memory table and injected into the system prompt.
 */
export interface SessionMemoryNote {
  id: string;
  sessionId: string;
  content: string;
  tokenCount: number;
  lastTokenPosition: number;
  searchIndexJson?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent Settings (configurable via frontend)
// ---------------------------------------------------------------------------

/**
 * Runtime-configurable agent parameters.
 * Stored in the settings table under the 'agent_settings' key.
 */
export interface AgentSettings {
  /** Maximum turns per agent task. -1 = unlimited (default). */
  maxTurns: number;
  /** Context window size in tokens. Default: 200000 */
  contextWindow: number;
  /** Compaction buffer in tokens. Default: 13000 */
  compactionBuffer: number;
  /** Token threshold to initialize session memory. Default: 10000 */
  sessionMemoryInitThreshold: number;
  /** Token increment between session memory updates. Default: 5000 */
  sessionMemoryUpdateInterval: number;
  /** Number of recent assistant turns to keep tool results for. Default: 10 */
  microcompactKeepTurns: number;
  /** Minimum hours between auto-dream runs. Default: 24 */
  autoDreamIntervalHours: number;
  /** Minimum sessions before auto-dream triggers. Default: 5 */
  autoDreamSessionThreshold: number;
  /** Maximum fraction of context window usable for loaded history. Default: 0.5 */
  contextLoadRatio: number;
  /** Maximum tokens per individual tool result in context. Default: 8000 */
  toolResultMaxTokens: number;
  /** Number of recent tool results to keep at full size. Default: 10 */
  toolResultKeepRecent: number;
  /** SM-compact minimum tokens of recent context to keep. Default: 10000 */
  smCompactMinTokens: number;
  /** SM-compact maximum tokens of recent context to keep. Default: 40000 */
  smCompactMaxTokens: number;
  /** Same-tool call count before stuck detection triggers. Default: 5 */
  stuckDetectionThreshold: number;
  /** Consecutive tool errors before error intervention triggers. Default: 3 */
  consecutiveErrorThreshold: number;
  /** Maximum turns for sub-agents (workflow_run / skill_invoke). Default: 200 */
  subAgentMaxTurns: number;
  /**
   * C3.4: Default maximum output tokens for agent responses.
   * Can be overridden per agent type via AgentDefinition.outputTokenBudget.
   * Analysis/report tasks benefit from 32768+, simple Q&A from 8192.
   * Default: 32768
   */
  outputTokenBudget: number;
  /** Reserved output tokens deducted from context window. Auto-detected from model registry. Default: 20000 */
  reservedOutputTokens?: number;
  /** Proactive compaction trigger lower ratio. Default: 0.70 */
  proactiveCompactLowerRatio?: number;
  /** Proactive compaction trigger upper ratio. Default: 0.85 */
  proactiveCompactUpperRatio?: number;

  // -- Feature flags (undefined = use flag default) --

  /** Enable concurrent tool execution. Default: true */
  concurrentToolExecution?: boolean;
  /** Enable prompt caching optimization. Default: true */
  promptCaching?: boolean;
  /** Enable cache editing (truncate old tool results for context management). Default: true */
  cacheEditing?: boolean;
  /** Enable streaming tool execution. Default: false (not yet fully integrated) */
  streamingToolExecution?: boolean;
  /** Enable hierarchical context compression. Default: true */
  hierarchicalCompression?: boolean;
  /** Enable long output continuation for truncated responses. Default: true */
  longOutputContinuation?: boolean;
  /** Knowledge base ID for cross-session project memory. Set at runtime from AgentRunOptions. */
  kbId?: string;

  // -- Post-compact file re-injection settings --

  /** Maximum number of files to re-inject after compaction. Default: 5 */
  postCompactMaxFiles?: number;
  /** Maximum tokens per re-injected file. Default: 5000 */
  postCompactMaxTokensPerFile?: number;
  /** Total token budget for re-injected files. Default: 25000 */
  postCompactTokenBudget?: number;

  // -- Post-compact skill re-injection settings --

  /** Maximum number of inline skills to re-inject after compaction. Default: 3 */
  postCompactMaxSkills?: number;
  /** Maximum tokens per re-injected skill. Default: 5000 */
  postCompactMaxTokensPerSkill?: number;
  /** Total token budget for re-injected skills. Default: 15000 */
  postCompactSkillTokenBudget?: number;
}

/** Read file state entry tracked during agent execution for post-compact re-injection. */
export interface ReadFileStateEntry {
  /** File content (may be truncated for large files) */
  content: string;
  /** Timestamp of last access */
  timestamp: number;
  /** Token estimate for content */
  tokenEstimate: number;
}

/** An invoked skill entry tracked during agent execution for post-compact re-injection. */
export interface InvokedSkillEntry {
  /** Skill name */
  name: string;
  /** Skill full prompt content */
  content: string;
  /** The user input that triggered the skill */
  input: string;
  /** Timestamp of invocation */
  timestamp: number;
  /** Estimated token count for content */
  tokenEstimate: number;
  /** Invocation mode */
  mode: "inline" | "fork" | "sub_agent";
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxTurns: -1,
  contextWindow: 200_000,
  compactionBuffer: 13_000,
  sessionMemoryInitThreshold: 10_000,
  sessionMemoryUpdateInterval: 5_000,
  microcompactKeepTurns: 10,
  autoDreamIntervalHours: 24,
  autoDreamSessionThreshold: 5,
  contextLoadRatio: 0.5,
  toolResultMaxTokens: 8_000,
  toolResultKeepRecent: 10,
  smCompactMinTokens: 10_000,
  smCompactMaxTokens: 40_000,
  stuckDetectionThreshold: 5,
  consecutiveErrorThreshold: 3,
  subAgentMaxTurns: 200,
  outputTokenBudget: 32_768,
  reservedOutputTokens: 20_000,
  proactiveCompactLowerRatio: 0.70,
  proactiveCompactUpperRatio: 0.85,
};

// ---------------------------------------------------------------------------
// Context Collapse (Read-time semantic projection)
// ---------------------------------------------------------------------------

/**
 * Method used to create a collapse entry.
 * Mirrors CompactBoundaryMeta methods.
 */
export type CollapseMethod =
  | "micro-collapse"
  | "sm-collapse"
  | "legacy-collapse"
  | "hierarchical-collapse"
  | "emergency-collapse"
  | "truncation-fallback"
  | "proactive-collapse";

/**
 * A single collapse entry representing a range of original messages
 * that have been semantically projected to a summary.
 *
 * Invariants:
 * - Original messages in [startIndex, endIndex) are NEVER deleted from the messages array
 * - The summary replaces those messages ONLY in the projected array sent to the API
 * - collapseId is unique within a run
 * - Entries are non-overlapping (enforced by CollapseStore)
 */
export interface CollapseEntry {
  /** Unique identifier for this collapse entry */
  collapseId: string;
  /** Start index in the original messages array (inclusive) */
  startIndex: number;
  /** End index in the original messages array (exclusive) */
  endIndex: number;
  /** The method that created this collapse */
  method: CollapseMethod;
  /** Estimated tokens in the original messages before collapse */
  originalTokens: number;
  /** The replacement message(s) to inject in the projected array */
  replacementMessages: ChatMessage[];
  /** Estimated tokens in the replacement messages */
  replacementTokens: number;
  /** Whether this entry contains search tool calls (affects expansion priority) */
  hasSearchContent: boolean;
  /** Turn number when this collapse was created */
  turnNumber: number;
  /** Timestamp when this collapse was created */
  createdAt: string;
  /** Optional metadata for debugging */
  metadata?: {
    /** Number of messages collapsed */
    messageCount: number;
    /** Tool names present in the collapsed range */
    toolNames?: string[];
    /** Whether this was triggered by emergency compaction */
    isEmergency?: boolean;
  };
}

/**
 * Result from the projection engine.
 */
export interface ProjectionResult {
  /** The projected message array for API submission */
  projectedMessages: ChatMessage[];
  /** Number of collapse entries applied */
  collapsesApplied: number;
  /** Total tokens saved by all applied collapses */
  totalTokensSaved: number;
}

/**
 * Summary information returned by CompactionEngine for collapse creation.
 * Unlike CompactionResult, this does NOT include a restructured message array.
 */
export interface CollapseSummaryInfo {
  /** Start index in the messages array */
  startIndex: number;
  /** End index in the messages array (exclusive) */
  endIndex: number;
  /** Replacement messages (summary) */
  replacementMessages: ChatMessage[];
  /** Estimated tokens in the original range */
  originalTokens: number;
  /** Estimated tokens in the replacement messages */
  replacementTokens: number;
  /** The collapse method */
  method: CollapseMethod;
}

// ---------------------------------------------------------------------------
// Skill Test Scenario (S6.6)
// ---------------------------------------------------------------------------

/**
 * A test scenario for validating skill behavior.
 */
export interface SkillTestScenario {
  name: string;
  description: string;
  input: string;
  expectedToolCalls?: string[];
  expectedKeywords?: string[];
  forbiddenPatterns?: string[];
}
