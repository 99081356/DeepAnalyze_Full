// =============================================================================
// DeepAnalyze - Compaction Engine
// =============================================================================
// Two-level context compression: SM-compact (no API call, uses session memory)
// and Legacy compact (LLM-generated summary). Groups messages by API round-trip
// (assistant + tool results) and finds cutoff at group boundaries only.
// Includes PTL retry loop for legacy compact and circuit breaker protection.
// =============================================================================

import { ModelRouter } from "../../models/router.js";
import type { ChatMessage } from "../../models/provider.js";
import { ContextManager } from "./context-manager.js";
import { SessionMemoryManager } from "./session-memory.js";
import { repairMessageSequence } from "./message-utils.js";
import type { SessionMemoryNote, AgentSettings, CollapseSummaryInfo, CollapseMethod, ReadFileStateEntry, InvokedSkillEntry } from "./types.js";
import { DEFAULT_AGENT_SETTINGS } from "./types.js";
import { getCompactPrompt, formatCompactSummary, getCompactUserSummaryMessage } from "./compact-prompt.js";
import { COMPRESSION_LEVELS } from "./hierarchical-compressor.js";
import { clearSystemPromptCache } from "./system-prompt.js";
import type { HookManager } from "./hooks.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Compaction escalation level. */
type EscalationLevel = "normal" | "aggressive" | "deterministic";

export interface CompactionResult {
  messages: ChatMessage[];
  method: "sm-compact" | "legacy-compact" | "hierarchical-compact" | "none";
  tokensSaved: number;
  /** Token count before compaction. Used for compact boundary metadata. */
  preCompactTokens: number;
  /** Path to transcript file containing pre-compaction message details. */
  transcriptPath?: string;
}

/**
 * A group of messages representing one API round-trip:
 * an assistant message followed by zero or more tool result messages.
 */
interface MessageGroup {
  /** Index of the assistant message in the original array */
  assistantIndex: number;
  /** Indices of the tool result messages that follow */
  toolResultIndices: number[];
  /** Estimated token count for the entire group */
  tokenCount: number;
  /** Whether this group contains a search tool call (kb_search, expand, etc.) */
  hasSearchCall?: boolean;
}

/** Search tools whose results are "raw materials" — losing them breaks citation chains. */
const CITATION_SOURCE_TOOLS = new Set([
  "kb_search", "expand", "doc_grep", "web_search", "wiki_browse",
]);

// ---------------------------------------------------------------------------
// Feature H: SM-Compact threshold configuration (C-193)
// ---------------------------------------------------------------------------

const SM_COMPACT_CONFIG = {
  /** Minimum tokens to preserve after compaction */
  minTokens: 10_000,
  /** Minimum messages with text blocks to keep */
  minTextBlockMessages: 5,
  /** Hard cap on preserved tokens */
  maxTokens: 40_000,
};

// ---------------------------------------------------------------------------
// Compaction Circuit Breaker
// ---------------------------------------------------------------------------

class CompactionCircuitBreaker {
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private circuitOpen = false;
  private escalationLevel: EscalationLevel = "normal";
  private consecutiveLowQuality = 0;

  constructor(
    private maxFailures: number = 5,
    private resetTimeoutMs: number = 120_000,
  ) {}

  /** Check if a compaction attempt is allowed. */
  canAttempt(): boolean {
    if (!this.circuitOpen) return true;
    // Half-open: try again after resetTimeout
    if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
      this.circuitOpen = false;
      console.log("[CompactionCircuitBreaker] Entering half-open state");
      return true;
    }
    return false;
  }

  /** Get current escalation level. */
  getEscalationLevel(): EscalationLevel {
    return this.escalationLevel;
  }

  /** Record a successful compaction — reset and close. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.consecutiveLowQuality = 0;
    // Reset to normal on success
    if (this.escalationLevel !== "normal") {
      console.log(`[CompactionCircuitBreaker] Resetting escalation from ${this.escalationLevel} to normal`);
      this.escalationLevel = "normal";
    }
  }

  /** Record a failed compaction — open circuit after maxFailures. */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.maxFailures) {
      this.circuitOpen = true;
      console.warn(
        `[CompactionCircuitBreaker] Circuit opened after ${this.consecutiveFailures} consecutive failures`,
      );
    }
  }

  /** Record low quality compaction — escalate if persistent. */
  recordLowQuality(): void {
    this.consecutiveLowQuality++;
    if (this.consecutiveLowQuality >= 2 && this.escalationLevel === "normal") {
      this.escalationLevel = "aggressive";
      console.log("[CompactionCircuitBreaker] Escalating to aggressive compression");
    } else if (this.consecutiveLowQuality >= 4 && this.escalationLevel === "aggressive") {
      this.escalationLevel = "deterministic";
      console.log("[CompactionCircuitBreaker] Escalating to deterministic compression");
    }
  }
}

// ---------------------------------------------------------------------------
// API Invariant Protection
// ---------------------------------------------------------------------------

/**
 * Adjust a compaction cutoff index to preserve API invariants:
 * 1. tool_use/tool_result pairs must not be split across the cutoff boundary
 * 2. If a tool_result in the kept range references a tool_use in the compacted
 *    range, pull the cutoff backward to include the tool_use.
 *
 * Reference: Claude Code's adjustIndexToPreserveAPIInvariants()
 */
export function adjustIndexToPreserveInvariants(
  messages: ChatMessage[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex;
  }

  let adjustedIndex = startIndex;

  // Step 1: Collect toolCallId values from tool results in the kept range
  const toolResultIdsInKeptRange: string[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === "tool" && msg.toolCallId) {
      toolResultIdsInKeptRange.push(msg.toolCallId);
    }
  }

  if (toolResultIdsInKeptRange.length === 0) {
    return adjustedIndex;
  }

  // Collect tool_use IDs already in the kept range (from assistant messages)
  const toolUseIdsInKeptRange = new Set<string>();
  for (let i = adjustedIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolUseIdsInKeptRange.add(tc.id);
      }
    }
  }

  // Find tool_uses we need but don't have in kept range (orphaned tool_results)
  const neededToolUseIds = toolResultIdsInKeptRange.filter(
    id => !toolUseIdsInKeptRange.has(id),
  );

  if (neededToolUseIds.length === 0) {
    return adjustedIndex;
  }

  const neededSet = new Set(neededToolUseIds);

  // Walk backwards to find the assistant messages containing these tool_use blocks
  for (let i = adjustedIndex - 1; i >= 0 && neededSet.size > 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (neededSet.has(tc.id)) {
          adjustedIndex = i;
          neededSet.delete(tc.id);
        }
      }
    }
  }

  if (adjustedIndex !== startIndex) {
    console.log(
      `[CompactionEngine] API invariant protection: adjusted cutoff from ${startIndex} to ${adjustedIndex} to preserve tool_use/tool_result pairs`,
    );
  }

  return adjustedIndex;
}

// ---------------------------------------------------------------------------
// CompactionEngine
// ---------------------------------------------------------------------------

export class CompactionEngine {
  private modelRouter: ModelRouter;
  private contextManager: ContextManager;
  private circuitBreaker = new CompactionCircuitBreaker();
  private settings: AgentSettings;
  private lastCompactionRatio = 1.0;
  private sessionId?: string;

  constructor(
    modelRouter: ModelRouter,
    contextManager: ContextManager,
    settings?: Partial<AgentSettings>,
    sessionId?: string,
  ) {
    this.modelRouter = modelRouter;
    this.contextManager = contextManager;
    this.settings = { ...DEFAULT_AGENT_SETTINGS, ...settings };
    this.sessionId = sessionId;
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  /**
   * Compact messages using the best available strategy.
   * Priority: Hierarchical compact (no session memory) > SM-compact (session memory) > Legacy compact.
   * Circuit breaker protects against repeated compaction failures.
   */
  async compact(
    messages: ChatMessage[],
    sessionMemory: SessionMemoryManager | null,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const memory = await sessionMemory?.load() ?? null;

    // Try hierarchical compact first (no API call needed)
    if (!memory) {
      try {
        const result = await this.hierarchicalCompact(messages, signal);
        if (result.method !== "none") {
          // Write transcript file for recovery
          const cutoff = this.findCompactionCutoff(messages, this.calculateKeepRecentTokens());
          const transcriptPath = await this.writeTranscriptFile(messages, Math.max(cutoff, 2));
          result.transcriptPath = transcriptPath;
          // Inject transcript path into the summary message (index 1)
          if (transcriptPath && result.messages.length > 1) {
            const summaryMsg = result.messages[1]!;
            if (typeof summaryMsg.content === "string") {
              summaryMsg.content += `\n\n如果需要压缩前的具体细节（如精确的代码片段、错误消息或生成的内容），可以读取完整的会话记录文件：${transcriptPath}`;
            }
          }
          this.circuitBreaker.recordSuccess();
          return result;
        }
      } catch (err) {
        // Hierarchical compact failed, fall through to legacy compact
        console.warn("[CompactionEngine] Hierarchical compact failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Try SM-compact (no API call needed)
    if (memory) {
      const result = this.smCompact(messages, memory);
      if (result.method !== "none") {
        // Write transcript file for recovery
        const cutoff = this.findCompactionCutoff(messages, this.calculateKeepRecentTokens());
        const transcriptPath = await this.writeTranscriptFile(messages, Math.max(cutoff, 2));
        result.transcriptPath = transcriptPath;
        // Inject transcript path into the memory summary message (index 1)
        if (transcriptPath && result.messages.length > 1) {
          const summaryMsg = result.messages[1]!;
          if (typeof summaryMsg.content === "string") {
            summaryMsg.content += `\n\n如果需要压缩前的具体细节（如精确的代码片段、错误消息或生成的内容），可以读取完整的会话记录文件：${transcriptPath}`;
          }
        }
        this.checkCompactionQuality(messages, result);
        this.circuitBreaker.recordSuccess();
      }
      return result;
    }

    // Fall back to legacy compact (requires API call — circuit breaker applies here)
    if (!this.circuitBreaker.canAttempt()) {
      console.warn("[CompactionEngine] Circuit breaker open for legacy compact, using deterministic fallback");
      return this.deterministicCompact(
        messages,
        this.contextManager.estimateMessagesTokens(messages),
        this.findCompactionCutoff(messages, this.calculateKeepRecentTokens()),
      );
    }

    try {
      const result = await this.legacyCompact(messages, signal);
      if (result.method !== "none") {
        this.checkCompactionQuality(messages, result);
        this.circuitBreaker.recordSuccess();
      }
      return result;
    } catch (err) {
      this.circuitBreaker.recordFailure();
      // Instead of throwing, fall back to deterministic compact to prevent unbounded context growth
      console.warn("[CompactionEngine] Legacy compact failed, using deterministic fallback:", err instanceof Error ? err.message : String(err));
      try {
        return this.deterministicCompact(
          messages,
          this.contextManager.estimateMessagesTokens(messages),
          this.findCompactionCutoff(messages, this.calculateKeepRecentTokens()),
        );
      } catch {
        // Last resort: return original messages
        return { messages, method: "none", tokensSaved: 0, preCompactTokens: this.contextManager.estimateMessagesTokens(messages) };
      }
    }
  }

  // -----------------------------------------------------------------------
  // SM-Compact: Replace old messages with session memory summary
  // -----------------------------------------------------------------------

  /**
   * SM-compact replaces old conversation messages with a compact summary
   * derived from session memory. No API call is needed.
   * Uses settings-based min/max token budget for cutoff calculation.
   */
  smCompact(
    messages: ChatMessage[],
    memory: SessionMemoryNote,
  ): CompactionResult {
    const tokensBefore = this.contextManager.estimateMessagesTokens(messages);
    const keepRecentTokens = this.calculateKeepRecentTokens();

    // Feature H: Use SM_COMPACT_CONFIG thresholds for cutoff validation (C-193)
    // Ensure at least minTextBlockMessages with text content are preserved
    let validatedKeepRecent = keepRecentTokens;
    if (keepRecentTokens < SM_COMPACT_CONFIG.minTokens) {
      validatedKeepRecent = Math.min(SM_COMPACT_CONFIG.maxTokens, tokensBefore * 0.5);
    }

    // Find the cutoff at a group boundary
    const cutoff = this.findCompactionCutoff(messages, validatedKeepRecent);

    if (cutoff <= 1) {
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }

    // Feature H: Use adjustIndexToPreserveInvariants to protect tool_use/tool_result pairs (C-193)
    const adjustedCutoff = adjustIndexToPreserveInvariants(messages, cutoff);

    // Extract identifiers from messages being removed (1..adjustedCutoff) for preservation
    const removedMessages = messages.slice(1, adjustedCutoff);
    const preservedIdentifiers = extractIdentifiers(removedMessages);

    // Truncate oversized memory content to fit within budget
    const truncatedMemory = this.truncateSessionMemory(memory, validatedKeepRecent);

    // Keep: system message (0) + memory summary + recent messages (adjustedCutoff..end)
    const memorySummary = this.buildMemorySummaryMessage(truncatedMemory);

    // Append preserved identifiers to prevent re-discovery of already-processed documents
    if (preservedIdentifiers.length > 0 && typeof memorySummary.content === "string") {
      memorySummary.content += buildIdentifierPreservationBlock(preservedIdentifiers);
    }

    const recentMessages = messages.slice(adjustedCutoff);

    let compacted: ChatMessage[] = [
      messages[0], // system prompt
      memorySummary,
      ...recentMessages,
    ];

    // Repair any message sequence violations
    compacted = repairMessageSequence(compacted);

    const tokensAfter = this.contextManager.estimateMessagesTokens(compacted);
    const tokensSaved = tokensBefore - tokensAfter;

    return {
      messages: compacted,
      method: "sm-compact",
      tokensSaved: Math.max(0, tokensSaved),
      preCompactTokens: tokensBefore,
    };
  }

  // -----------------------------------------------------------------------
  // Legacy Compact: LLM-generated summary with PTL retry
  // -----------------------------------------------------------------------

  /**
   * Legacy compact uses a summarizer LLM to generate a summary of old
   * messages, then replaces them with the summary.
   * Includes PTL (prompt-too-long) retry loop: if the summarizer call
   * itself is too long, truncates the oldest message groups and retries
   * up to 3 times before falling back to a truncation summary.
   */
  async legacyCompact(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const tokensBefore = this.contextManager.estimateMessagesTokens(messages);
    const keepRecentTokens = this.calculateKeepRecentTokens();

    const cutoff = this.findCompactionCutoff(messages, keepRecentTokens);

    if (cutoff <= 1) {
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }

    // PTL retry loop: up to 3 attempts, truncating oldest groups on PTL errors
    const MAX_PTL_RETRIES = 3;
    let summary = "";
    let summaryStart = 1; // Start index for messages to summarize

    // Adjust behavior based on escalation level
    const escalation = this.circuitBreaker.getEscalationLevel();

    // Aggressive/deterministic: use more aggressive truncation in summary
    const aggressiveTruncation = escalation === "aggressive" || escalation === "deterministic";
    // Deterministic: skip LLM summary entirely, use template-based compression
    const useDeterministic = escalation === "deterministic";

    if (useDeterministic) {
      // Deterministic mode: template-based compression, guaranteed token limits
      return this.deterministicCompact(messages, tokensBefore, cutoff);
    }

    for (let attempt = 0; attempt < MAX_PTL_RETRIES; attempt++) {
      try {
        const oldMessages = messages.slice(summaryStart, cutoff);
        if (oldMessages.length === 0) {
          summary = this.truncationSummary(messages.slice(1, cutoff));
          break;
        }
        const maxSummaryTokens = aggressiveTruncation ? 500 : 2000;
        summary = await this.generateSummary(oldMessages, signal, maxSummaryTokens);
        break; // Success
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (this.isPromptTooLongError(errorMsg) && attempt < MAX_PTL_RETRIES - 1) {
          // Drop the oldest group from the summary range and retry
          console.warn(
            `[CompactionEngine] Summary PTL error (attempt ${attempt + 1}/${MAX_PTL_RETRIES}), truncating old messages`,
          );
          const groups = this.groupMessages(messages.slice(summaryStart, cutoff));
          if (groups.length > 1) {
            // Skip the first group: move summaryStart to the second group's position
            summaryStart += groups[1]!.assistantIndex;
          } else {
            // Only one group or fewer — can't truncate further
            summary = this.truncationSummary(messages.slice(summaryStart, cutoff));
            break;
          }
        } else {
          // Non-PTL error or retries exhausted — fall back to truncation summary
          console.warn(`[CompactionEngine] Summary generation failed: ${errorMsg}`);
          summary = this.truncationSummary(messages.slice(summaryStart, cutoff));
          break;
        }
      }
    }

    // Write transcript file for post-compaction recovery
    const transcriptPath = await this.writeTranscriptFile(messages, cutoff);

    // Extract identifiers from removed messages for preservation
    const removedMessages = messages.slice(1, cutoff);
    const preservedIdentifiers = extractIdentifiers(removedMessages);
    const identifierBlock = buildIdentifierPreservationBlock(preservedIdentifiers);

    const summaryMessage: ChatMessage = {
      role: "user",
      content: getCompactUserSummaryMessage(summary, { isAutoCompact: true, transcriptPath }) + identifierBlock,
    };

    const recentMessages = messages.slice(cutoff);
    let compacted: ChatMessage[] = [
      messages[0], // system prompt
      summaryMessage,
      ...recentMessages,
    ];

    // Repair any message sequence violations
    compacted = repairMessageSequence(compacted);

    const tokensAfter = this.contextManager.estimateMessagesTokens(compacted);
    const tokensSaved = tokensBefore - tokensAfter;

    return {
      messages: compacted,
      method: "legacy-compact",
      tokensSaved: Math.max(0, tokensSaved),
      preCompactTokens: tokensBefore,
      transcriptPath,
    };
  }

  // -----------------------------------------------------------------------
  // Hierarchical Compact: D2/D1/Leaf layers with different granularity
  // -----------------------------------------------------------------------

  /**
   * Hierarchical compression: split messages into D2/D1/Leaf layers
   * with different compression granularity per layer.
   */
  async hierarchicalCompact(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const tokensBefore = this.contextManager.estimateMessagesTokens(messages);

    // Group messages (skip system prompt at index 0)
    // Note: groupMessages returns indices relative to the sliced array,
    // so we add +1 when indexing into the original messages array.
    const sliced = messages.slice(1);
    const groups = this.groupMessages(sliced);
    if (groups.length < 3) {
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }

    // Split into thirds
    const d2End = Math.floor(groups.length / 3);
    const d1End = Math.floor(groups.length * 2 / 3);

    // Generate summaries for D2 and D1 layers
    const d2Groups = groups.slice(0, d2End);
    const d1Groups = groups.slice(d2End, d1End);

    let d2Summary = "";
    let d1Summary = "";

    try {
      if (d2Groups.length > 0) {
        const d2Msgs = this.flattenGroups(sliced, d2Groups);
        d2Summary = await this.generateSummaryWithPrompt(d2Msgs, COMPRESSION_LEVELS[0].prompt, signal);
      }
    } catch {
      d2Summary = this.truncationSummary(this.flattenGroups(sliced, d2Groups));
    }

    try {
      if (d1Groups.length > 0) {
        const d1Msgs = this.flattenGroups(sliced, d1Groups);
        d1Summary = await this.generateSummaryWithPrompt(d1Msgs, COMPRESSION_LEVELS[1].prompt, signal);
      }
    } catch {
      d1Summary = this.truncationSummary(this.flattenGroups(sliced, d1Groups));
    }

    // Assemble compacted messages — leaf starts at d1End boundary
    // +1 to convert from sliced-index back to original messages index
    const leafStart = (groups[d1End]?.assistantIndex ?? messages.length - 2) + 1;
    const leafMessages = messages.slice(leafStart);

    const summaryParts: string[] = [];
    if (d2Summary) summaryParts.push(`## 早期对话摘要\n${d2Summary}`);
    if (d1Summary) summaryParts.push(`## 近期对话摘要\n${d1Summary}`);

    const compacted: ChatMessage[] = [
      messages[0], // system prompt
      {
        role: "user",
        content: `[分层压缩上下文]\n${summaryParts.join("\n\n")}\n\n以下是最新的对话内容：`,
      },
      ...leafMessages,
    ];

    const repaired = repairMessageSequence(compacted);
    const tokensAfter = this.contextManager.estimateMessagesTokens(repaired);

    return {
      messages: repaired,
      method: "hierarchical-compact",
      tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      preCompactTokens: tokensBefore,
    };
  }

  // -----------------------------------------------------------------------
  // Deterministic Compact: template-based, guaranteed token limits
  // -----------------------------------------------------------------------

  /**
   * Deterministic compaction uses template-based compression without any LLM call.
   * This is the escalation endpoint when LLM-based summarization repeatedly fails
   * or produces low-quality output. Guaranteed to reduce tokens within budget.
   */
  /** Public accessor for deterministic compact — used as emergency fallback. */
  deterministicCompactPublic(
    messages: ChatMessage[],
  ): CompactionResult {
    const tokensBefore = this.contextManager.estimateMessagesTokens(messages);
    const cutoff = this.findCompactionCutoff(messages, this.calculateKeepRecentTokens());
    return this.deterministicCompact(messages, tokensBefore, cutoff);
  }

  private deterministicCompact(
    messages: ChatMessage[],
    tokensBefore: number,
    cutoff: number,
  ): CompactionResult {
    const keepRecentTokens = this.calculateKeepRecentTokens();
    const oldMessages = messages.slice(1, cutoff);

    // Template-based summary: extract key facts mechanically
    const userMessages = oldMessages
      .filter(m => m.role === "user")
      .map(m => (m.content ?? "").slice(0, 200))
      .filter(c => c.length > 0);

    // Extract tool names
    const toolNames = oldMessages
      .filter(m => m.role === "assistant" && m.toolCalls)
      .flatMap(m => m.toolCalls!.map(tc => tc.function.name))
      .filter((v, i, a) => a.indexOf(v) === i); // unique

    // Extract file paths from tool call arguments
    const filePaths = oldMessages
      .filter(m => m.role === "assistant" && m.toolCalls)
      .flatMap(m => m.toolCalls!.flatMap(tc => {
        try {
          const args = JSON.parse(tc.function.arguments);
          return [
            args.filePath, args.path, args.file_path,
            args.source, args.target, args.dest,
          ].filter((v): v is string => typeof v === "string");
        } catch { return []; }
      }))
      .filter((v, i, a) => a.indexOf(v) === i); // unique

    // Extract search queries from tool call arguments
    const searchQueries = oldMessages
      .filter(m => m.role === "assistant" && m.toolCalls)
      .flatMap(m => m.toolCalls!.flatMap(tc => {
        try {
          const args = JSON.parse(tc.function.arguments);
          return [args.query, args.keyword, args.searchTerm, args.q, args.search_query]
            .filter((v): v is string => typeof v === "string" && v.length > 0);
        } catch { return []; }
      }))
      .filter((v, i, a) => a.indexOf(v) === i); // unique

    const topicSummary = userMessages.length > 0
      ? userMessages.slice(0, 10).map(t => `- ${t}`).join("\n")
      : "No user messages in compacted range.";

    const toolSummary = toolNames.length > 0
      ? `Tools used: ${toolNames.join(", ")}`
      : "";

    const filePathSummary = filePaths.length > 0
      ? filePaths.slice(0, 20).map(p => `- ${p}`).join("\n")
      : "No file paths captured.";

    const searchSummary = searchQueries.length > 0
      ? searchQueries.slice(0, 15).map(q => `- ${q}`).join("\n")
      : "No search queries captured.";

    // Extract identifiers for deterministic path too
    const preservedIdentifiers = extractIdentifiers(oldMessages);
    const identifierBlock = buildIdentifierPreservationBlock(preservedIdentifiers);

    const templateContent = [
      "[Deterministic Context Compression]",
      "",
      "Topics discussed:",
      topicSummary,
      "",
      toolSummary,
      "",
      "Files involved:",
      filePathSummary,
      "",
      "Search queries:",
      searchSummary,
      "",
      `[${userMessages.length} user messages, ${toolNames.length} unique tools, ${filePaths.length} file paths compressed]`,
      identifierBlock,
    ].join("\n");

    const summaryMessage: ChatMessage = {
      role: "user",
      content: templateContent,
    };

    const recentMessages = messages.slice(cutoff);
    let compacted: ChatMessage[] = [
      messages[0], // system prompt
      summaryMessage,
      ...recentMessages,
    ];

    compacted = repairMessageSequence(compacted);
    const tokensAfter = this.contextManager.estimateMessagesTokens(compacted);
    const tokensSaved = tokensBefore - tokensAfter;

    // If the template summary didn't actually reduce the token count (e.g. a
    // very short conversation where the summary overhead exceeds the savings),
    // treat it as a no-op. Returning a non-"none" method with 0 tokens saved
    // would cause the caller to replace the messages with a *larger* context
    // (system + summary + recent) — a "compaction" that grows the context.
    if (tokensSaved <= 0) {
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }

    return {
      messages: compacted,
      method: "legacy-compact",
      tokensSaved,
      preCompactTokens: tokensBefore,
    };
  }

  // -----------------------------------------------------------------------
  // Quality tracking
  // -----------------------------------------------------------------------

  /**
   * Check compaction quality and escalate if retention ratio is low.
   * A "low quality" compaction is one where less than 30% of the original
   * context is retained (i.e., too aggressive compression).
   */
  private checkCompactionQuality(
    originalMessages: ChatMessage[],
    result: CompactionResult,
  ): void {
    if (result.preCompactTokens === 0) return;
    const retentionRatio = (result.preCompactTokens - result.tokensSaved) / result.preCompactTokens;
    this.lastCompactionRatio = retentionRatio;

    // If we retained less than 30% of original content, that's low quality
    if (retentionRatio < 0.3) {
      this.circuitBreaker.recordLowQuality();
    }
  }

  /**
   * Flatten groups back to messages by looking up original indices.
   */
  private flattenGroups(messages: ChatMessage[], groups: MessageGroup[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (const group of groups) {
      result.push(messages[group.assistantIndex]);
      for (const idx of group.toolResultIndices) {
        result.push(messages[idx]);
      }
    }
    return result;
  }

  /**
   * Generate a summary using a specific compression-level prompt.
   */
  private async generateSummaryWithPrompt(
    messages: ChatMessage[],
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const summarizerModel = this.modelRouter.getDefaultModel("summarizer");
    const identifierPattern = /(?:\/[\w\-._]+){2,}|[A-Z]:\\(?:[\w\-._]+\\){1,}[\w\-._]+|https?:\/\/[^\s<>"]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\bdoc_[a-zA-Z0-9_]+|\bpage_[a-zA-Z0-9_]+/gi;

    const serialized = messages
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        if (content.length <= 2000) {
          return `[${m.role}]: ${content}`;
        }
        // Truncate but preserve identifiers from the remainder
        const truncated = content.slice(0, 2000);
        const remainder = content.slice(2000);
        const truncatedIds = new Set<string>();
        let match: RegExpExecArray | null;
        identifierPattern.lastIndex = 0;
        while ((match = identifierPattern.exec(truncated)) !== null) {
          truncatedIds.add(match[0]);
        }
        const missingIds: string[] = [];
        identifierPattern.lastIndex = 0;
        while ((match = identifierPattern.exec(remainder)) !== null) {
          if (!truncatedIds.has(match[0])) {
            missingIds.push(match[0]);
          }
        }
        const idSuffix = missingIds.length > 0
          ? `\n[截断部分中的标识符: ${missingIds.join(", ")}]`
          : "";
        return `[${m.role}]: ${truncated}${idSuffix}`;
      })
      .join("\n\n");

    const response = await this.modelRouter.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: serialized },
      ],
      { model: summarizerModel, maxTokens: 2000, signal },
    );
    return response.content || "";
  }

  // -----------------------------------------------------------------------
  // Message grouping
  // -----------------------------------------------------------------------

  /**
   * Group messages by API round-trip (assistant + following tool results).
   * Feature C (C-188): Groups by assistant message ID changes — each unique
   * assistant ID represents one API call. Streaming chunks from the same API
   * response share an id, so they stay in one group even with interleaved tool_results.
   * System messages and user messages are standalone (not grouped).
   * Each group is tagged with `hasSearchCall` if it contains a search tool
   * invocation (kb_search, expand, etc.) — used for citation chain preservation.
   */
  groupMessages(messages: ChatMessage[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let currentGroup: MessageGroup | null = null;
    let lastAssistantId: string | undefined;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "assistant") {
        // Feature C: Use message ID to detect new API rounds
        // When assistant message ID changes, it's a new API round
        const isNewApiRound = msg.id !== undefined
          && msg.id !== lastAssistantId
          && currentGroup !== null;

        if (isNewApiRound) {
          // Finalize current group, start a new one
          currentGroup = null;
        }

        lastAssistantId = msg.id;

        // Start a new group for this assistant message
        currentGroup = {
          assistantIndex: i,
          toolResultIndices: [],
          tokenCount: this.contextManager.estimateMessagesTokens([msg]),
        };

        // C3.7: Tag groups that contain search tool calls
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (CITATION_SOURCE_TOOLS.has(tc.function.name)) {
              currentGroup.hasSearchCall = true;
              break;
            }
          }
        }

        groups.push(currentGroup);
      } else if (msg.role === "tool" && currentGroup) {
        // Add to the current group
        currentGroup.toolResultIndices.push(i);
        currentGroup.tokenCount += this.contextManager.estimateMessagesTokens([msg]);
      } else {
        // User or system message — finalize current group
        currentGroup = null;
      }
    }

    return groups;
  }

  // -----------------------------------------------------------------------
  // Cutoff finding (group-boundary-aware)
  // -----------------------------------------------------------------------

  /**
   * Find the index at which to cut the message array for compaction.
   * Uses group boundaries to ensure assistant-tool pairings are preserved.
   * C3.7: Also respects citation chains — if a search group is about to be
   * compacted but the following analysis group is kept, the cutoff is moved
   * backward to include the search group, preserving the source→analysis link.
   *
   * Always returns the index of an assistant message (group start).
   * Returns 1 if no group boundary is suitable (meaning nothing to compact).
   */
  findCompactionCutoff(
    messages: ChatMessage[],
    keepRecentTokens: number,
  ): number {
    const groups = this.groupMessages(messages);

    if (groups.length === 0) {
      // No assistant groups — can't compact at group boundaries
      return 1;
    }

    let accumulated = 0;
    let cutoffGroupIdx = -1;
    // Walk backwards from the last group
    for (let g = groups.length - 1; g >= 0; g--) {
      accumulated += groups[g].tokenCount;
      if (accumulated > keepRecentTokens) {
        cutoffGroupIdx = g;
        break;
      }
    }

    if (cutoffGroupIdx < 0) {
      // All groups fit within budget — nothing to compact
      return 1;
    }

    // C3.7: Adjust cutoff to preserve citation chains.
    const MAX_CHAIN_PULLBACK = 2;
    let adjustedIdx = cutoffGroupIdx;
    for (let pullback = 1; pullback <= MAX_CHAIN_PULLBACK && adjustedIdx > 0; pullback++) {
      const prevGroup = groups[adjustedIdx - 1];
      if (prevGroup?.hasSearchCall) {
        adjustedIdx--;
        console.log(
          `[CompactionEngine] C3.7: Adjusted cutoff from group ${cutoffGroupIdx} to ${adjustedIdx} to preserve citation chain`,
        );
      } else {
        break;
      }
    }

    const rawCutoff = groups[adjustedIdx]!.assistantIndex;
    // Protect API invariants: ensure tool_use/tool_result pairs aren't split
    return adjustIndexToPreserveInvariants(messages, rawCutoff);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Write a transcript file containing the messages being compacted.
   * The model can read this file post-compaction to recover specific details.
   * Returns the file path, or undefined if writing fails.
   */
  private async writeTranscriptFile(
    messages: ChatMessage[],
    cutoff: number,
  ): Promise<string | undefined> {
    if (!this.sessionId || cutoff <= 1) return undefined;

    try {
      const dataDir = DEEPANALYZE_CONFIG.dataDir;
      const tmpDir = join(dataDir, "tmp");
      await mkdir(tmpDir, { recursive: true });

      const timestamp = Date.now();
      const fileName = `transcript-${this.sessionId.slice(0, 8)}-${timestamp}.md`;
      const filePath = join(tmpDir, fileName);

      // Serialize the compacted messages (those before the cutoff)
      const oldMessages = messages.slice(1, cutoff);
      const serializedParts: string[] = [
        `# Session Transcript (pre-compaction)`,
        `> Session: ${this.sessionId}`,
        `> Generated: ${new Date().toISOString()}`,
        `> Messages: ${oldMessages.length} (indices 1-${cutoff - 1})`,
        "",
        "This file contains the messages that were removed during context compaction.",
        "You can read this file to recover specific details if needed.",
        "",
        "---",
        "",
      ];

      for (let i = 0; i < oldMessages.length; i++) {
        const m = oldMessages[i]!;
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        const role = m.role;
        const truncated = content.slice(0, 5000);
        serializedParts.push(`## Message ${i + 1} [${role}]`);
        serializedParts.push(truncated);
        if (content.length > 5000) {
          serializedParts.push(`\n[... truncated: ${content.length} chars total ...]`);
        }
        serializedParts.push("");
      }

      await writeFile(filePath, serializedParts.join("\n"), "utf-8");
      console.log(`[CompactionEngine] Transcript written: ${filePath} (${oldMessages.length} messages)`);
      return filePath;
    } catch (err) {
      console.warn("[CompactionEngine] Failed to write transcript:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /**
   * Calculate the number of recent tokens to keep during compaction.
   * Uses 60% of effective window as target, clamped to settings-based
   * min/max bounds (smCompactMinTokens / smCompactMaxTokens).
   */
  private calculateKeepRecentTokens(): number {
    const { effectiveWindow } = this.contextManager.getContextWindow();
    let target = Math.floor(effectiveWindow * 0.6);
    target = Math.max(
      this.settings.smCompactMinTokens,
      Math.min(this.settings.smCompactMaxTokens, target),
    );
    return target;
  }

  /**
   * Truncate session memory content if it exceeds the budget allocation.
   * Memory gets at most 30% of the recent token budget.
   */
  private truncateSessionMemory(
    memory: SessionMemoryNote,
    budgetTokens: number,
  ): SessionMemoryNote {
    const memoryTokens = this.contextManager.estimateTextTokens(memory.content);
    const maxMemoryTokens = Math.floor(budgetTokens * 0.3);

    if (memoryTokens <= maxMemoryTokens) {
      return memory;
    }

    // Approximate character limit from token limit (~3 chars per token)
    const maxChars = Math.floor(maxMemoryTokens * 3);
    return {
      ...memory,
      content:
        memory.content.slice(0, maxChars) +
        "\n\n[... memory truncated to fit context budget]",
    };
  }

  private buildMemorySummaryMessage(memory: SessionMemoryNote): ChatMessage {
    return {
      role: "user",
      content: `[之前会话的历史摘要]\n重要提示：以下为已完成的历史任务记录，仅供参考。其中的"待处理任务"属于已结束的历史任务，不要主动执行它们。当前应以用户的最新请求为准。\n\n${memory.content}`,
    };
  }

  /**
   * Generate a summary of old messages using the summarizer LLM.
   * C3.7: Includes a citation preservation instruction in the summary prompt
   * to ensure source references are not lost during compaction.
   * Errors are NOT caught here — callers handle PTL retry and fallback.
   */
  private async generateSummary(
    oldMessages: ChatMessage[],
    signal?: AbortSignal,
    maxTokens: number = 2000,
  ): Promise<string> {
    const summarizerModel = this.modelRouter.getDefaultModel("summarizer");
    const summaryPrompt = getCompactPrompt();

    // Aggressive mode uses shorter per-message limits
    const aggressive = maxTokens <= 500;

    const serialized = oldMessages
      .map((m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        const limit = aggressive
          ? (m.role === "tool" ? 500 : 200)
          : (m.role === "tool" ? 3000 : 1000);

        // If content fits within limit, use as-is
        if (content.length <= limit) {
          return `[${m.role}]: ${content}`;
        }

        // Content exceeds limit: truncate but preserve identifiers from the full content
        const truncated = content.slice(0, limit);
        const remainder = content.slice(limit);

        // Extract identifiers (paths, UUIDs, doc IDs) from the truncated portion
        const identifierPattern = /(?:\/[\w\-._]+){2,}|[A-Z]:\\(?:[\w\-._]+\\){1,}[\w\-._]+|https?:\/\/[^\s<>"]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\bdoc_[a-zA-Z0-9_]+|\bpage_[a-zA-Z0-9_]+/gi;
        const truncatedIds = new Set<string>();
        let match: RegExpExecArray | null;
        identifierPattern.lastIndex = 0;
        while ((match = identifierPattern.exec(truncated)) !== null) {
          truncatedIds.add(match[0]);
        }

        // Find identifiers in remainder that aren't already in truncated portion
        const missingIds: string[] = [];
        identifierPattern.lastIndex = 0;
        while ((match = identifierPattern.exec(remainder)) !== null) {
          if (!truncatedIds.has(match[0])) {
            missingIds.push(match[0]);
          }
        }

        // Append extracted identifiers from the truncated portion
        const idSuffix = missingIds.length > 0
          ? `\n[截断部分中的标识符: ${missingIds.join(", ")}]`
          : "";

        return `[${m.role}]: ${truncated}${idSuffix}`;
      })
      .join("\n\n");

    // C3.7: Append citation preservation instruction
    const citationInstruction = "\n\n重要：保留摘要中所有数据来源的引用信息（文件名、文档ID、搜索关键词），不要丢失来源标注。";

    const response = await this.modelRouter.chat(
      [
        { role: "system", content: summaryPrompt + citationInstruction },
        { role: "user", content: serialized },
      ],
      {
        model: summarizerModel,
        maxTokens,
        signal,
      },
    );
    return formatCompactSummary(response.content || "Previous conversation was compacted.");
  }

  private truncationSummary(messages: ChatMessage[]): string {
    const parts: string[] = [];

    // Extract user topics
    const userMsgs = messages.filter((m) => m.role === "user");
    const topics = userMsgs
      .map((m) => (m.content ?? "").slice(0, 150))
      .filter((c) => c.length > 0);
    if (topics.length > 0) {
      parts.push("用户请求:\n" + topics.slice(0, 10).map((t) => `- ${t}`).join("\n"));
    }

    // Extract tool call names and brief results for key findings
    const toolCalls: string[] = [];
    const keyFindings: string[] = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const tc of m.toolCalls) {
          const name = tc.function?.name || "";
          if (name) toolCalls.push(name);
        }
      }
      // Extract brief findings from tool results (first 80 chars)
      if (m.role === "tool" && m.content) {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        const preview = content.slice(0, 80).replace(/\n/g, " ").trim();
        if (preview.length > 20) keyFindings.push(preview);
      }
    }

    if (toolCalls.length > 0) {
      const toolBreakdown: Record<string, number> = {};
      for (const tc of toolCalls) toolBreakdown[tc] = (toolBreakdown[tc] || 0) + 1;
      parts.push(`工具调用 (${toolCalls.length}次): ${Object.entries(toolBreakdown).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }

    if (keyFindings.length > 0) {
      parts.push("关键发现:\n" + keyFindings.slice(0, 5).map((f) => `- ${f}`).join("\n"));
    }

    if (parts.length === 0) {
      return "对话中间段已压缩（压缩降级模式）";
    }

    return parts.join("\n\n");
  }

  /**
   * Check if an error message indicates a prompt-too-long / context-length
   * exceeded error from the LLM provider.
   */
  private isPromptTooLongError(errorMsg: string): boolean {
    const lower = errorMsg.toLowerCase();
    return (
      lower.includes("prompt_too_long") ||
      lower.includes("context_length_exceeded") ||
      lower.includes("maximum context length") ||
      lower.includes("too many tokens") ||
      lower.includes("token limit exceeded")
    );
  }

  // -----------------------------------------------------------------------
  // Partial compact: compress only a middle range of messages
  // -----------------------------------------------------------------------

  /**
   * Compact messages within a specific index range, preserving both the
   * oldest prefix and the newest suffix. This is useful when the conversation
   * is very long but the oldest messages are still valuable (e.g., original
   * instructions, early important search results).
   *
   * @param messages Full message array
   * @param fromIndex Start of the range to compact (inclusive, group-aligned)
   * @param toIndex End of the range to compact (exclusive, group-aligned).
   *                If not provided, uses normal cutoff calculation.
   * @param signal Optional abort signal for the LLM call
   * @returns Compaction result with the middle replaced by a summary
   */
  async compactMiddle(
    messages: ChatMessage[],
    fromIndex: number,
    toIndex?: number,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (!this.circuitBreaker.canAttempt()) {
      console.warn("[CompactionEngine] Circuit breaker open, skipping partial compaction");
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: 0 };
    }

    const tokensBefore = this.contextManager.estimateMessagesTokens(messages);

    // Ensure fromIndex is at least past the system message
    const start = Math.max(1, fromIndex);
    if (start >= messages.length - 1) {
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }

    // Calculate toIndex if not provided — use normal keep-recent budget
    const end = toIndex ?? this.findCompactionCutoff(messages, this.calculateKeepRecentTokens());
    if (end <= start) {
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }

    // Extract the range to summarize
    const rangeToCompact = messages.slice(start, end);
    if (rangeToCompact.length < 2) {
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }

    try {
      // Generate a summary of the middle range
      const summary = await this.generateRangeSummary(rangeToCompact, signal);
      // Write transcript file for post-compaction recovery
      const transcriptPath = await this.writeTranscriptFile(messages, end);
      const transcriptNote = transcriptPath
        ? `\n\n如果需要压缩前的具体细节，可以读取文件：${transcriptPath}`
        : "";

      // Extract identifiers from the range being compacted
      const preservedIdentifiers = extractIdentifiers(rangeToCompact);
      const identifierBlock = buildIdentifierPreservationBlock(preservedIdentifiers);

      const summaryMessage: ChatMessage = {
        role: "user",
        content: `[以下是对话中间段的摘要，原始消息已被压缩]\n\n${summary}${transcriptNote}${identifierBlock}`,
      };

      // Reconstruct: prefix + summary + suffix
      const compacted = repairMessageSequence([
        ...messages.slice(0, start),
        summaryMessage,
        ...messages.slice(end),
      ]);

      const tokensAfter = this.contextManager.estimateMessagesTokens(compacted);
      const tokensSaved = tokensBefore - tokensAfter;

      this.circuitBreaker.recordSuccess();
      return {
        messages: compacted,
        method: "legacy-compact",
        tokensSaved: Math.max(0, tokensSaved),
        preCompactTokens: tokensBefore,
      };
    } catch (err) {
      this.circuitBreaker.recordFailure();
      // Instead of throwing, fall back to deterministic compact for the middle range
      console.warn("[CompactionEngine] compactMiddle LLM failed, using deterministic fallback:", err instanceof Error ? err.message : String(err));
      try {
        const deterministicResult = this.deterministicCompact(messages, tokensBefore, end);
        if (deterministicResult.method !== "none") {
          return deterministicResult;
        }
      } catch {
        // Deterministic also failed — fall through
      }
      // Return unmodified messages rather than crashing
      return { messages, method: "none", tokensSaved: 0, preCompactTokens: tokensBefore };
    }
  }

  /**
   * Generate a summary of a message range using the summarizer model.
   * Uses a focused compact prompt that only summarizes the provided range.
   */
  private async generateRangeSummary(
    messageRange: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const { getCompactPrompt, formatCompactSummary } = await import("./compact-prompt.js");
    const compactPrompt = getCompactPrompt("只摘要以下消息范围内的关键信息、决策和发现。保留所有具体的数据点、名称和标识符。");

    // Repair the sliced range to fix any orphaned tool_use/tool_result pairs
    // caused by arbitrary range boundaries. This prevents API errors from
    // providers (e.g. MiniMax error 2013) that strictly validate pairing.
    const repairedRange = repairMessageSequence(messageRange);

    const summarizerModel = this.modelRouter.getDefaultModel("summarizer");
    const messages: ChatMessage[] = [
      { role: "user" as const, content: compactPrompt },
      ...repairedRange,
    ];

    const response = await this.modelRouter.chat(
      messages,
      { model: summarizerModel, maxTokens: 4096, temperature: 0.1, signal },
    );

    return formatCompactSummary(response.content || "");
  }

  // -----------------------------------------------------------------------
  // Context Collapse support: generate summaries without modifying messages
  // -----------------------------------------------------------------------

  /**
   * Generate a collapse summary for a message range without modifying the
   * input messages array. Returns summary information that CollapseStore
   * uses to create a collapse entry.
   */
  async generateCollapseSummary(
    messages: ChatMessage[],
    sessionMemory: SessionMemoryManager | null,
    signal?: AbortSignal,
  ): Promise<CollapseSummaryInfo | null> {
    if (!this.circuitBreaker.canAttempt()) {
      console.warn("[CompactionEngine] Circuit breaker open, skipping collapse summary");
      return null;
    }

    const memory = await sessionMemory?.load() ?? null;
    const tokensBefore = this.contextManager.estimateMessagesTokens(messages);
    const keepRecentTokens = this.calculateKeepRecentTokens();
    const cutoff = this.findCompactionCutoff(messages, keepRecentTokens);

    if (cutoff <= 1) return null;

    const oldMessages = messages.slice(1, cutoff);
    const originalTokens = this.contextManager.estimateMessagesTokens(oldMessages);

    let replacementMessages: ChatMessage[];
    let method: CollapseMethod;

    // Extract identifiers from messages being removed for preservation
    const preservedIdentifiers = extractIdentifiers(oldMessages);
    const identifierBlock = buildIdentifierPreservationBlock(preservedIdentifiers);

    try {
      // Write transcript file for post-compaction recovery
      const transcriptPath = await this.writeTranscriptFile(messages, cutoff);

      // Try SM-compact path if we have session memory
      if (memory) {
        const truncatedMemory = this.truncateSessionMemory(memory, keepRecentTokens);
        const memoryMsg = this.buildMemorySummaryMessage(truncatedMemory);
        // Inject transcript path into the SM-compact message
        if (transcriptPath && typeof memoryMsg.content === "string") {
          memoryMsg.content += `\n\n如果需要压缩前的具体细节（如精确的代码片段、错误消息或生成的内容），可以读取完整的会话记录文件：${transcriptPath}`;
        }
        // Append preserved identifiers
        if (identifierBlock && typeof memoryMsg.content === "string") {
          memoryMsg.content += identifierBlock;
        }
        replacementMessages = [memoryMsg];
        method = "sm-collapse";
      } else {
        // Try hierarchical compact
        if (this.settings.hierarchicalCompression) {
          const hierResult = await this.hierarchicalCollapseSummary(messages, cutoff, signal);
          if (hierResult) {
            // Append identifiers to hierarchical result too
            if (identifierBlock) {
              for (const msg of hierResult.replacementMessages) {
                if (typeof msg.content === "string") {
                  msg.content += identifierBlock;
                  break; // Only append to first text message
                }
              }
            }
            this.circuitBreaker.recordSuccess();
            return hierResult;
          }
        }

        // Fall back to legacy compact summary
        const summary = await this.generateSummary(oldMessages, signal, 2000);
        let summaryContent = getCompactUserSummaryMessage(summary, { isAutoCompact: true, transcriptPath });
        if (identifierBlock) {
          summaryContent += identifierBlock;
        }
        replacementMessages = [{
          role: "user",
          content: summaryContent,
        }];
        method = "legacy-collapse";
      }

      const replacementTokens = this.contextManager.estimateMessagesTokens(replacementMessages);

      this.circuitBreaker.recordSuccess();

      return {
        startIndex: 1,
        endIndex: cutoff,
        replacementMessages,
        originalTokens,
        replacementTokens,
        method,
      };
    } catch (err) {
      this.circuitBreaker.recordFailure();
      throw err;
    }
  }

  /**
   * Generate a collapse summary for a middle range without modifying messages.
   * Used for proactive compaction.
   */
  async generateMiddleSummary(
    messages: ChatMessage[],
    fromIndex: number,
    toIndex: number,
    signal?: AbortSignal,
  ): Promise<CollapseSummaryInfo | null> {
    if (!this.circuitBreaker.canAttempt()) {
      console.warn("[CompactionEngine] Circuit breaker open, skipping middle summary");
      return null;
    }

    let start = Math.max(1, fromIndex);
    if (start >= messages.length - 1) return null;
    if (toIndex <= start) return null;

    // Align range boundaries to group boundaries to avoid splitting
    // tool_use/tool_result pairs, which causes API errors (e.g. MiniMax 2013).
    // Walk start forward past any leading tool messages (orphaned without their
    // parent assistant), and walk end backward past any trailing tool messages
    // whose results are outside the range.
    while (start < toIndex && messages[start]?.role === "tool") {
      start++;
    }
    while (toIndex > start && messages[toIndex - 1]?.role === "assistant"
           && messages[toIndex - 1]?.toolCalls?.length) {
      toIndex--;
    }

    if (toIndex <= start) return null;

    const rangeToCompact = messages.slice(start, toIndex);
    if (rangeToCompact.length < 2) return null;

    const originalTokens = this.contextManager.estimateMessagesTokens(rangeToCompact);

    try {
      const summary = await this.generateRangeSummary(rangeToCompact, signal);

      // Extract identifiers from the range being compacted
      const preservedIdentifiers = extractIdentifiers(rangeToCompact);
      const identifierBlock = buildIdentifierPreservationBlock(preservedIdentifiers);

      const replacementMessages: ChatMessage[] = [{
        role: "user",
        content: `[以下是对话中间段的摘要，原始消息已被压缩]\n\n${summary}${identifierBlock}`,
      }];

      const replacementTokens = this.contextManager.estimateMessagesTokens(replacementMessages);

      this.circuitBreaker.recordSuccess();

      return {
        startIndex: start,
        endIndex: toIndex,
        replacementMessages,
        originalTokens,
        replacementTokens,
        method: "legacy-collapse",
      };
    } catch (err) {
      this.circuitBreaker.recordFailure();
      console.warn("[CompactionEngine] generateMiddleSummary failed, using truncation fallback:",
        err instanceof Error ? err.message : String(err));

      // Fallback: deterministic truncation summary (no LLM call needed)
      const fallbackSummary = this.truncationSummary(rangeToCompact);
      const fallbackBlock = buildIdentifierPreservationBlock(
        extractIdentifiers(rangeToCompact)
      );
      const fallbackMessages: ChatMessage[] = [{
        role: "user",
        content: `[以下是对话中间段的摘要（压缩降级模式），原始消息已被压缩]\n\n${fallbackSummary}${fallbackBlock}`,
      }];
      const fallbackTokens = this.contextManager.estimateMessagesTokens(fallbackMessages);

      return {
        startIndex: start,
        endIndex: toIndex,
        replacementMessages: fallbackMessages,
        originalTokens,
        replacementTokens: fallbackTokens,
        method: "truncation-fallback",
      };
    }
  }

  /**
   * Generate a hierarchical collapse summary.
   * Uses compression levels D2/D1 for older messages.
   */
  private async hierarchicalCollapseSummary(
    messages: ChatMessage[],
    cutoff: number,
    signal?: AbortSignal,
  ): Promise<CollapseSummaryInfo | null> {
    if (cutoff <= 2) return null;

    const oldMessages = messages.slice(1, cutoff);
    const groups = this.groupMessages(oldMessages);
    if (groups.length < 2) return null;

    // Split groups into D2 (oldest half) and D1 (newer half)
    const midPoint = Math.floor(groups.length / 2);
    const d2Groups = groups.slice(0, midPoint);
    const d1Groups = groups.slice(midPoint);

    const d2Range = this.flattenGroups(oldMessages, d2Groups);
    const d1Range = this.flattenGroups(oldMessages, d1Groups);

    const d2Level = COMPRESSION_LEVELS[0]!; // Coarse
    const d1Level = COMPRESSION_LEVELS[1]!; // Medium

    const summarizerModel = this.modelRouter.getDefaultModel("summarizer");

    // Generate D2 summary (oldest, coarsest)
    const d2Response = await this.modelRouter.chat(
      [{ role: "user", content: d2Level.prompt }, ...d2Range],
      { model: summarizerModel, maxTokens: d2Level.maxTokens, temperature: 0.1, signal },
    );

    // Generate D1 summary (newer, medium detail)
    const d1Response = await this.modelRouter.chat(
      [{ role: "user", content: d1Level.prompt }, ...d1Range],
      { model: summarizerModel, maxTokens: d1Level.maxTokens, temperature: 0.1, signal },
    );

    const replacementMessages: ChatMessage[] = [{
      role: "user",
      content: getCompactUserSummaryMessage(
        `## 较早对话摘要（D2层）\n${d2Response.content}\n\n## 近期对话摘要（D1层）\n${d1Response.content}`,
        { isAutoCompact: true },
      ),
    }];

    const originalTokens = this.contextManager.estimateMessagesTokens(oldMessages);
    const replacementTokens = this.contextManager.estimateMessagesTokens(replacementMessages);

    return {
      startIndex: 1,
      endIndex: cutoff,
      replacementMessages,
      originalTokens,
      replacementTokens,
      method: "hierarchical-collapse",
    };
  }
}

// ---------------------------------------------------------------------------
// Post-compact file re-injection
// ---------------------------------------------------------------------------

/**
 * Default settings for post-compact file re-injection.
 * Reduced to prevent immediate re-bloat after compaction.
 * The agent can always read_file on demand if it needs full content.
 */
const POST_COMPACT_MAX_FILES = 3;
const POST_COMPACT_MAX_TOKENS_PER_FILE = 3_000;
const POST_COMPACT_TOKEN_BUDGET = 9_000;

// Post-compact skill re-injection defaults
const POST_COMPACT_MAX_SKILLS = 1;
const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000;
const POST_COMPACT_SKILL_TOKEN_BUDGET = 5_000;

/**
 * Create file attachment messages from the tracked readFileState.
 * Selects the most recently accessed files, respects per-file and total
 * token budgets, and returns user-role messages that restore file context
 * after compaction.
 *
 * Files already referenced in preserved messages (post-cutoff) are excluded
 * to avoid duplication.
 *
 * @param readFileState Map of file path → { content, timestamp, tokenEstimate }
 * @param preservedMessages Messages that survived compaction (checked for file references)
 * @param modelRouter Used for token estimation
 * @param settings Agent settings for budget overrides
 * @returns Array of ChatMessage (one per file) or empty array
 */
export function createPostCompactFileAttachments(
  readFileState: Map<string, ReadFileStateEntry>,
  preservedMessages: ChatMessage[],
  modelRouter: ModelRouter,
  settings: AgentSettings = DEFAULT_AGENT_SETTINGS,
): ChatMessage[] {
  if (readFileState.size === 0) return [];

  const maxFiles = settings.postCompactMaxFiles ?? POST_COMPACT_MAX_FILES;
  const maxTokensPerFile = settings.postCompactMaxTokensPerFile ?? POST_COMPACT_MAX_TOKENS_PER_FILE;
  const totalBudget = settings.postCompactTokenBudget ?? POST_COMPACT_TOKEN_BUDGET;

  // Collect file paths already present in preserved messages to avoid duplication
  const preservedPaths = new Set<string>();
  for (const msg of preservedMessages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    // Look for file path patterns in preserved messages
    for (const [filePath] of readFileState) {
      if (content.includes(filePath)) {
        preservedPaths.add(filePath);
      }
    }
  }

  // Sort files by timestamp (most recently accessed first)
  const sortedFiles = [...readFileState.entries()]
    .filter(([path]) => !preservedPaths.has(path))
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, maxFiles);

  if (sortedFiles.length === 0) return [];

  const attachments: ChatMessage[] = [];
  let totalTokens = 0;

  for (const [filePath, entry] of sortedFiles) {
    let content = entry.content;

    // Truncate per-file if exceeds maxTokensPerFile
    if (entry.tokenEstimate > maxTokensPerFile) {
      const maxChars = maxTokensPerFile * 3; // ~3 chars per token
      content = content.slice(0, maxChars)
        + `\n\n[... file truncated for length (${entry.tokenEstimate} tokens total) ...]`;
    }

    const tokenEstimate = Math.min(entry.tokenEstimate, maxTokensPerFile);

    // Check total budget
    if (totalTokens + tokenEstimate > totalBudget) {
      break;
    }

    totalTokens += tokenEstimate;

    attachments.push({
      role: "user",
      content: `[Previously read file: ${filePath}]\n${content}`,
    });
  }

  return attachments;
}

// ---------------------------------------------------------------------------
// Post-compact skill re-injection
// ---------------------------------------------------------------------------

/**
 * Create user messages that re-inject inline skill instructions after compaction.
 * Skills are ordered by most recently invoked, with token budgets enforced.
 */
export function createPostCompactSkillAttachments(
  invokedSkills: Map<string, InvokedSkillEntry>,
  preservedMessages: ChatMessage[],
  modelRouter: ModelRouter,
  settings: AgentSettings = DEFAULT_AGENT_SETTINGS,
): ChatMessage[] {
  if (invokedSkills.size === 0) return [];

  const maxSkills = settings.postCompactMaxSkills ?? POST_COMPACT_MAX_SKILLS;
  const maxTokensPerSkill = settings.postCompactMaxTokensPerSkill ?? POST_COMPACT_MAX_TOKENS_PER_SKILL;
  const totalBudget = settings.postCompactSkillTokenBudget ?? POST_COMPACT_SKILL_TOKEN_BUDGET;

  // Collect skill names already present in preserved messages to avoid duplication
  const preservedNames = new Set<string>();
  for (const msg of preservedMessages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    for (const [name] of invokedSkills) {
      if (content.includes(name)) {
        preservedNames.add(name);
      }
    }
  }

  // Only re-inject inline skills (fork/sub_agent skills are not needed post-compact)
  const sortedSkills = [...invokedSkills.entries()]
    .filter(([name, entry]) => !preservedNames.has(name) && entry.mode === "inline")
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, maxSkills);

  if (sortedSkills.length === 0) return [];

  const attachments: ChatMessage[] = [];
  let totalTokens = 0;

  for (const [name, entry] of sortedSkills) {
    let content = entry.content;

    // Truncate per-skill if exceeds maxTokensPerSkill
    if (entry.tokenEstimate > maxTokensPerSkill) {
      const maxChars = maxTokensPerSkill * 3;
      content = content.slice(0, maxChars)
        + `\n\n[... skill truncated for length (${entry.tokenEstimate} tokens total) ...]`;
    }

    const tokenEstimate = Math.min(entry.tokenEstimate, maxTokensPerSkill);

    if (totalTokens + tokenEstimate > totalBudget) {
      break;
    }

    totalTokens += tokenEstimate;

    attachments.push({
      role: "user",
      content: [
        "<system-reminder>",
        `Skill: ${name}`,
        "",
        content,
        "",
        `Task: ${entry.input}`,
        "</system-reminder>",
      ].join("\n"),
    });
  }

  return attachments;
}

/**
 * Inject post-compact file and skill attachments into a CompactionResult's message array.
 * Attachments are inserted between the summary message and the recent messages.
 *
 * @param result The compaction result to enhance
 * @param readFileState Tracked file state from the agent run
 * @param modelRouter For token estimation
 * @param settings Agent settings
 * @param invokedSkills Optional tracked inline skills for re-injection
 * @returns Modified CompactionResult with attachments (does not mutate input)
 */
export function injectPostCompactFiles(
  result: CompactionResult,
  readFileState: Map<string, ReadFileStateEntry>,
  modelRouter: ModelRouter,
  settings: AgentSettings = DEFAULT_AGENT_SETTINGS,
  invokedSkills?: Map<string, InvokedSkillEntry>,
): CompactionResult {
  if (result.method === "none" || (readFileState.size === 0 && (!invokedSkills || invokedSkills.size === 0))) return result;

  const messages = result.messages;

  // Recent messages = everything after the first two messages (system + summary)
  // The summary message is at index 1 (for sm-compact and legacy-compact)
  const recentMessages = messages.length > 2 ? messages.slice(2) : [];

  const fileAttachments = createPostCompactFileAttachments(
    readFileState,
    recentMessages,
    modelRouter,
    settings,
  );

  const skillAttachments = invokedSkills
    ? createPostCompactSkillAttachments(invokedSkills, recentMessages, modelRouter, settings)
    : [];

  if (fileAttachments.length === 0 && skillAttachments.length === 0) return result;

  // Rebuild: system prompt + summary + file attachments + skill attachments + recent messages
  const newMessages = [
    messages[0]!, // system prompt
    messages[1]!, // summary / memory injection
    ...fileAttachments,
    ...skillAttachments,
    ...recentMessages,
  ];

  const repaired = repairMessageSequence(newMessages);
  const tokensAfter = modelRouter.estimateTokens(
    repaired.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).join(""),
  );

  console.log(
    `[CompactionEngine] Post-compact: injected ${fileAttachments.length} file attachments, ` +
    `${skillAttachments.length} skill attachments (~${tokensAfter} tokens total)`,
  );

  return {
    ...result,
    messages: repaired,
  };
}

/**
 * Inject post-compact file and skill attachments into collapse replacement messages.
 * Used for the Context Collapse path (non-destructive compaction).
 */
export function injectPostCompactFilesForCollapse(
  replacementMessages: ChatMessage[],
  recentMessages: ChatMessage[],
  readFileState: Map<string, ReadFileStateEntry>,
  modelRouter: ModelRouter,
  settings: AgentSettings = DEFAULT_AGENT_SETTINGS,
  invokedSkills?: Map<string, InvokedSkillEntry>,
): ChatMessage[] {
  if (readFileState.size === 0 && (!invokedSkills || invokedSkills.size === 0)) return replacementMessages;

  const fileAttachments = createPostCompactFileAttachments(
    readFileState,
    recentMessages,
    modelRouter,
    settings,
  );

  const skillAttachments = invokedSkills
    ? createPostCompactSkillAttachments(invokedSkills, recentMessages, modelRouter, settings)
    : [];

  if (fileAttachments.length === 0 && skillAttachments.length === 0) return replacementMessages;

  return [...replacementMessages, ...fileAttachments, ...skillAttachments];
}

// ---------------------------------------------------------------------------
// Post-compact cleanup
// ---------------------------------------------------------------------------

/**
 * Perform cleanup after compaction completes.
 * Clears state that should be reset after a compaction event.
 * Feature L (C-197): Optionally replays SessionStart hooks to restore
 * system prompt context that was lost during compaction.
 *
 * @param readFileState The tracked file state to clear (files already re-injected)
 * @param sessionMemoryManager Session memory manager (trigger background update)
 * @param messages Current messages after compaction
 * @param totalTokens Current token usage
 * @param extras Optional cleanup targets for centralized cache invalidation
 * @param hookManager Optional hook manager for SessionStart replay (Feature L)
 */
export async function runPostCompactCleanup(
  readFileState: Map<string, ReadFileStateEntry>,
  sessionMemoryManager: SessionMemoryManager | null,
  messages: ChatMessage[],
  totalTokens: number,
  // Optional cleanup targets for centralized cache invalidation
  extras?: {
    tokenEstimator?: { clear(): void } | null;
    collapseStore?: { clear(): void } | null;
    searchSaturation?: { reset(): void } | null;
    hookManager?: HookManager | null;
  },
): Promise<void> {
  // 1. Clear readFileState — files have already been re-injected as attachments
  readFileState.clear();

  // 2. Clear system prompt section cache — force recomputation after compaction
  clearSystemPromptCache();

  // 3. Clear token estimator API tracking — stale after message array changes
  extras?.tokenEstimator?.clear();

  // 4. Clear context collapse store — projections are stale after compaction
  extras?.collapseStore?.clear();

  // 5. Reset search saturation detector — search context changed after compaction
  extras?.searchSaturation?.reset();

  // 6. Feature L (C-197): Replay SessionStart hook to restore system prompt context
  if (extras?.hookManager) {
    try {
      await extras.hookManager.fire("SessionStart", {
        hookType: "SessionStart",
      });
      console.log("[PostCompactCleanup] SessionStart hook replayed (source: compact)");
    } catch {
      // Non-critical — best effort
    }
  }

  // 7. Trigger session memory update if available
  // This ensures the memory captures the compaction event
  if (sessionMemoryManager) {
    try {
      const memory = await sessionMemoryManager.load();
      if (memory) {
        // Mark stale pending tasks to prevent re-execution after compaction
        memory.content = markStaleTasksInMemory(memory.content);

        // Mark that a compaction just happened in the memory
        const compactionNote = `\n- [${new Date().toISOString()}] 上下文压缩已执行，旧消息已被摘要替换`;
        const workLogIdx = memory.content.indexOf("## 工作日志");
        if (workLogIdx !== -1) {
          // Append to worklog section
          const beforeWorklog = memory.content.slice(0, workLogIdx);
          const afterWorklogStart = memory.content.slice(workLogIdx);
          const nextSectionIdx = afterWorklogStart.indexOf("\n## ", 1);
          const worklogSection = nextSectionIdx !== -1
            ? afterWorklogStart.slice(0, nextSectionIdx)
            : afterWorklogStart;
          const afterWorklog = nextSectionIdx !== -1
            ? afterWorklogStart.slice(nextSectionIdx)
            : "";
          memory.content = beforeWorklog + worklogSection + compactionNote + afterWorklog;
        }
        await sessionMemoryManager.save(memory);
      }
    } catch {
      // Non-critical — best effort
    }
  }

  console.log("[PostCompactCleanup] Cleanup complete: readFileState, systemPromptCache, tokenEstimator, collapseStore, searchSaturation all reset");
}

/**
 * Mark stale tasks in session memory to prevent the agent from re-executing
 * completed old tasks after compaction.
 *
 * Strategy: Add freshness warnings to "当前状态" and "待处理任务" sections
 * so the model knows these may be outdated after compaction.
 */
function markStaleTasksInMemory(content: string): string {
  // Add freshness warning before "当前状态" section
  const statusIdx = content.indexOf("## 当前状态");
  if (statusIdx !== -1) {
    const warning = "> [压缩提示] 以下状态在压缩时可能已过时，请以用户最新请求为准判断哪些任务仍然活跃\n";
    content = content.slice(0, statusIdx) + warning + content.slice(statusIdx);
  }

  // Add warning before "待处理任务" section
  const pendingIdx = content.indexOf("## 待处理任务");
  if (pendingIdx !== -1) {
    const pendingWarning = "> [压缩提示] 以下任务可能属于已完成的旧任务，除非与最新请求直接相关，否则应忽略\n";
    content = content.slice(0, pendingIdx) + pendingWarning + content.slice(pendingIdx);
  }

  return content;
}

// ---------------------------------------------------------------------------
// Quality audit
// ---------------------------------------------------------------------------

// Regex patterns for opaque identifiers that must survive compaction
const IDENTIFIER_PATTERNS = [
  // File paths (Unix and Windows)
  /(?:\/[\w\-._]+){2,}/g,
  /[A-Z]:\\(?:[\w\-._]+\\){1,}[\w\-._]+/gi,
  // URLs
  /https?:\/\/[^\s<>"]+/g,
  // UUIDs
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  // Document IDs (doc_xxx, page_xxx)
  /\bdoc_[a-zA-Z0-9_]+/g,
  /\bpage_[a-zA-Z0-9_]+/g,
  // Note: removed generic hash pattern /\b[0-9a-f]{32,64}\b/gi — it matched too many
  // non-identifier hex substrings in tool results, inflating counts by 200+ false positives.
];

/**
 * Extract all opaque identifiers from a set of messages.
 * Returns a deduplicated, sorted array of identifier strings.
 */
function extractIdentifiers(messages: ChatMessage[]): string[] {
  const identifiers = new Set<string>();
  for (const msg of messages) {
    const content = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content ?? "");
    for (const pattern of IDENTIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        identifiers.add(match[0]);
      }
    }
  }
  return Array.from(identifiers).sort();
}

/**
 * Build a structured identifier preservation section to append to a compaction summary.
 * This ensures critical identifiers (file paths, doc IDs, UUIDs) survive compaction,
 * preventing the agent from re-discovering already-processed documents.
 */
// Maximum identifiers to preserve in compaction summaries.
// Cap prevents excessive bulk while covering most sessions.
// Raised from 30 to 150 — 30 was too aggressive, losing most identifiers in large KB sessions.
const MAX_PRESERVED_IDENTIFIERS = 300;

function buildIdentifierPreservationBlock(identifiers: string[]): string {
  if (identifiers.length === 0) return "";
  // Prioritize: file paths > doc_ids/page_ids > UUIDs > hashes
  // File paths are most useful for avoiding re-discovery
  const sorted = [...identifiers];
  if (sorted.length > MAX_PRESERVED_IDENTIFIERS) {
    const paths = sorted.filter(id => id.startsWith("/") || /^[A-Z]:/i.test(id));
    const docIds = sorted.filter(id => id.startsWith("doc_") || id.startsWith("page_"));
    const rest = sorted.filter(id => !paths.includes(id) && !docIds.includes(id));
    sorted.length = 0;
    sorted.push(...paths, ...docIds, ...rest);
    sorted.length = MAX_PRESERVED_IDENTIFIERS;
  }
  const lines = sorted.map(id => `- ${id}`);
  return `\n\n<preserved_identifiers>\n以下标识符来自被压缩的对话历史，用于避免重复搜索和读取：\n${lines.join("\n")}\n</preserved_identifiers>`;
}

/**
 * Audit a compaction summary for quality by checking whether opaque identifiers
 * from the original messages are preserved in the summary.
 *
 * This is a programmatic check — it does NOT block compaction if identifiers
 * are missing, but logs a warning for diagnostic purposes.
 *
 * @param originalMessages The messages before compaction
 * @param summaryText The generated summary text
 * @returns List of missing identifiers (empty = perfect quality)
 */
export function auditSummaryQuality(
  originalMessages: ChatMessage[],
  summaryText: string,
): string[] {
  // Extract all identifiers from original messages
  const originalIdentifiers = new Set<string>();
  for (const msg of originalMessages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    for (const pattern of IDENTIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        originalIdentifiers.add(match[0]);
      }
    }
  }

  if (originalIdentifiers.size === 0) return [];

  // Check which identifiers are missing from the summary
  const missing: string[] = [];
  for (const id of originalIdentifiers) {
    if (!summaryText.includes(id)) {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    console.warn(
      `[CompactionAudit] Summary quality warning: ${missing.length}/${originalIdentifiers.size} ` +
      `identifiers missing from compaction summary. Examples: ${missing.slice(0, 5).join(", ")}`,
    );
  }

  return missing;
}
