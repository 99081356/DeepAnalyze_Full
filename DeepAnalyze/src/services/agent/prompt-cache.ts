// prompt-cache.ts

/**
 * Prompt caching support for the agent system.
 *
 * Strategy:
 * 1. System prompt is split into static prefix (cacheable) + dynamic suffix
 * 2. Tool definitions are sorted alphabetically for cache stability
 * 3. cache_control markers placed on appropriate messages
 *
 * Reference: refcode/claude-code/src/services/api/claude.ts addCacheBreakpoints()
 */

// ---------------------------------------------------------------------------
// System prompt splitting
// ---------------------------------------------------------------------------

export interface SystemPromptParts {
  /** Static prefix (agent definition + tool descriptions) — cacheable */
  staticPrefix: string;
  /** Dynamic boundary marker */
  dynamicBoundary: string;
  /** Dynamic suffix (scope injection, session memory, project config) — changes per request */
  dynamicSuffix: string;
}

const DYNAMIC_BOUNDARY = "\n\n---DYNAMIC_BOUNDARY---\n\n";

/**
 * Split a full system prompt into static and dynamic parts.
 * Uses the DYNAMIC_BOUNDARY marker as separator.
 * If no boundary found, the entire prompt is treated as static.
 */
export function splitSystemPrompt(fullPrompt: string): SystemPromptParts {
  const boundaryIndex = fullPrompt.indexOf(DYNAMIC_BOUNDARY);

  if (boundaryIndex === -1) {
    return {
      staticPrefix: fullPrompt,
      dynamicBoundary: "",
      dynamicSuffix: "",
    };
  }

  return {
    staticPrefix: fullPrompt.slice(0, boundaryIndex),
    dynamicBoundary: DYNAMIC_BOUNDARY,
    dynamicSuffix: fullPrompt.slice(boundaryIndex + DYNAMIC_BOUNDARY.length),
  };
}

/**
 * Reassemble system prompt parts into a full prompt.
 */
export function assembleSystemPrompt(parts: SystemPromptParts): string {
  if (!parts.dynamicSuffix) return parts.staticPrefix;
  return parts.staticPrefix + parts.dynamicBoundary + parts.dynamicSuffix;
}

// ---------------------------------------------------------------------------
// Cache control for API messages
// ---------------------------------------------------------------------------

/**
 * Add cache_control hints to messages for prompt caching.
 * Places cache_control on:
 * 1. The system message (if it contains a DYNAMIC_BOUNDARY, marks static prefix)
 * 2. The last user message (standard cache write point)
 *
 * Reference: refcode/claude-code/src/services/api/claude.ts addCacheBreakpoints()
 *
 * Note: The actual cache_control injection happens in the provider adapter
 * (e.g., Anthropic provider). This function marks which messages should have it.
 */
export function markCacheBreakpoints<T extends { role: string }>(
  messages: T[],
): T[] {
  let marked = messages;

  // Mark the last user message for cache writing
  for (let i = marked.length - 1; i >= 0; i--) {
    if (marked[i].role === "user") {
      marked = marked.map((msg, idx) =>
        idx === i
          ? { ...msg, __cache_control: { type: "ephemeral" as const } }
          : msg
      );
      break;
    }
  }

  return marked;
}

// ---------------------------------------------------------------------------
// System prompt cache blocks (for Anthropic TextBlockParam[])
// ---------------------------------------------------------------------------

export interface SystemPromptCacheBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * Split a full system prompt into Anthropic TextBlockParam[] with cache_control.
 * The static prefix gets cache_control (cacheable), the dynamic suffix does not.
 * Falls back to a single block without caching if no boundary is found.
 */
export function splitSystemPromptForCache(
  fullPrompt: string,
): SystemPromptCacheBlock[] {
  const parts = splitSystemPrompt(fullPrompt);

  const blocks: SystemPromptCacheBlock[] = [];

  if (parts.staticPrefix) {
    blocks.push({
      type: "text",
      text: parts.staticPrefix,
      cache_control: { type: "ephemeral" },
    });
  }

  if (parts.dynamicSuffix) {
    blocks.push({
      type: "text",
      text: parts.dynamicSuffix,
    });
  }

  // If no blocks were created (empty prompt), return single empty block
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: fullPrompt });
  }

  return blocks;
}
