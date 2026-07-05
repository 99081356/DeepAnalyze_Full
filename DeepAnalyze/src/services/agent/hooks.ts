// =============================================================================
// DeepAnalyze - Hook Manager
// =============================================================================
// Manages hooks for 27 lifecycle events in the agent system.
// Supports "command" (shell), "http" (POST), and "callback" (in-process) hooks.
// Hooks are persisted via the settings table (key = "agent_hooks").
// =============================================================================

import { getRepos } from "../../store/repos/index.js";
import type { HookType, HookContext, HookResult } from "./hook-types.js";

// Re-export types for backward compatibility
export type { HookType, HookContext, HookResult } from "./hook-types.js";

// ---------------------------------------------------------------------------
// Backward-compatible alias
// ---------------------------------------------------------------------------

/** @deprecated Use HookType instead */
export type HookEvent = HookType;

// ---------------------------------------------------------------------------
// Hook definition
// ---------------------------------------------------------------------------

export interface HookDefinition {
  id: string;
  event: HookType;
  type: "command" | "http" | "callback";
  /** Glob-style matcher for tool names. "*" matches all. */
  matcher: string;
  config: {
    /** Shell command (for "command" type). Invoked with env vars: $TOOL_NAME, $TASK_ID, $HOOK_TYPE */
    command?: string;
    /** HTTP URL to POST to (for "http" type). */
    url?: string;
    headers?: Record<string, string>;
  };
  /** In-process callback (for "callback" type). Not persisted — programmatic only. */
  callback?: (ctx: HookContext) => Promise<HookResult>;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Hook types classification
// ---------------------------------------------------------------------------

/** Hooks that can block the action (returning { allowed: false }) */
const BLOCKING_HOOK_TYPES = new Set<HookType>([
  "PreToolUse",
  "PreCompact",
  "UserPromptSubmit",
  "PermissionRequest",
  "Elicitation",
]);

/** Hooks that do not need a toolName matcher (lifecycle/session hooks) */
const LIFECYCLE_HOOK_TYPES = new Set<HookType>([
  "SessionStart",
  "SessionEnd",
  "AgentStart",
  "AgentComplete",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "Notification",
  "PermissionRequest",
  "PermissionDenied",
  "FileChanged",
  "UserPromptSubmit",
  "PostToolUseFailure",
  "TaskCreated",
  "TaskCompleted",
  "ConfigChange",
  "InstructionsLoaded",
  "CwdChanged",
  "TeammateIdle",
  "Elicitation",
  "ElicitationResult",
  "Setup",
]);

// ---------------------------------------------------------------------------
// HookManager
// ---------------------------------------------------------------------------

export class HookManager {
  private hooks: Map<HookType, HookDefinition[]> = new Map();
  private loaded = false;

  /** Load hooks from the settings table. */
  async loadFromSettings(): Promise<void> {
    try {
      const repos = await getRepos();
      const raw = await repos.settings.get("agent_hooks");

      // Preserve callback hooks (programmatically registered), clear only persisted hooks
      const callbackHooks = new Map<HookType, HookDefinition[]>();
      for (const [event, defs] of this.hooks) {
        const callbacks = defs.filter(d => d.type === "callback");
        if (callbacks.length > 0) callbackHooks.set(event, callbacks);
      }

      this.hooks.clear();

      // Restore callback hooks
      for (const [event, defs] of callbackHooks) {
        this.hooks.set(event, defs);
      }

      if (raw) {
        const defs = JSON.parse(raw) as HookDefinition[];
        for (const def of defs) {
          if (!def.enabled) continue;
          const list = this.hooks.get(def.event) ?? [];
          list.push(def);
          this.hooks.set(def.event, list);
        }
      }
      this.loaded = true;
    } catch {
      // Settings table may not exist yet — preserve callback hooks, clear rest
      const callbackHooks = new Map<HookType, HookDefinition[]>();
      for (const [event, defs] of this.hooks) {
        const callbacks = defs.filter(d => d.type === "callback");
        if (callbacks.length > 0) callbackHooks.set(event, callbacks);
      }
      this.hooks.clear();
      for (const [event, defs] of callbackHooks) {
        this.hooks.set(event, defs);
      }
      this.loaded = true;
    }
  }

  /**
   * Register an in-process callback hook programmatically.
   * Used by plugins and internal systems. Not persisted to DB.
   */
  registerCallbackHook(
    event: HookType,
    id: string,
    callback: (ctx: HookContext) => Promise<HookResult>,
    matcher = "*",
  ): void {
    const def: HookDefinition = {
      id,
      event,
      type: "callback",
      matcher,
      config: {},
      callback,
      enabled: true,
    };
    const list = this.hooks.get(event) ?? [];
    list.push(def);
    this.hooks.set(event, list);
  }

  /**
   * Fire hooks for the given event. Returns the aggregated result.
   *
   * **Blocking hooks** (PreToolUse, PreCompact, UserPromptSubmit, PermissionRequest):
   * if any hook denies, the overall result is denied.
   *
   * **Fire-and-forget hooks** (all others): errors are logged but do not
   * affect the result — always returns `{ allowed: true }`.
   */
  async fire(
    hookType: HookType,
    ctx: HookContext,
  ): Promise<HookResult> {
    if (!this.loaded) {
      await this.loadFromSettings();
    }

    const defs = this.hooks.get(hookType) ?? [];

    // For tool-related hooks, filter by tool name matcher
    const isBlocking = BLOCKING_HOOK_TYPES.has(hookType);
    const needsMatcher = !LIFECYCLE_HOOK_TYPES.has(hookType);
    const matching = needsMatcher && ctx.toolName
      ? defs.filter((d) => this.matches(d.matcher, ctx.toolName))
      : defs;

    // Accumulate modified input from blocking hooks
    let modifiedInput: Record<string, unknown> | undefined;

    for (const def of matching) {
      try {
        const result = await this.executeHook(def, ctx);

        // Accumulate modifiedInput if returned
        if (result.modifiedInput) {
          modifiedInput = { ...(modifiedInput ?? ctx.toolInput), ...result.modifiedInput };
        }

        if (isBlocking && !result.allowed) {
          return {
            allowed: false,
            error: result.error,
            modifiedInput,
          };
        }
      } catch (err) {
        if (isBlocking) {
          // For blocking hooks, a thrown error is treated as a deny
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[HookManager] Blocking hook "${def.id}" threw:`, errMsg);
          return { allowed: false, error: errMsg, modifiedInput };
        }
        // Non-blocking: hook execution failure does NOT affect execution
        console.warn(`[HookManager] Hook "${def.id}" threw:`, err instanceof Error ? err.message : String(err));
      }
    }

    return { allowed: true, modifiedInput };
  }

  // -----------------------------------------------------------------------
  // Convenience methods for specific hook types
  // -----------------------------------------------------------------------

  /** Fire SessionStart hooks. Fire-and-forget. */
  async fireSessionStart(taskId?: string): Promise<void> {
    await this.fire("SessionStart", { hookType: "SessionStart", taskId }).catch(() => {});
  }

  /** Fire SessionEnd hooks. Fire-and-forget. */
  async fireSessionEnd(taskId?: string): Promise<void> {
    await this.fire("SessionEnd", { hookType: "SessionEnd", taskId }).catch(() => {});
  }

  /** Fire AgentStart hooks. Fire-and-forget. */
  async fireAgentStart(taskId?: string): Promise<void> {
    await this.fire("AgentStart", { hookType: "AgentStart", taskId }).catch(() => {});
  }

  /** Fire AgentComplete hooks. Fire-and-forget. */
  async fireAgentComplete(taskId?: string): Promise<void> {
    await this.fire("AgentComplete", { hookType: "AgentComplete", taskId }).catch(() => {});
  }

  /** Fire PreCompact hooks. Can block — returns the result. */
  async firePreCompact(taskId?: string, customInstructions?: string): Promise<HookResult> {
    return this.fire("PreCompact", {
      hookType: "PreCompact",
      taskId,
      customInstructions,
    });
  }

  /** Fire PostCompact hooks. Fire-and-forget. */
  async firePostCompact(taskId?: string): Promise<void> {
    await this.fire("PostCompact", { hookType: "PostCompact", taskId }).catch(() => {});
  }

  /** Fire UserPromptSubmit hooks. Can block or modify user input. */
  async fireUserPromptSubmit(userPrompt: string, taskId?: string): Promise<HookResult> {
    return this.fire("UserPromptSubmit", {
      hookType: "UserPromptSubmit",
      taskId,
      userPrompt,
    });
  }

  /** Fire SubagentStart hooks. Fire-and-forget. */
  async fireSubagentStart(subagentId: string, taskId?: string): Promise<void> {
    await this.fire("SubagentStart", {
      hookType: "SubagentStart",
      taskId,
      subagentId,
    }).catch(() => {});
  }

  /** Fire SubagentStop hooks. Fire-and-forget. */
  async fireSubagentStop(subagentId: string, taskId?: string): Promise<void> {
    await this.fire("SubagentStop", {
      hookType: "SubagentStop",
      taskId,
      subagentId,
    }).catch(() => {});
  }

  /** Fire Stop hooks (agent ending normally). Fire-and-forget. */
  async fireStop(taskId?: string): Promise<void> {
    await this.fire("Stop", { hookType: "Stop", taskId }).catch(() => {});
  }

  /** Fire StopFailure hooks (agent ending with error). Fire-and-forget. */
  async fireStopFailure(error: string, taskId?: string): Promise<void> {
    await this.fire("StopFailure", {
      hookType: "StopFailure",
      taskId,
      errorMessage: error,
    }).catch(() => {});
  }

  /** Fire FileChanged hooks. Fire-and-forget. */
  async fireFileChanged(filePath: string, taskId?: string): Promise<void> {
    await this.fire("FileChanged", {
      hookType: "FileChanged",
      taskId,
      filePath,
    }).catch(() => {});
  }

  /** Fire Notification hooks. Fire-and-forget. */
  async fireNotification(content: string, taskId?: string): Promise<void> {
    await this.fire("Notification", {
      hookType: "Notification",
      taskId,
      notificationContent: content,
    }).catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Feature F: New convenience methods for extended hook events (C-191)
  // -----------------------------------------------------------------------

  /** Fire PostToolUseFailure hooks. Fire-and-forget. */
  async firePostToolUseFailure(toolName: string, error: string, taskId?: string): Promise<void> {
    await this.fire("PostToolUseFailure", {
      hookType: "PostToolUseFailure",
      toolName,
      taskId,
      errorMessage: error,
    }).catch(() => {});
  }

  /** Fire TaskCreated hooks. Fire-and-forget. */
  async fireTaskCreated(taskId: string): Promise<void> {
    await this.fire("TaskCreated", { hookType: "TaskCreated", taskId }).catch(() => {});
  }

  /** Fire TaskCompleted hooks. Fire-and-forget. */
  async fireTaskCompleted(taskId: string, result?: unknown): Promise<void> {
    await this.fire("TaskCompleted", {
      hookType: "TaskCompleted",
      taskId,
      taskResult: result,
    }).catch(() => {});
  }

  /** Fire ConfigChange hooks. Fire-and-forget. */
  async fireConfigChange(configKey: string, taskId?: string): Promise<void> {
    await this.fire("ConfigChange", {
      hookType: "ConfigChange",
      taskId,
      configKey,
    }).catch(() => {});
  }

  /** Fire InstructionsLoaded hooks. Fire-and-forget. */
  async fireInstructionsLoaded(taskId?: string): Promise<void> {
    await this.fire("InstructionsLoaded", { hookType: "InstructionsLoaded", taskId }).catch(() => {});
  }

  /** Fire CwdChanged hooks. Fire-and-forget. */
  async fireCwdChanged(cwd: string, taskId?: string): Promise<void> {
    await this.fire("CwdChanged", { hookType: "CwdChanged", taskId, cwd }).catch(() => {});
  }

  /** Fire TeammateIdle hooks. Fire-and-forget. */
  async fireTeammateIdle(subagentId: string, taskId?: string): Promise<void> {
    await this.fire("TeammateIdle", { hookType: "TeammateIdle", taskId, subagentId }).catch(() => {});
  }

  /** Fire Elicitation hooks. Blocking — can deny the request. */
  async fireElicitation(action: string, content: string, taskId?: string): Promise<HookResult> {
    return this.fire("Elicitation", {
      hookType: "Elicitation",
      taskId,
      elicitationAction: action,
      elicitationContent: content,
    });
  }

  /** Fire ElicitationResult hooks. Fire-and-forget. */
  async fireElicitationResult(action: string, content: string, taskId?: string): Promise<void> {
    await this.fire("ElicitationResult", {
      hookType: "ElicitationResult",
      taskId,
      elicitationAction: action,
      elicitationContent: content,
    }).catch(() => {});
  }

  /** Fire Setup hooks. Fire-and-forget. */
  async fireSetup(taskId?: string): Promise<void> {
    await this.fire("Setup", { hookType: "Setup", taskId }).catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Simple glob matcher: supports "*" (any) and exact match. */
  private matches(matcher: string, toolName: string): boolean {
    if (matcher === "*" || matcher === "") return true;
    if (matcher === toolName) return true;
    // Support prefix glob: "bash*" matches "bash", "bash_exec", etc.
    if (matcher.endsWith("*") && toolName.startsWith(matcher.slice(0, -1))) return true;
    return false;
  }

  private async executeHook(
    def: HookDefinition,
    ctx: HookContext,
  ): Promise<HookResult> {
    switch (def.type) {
      case "command":
        return this.executeCommandHook(def, ctx);
      case "http":
        return this.executeHttpHook(def, ctx);
      case "callback":
        return this.executeCallbackHook(def, ctx);
      default:
        return { allowed: true };
    }
  }

  private async executeCallbackHook(
    def: HookDefinition,
    ctx: HookContext,
  ): Promise<HookResult> {
    if (!def.callback) return { allowed: true };
    try {
      return await def.callback(ctx);
    } catch (err) {
      return { allowed: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeCommandHook(
    def: HookDefinition,
    ctx: HookContext,
  ): Promise<HookResult> {
    const cmd = def.config.command;
    if (!cmd) return { allowed: true };

    const { spawn } = await import("node:child_process");
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TOOL_NAME: ctx.toolName ?? "",
      TASK_ID: ctx.taskId ?? "",
      HOOK_TYPE: ctx.hookType,
    };
    // Add new context fields as env vars for command hooks
    if (ctx.subagentId) env.SUBAGENT_ID = ctx.subagentId;
    if (ctx.filePath) env.FILE_PATH = ctx.filePath;
    if (ctx.errorMessage) env.ERROR_MESSAGE = ctx.errorMessage;
    if (ctx.userPrompt) env.USER_PROMPT = ctx.userPrompt;

    return new Promise((resolve) => {
      const proc = spawn("sh", ["-c", cmd], { env, timeout: 10_000 });
      let stderr = "";
      let stdout = "";

      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          // Try to parse stdout as JSON for extended result support
          const result = this.parseHookOutput(stdout.trim());
          resolve(result);
        } else {
          resolve({ allowed: false, error: stderr.trim() || `Hook exited with code ${code}` });
        }
      });

      proc.on("error", (err) => {
        resolve({ allowed: false, error: err.message });
      });
    });
  }

  private async executeHttpHook(
    def: HookDefinition,
    ctx: HookContext,
  ): Promise<HookResult> {
    const url = def.config.url;
    if (!url) return { allowed: true };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(def.config.headers ?? {}),
        },
        body: JSON.stringify({
          event: def.event,
          hookType: ctx.hookType,
          toolName: ctx.toolName,
          toolInput: ctx.toolInput,
          taskId: ctx.taskId,
          customInstructions: ctx.customInstructions,
          subagentId: ctx.subagentId,
          filePath: ctx.filePath,
          errorMessage: ctx.errorMessage,
          userPrompt: ctx.userPrompt,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (resp.ok) {
        const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
        const allowed = body.allowed !== false;
        const error = typeof body.error === "string" ? body.error : undefined;
        const modifiedInput = body.modifiedInput as Record<string, unknown> | undefined;
        return { allowed, error, modifiedInput };
      }
      // Non-2xx: don't block
      return { allowed: true };
    } catch {
      // Network error: don't block
      return { allowed: true };
    }
  }

  /**
   * Parse hook stdout for extended result support.
   * Supports JSON output: { "allowed": false, "error": "...", "modifiedInput": {...} }
   * Falls back to allowed: true for empty/non-JSON output.
   */
  private parseHookOutput(stdout: string): HookResult {
    if (!stdout) return { allowed: true };

    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      return {
        allowed: parsed.allowed !== false,
        error: typeof parsed.error === "string" ? parsed.error : undefined,
        modifiedInput: parsed.modifiedInput as Record<string, unknown> | undefined,
      };
    } catch {
      // Non-JSON stdout — treat as success
      return { allowed: true };
    }
  }
}
