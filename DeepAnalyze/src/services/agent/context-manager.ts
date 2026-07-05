// =============================================================================
// DeepAnalyze - Context Manager
// =============================================================================
// Manages context window estimation, compaction decision logic, and token
// budget calculation. Uses ModelRouter.estimateTokens() for heuristics.
// Reads configurable parameters from AgentSettings.
// =============================================================================

import { ModelRouter } from "../../models/router.js";
import type { ChatMessage, ToolDefinition } from "../../models/provider.js";
import { getContextWindowForModel, getMaxOutputTokensForModel } from "../../models/provider-registry.js";
import type { AgentSettings } from "./types.js";
import { DEFAULT_AGENT_SETTINGS } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default reserved tokens for output generation buffer (fallback) */
const DEFAULT_RESERVED_OUTPUT_TOKENS = 20_000;

// ---------------------------------------------------------------------------
// Context window info
// ---------------------------------------------------------------------------

export interface ContextWindowInfo {
  totalTokens: number;
  reservedTokens: number;
  effectiveWindow: number;
}

/** Result of token-aware context loading */
export interface ContextLoadResult {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

export class ContextManager {
  private modelRouter: ModelRouter;
  private modelId: string;
  private toolDefs: ToolDefinition[];
  private settings: AgentSettings;

  constructor(
    modelRouter: ModelRouter,
    modelId: string,
    toolDefs: ToolDefinition[],
    settings?: Partial<AgentSettings>,
  ) {
    this.modelRouter = modelRouter;
    this.modelId = modelId;
    this.toolDefs = toolDefs;
    this.settings = { ...DEFAULT_AGENT_SETTINGS, ...settings };
  }

  // -----------------------------------------------------------------------
  // Context window calculation
  // -----------------------------------------------------------------------

  /**
   * Get the effective context window info.
   * Resolves context window from model registry first, falls back to settings.
   * effectiveWindow = contextWindow - reservedOutput - toolDefsOverhead
   */
  getContextWindow(): ContextWindowInfo {
    const toolDefsOverhead = this.estimateToolDefsTokens();
    // Model-aware resolution: registry > settings > default
    const modelCtx = getContextWindowForModel(this.modelId);
    const contextWindow = modelCtx ?? this.settings.contextWindow;

    // Dynamic reserved tokens: model registry max output > settings > default
    const modelMaxOutput = getMaxOutputTokensForModel(this.modelId);
    const reservedOutput = modelMaxOutput
      ?? this.settings.reservedOutputTokens
      ?? DEFAULT_RESERVED_OUTPUT_TOKENS;

    return {
      totalTokens: contextWindow,
      reservedTokens: reservedOutput + toolDefsOverhead,
      effectiveWindow: contextWindow - reservedOutput - toolDefsOverhead,
    };
  }

  // -----------------------------------------------------------------------
  // Compaction decision
  // -----------------------------------------------------------------------

  /**
   * Check if messages exceed the compaction threshold.
   * Returns true when current tokens > effectiveWindow - compactionBuffer.
   */
  shouldCompact(messages: ChatMessage[]): boolean {
    const { effectiveWindow } = this.getContextWindow();
    const threshold = effectiveWindow - this.settings.compactionBuffer;
    const currentTokens = this.estimateMessagesTokens(messages);
    return currentTokens > threshold;
  }

  /**
   * Check if there are old tool result messages eligible for microcompact.
   * Uses age-based heuristic: counts tool results that are more than
   * `microcompactKeepTurns` assistant messages ago from the end.
   */
  shouldMicrocompact(messages: ChatMessage[]): boolean {
    const keepTurns = this.settings.microcompactKeepTurns;

    // Count assistant messages from the end
    let assistantCount = 0;
    let cutoffIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        assistantCount++;
        if (assistantCount >= keepTurns) {
          cutoffIndex = i;
          break;
        }
      }
    }

    if (assistantCount < keepTurns) {
      // Not enough assistant turns yet — nothing to prune
      return false;
    }

    // Check if there are tool results before the cutoff that are long enough to prune
    for (let i = 0; i < cutoffIndex; i++) {
      if (messages[i].role === "tool" && (messages[i].content ?? "").length > 200) {
        return true;
      }
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Token estimation
  // -----------------------------------------------------------------------

  /**
   * Estimate the total token count for all messages.
   */
  estimateMessagesTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // Content tokens
      total += this.modelRouter.estimateTokens(typeof msg.content === "string" ? (msg.content ?? "") : JSON.stringify(msg.content));

      // Tool call arguments tokens
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += this.modelRouter.estimateTokens(tc.function.arguments);
          // Overhead per tool call (name, id, formatting)
          total += 20;
        }
      }

      // Per-message overhead (role tags, formatting)
      total += 10;
    }
    return total;
  }

  /**
   * Estimate the token overhead from tool definitions.
   */
  private estimateToolDefsTokens(): number {
    if (this.toolDefs.length === 0) return 0;
    const schemaJson = JSON.stringify(this.toolDefs);
    return this.modelRouter.estimateTokens(schemaJson);
  }

  // -----------------------------------------------------------------------
  // Token-aware context loading (for route handlers)
  // -----------------------------------------------------------------------

  /**
   * Load context messages from history within a token budget.
   * Walks backward from the most recent message, accumulating tokens,
   * and stops when adding the next-older message would exceed maxTokens.
   *
   * This replaces fixed-count loading (e.g. "last 20 messages") with
   * a token-based approach that adapts to actual content size.
   */
  loadContextMessages(
    allMessages: Array<{ role: string; content: string }>,
    maxTokens: number,
  ): ContextLoadResult {
    // Filter to only user/assistant messages
    const candidates = allMessages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );

    // Walk backward, accumulating tokens
    const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
    let totalTokens = 0;

    for (let i = candidates.length - 1; i >= 0; i--) {
      const msg = candidates[i]!;
      const msgTokens = this.estimateTextTokens(msg.content || "") + 10; // 10 overhead per msg

      if (totalTokens + msgTokens > maxTokens) {
        break;
      }

      selected.unshift({
        role: msg.role as "user" | "assistant",
        content: msg.content || "",
      });
      totalTokens += msgTokens;
    }

    return { messages: selected, estimatedTokens: totalTokens };
  }

  /**
   * Estimate tokens for a plain text string (no message overhead).
   * Uses the same heuristic as ModelRouter.estimateTokens().
   */
  estimateTextTokens(text: string): number {
    return this.modelRouter.estimateTokens(text);
  }
}
