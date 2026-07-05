// =============================================================================
// DeepAnalyze - Tool Registry
// =============================================================================
// Manages available tools for the agent system. Provides registration,
// lookup, filtering, and tool definition building for LLM function calling.
// =============================================================================

import type { AgentTool } from "./types.js";
import type { ToolDefinition } from "../../models/provider.js";
import { AsyncLocalStorage } from "async_hooks";

// ---------------------------------------------------------------------------
// Per-task context isolation via AsyncLocalStorage
// ---------------------------------------------------------------------------

/**
 * AsyncLocalStorage instance for per-task execution context.
 * Each concurrent agent task is wrapped in agentAsyncContext.run(context, ...)
 * so that all tools in that task's async call chain see only that task's context.
 */
export const agentAsyncContext = new AsyncLocalStorage<Record<string, unknown>>();

/** Active contexts indexed by taskId, for cross-request access (e.g. inject route). */
const activeContexts = new Map<string, { ctx: Record<string, unknown>; createdAt: number }>();

/** Get the active context for a given taskId (used by inject route). */
export function getActiveContext(taskId: string): Record<string, unknown> | undefined {
  return activeContexts.get(taskId)?.ctx;
}

/** Register a context for cross-request access. Call when a streaming task starts. */
export function setActiveContext(taskId: string, ctx: Record<string, unknown>): void {
  activeContexts.set(taskId, { ctx, createdAt: Date.now() });
  // Cleanup stale entries (older than 2 hours)
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of activeContexts) {
    if (entry.createdAt < cutoff) activeContexts.delete(id);
  }
}

/** Remove a context after task completion. Prevents memory leaks. */
export function deleteActiveContext(taskId: string): void {
  activeContexts.delete(taskId);
}

// ---------------------------------------------------------------------------
// Deferred tool configuration
// ---------------------------------------------------------------------------

/**
 * Tools that are loaded lazily to save input tokens.
 * These tools are registered but not included in the initial tool definitions
 * sent to the model. The model can discover them via the tool_discover tool.
 *
 * @deprecated Use `shouldDefer` property on individual tools instead. This Set
 * is kept for backward compatibility but the primary mechanism is now the
 * `shouldDefer` attribute on AgentTool.
 */
export const DEFERRED_TOOLS = new Set([
  // --- Media generation (high cost, very low frequency) ---
  "tts_generate",
  "image_generate",
  "video_generate",
  "music_generate",
  // --- VLM re-analysis (KB images already have L1 VLM descriptions) ---
  "image_analysis",
  // --- Analysis output tools (low frequency, can be discovered) ---
  "timeline_build",
  "graph_build",
  // --- File discovery (overlaps with wiki_browse + glob) ---
  "list_files",
  // --- PDF direct read (overlaps with expand L1/L2) ---
  "pdf_read",          // expand(docId, L1) already returns PDF structured content
  // --- External knowledge tools (not needed for KB analysis) ---
  "youtube_transcript",
  "wikipedia",
  "scholar_search",
  // --- Skill management (not needed during analysis) ---
  "skill_create",
  "skill_update",
  "skill_delete",
  "skill_hub_search",
  "skill_hub_install",
  // --- Debug/introspection (not needed during analysis) ---
  "subagent_transcript",
  "notebook_read",
  // --- Platform-specific tools (deferred until needed) ---
  "powershell",        // PowerShell commands - Windows/WSL specific, not always available
  "db_connect",        // External database connections - scenario-specific
  "db_query",          // External database queries - depends on db_connect
  // --- Dynamic tool creation (rare, advanced) ---
  "tool_create",       // Create new tools at runtime - only when agent needs custom tools
  // --- Structured output (SDK/programmatic usage) ---
  "structured_output", // JSON Schema validated output - only for programmatic consumers
  // --- Cron scheduling (Agent self-management) ---
  "cron_create",       // Create scheduled tasks - only when agent needs periodic execution
  "cron_list",         // List scheduled tasks
  "cron_delete",       // Delete scheduled tasks
  // --- Builtin MCP adapters (duplicate of hardcoded tools, discovered via tool_discover) ---
  "mcp__vlm__analyze_image",   // VLM image analysis via MCP pipeline
  "mcp__websearch__search",    // Web search via MCP pipeline
]);

/**
 * General-purpose tools that are deferred in KB sessions (where pre-extracted
 * content exists) but should be auto-included for non-KB sessions (general
 * chat, GAIA-style tasks, etc.).
 *
 * Rationale: In KB sessions, image_analysis would cause agents to re-analyze
 * images with VLM instead of using pre-extracted L0/L1/L2 content. But for
 * general tasks (no KB), these tools are essential capabilities.
 */
export const GENERAL_PURPOSE_DEFERRED_TOOLS = new Set([
  "image_analysis",      // VLM image analysis — essential for non-KB image tasks
  "wikipedia",           // Wikipedia access — essential for general knowledge queries
  "youtube_transcript",  // YouTube transcript — essential for video content extraction
  "scholar_search",      // Academic paper search — essential for research tasks
]);

/** Tools that are always included in the initial tool definitions (core tools). */
export const CORE_TOOLS: Set<string> | null = null; // null means "all non-deferred"

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

/**
 * A simple "think" tool that lets the agent reason without taking action.
 * Useful for planning and step-by-step reasoning before acting.
 */
const thinkTool: AgentTool = {
  name: "think",
  description:
    "逐步思考问题。在采取行动之前使用此工具来规划你的方法。" +
    "此工具不执行任何外部操作，只是记录你的推理过程供下一轮使用。",
  async execute(input: Record<string, unknown>) {
    return { thought: input.thought, recorded: true };
  },
  inputSchema: {
    type: "object",
    properties: {
      thought: {
        type: "string",
        description: "你的推理过程（使用与用户相同的语言）",
      },
    },
    required: ["thought"],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
};

/**
 * A "finish" tool that signals the agent has completed its task.
 * The agent should call this with its final answer when done.
 */
const finishTool: AgentTool = {
  name: "finish",
  description:
    "Signal that you have completed the task. " +
    "Call this AFTER you have output your complete answer as text in the conversation — " +
    "the user reads your text output in real-time, so your answer must already be visible there. " +
    "Use the summary parameter to briefly note what you accomplished.\n\n" +
    "**IMPORTANT**: Your answer should already be in your text output above. " +
    "The summary is a brief completion note, NOT the place to put your full answer. " +
    "Example: summary=\"Analyzed the insurance data for 10 companies and identified the top 3 by growth potential.\"\n\n" +
    "Before finishing:\n" +
    "1. Verify your text output above contains the complete answer to the user's question.\n" +
    "2. **Hallucination check** — can every specific fact (names, dates, numbers) be traced back to a tool result? " +
    "If any fact comes from your model memory rather than tool data, REMOVE it.\n" +
    "3. Do not include fabricated statistics, future events, or unverified claims.\n" +
    "4. **Output completeness check** — review what you intended to deliver. " +
    "If you planned multiple outputs (files, cards, sections), verify nothing was skipped or dropped midway. " +
    "When you used workflow_run in batches, verify all planned batches were dispatched and the total output covers the full scope — " +
    "do not finish if some batches were skipped or duplicated. " +
    "You may choose to omit low-quality outputs, but intentional omissions should be acknowledged.\n" +
    "5. **Answer clarity** — if the user asked a specific question, verify the answer is clearly identifiable in your output.",
  async execute(input: Record<string, unknown>) {
    return { completed: true, summary: input.summary };
  },
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "A brief completion note summarizing what you accomplished. Your full answer should already be in the conversation text above, NOT here. Example: 'Analyzed 5 companies and identified top performers.'",
      },
    },
    required: ["summary"],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
};

/**
 * A "context_expand" tool that restores previously collapsed conversation context.
 * Only available when contextCollapse feature flag is enabled.
 */
const contextExpandTool: AgentTool = {
  name: "context_expand",
  description:
    "恢复之前被压缩的对话上下文。当你需要回引之前的搜索结果、工具输出或分析细节时使用。" +
    "使用 'auto' 自动展开最相关的区域，或指定 collapse_id 展开特定区域。" +
    "使用 'list' 查看所有可展开的区域。" +
    "展开后，原始消息会在下一轮恢复到你的上下文中。",
  async execute(input: Record<string, unknown>) {
    return { requested: true, collapse_id: input.collapse_id ?? "auto" };
  },
  inputSchema: {
    type: "object",
    properties: {
      collapse_id: {
        type: "string",
        description:
          "要展开的折叠区域 ID。使用 'auto' 自动选择最相关的区域。" +
          "使用 'list' 查看所有可展开的区域。",
      },
    },
    required: ["collapse_id"],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  shouldDefer: true,
};

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

/**
 * Registry that manages all available tools for agents. Tools can be
 * registered individually or in bulk, looked up by name, filtered, and
 * converted to LLM function calling definitions.
 */
export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  /** Shared context that tools can read at execution time. Set per-request by the route handler. */
  private _executionContext: Record<string, unknown> = {};

  constructor() {
    // Pre-register the built-in tools
    this.tools.set(thinkTool.name, thinkTool);
    this.tools.set(finishTool.name, finishTool);
    this.tools.set(contextExpandTool.name, contextExpandTool);
  }

  /** Set execution context for the current request (legacy — prefer ALS via agentAsyncContext.run). */
  setExecutionContext(ctx: Record<string, unknown>): void {
    this._executionContext = ctx;
  }

  /**
   * Get the current execution context.
   * Returns the per-task context from AsyncLocalStorage if available,
   * otherwise falls back to the legacy singleton context.
   */
  getExecutionContext(): Record<string, unknown> {
    const store = agentAsyncContext.getStore();
    if (store) return store;
    return this._executionContext;
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a single tool. If a tool with the same name already exists,
   * it will be replaced.
   */
  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once.
   */
  registerMany(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Unregister a tool by name.
   * Returns true if the tool was found and removed, false otherwise.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  /**
   * Get a tool by name. Returns undefined if not found.
   */
  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools.
   */
  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if a tool with the given name is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------

  /**
   * Get tools filtered by their names. Supports wildcard "*" to return all tools.
   *
   * @param names - Array of tool names, or ["*"] for all tools.
   * @returns Array of matching tools.
   */
  filterByNames(names: string[]): AgentTool[] {
    // Wildcard returns all tools
    if (names.includes("*")) {
      return this.getAll();
    }

    const result: AgentTool[] = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        result.push(tool);
      }
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  /**
   * Validate tool input against its JSON Schema.
   * Checks required fields and basic type compatibility.
   */
  validateToolInput(
    toolName: string,
    input: Record<string, unknown>,
    schema: Record<string, unknown>,
  ): { valid: boolean; error?: string } {
    if (!schema.properties) return { valid: true };

    // Check required fields
    const required = schema.required as string[] | undefined;
    if (required) {
      for (const field of required) {
        if (input[field] === undefined || input[field] === null) {
          return {
            valid: false,
            error: `Missing required parameter "${field}"`,
          };
        }
      }
    }

    // Check field types — with auto-coercion for common model errors
    const props = schema.properties as Record<string, { type?: string; description?: string }>;
    for (const [key, propSchema] of Object.entries(props)) {
      let value = input[key];
      if (value === undefined || value === null) continue;

      if (propSchema.type) {
        const expectedType = propSchema.type;
        let actualType = Array.isArray(value) ? "array" : typeof value;

        // JSON Schema "integer" is a subtype of "number". JavaScript has no integer type
        // (typeof 5 === "number"), so we handle integer as a number-with-integer-value check.
        // This is critical for MCP tool schemas (e.g. arxiv max_results: { type: "integer" }).
        const isIntegerExpected = expectedType === "integer";
        const isNumberLikeExpected = expectedType === "number" || isIntegerExpected;
        const numberValueOk =
          actualType === "number" &&
          (!isIntegerExpected || Number.isInteger(value));

        const typeCompatible =
          (expectedType === "string" && actualType === "string") ||
          (isNumberLikeExpected && numberValueOk) ||
          (expectedType === "boolean" && actualType === "boolean") ||
          (expectedType === "array" && actualType === "array") ||
          (expectedType === "object" && actualType === "object" && !Array.isArray(value));

        if (!typeCompatible) {
          // Auto-coercion: fix common type mismatches from model output
          let coerced = false;
          if (expectedType === "array" && actualType === "string") {
            // "value" → ["value"]
            input[key] = [value];
            coerced = true;
          } else if (isNumberLikeExpected && actualType === "string") {
            const num = Number(value);
            if (!isNaN(num) && (!isIntegerExpected || Number.isInteger(num))) {
              input[key] = num;
              coerced = true;
            }
          } else if (isNumberLikeExpected && actualType === "number" && isIntegerExpected && !Number.isInteger(value)) {
            // Float → integer: tolerate if the model emitted 5.0 for an integer field
            const truncated = Math.trunc(value as number);
            if (Number.isInteger(truncated)) {
              input[key] = truncated;
              coerced = true;
            }
          } else if (expectedType === "string" && actualType === "number") {
            input[key] = String(value);
            coerced = true;
          } else if (expectedType === "boolean" && actualType === "string") {
            if (value === "true" || value === "false") {
              input[key] = value === "true";
              coerced = true;
            }
          }

          if (!coerced) {
            return {
              valid: false,
              error: `Parameter "${key}" expected type "${expectedType}" but got "${actualType}"`,
            };
          }
        }
      }
    }

    // T1.3: Per-tool semantic validation
    const semanticError = this.validateSemantics(toolName, input);
    if (semanticError) return { valid: false, error: semanticError };

    return { valid: true };
  }

  /**
   * Per-tool semantic validation that goes beyond basic schema checks.
   * Returns an error message string if validation fails, or null if input is valid.
   */
  private validateSemantics(
    toolName: string,
    input: Record<string, unknown>,
  ): string | null {
    switch (toolName) {
      case "kb_search": {
        const query = input.query;
        if (typeof query !== "string" || query.trim().length <= 1) {
          return "kb_search query cannot be empty or a single character";
        }
        break;
      }
      case "expand": {
        const docIds = input.docIds;
        if (Array.isArray(docIds) && docIds.length > 20) {
          return "expand docIds cannot exceed 20 items";
        }
        break;
      }
      case "doc_grep": {
        const pattern = input.pattern;
        if (typeof pattern === "string" && pattern.length < 2) {
          return "doc_grep pattern must be at least 2 characters";
        }
        break;
      }
      case "run_sql": {
        const sql = input.sql;
        if (typeof sql !== "string" || !sql.trim()) {
          return "run_sql requires a non-empty SQL statement";
        }
        break;
      }
      case "web_search": {
        const query = input.query;
        if (typeof query !== "string" || query.trim().length === 0) {
          return "web_search query cannot be empty";
        }
        break;
      }
      case "bash": {
        const command = input.command;
        if (typeof command !== "string" || command.trim().length === 0) {
          return "bash command cannot be empty";
        }
        break;
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Tool definition building for LLM function calling
  // -----------------------------------------------------------------------

  /**
   * Build tool definitions suitable for LLM function calling.
   * If names is provided, only include those tools. Otherwise include all
   * non-deferred tools (deferred tools can be discovered via tool_discover).
   * Returns ToolDefinition[] compatible with ChatOptions.tools.
   *
   * @param names - Optional array of tool names to include. Use ["*"] for all.
   * @param includeDeferred - If true, include deferred tools. Default: false.
   * @returns Array of tool definitions for the model's tool use parameter.
   */
  buildToolDefinitions(names?: string[], includeDeferred = false): ToolDefinition[] {
    let tools: AgentTool[];

    const isDeferred = (t: AgentTool) => t.shouldDefer || DEFERRED_TOOLS.has(t.name);

    if (names && names.includes("*")) {
      // Wildcard: return all tools (respecting deferred flag)
      tools = this.getAll().filter(t => includeDeferred || !isDeferred(t));
    } else if (names) {
      tools = this.filterByNames(names);
    } else {
      // No names specified: return all non-deferred tools
      tools = this.getAll().filter(t => includeDeferred || !isDeferred(t));
    }

    // Filter out KB-scoped tools when no KB is associated with the session
    const scopeKbIds = this.getExecutionContext().scopeKbIds as string[] | undefined;
    const hasKbScope = !!(scopeKbIds && scopeKbIds.length > 0);
    if (!hasKbScope) {
      const kbToolCount = tools.filter(t => t.requiresKbScope).length;
      if (kbToolCount > 0) {
        tools = tools.filter(t => !t.requiresKbScope);
        console.log(`[ToolRegistry] Excluded ${kbToolCount} KB-scoped tools (no KB in session)`);
      }

      // Auto-include general-purpose deferred tools for non-KB sessions
      // These tools (image_analysis, wikipedia, scholar_search) are deferred in KB
      // sessions to prevent agents from re-analyzing pre-extracted content, but are
      // essential for general tasks like GAIA-style questions.
      const deferredGeneralTools = this.getAll().filter(
        t => GENERAL_PURPOSE_DEFERRED_TOOLS.has(t.name) && !tools.some(existing => existing.name === t.name)
      );
      if (deferredGeneralTools.length > 0) {
        tools.push(...deferredGeneralTools);
      }
    }

    // Sort alphabetically by name for prompt cache stability
    tools.sort((a, b) => a.name.localeCompare(b.name));

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: `Input for ${tool.name}`,
          },
        },
        required: ["query"],
      },
    }));
  }
}
