// =============================================================================
// DeepAnalyze - Cache-Safe Params for Subagent Forking
// =============================================================================
// Ensures sub-agents share the parent agent's prompt cache by tracking
// the key parameters that form the Anthropic API cache key:
// system prompt, tool schemas, model, and message prefix.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheSafeParams {
  /** Hash of the system prompt (static + dynamic sections) */
  systemPromptHash: string;
  /** Hash of the tool definitions JSON */
  toolsHash: string;
  /** Model identifier */
  model: string;
  /** Number of context messages passed to the API */
  contextMessagesCount: number;
}

export interface CacheSafetyResult {
  safe: boolean;
  violations: string[];
}

// ---------------------------------------------------------------------------
// Module-level slot (written after each API call in the main loop)
// ---------------------------------------------------------------------------

let lastCacheSafeParams: CacheSafeParams | null = null;

/**
 * Save cache-safe params after each API call.
 * Sub-agents can read these to verify cache compatibility.
 */
export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params;
}

/**
 * Get the last saved cache-safe params.
 * Used by sub-agents to verify they can share the parent's cache.
 */
export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams;
}

// ---------------------------------------------------------------------------
// Simple hash for string content (djb2)
// ---------------------------------------------------------------------------

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Compute a CacheSafeParams snapshot from the current call parameters.
 */
export function computeCacheSafeParams(params: {
  systemPrompt: string;
  toolsJson: string;
  model: string;
  contextMessagesCount: number;
}): CacheSafeParams {
  return {
    systemPromptHash: djb2Hash(params.systemPrompt),
    toolsHash: djb2Hash(params.toolsJson),
    model: params.model,
    contextMessagesCount: params.contextMessagesCount,
  };
}

/**
 * Validate that child params are compatible with parent params for cache sharing.
 * Returns a result with safe=true if all critical params match.
 */
export function validateCacheSafety(
  parent: CacheSafeParams,
  child: CacheSafeParams,
): CacheSafetyResult {
  const violations: string[] = [];

  if (child.systemPromptHash !== parent.systemPromptHash) {
    violations.push("system prompt hash mismatch — sub-agent uses different system prompt");
  }

  if (child.toolsHash !== parent.toolsHash) {
    violations.push("tools hash mismatch — sub-agent uses different tool definitions");
  }

  if (child.model !== parent.model) {
    violations.push(`model mismatch — parent: ${parent.model}, child: ${child.model}`);
  }

  // Context messages prefix should be a subset (child <= parent)
  if (child.contextMessagesCount > parent.contextMessagesCount) {
    violations.push(
      `context messages count exceeds parent — child: ${child.contextMessagesCount}, parent: ${parent.contextMessagesCount}`,
    );
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}
