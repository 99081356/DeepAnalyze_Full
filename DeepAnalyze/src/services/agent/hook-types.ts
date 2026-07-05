// =============================================================================
// DeepAnalyze - Hook Type Definitions
// =============================================================================
// Expanded hook types for the agent hooks system. Supports 27 hook types
// covering the full agent lifecycle: session, agent, tool, compaction,
// sub-agent, task, MCP elicitation, and external event hooks.
// ============================================================================

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

/**
 * Supported hook types covering the full agent lifecycle.
 *
 * **Core lifecycle:**
 * 1. SessionStart     — fired when a session begins
 * 2. Setup            — fired during initial setup
 * 3. InstructionsLoaded — fired after instructions are loaded
 * 4. UserPromptSubmit — fired before processing user input (can block/modify)
 * 5. AgentStart       — fired at the beginning of an agent run()
 * 6. PreToolUse       — fired before each tool execution (can block)
 * 7. PostToolUse      — fired after each tool execution (fire-and-forget)
 * 8. PostToolUseFailure — fired after tool execution failure (fire-and-forget)
 * 9. SubagentStart    — fired before sub-agent execution
 * 10. SubagentStop    — fired after sub-agent execution
 * 11. PreCompact      — fired before context compaction (can block/inject)
 * 12. PostCompact     — fired after context compaction (fire-and-forget)
 * 13. Stop            — fired when agent session ends normally
 * 14. StopFailure     — fired when agent session ends due to error
 * 15. AgentComplete   — fired at the end of an agent run
 * 16. SessionEnd      — fired when a session ends
 *
 * **Task lifecycle:**
 * - TaskCreated       — fired when a task is created
 * - TaskCompleted     — fired when a task completes
 *
 * **Permission & security:**
 * - PermissionRequest — fired before a permission check (can block)
 * - PermissionDenied  — fired after a permission is denied
 *
 * **MCP elicitation:**
 * - Elicitation       — fired for MCP elicitation requests (can block)
 * - ElicitationResult — fired after elicitation response
 *
 * **Environment events:**
 * - Notification      — fired when a system notification is dispatched
 * - ConfigChange      — fired when configuration changes
 * - FileChanged       — fired when a file system change is detected
 * - CwdChanged        — fired when the working directory changes
 * - TeammateIdle      — fired when a team agent becomes idle
 * - WorktreeCreate    — fired when a worktree is created
 * - WorktreeRemove    — fired when a worktree is removed
 */
export type HookType =
  // Core lifecycle
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "PostCompact"
  | "SessionStart"
  | "SessionEnd"
  | "AgentStart"
  | "AgentComplete"
  // User interaction
  | "UserPromptSubmit"
  // Sub-agent
  | "SubagentStart"
  | "SubagentStop"
  // Task lifecycle
  | "TaskCreated"
  | "TaskCompleted"
  // Stop events
  | "Stop"
  | "StopFailure"
  // Permission & security
  | "PermissionRequest"
  | "PermissionDenied"
  // MCP elicitation
  | "Elicitation"
  | "ElicitationResult"
  // Environment events
  | "Notification"
  | "ConfigChange"
  | "FileChanged"
  | "CwdChanged"
  | "TeammateIdle"
  | "Setup"
  | "InstructionsLoaded";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Context passed to hook handlers.
 * Fields vary by hook type — only relevant fields are populated.
 */
export interface HookContext {
  hookType: HookType;
  /** Tool name (PreToolUse, PostToolUse, PostToolUseFailure) */
  toolName?: string;
  /** Tool input parameters (PreToolUse, PostToolUse) */
  toolInput?: Record<string, unknown>;
  /** Current task ID */
  taskId?: string;
  /** PreCompact hook can inject custom instructions into the compaction process */
  customInstructions?: string;
  /** Sub-agent ID (SubagentStart, SubagentStop) */
  subagentId?: string;
  /** File path (FileChanged) */
  filePath?: string;
  /** Permission type (PermissionRequest, PermissionDenied) */
  permissionType?: string;
  /** Error message (StopFailure, PostToolUseFailure) */
  errorMessage?: string;
  /** Notification content (Notification) */
  notificationContent?: string;
  /** User prompt text (UserPromptSubmit) */
  userPrompt?: string;
  /** Config key that changed (ConfigChange) */
  configKey?: string;
  /** Working directory (CwdChanged) */
  cwd?: string;
  /** Task result (TaskCompleted) */
  taskResult?: unknown;
  /** Elicitation action (Elicitation, ElicitationResult) */
  elicitationAction?: string;
  /** Elicitation content (Elicitation, ElicitationResult) */
  elicitationContent?: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Result returned by a hook handler.
 *
 * For **blocking** hooks (PreToolUse, PreCompact, UserPromptSubmit, PermissionRequest, Elicitation):
 *   - `allowed: false` prevents the action from proceeding.
 *   - `error` provides a reason shown to the agent / user.
 *
 * For **fire-and-forget** hooks (all others):
 *   - The result is logged but does not affect execution flow.
 *
 * For **PreToolUse** additionally:
 *   - `modifiedInput` allows hooks to transform the tool input before execution.
 *
 * For **UserPromptSubmit** additionally:
 *   - `modifiedInput` can contain `{ userPrompt: "modified text" }` to rewrite the input.
 */
export interface HookResult {
  /** false = block the action (blocking hooks only) */
  allowed: boolean;
  error?: string;
  /** Modified input (PreToolUse: tool input; UserPromptSubmit: {userPrompt}). Merged with original. */
  modifiedInput?: Record<string, unknown>;
}
