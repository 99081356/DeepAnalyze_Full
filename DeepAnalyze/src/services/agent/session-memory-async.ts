// =============================================================================
// DeepAnalyze - Async Session Memory Extraction
// =============================================================================
// Triggers background memory extraction periodically without blocking the
// main agent loop. Inspired by Claude Code's SM-compact async extraction.
//
// Triggers:
// 1. Token increment exceeds threshold (existing)
// 2. Tool call count increment exceeds 3 (new, from CC)
// =============================================================================

import type { AgentSettings } from "./types.js";
import { DEFAULT_AGENT_SETTINGS } from "./types.js";

/**
 * Async session memory extractor.
 * Triggers background extraction periodically without blocking the agent loop.
 *
 * Reference: Claude Code's SM-compact async extraction + tool-call-count trigger
 */
export class AsyncSessionMemoryExtractor {
  private extractPromise: Promise<void> | null = null;
  private lastExtractedTokens = 0;
  private lastExtractedToolCallCount = 0;
  private settings: AgentSettings;

  constructor(settings?: Partial<AgentSettings>) {
    this.settings = { ...DEFAULT_AGENT_SETTINGS, ...settings };
  }

  /**
   * Try to trigger async extraction. Non-blocking.
   * Skips if already extracting or if neither trigger condition is met.
   *
   * @param currentTokens - Current total token count
   * @param toolCallCount - Total tool calls so far
   * @param extractFn - Async function that performs the extraction
   */
  tryExtract(
    currentTokens: number,
    extractFn: () => Promise<void>,
    toolCallCount?: number,
  ): void {
    // Already extracting → skip
    if (this.extractPromise) return;

    // Check token increment trigger
    const tokenIncrement = currentTokens - this.lastExtractedTokens;
    const tokenTrigger = tokenIncrement >= this.settings.sessionMemoryUpdateInterval * 3;

    // Check tool call count trigger (new: 3+ tool calls between extractions)
    const currentToolCalls = toolCallCount ?? 0;
    const toolCallIncrement = currentToolCalls - this.lastExtractedToolCallCount;
    const toolCallTrigger = toolCallIncrement >= 3;

    if (!tokenTrigger && !toolCallTrigger) {
      return;
    }

    // Start background extraction
    this.extractPromise = extractFn()
      .then(() => {
        this.lastExtractedTokens = currentTokens;
        this.lastExtractedToolCallCount = currentToolCalls;
      })
      .catch((err) => {
        console.warn("[AsyncSessionMemory] Background extraction failed:", err);
      })
      .finally(() => {
        this.extractPromise = null;
      });
  }

  /**
   * Wait for any in-progress extraction to complete.
   */
  async waitForExtraction(): Promise<void> {
    if (this.extractPromise) {
      await this.extractPromise;
    }
  }

  /**
   * Whether extraction is currently in progress.
   */
  get isExtracting(): boolean {
    return this.extractPromise !== null;
  }

  /**
   * Reset state (e.g., after compaction).
   */
  reset(): void {
    this.lastExtractedTokens = 0;
    this.lastExtractedToolCallCount = 0;
  }
}
