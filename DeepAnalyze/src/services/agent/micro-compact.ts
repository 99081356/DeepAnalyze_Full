// =============================================================================
// DeepAnalyze - Micro Compactor
// =============================================================================
// Token-aware cleanup of tool result messages. Replaces verbose tool
// results with compact placeholders that preserve tool name and arg summary.
// =============================================================================

import type { ChatMessage } from "../../models/provider.js";
import type { ModelRouter } from "../../models/router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MicroCompactResult {
  messages: ChatMessage[];
  prunedCount: number;
  tokensSaved: number;
}

export interface MicroCompactOptions {
  /** Number of recent tool results to protect from pruning. Default: 10 */
  keepRecent: number;
  /** Max tokens per tool result before truncation. Default: 8000 */
  maxTokens: number;
  /** ModelRouter for token estimation */
  modelRouter: ModelRouter;
}

/**
 * Tool names whose results should be protected from pruning during compaction.
 * Search results are "raw materials" for analysis — once lost, they cannot be
 * recovered without re-running the search. Other tool results (file reads,
 * bash output) can be regenerated or are less critical.
 *
 * Protection is capped at MAX_PROTECTED_SEARCH_RESULTS to prevent context
 * overflow on search-heavy tasks where dozens of searches accumulate.
 *
 * Reference: Design doc C3.2 "搜索结果保护"
 */
const SEARCH_RESULT_TOOLS = new Set([
  "kb_search",
  "web_search",
  "mcp__minimax_websearch__web_search",
  "wikipedia",
  "web_fetch",
]);

/**
 * Maximum number of search results to protect from pruning.
 * Older search results beyond this limit will be eligible for pruning,
 * preventing unbounded context growth on search-heavy tasks.
 */
const MAX_PROTECTED_SEARCH_RESULTS = 20;

// ---------------------------------------------------------------------------
// MicroCompactor
// ---------------------------------------------------------------------------

export class MicroCompactor {
  /**
   * Prune old or oversized tool result messages by replacing their content
   * with descriptive placeholders.
   *
   * Strategy (token-aware):
   * 1. Find all tool result messages and estimate their tokens
   * 2. Protect the most recent `keepRecent` tool results from pruning
   * 3. For unprotected results exceeding `maxTokens`, truncate to placeholder
   *
   * @param messages The current conversation messages
   * @param options  Token-aware pruning options
   */
  prune(messages: ChatMessage[], options: MicroCompactOptions): MicroCompactResult;
  /**
   * Legacy overload: turn-count-based pruning (backwards compatible).
   */
  prune(messages: ChatMessage[], keepTurns: number): MicroCompactResult;
  prune(messages: ChatMessage[], optionsOrKeepTurns: MicroCompactOptions | number): MicroCompactResult {
    // Handle legacy overload
    if (typeof optionsOrKeepTurns === "number") {
      return this.pruneByTurnCount(messages, optionsOrKeepTurns);
    }
    return this.pruneByTokenBudget(messages, optionsOrKeepTurns);
  }

  // -----------------------------------------------------------------------
  // Token-aware pruning (new)
  // -----------------------------------------------------------------------

  private pruneByTokenBudget(
    messages: ChatMessage[],
    options: MicroCompactOptions,
  ): MicroCompactResult {
    const { keepRecent, maxTokens, modelRouter } = options;

    // Build tool call info map for descriptive placeholders
    const toolCallInfo = this.buildToolCallInfoMap(messages);

    // Collect all tool result message indices
    const toolResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        toolResultIndices.push(i);
      }
    }

    // The last `keepRecent` tool results are protected
    // Note: slice(-0) === slice(0) returns ALL elements, so handle keepRecent=0 explicitly
    const protectedSet = keepRecent > 0
      ? new Set(toolResultIndices.slice(-keepRecent))
      : new Set<number>();

    // Additionally protect search tool results (C3.2), but cap the total to
    // prevent unbounded context growth. Keep the most recent search results.
    // Search results are irreplaceable raw materials — once pruned, the model
    // would need to re-run the search, wasting turns and tokens. But on
    // search-heavy tasks (20+ searches), protecting ALL results causes overflow.
    const allSearchResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        const info = toolCallInfo.get(messages[i].toolCallId ?? "");
        if (info && SEARCH_RESULT_TOOLS.has(info.toolName)) {
          allSearchResultIndices.push(i);
        }
      }
    }
    // Keep only the most recent MAX_PROTECTED_SEARCH_RESULTS search results
    const protectedSearchIndices = new Set(
      allSearchResultIndices.slice(-MAX_PROTECTED_SEARCH_RESULTS)
    );

    let prunedCount = 0;
    let tokensSaved = 0;
    const result: ChatMessage[] = messages.map((msg, idx) => {
      if (msg.role !== "tool" || protectedSet.has(idx) || protectedSearchIndices.has(idx)) {
        return msg;
      }

      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      const estimatedTokens = modelRouter.estimateTokens(content);

      if (estimatedTokens > maxTokens) {
        prunedCount++;
        tokensSaved += estimatedTokens - 50; // ~50 tokens for placeholder

        const info = toolCallInfo.get(msg.toolCallId ?? "");
        if (info) {
          return {
            ...msg,
            content: `[Pruned: ${info.toolName}("${info.argsSnippet}") — result trimmed (${estimatedTokens} tokens → placeholder)]`,
          };
        }
        return {
          ...msg,
          content: `[Tool result pruned to save context (${estimatedTokens} tokens)]`,
        };
      }

      return msg;
    });

    return { messages: result, prunedCount, tokensSaved };
  }

  // -----------------------------------------------------------------------
  // Turn-count-based pruning (legacy, backwards compatible)
  // -----------------------------------------------------------------------

  private pruneByTurnCount(messages: ChatMessage[], keepTurns: number): MicroCompactResult {
    // Find the cutoff: the index of the Nth-from-last assistant message
    let assistantCount = 0;
    let cutoffIndex = 0;

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
      return { messages, prunedCount: 0, tokensSaved: 0 };
    }

    const toolCallInfo = this.buildToolCallInfoMap(messages);

    // Protect search tool results even before the cutoff (C3.2), but cap total
    const allSearchResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        const info = toolCallInfo.get(messages[i].toolCallId ?? "");
        if (info && SEARCH_RESULT_TOOLS.has(info.toolName)) {
          allSearchResultIndices.push(i);
        }
      }
    }
    const protectedSearchIndices = new Set(
      allSearchResultIndices.slice(-MAX_PROTECTED_SEARCH_RESULTS)
    );

    let prunedCount = 0;
    const result: ChatMessage[] = messages.map((msg, idx) => {
      if (idx < cutoffIndex && msg.role === "tool" && !protectedSearchIndices.has(idx)) {
        const content = msg.content ?? "";
        if (content.length > 200) {
          prunedCount++;
          const info = toolCallInfo.get(msg.toolCallId ?? "");
          if (info) {
            return {
              ...msg,
              content: `[Pruned: ${info.toolName}("${info.argsSnippet}") — result trimmed to save context]`,
            };
          }
          return {
            ...msg,
            content: "[Tool result pruned to save context space]",
          };
        }
      }
      return msg;
    });

    return { messages: result, prunedCount, tokensSaved: 0 };
  }

  // -----------------------------------------------------------------------
  // Snip compact — lightweight trimming of old assistant reasoning
  // -----------------------------------------------------------------------

  /**
   * Trim verbose assistant reasoning in older turns, preserving only the
   * concluding portion of each assistant message. User messages and recent
   * assistant messages are left untouched.
   *
   * @param messages        Full conversation message array
   * @param keepRecentCount Number of most-recent assistant messages to keep intact (default 20)
   * @returns A new array with old assistant messages snipped; original array is NOT mutated
   */
  snipCompact(messages: ChatMessage[], keepRecentCount: number = 20): ChatMessage[] {
    // Find indices of the most recent `keepRecentCount` assistant messages
    const recentAssistantIndices = new Set<number>();
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        recentAssistantIndices.add(i);
        count++;
        if (count >= keepRecentCount) break;
      }
    }

    const SNIP_THRESHOLD = 200;

    return messages.map((msg, idx) => {
      // User messages are always kept as-is (they are instructions)
      if (msg.role !== "assistant") return msg;

      // Recent assistant messages are kept intact
      if (recentAssistantIndices.has(idx)) return msg;

      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content ?? "");

      // Already short enough — no snipping needed
      if (content.length <= SNIP_THRESHOLD) return msg;

      // Keep only the first 200 chars (conclusion/summary) and append marker
      const snipped = content.slice(0, SNIP_THRESHOLD) + "\n[... detailed reasoning trimmed]";

      return {
        ...msg,
        content: snipped,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Identify pruned ranges (for Context Collapse integration)
  // -----------------------------------------------------------------------

  /**
   * Identify which message ranges would be pruned by the token-budget strategy.
   * Returns the ranges without actually pruning them, allowing CollapseStore
   * to create collapse entries for each range.
   *
   * @param messages The current conversation messages
   * @param options  Token-aware pruning options
   * @returns Array of { startIndex, endIndex, originalTokens } for each contiguous pruned range
   */
  identifyPrunedRanges(
    messages: ChatMessage[],
    options: MicroCompactOptions,
  ): Array<{ startIndex: number; endIndex: number; originalTokens: number }> {
    const { keepRecent, maxTokens, modelRouter } = options;

    // Build tool call info map
    const toolCallInfo = this.buildToolCallInfoMap(messages);

    // Collect all tool result message indices
    const toolResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        toolResultIndices.push(i);
      }
    }

    // The last `keepRecent` tool results are protected
    const protectedSet = keepRecent > 0
      ? new Set(toolResultIndices.slice(-keepRecent))
      : new Set<number>();

    // Additionally protect search tool results (C3.2), but cap total
    const allSearchResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        const info = toolCallInfo.get(messages[i].toolCallId ?? "");
        if (info && SEARCH_RESULT_TOOLS.has(info.toolName)) {
          allSearchResultIndices.push(i);
        }
      }
    }
    const protectedSearchIndices = new Set(
      allSearchResultIndices.slice(-MAX_PROTECTED_SEARCH_RESULTS)
    );

    // Find eligible tool results that exceed maxTokens
    const prunableIndices: number[] = [];
    for (const idx of toolResultIndices) {
      if (protectedSet.has(idx) || protectedSearchIndices.has(idx)) continue;

      const rawContent = messages[idx]!.content;
      const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
      const estimatedTokens = modelRouter.estimateTokens(content);

      if (estimatedTokens > maxTokens) {
        prunableIndices.push(idx);
      }
    }

    if (prunableIndices.length === 0) return [];

    // Group consecutive indices into contiguous ranges
    const ranges: Array<{ startIndex: number; endIndex: number; originalTokens: number }> = [];
    let rangeStart = prunableIndices[0]!;
    let rangeEnd = prunableIndices[0]! + 1;
    const startContent = messages[rangeStart]!.content;
    const startContentStr = typeof startContent === "string" ? startContent : JSON.stringify(startContent ?? "");
    let rangeTokens = modelRouter.estimateTokens(startContentStr);

    for (let i = 1; i < prunableIndices.length; i++) {
      const idx = prunableIndices[i]!;
      const idxContent = messages[idx]!.content;
      const idxContentStr = typeof idxContent === "string" ? idxContent : JSON.stringify(idxContent ?? "");
      if (idx === rangeEnd) {
        // Consecutive — extend range
        rangeEnd = idx + 1;
        rangeTokens += modelRouter.estimateTokens(idxContentStr);
      } else {
        // Non-consecutive — finalize current range, start new one
        ranges.push({ startIndex: rangeStart, endIndex: rangeEnd, originalTokens: rangeTokens });
        rangeStart = idx;
        rangeEnd = idx + 1;
        rangeTokens = modelRouter.estimateTokens(idxContentStr);
      }
    }
    // Finalize last range
    ranges.push({ startIndex: rangeStart, endIndex: rangeEnd, originalTokens: rangeTokens });

    return ranges;
  }

  // -----------------------------------------------------------------------
  // Shared helper
  // -----------------------------------------------------------------------

  private buildToolCallInfoMap(messages: ChatMessage[]): Map<string, { toolName: string; argsSnippet: string }> {
    const toolCallInfo = new Map<string, { toolName: string; argsSnippet: string }>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          let argsSnippet = "";
          try {
            const parsed = JSON.parse(tc.function.arguments);
            const firstVal = Object.values(parsed)[0];
            if (typeof firstVal === "string") {
              argsSnippet = firstVal.slice(0, 80);
            } else {
              argsSnippet = JSON.stringify(firstVal).slice(0, 80);
            }
          } catch {
            argsSnippet = tc.function.arguments.slice(0, 80);
          }
          toolCallInfo.set(tc.id, { toolName: tc.function.name, argsSnippet });
        }
      }
    }
    return toolCallInfo;
  }
}
