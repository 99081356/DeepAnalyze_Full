// =============================================================================
// DeepAnalyze - Cache Editing
// =============================================================================
// Truncates old tool results when sending to the API, without modifying the
// local message array. This preserves the cache prefix (system prompt + tool
// definitions) so prompt caching remains effective across turns.
//
// Reference: claude-code microCompact
// =============================================================================

import type { ChatMessage } from "../../models/provider.js";

/**
 * Options for cache editing behaviour.
 */
export interface CacheEditOptions {
  /** Keep recent N assistant turns' tool results untouched. Default: 10 */
  keepRecentTurns: number;
  /** Max chars per tool result before truncation. Default: 8000 */
  maxResultChars: number;
}

const DEFAULT_CACHE_EDIT_OPTIONS: CacheEditOptions = {
  keepRecentTurns: 10,
  maxResultChars: 8000,
};

/**
 * Apply cache editing to messages for API submission.
 * Returns a **new** array — original messages are never modified.
 * Truncates old tool results that exceed `maxResultChars`.
 */
export function applyCacheEditing(
  messages: ChatMessage[],
  options: CacheEditOptions = DEFAULT_CACHE_EDIT_OPTIONS,
): ChatMessage[] {
  const { keepRecentTurns, maxResultChars } = options;

  // If there are no messages, skip processing.
  if (messages.length === 0) return [];

  // keepRecentTurns = 0 means "all turns are old" — everything is eligible.
  if (keepRecentTurns <= 0) {
    return messages.map((msg) => {
      if (msg.role === "tool") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        if (content.length > maxResultChars) {
          return {
            ...msg,
            content:
              content.slice(0, maxResultChars) +
              `\n\n[... result truncated (${Math.round(content.length / 1024)}KB total), removed for context management ...]`,
          };
        }
      }
      return msg;
    });
  }

  // Calculate cutoff index based on assistant turn count (from end)
  let assistantTurns = 0;
  let cutoffIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantTurns++;
      if (assistantTurns >= keepRecentTurns) {
        cutoffIndex = i;
        break;
      }
    }
  }

  // If we never hit the threshold, all messages are "recent" — nothing to
  // truncate.  Return a shallow copy for consistency.
  if (assistantTurns < keepRecentTurns) {
    return messages.map((msg) => msg);
  }

  // Truncate old tool results above the cutoff
  return messages.map((msg, idx) => {
    if (idx < cutoffIndex && msg.role === "tool") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      if (content.length > maxResultChars) {
        return {
          ...msg,
          content:
            content.slice(0, maxResultChars) +
            `\n\n[... result truncated (${Math.round(content.length / 1024)}KB total), removed for context management ...]`,
        };
      }
    }
    return msg;
  });
}

// ---------------------------------------------------------------------------
// Smart Cache Editing — preserves search/citation tool results longer
// ---------------------------------------------------------------------------

/**
 * Tools whose results contain citation/source data that should be preserved
 * longer than generic tool results.
 */
const CITATION_TOOLS = new Set([
  "kb_search", "expand", "doc_grep", "web_search", "wiki_browse",
]);

/**
 * Options for smart cache editing.
 */
export interface SmartCacheEditOptions {
  /** Keep recent N assistant turns' tool results untouched. Default: 10 */
  keepRecentTurns: number;
  /** Max chars for citation-source tool results. Default: 16000 (2x normal) */
  maxCitationResultChars: number;
  /** Max chars for generic tool results. Default: 4000 */
  maxGenericResultChars: number;
}

const DEFAULT_SMART_CACHE_EDIT_OPTIONS: SmartCacheEditOptions = {
  keepRecentTurns: 10,
  maxCitationResultChars: 16000,
  maxGenericResultChars: 4000,
};

/**
 * Apply smart cache editing to messages for API submission.
 *
 * Improvements over applyCacheEditing():
 * 1. Citation-source tools (kb_search, expand, etc.) keep 2x more content
 * 2. Generic tools get structured summaries instead of brute-force truncation
 * 3. Empty results and short results are preserved as-is
 *
 * Returns a **new** array — original messages are never modified.
 */
export function applySmartCacheEditing(
  messages: ChatMessage[],
  options: SmartCacheEditOptions = DEFAULT_SMART_CACHE_EDIT_OPTIONS,
): ChatMessage[] {
  const { keepRecentTurns, maxCitationResultChars, maxGenericResultChars } = options;

  if (messages.length === 0) return [];

  // Build a lookup: tool_call_id -> tool name (from preceding assistant messages)
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id) toolNameMap.set(tc.id, tc.function.name);
      }
    }
  }

  // Calculate cutoff index based on assistant turn count (from end)
  let assistantTurns = 0;
  let cutoffIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantTurns++;
      if (assistantTurns >= keepRecentTurns) {
        cutoffIndex = i;
        break;
      }
    }
  }

  if (assistantTurns < keepRecentTurns) {
    return messages.map((msg) => msg);
  }

  return messages.map((msg, idx) => {
    if (idx >= cutoffIndex || msg.role !== "tool") return msg;

    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);

    // Determine if this is a citation-source tool result
    const toolName = msg.toolCallId ? toolNameMap.get(msg.toolCallId) : undefined;
    const isCitationTool = toolName ? CITATION_TOOLS.has(toolName) : false;
    const maxChars = isCitationTool ? maxCitationResultChars : maxGenericResultChars;

    if (content.length <= maxChars) return msg;

    if (isCitationTool) {
      // For citation tools: keep first N chars (contains the actual data)
      // and a tail summary showing what was cut
      const tailPreview = content.slice(-500).replace(/^.*\n/, "... ");
      return {
        ...msg,
        content:
          content.slice(0, maxChars) +
          `\n\n[... ${Math.round(content.length / 1024)}KB citation data truncated, tail: ${tailPreview} ...]`,
      };
    } else {
      // For generic tools: generate a structured summary
      return {
        ...msg,
        content: generateSmartSummary(content, maxGenericResultChars, toolName),
      };
    }
  });
}

/**
 * Generate a structured summary for a long tool result.
 * Preserves the beginning (usually metadata/status) and extracts
 * key statistics from the body.
 */
function generateSmartSummary(
  content: string,
  maxChars: number,
  toolName?: string,
): string {
  const totalKB = Math.round(content.length / 1024);
  const header = `[Tool result condensed from ${totalKB}KB]`;

  // Keep the first portion (usually metadata, status, headers)
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = Math.floor(maxChars * 0.3);

  const head = content.slice(0, headBudget);

  // Extract line count and key patterns from the body
  const lineCount = content.split("\n").length;
  const statsLine = `[Original: ${lineCount} lines, ${totalKB}KB]`;

  // Take the tail (usually contains completion status or summary)
  const tail = content.slice(-tailBudget);

  return `${header}\n${head}\n... [${statsLine}] ...\n${tail}`;
}
