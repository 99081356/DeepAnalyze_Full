// =============================================================================
// DeepAnalyze - Token Estimator (Enhanced)
// =============================================================================
// Multi-layer token estimator inspired by Claude Code's tokenEstimation.ts.
//
// Layers:
// 1. API-reported usage (most accurate, cached per message hash)
// 2. Canonical pattern: last API usage + rough estimate for new messages
// 3. File-type-aware heuristic (JSON=2 bytes/token, default=4)
// 4. Image/document fixed estimate (2000 tokens)
//
// Reference: refcode/claude-code/src/services/tokenEstimation.ts
// =============================================================================

// ---------------------------------------------------------------------------
// FNV-1a hash (fast, good distribution for cache keys)
// ---------------------------------------------------------------------------

function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// File-type-aware bytes-per-token
// ---------------------------------------------------------------------------

const DENSE_TOKEN_EXTENSIONS = new Set(["json", "jsonl", "jsonc"]);

/**
 * Get bytes-per-token ratio based on file extension.
 * Dense formats (JSON/JSONL/JSONC) tokenize more densely (~2 bytes/token).
 * Default text is ~4 bytes/token (conservative).
 */
export function bytesPerTokenForFileType(extension: string): number {
  return DENSE_TOKEN_EXTENSIONS.has(extension.toLowerCase()) ? 2 : 4;
}

// ---------------------------------------------------------------------------
// TokenEstimator
// ---------------------------------------------------------------------------

export class TokenEstimator {
  /** API-reported token counts keyed by message hash */
  private reportedTokens = new Map<string, number>();
  /** Last API-reported total input tokens for canonical estimation */
  private lastApiInputTokens: number | null = null;
  /** Message count at the time of last API report */
  private lastApiMessageCount: number = 0;

  /**
   * Record API-reported token usage for a message.
   */
  reportUsage(messageHash: string, tokenCount: number): void {
    this.reportedTokens.set(messageHash, tokenCount);
  }

  /**
   * Record the total input tokens reported by the API for a full turn.
   * Used for the canonical "last API + estimate delta" pattern.
   */
  reportApiUsage(totalInputTokens: number, messageCount: number): void {
    this.lastApiInputTokens = totalInputTokens;
    this.lastApiMessageCount = messageCount;
  }

  /**
   * Estimate tokens for a single message.
   * Uses API-reported value if available, otherwise conservative estimation.
   */
  estimateMessage(msg: {
    content?: string;
    toolCalls?: Array<{ function: { arguments: string } }>;
    role: string;
  }): number {
    const hash = this.hashMessage(msg);
    const reported = this.reportedTokens.get(hash);
    if (reported !== undefined) return reported;

    let tokens = 0;
    if (msg.content) {
      // CJK-aware: CJK chars take more tokens, ASCII fewer
      tokens += roughEstimate(msg.content);
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        tokens += roughEstimate(tc.function.arguments);
        tokens += 20; // overhead per tool call
      }
    }
    tokens += 10; // per-message overhead
    return tokens;
  }

  /**
   * Estimate total tokens for a message array.
   */
  estimateMessages(messages: Array<{
    content?: string;
    toolCalls?: Array<{ function: { arguments: string } }>;
    role: string;
  }>): number {
    return messages.reduce((sum, msg) => sum + this.estimateMessage(msg), 0);
  }

  /**
   * Canonical token count: last API usage + rough estimate for new messages.
   * This is more accurate than full estimation because the API-reported value
   * is exact, and only the delta (new messages) needs estimation.
   */
  tokenCountWithEstimation(
    messages: Array<{
      content?: string;
      toolCalls?: Array<{ function: { arguments: string } }>;
      role: string;
    }>,
  ): number {
    if (this.lastApiInputTokens !== null && messages.length > this.lastApiMessageCount) {
      const deltaMessages = messages.slice(this.lastApiMessageCount);
      const deltaEstimate = deltaMessages.reduce(
        (sum, msg) => sum + this.estimateMessage(msg), 0,
      );
      return this.lastApiInputTokens + deltaEstimate;
    }
    // If we have API tokens and no new messages, return exact value
    if (this.lastApiInputTokens !== null && messages.length <= this.lastApiMessageCount) {
      return this.lastApiInputTokens;
    }
    // Fall back to full estimation
    return this.estimateMessages(messages);
  }

  /**
   * File-type-aware token estimation.
   * Dense JSON/JSONL uses bytesPerToken=2, default=4.
   */
  estimateForFileType(content: string, fileExtension: string): number {
    const bytesPerToken = bytesPerTokenForFileType(fileExtension);
    return Math.ceil(content.length / bytesPerToken);
  }

  /**
   * Estimate tokens for image/document content.
   * Images and documents use a fixed 2000 token estimate
   * (matching CC's roughTokenCountEstimationForBlock).
   */
  estimateForImageOrDocument(): number {
    return 2000;
  }

  /**
   * Hash a message for cache lookup.
   * Uses full content (not truncated) with FNV-1a for speed.
   */
  private hashMessage(msg: {
    content?: string;
    toolCalls?: Array<{ function: { arguments: string } }>;
    role: string;
  }): string {
    const parts = [msg.role];
    if (msg.content) parts.push(msg.content);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        parts.push(tc.function.arguments);
      }
    }
    return fnv1aHash(parts.join("|"));
  }

  /**
   * Clear all cached values.
   */
  clear(): void {
    this.reportedTokens.clear();
    this.lastApiInputTokens = null;
    this.lastApiMessageCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Rough token estimation (CJK-aware)
// ---------------------------------------------------------------------------

/**
 * Conservative character-level token estimation.
 * CJK characters take ~1.5 tokens, ASCII ~0.25 tokens.
 * This matches the estimateTokens() in the provider implementations.
 */
function roughEstimate(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 1.5; // CJK Unified Ideographs
    } else if (code >= 0x3040 && code <= 0x30ff) {
      tokens += 1.5; // Hiragana + Katakana
    } else if (code >= 0xac00 && code <= 0xd7af) {
      tokens += 1.5; // Hangul Syllables
    } else if (code > 0x7f) {
      tokens += 0.5; // Other non-ASCII
    } else {
      tokens += 0.25; // ASCII
    }
  }
  return Math.ceil(tokens);
}
