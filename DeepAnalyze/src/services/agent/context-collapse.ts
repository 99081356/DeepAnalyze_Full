// =============================================================================
// DeepAnalyze - Context Collapse (Read-Time Semantic Projection)
// =============================================================================
// Provides non-destructive context reduction by maintaining a separate store
// of collapse entries. Original messages are NEVER modified. Instead, a
// projection engine creates a derived array for API submission where collapsed
// regions are replaced by summaries.
//
// Architecture:
//   messages (immutable source of truth)
//     -> applyCollapseProjection()  -> projectedMessages
//     -> applyCacheEditing()        -> messagesForApi
//     -> markCacheBreakpoints()     -> messagesForApi (with cache_control)
//     -> API call
//
// Key properties:
//   - CollapseStore is per-run (in-memory), not per-session
//   - Collapse entries are non-overlapping
//   - Index 0 (system prompt) is never collapsed
//   - Expansion removes a collapse entry, restoring original messages on next projection
// =============================================================================

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../models/provider.js";
import type {
  CollapseEntry,
  CollapseMethod,
  ProjectionResult,
  CollapseSummaryInfo,
} from "./types.js";
import { repairMessageSequence } from "./message-utils.js";
import type { MicroCompactResult, MicroCompactOptions } from "./micro-compact.js";

// ---------------------------------------------------------------------------
// Search tools whose results are "raw materials" — losing them breaks citation chains.
// Re-uses the same set from compaction.ts.
// ---------------------------------------------------------------------------

const CITATION_SOURCE_TOOLS = new Set([
  "kb_search", "expand", "doc_grep", "web_search", "wiki_browse",
]);

// ---------------------------------------------------------------------------
// CollapseStore
// ---------------------------------------------------------------------------

export class CollapseStore {
  /** All active collapse entries, ordered by startIndex */
  private entries: CollapseEntry[] = [];

  /** Index for O(1) lookup by collapseId */
  private entryIndex = new Map<string, CollapseEntry>();

  /** Reference to the original messages array (for expansion) */
  private originalMessages: ChatMessage[];

  constructor(originalMessages: ChatMessage[]) {
    this.originalMessages = originalMessages;
  }

  /**
   * Clear all collapse entries. Called after compaction to reset state.
   */
  clear(): void {
    this.entries = [];
    this.entryIndex.clear();
  }

  // -----------------------------------------------------------------------
  // Collapse Creation
  // -----------------------------------------------------------------------

  /**
   * Create a new collapse entry for a message range.
   *
   * Overlap resolution strategy:
   * - New range FULLY CONTAINS existing → remove existing (superseded by newer, larger summary)
   * - New range PARTIALLY OVERLAPS existing → remove existing (new range extends coverage)
   * - Existing FULLY CONTAINS new range → reject (no new area to compact)
   * - No overlap → proceed normally
   *
   * INVARIANTS:
   * - Never collapses index 0 (system prompt)
   * - Entries are non-overlapping after resolution
   * - startIndex < endIndex
   * - Range must have at least 1 message
   *
   * @returns The created CollapseEntry, or null if the range is invalid
   */
  createCollapse(
    startIndex: number,
    endIndex: number,
    replacementMessages: ChatMessage[],
    method: CollapseMethod,
    originalTokens: number,
    replacementTokens: number,
    turnNumber: number,
    metadata?: CollapseEntry["metadata"],
  ): CollapseEntry | null {
    // Validation
    if (startIndex < 1) {
      console.warn("[CollapseStore] Reject: cannot collapse system prompt (index 0)");
      return null;
    }
    if (startIndex >= endIndex) {
      console.warn(`[CollapseStore] Reject: invalid range [${startIndex}, ${endIndex})`);
      return null;
    }
    if (endIndex > this.originalMessages.length) {
      console.warn(`[CollapseStore] Reject: endIndex ${endIndex} > messages.length ${this.originalMessages.length}`);
      return null;
    }

    // Resolve overlaps with existing entries
    // Strategy: new ranges that contain or partially overlap existing entries
    // supersede them (the new, larger summary replaces the old smaller one).
    // Only reject if the existing entry already fully covers the new range.
    const toRemove: string[] = [];
    for (const existing of this.entries) {
      // No overlap — skip
      if (startIndex >= existing.endIndex || endIndex <= existing.startIndex) {
        continue;
      }

      // Existing fully contains new range — no benefit from re-compacting a subset
      if (existing.startIndex <= startIndex && existing.endIndex >= endIndex) {
        // This is a normal, expected case when micro-compact re-identifies already-collapsed
        // ranges on subsequent turns. Debug level to avoid log spam.
        console.debug(
          `[CollapseStore] Skip: already collapsed [${startIndex}, ${endIndex}) ` +
          `by entry ${existing.collapseId.slice(0, 8)} [${existing.startIndex}, ${existing.endIndex})`
        );
        return null;
      }

      // New range contains or partially overlaps existing → remove existing
      console.log(
        `[CollapseStore] Extend: removing superseded entry ${existing.collapseId} ` +
        `[${existing.startIndex}, ${existing.endIndex}) to make room for [${startIndex}, ${endIndex})`
      );
      toRemove.push(existing.collapseId);
    }

    // Remove superseded entries
    if (toRemove.length > 0) {
      const removeSet = new Set(toRemove);
      this.entries = this.entries.filter(e => !removeSet.has(e.collapseId));
      for (const id of toRemove) {
        this.entryIndex.delete(id);
      }
    }

    // Check if the range contains search tool calls
    const hasSearchContent = this.rangeHasSearchContent(startIndex, endIndex);

    const entry: CollapseEntry = {
      collapseId: randomUUID(),
      startIndex,
      endIndex,
      method,
      originalTokens,
      replacementMessages,
      replacementTokens,
      hasSearchContent,
      turnNumber,
      createdAt: new Date().toISOString(),
      metadata,
    };

    this.entries.push(entry);
    this.entryIndex.set(entry.collapseId, entry);

    // Maintain sorted order by startIndex
    this.entries.sort((a, b) => a.startIndex - b.startIndex);

    return entry;
  }

  // -----------------------------------------------------------------------
  // Projection Engine
  // -----------------------------------------------------------------------

  /**
   * Project the original messages array into a derived array where
   * all collapsed regions are replaced by their summary messages.
   *
   * Algorithm:
   * 1. Walk through original messages from index 0 to end
   * 2. For each position, check if a collapse entry covers it
   * 3. If covered, skip original messages and inject replacement messages
   * 4. If not covered, copy the original message as-is
   * 5. Repair the resulting sequence for API validity
   *
   * Complexity: O(n + m) where n = messages.length, m = entries.length
   */
  project(): ProjectionResult {
    if (this.entries.length === 0) {
      return {
        projectedMessages: this.originalMessages,
        collapsesApplied: 0,
        totalTokensSaved: 0,
      };
    }

    const projected: ChatMessage[] = [];
    let collapsesApplied = 0;
    let totalTokensSaved = 0;
    let cursor = 0;

    for (const entry of this.entries) {
      // Copy messages before this collapse entry
      while (cursor < entry.startIndex) {
        projected.push(this.originalMessages[cursor]!);
        cursor++;
      }

      // Inject replacement messages
      for (const replacement of entry.replacementMessages) {
        projected.push(replacement);
      }

      // Skip past the collapsed range
      cursor = entry.endIndex;
      collapsesApplied++;
      totalTokensSaved += Math.max(0, entry.originalTokens - entry.replacementTokens);
    }

    // Copy remaining messages after the last collapse entry
    while (cursor < this.originalMessages.length) {
      projected.push(this.originalMessages[cursor]!);
      cursor++;
    }

    // Repair any sequence violations (e.g., tool messages without preceding assistant)
    const repaired = repairMessageSequence(projected);

    return {
      projectedMessages: repaired,
      collapsesApplied,
      totalTokensSaved,
    };
  }

  // -----------------------------------------------------------------------
  // Expansion
  // -----------------------------------------------------------------------

  /**
   * Expand a previously collapsed region, restoring the original messages.
   * Removes the collapse entry from the store.
   *
   * @param collapseId The ID of the collapse entry to expand
   * @returns The expanded entry info, or null if not found
   */
  expand(collapseId: string): { expandedEntry: CollapseEntry } | null {
    const entry = this.entryIndex.get(collapseId);
    if (!entry) return null;

    // Remove from store
    this.entries = this.entries.filter(e => e.collapseId !== collapseId);
    this.entryIndex.delete(collapseId);

    console.log(
      `[CollapseStore] Expanded collapse ${collapseId.slice(0, 8)}... ` +
      `[${entry.startIndex}, ${entry.endIndex}) method=${entry.method}, ` +
      `restored ${entry.endIndex - entry.startIndex} messages`
    );

    return { expandedEntry: entry };
  }

  /**
   * Find collapse entries that contain a specific message index.
   */
  findCollapsesContaining(messageIndex: number): CollapseEntry[] {
    return this.entries.filter(
      e => messageIndex >= e.startIndex && messageIndex < e.endIndex
    );
  }

  /**
   * Find collapse entries that contain search tool results.
   * These are prioritized for expansion when the model needs source data.
   */
  findSearchCollapses(): CollapseEntry[] {
    return this.entries.filter(e => e.hasSearchContent);
  }

  /**
   * Auto-expand the most valuable collapsed region when the model
   * appears to reference something from a collapsed range.
   *
   * Heuristic: expand the most recent collapse with search content.
   * If none, expand the most recent collapse overall.
   */
  autoExpandForReference(): { expandedEntry: CollapseEntry } | null {
    if (this.entries.length === 0) return null;

    // Priority 1: Most recent collapse with search content
    const searchEntries = this.entries.filter(e => e.hasSearchContent);
    if (searchEntries.length > 0) {
      const target = searchEntries[searchEntries.length - 1]!;
      return this.expand(target.collapseId);
    }

    // Priority 2: Most recent collapse overall
    const target = this.entries[this.entries.length - 1]!;
    return this.expand(target.collapseId);
  }

  // -----------------------------------------------------------------------
  // Query Methods
  // -----------------------------------------------------------------------

  /** Get all active collapse entries */
  getEntries(): ReadonlyArray<CollapseEntry> {
    return this.entries;
  }

  /** Get a specific collapse entry by ID */
  getEntry(collapseId: string): CollapseEntry | undefined {
    return this.entryIndex.get(collapseId);
  }

  /** Total number of active collapses */
  get count(): number {
    return this.entries.length;
  }

  /** Total tokens saved across all collapses */
  get totalTokensSaved(): number {
    return this.entries.reduce(
      (sum, e) => sum + Math.max(0, e.originalTokens - e.replacementTokens), 0
    );
  }

  /** Whether any collapses are active */
  get hasCollapses(): boolean {
    return this.entries.length > 0;
  }

  /**
   * Check if a range is already fully covered by an existing collapse entry.
   * Used by micro-compact to avoid redundant createCollapse() calls.
   */
  isRangeCovered(startIndex: number, endIndex: number): boolean {
    for (const existing of this.entries) {
      if (existing.startIndex <= startIndex && existing.endIndex >= endIndex) {
        return true;
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Index Adjustment
  // -----------------------------------------------------------------------

  /**
   * Adjust collapse entry indices after new messages are appended.
   * Since collapses only cover old messages and new messages are appended
   * at the end, existing collapse indices remain valid.
   *
   * This method exists for future use if messages are inserted in the middle.
   */
  adjustIndices(insertedAt: number, count: number): void {
    for (const entry of this.entries) {
      if (entry.startIndex >= insertedAt) {
        entry.startIndex += count;
      }
      if (entry.endIndex > insertedAt) {
        entry.endIndex += count;
      }
    }
    // Re-sort in case order changed
    this.entries.sort((a, b) => a.startIndex - b.startIndex);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Remove collapse entries whose ranges have been invalidated
   * (e.g., if the original messages array was somehow truncated).
   */
  cleanup(): void {
    const maxIndex = this.originalMessages.length;
    const before = this.entries.length;
    this.entries = this.entries.filter(
      e => e.startIndex < maxIndex && e.endIndex <= maxIndex
    );
    // Rebuild index
    this.entryIndex.clear();
    for (const entry of this.entries) {
      this.entryIndex.set(entry.collapseId, entry);
    }
    if (this.entries.length < before) {
      console.log(`[CollapseStore] Cleanup: removed ${before - this.entries.length} invalidated entries`);
    }
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  /**
   * Check if a message range contains search tool calls.
   */
  private rangeHasSearchContent(startIndex: number, endIndex: number): boolean {
    for (let i = startIndex; i < endIndex && i < this.originalMessages.length; i++) {
      const msg = this.originalMessages[i]!;
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (CITATION_SOURCE_TOOLS.has(tc.function.name)) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Standalone projection function (same pattern as applyCacheEditing)
// ---------------------------------------------------------------------------

/**
 * Apply collapse projection to messages for API submission.
 * Returns a new array -- original messages are never modified.
 *
 * This is the main entry point called from agent-runner.ts.
 *
 * @param messages The original, immutable message array
 * @param collapseStore The collapse store with active entries
 * @returns Projected message array for API submission
 */
export function applyCollapseProjection(
  messages: ChatMessage[],
  collapseStore: CollapseStore,
): ChatMessage[] {
  if (!collapseStore.hasCollapses) {
    return messages; // Identity return -- no allocation
  }

  const result = collapseStore.project();
  return result.projectedMessages;
}

// ---------------------------------------------------------------------------
// Helper: Create micro-collapse entries from prune result
// ---------------------------------------------------------------------------

/**
 * Create micro-collapse entries by comparing original messages with the
 * pruned result. Each pruned tool result message gets its own collapse entry
 * for fine-grained expansion.
 *
 * @returns Number of collapse entries created
 */
export function createMicroCollapseEntries(
  store: CollapseStore,
  originalMessages: ChatMessage[],
  prunedMessages: ChatMessage[],
  prunedCount: number,
  modelRouter: { estimateTokens(text: string): number },
  turn: number,
): number {
  if (prunedCount === 0) return 0;

  let created = 0;

  for (let i = 0; i < originalMessages.length && i < prunedMessages.length; i++) {
    const orig = originalMessages[i]!;
    const pruned = prunedMessages[i]!;

    // Check if this message was pruned (content differs and it's a tool message)
    if (orig.role !== "tool" || pruned.role !== "tool") continue;
    if (orig.content === pruned.content) continue;

    // This tool result was pruned
    const origContent = typeof orig.content === "string" ? orig.content : JSON.stringify(orig.content);
    const prunedContent = typeof pruned.content === "string" ? pruned.content : JSON.stringify(pruned.content);

    // Only create a collapse if the original was significantly larger
    if (origContent.length > prunedContent.length + 100) {
      const originalTokens = modelRouter.estimateTokens(origContent);

      const entry = store.createCollapse(
        i, i + 1,
        [pruned],
        "micro-collapse",
        originalTokens,
        modelRouter.estimateTokens(prunedContent),
        turn,
        { messageCount: 1 },
      );

      if (entry) {
        created++;
      }
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
// Helper: Create collapse entry from CollapseSummaryInfo
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper to create a collapse entry from a CollapseSummaryInfo result.
 */
export function createCollapseFromSummary(
  store: CollapseStore,
  info: CollapseSummaryInfo,
  turn: number,
  metadata?: CollapseEntry["metadata"],
): CollapseEntry | null {
  return store.createCollapse(
    info.startIndex,
    info.endIndex,
    info.replacementMessages,
    info.method,
    info.originalTokens,
    info.replacementTokens,
    turn,
    metadata ?? { messageCount: info.endIndex - info.startIndex },
  );
}
