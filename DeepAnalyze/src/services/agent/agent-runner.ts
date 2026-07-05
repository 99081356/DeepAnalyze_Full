// =============================================================================
// DeepAnalyze - Agent Runner
// =============================================================================
// Core agent execution engine. Implements a continuous TAOR loop with:
//   - while(true) loop (model decides when to stop, configurable turn limits)
//   - Auto-compaction (SM-compact + Legacy compact)
//   - Session memory extraction and injection
//   - Microcompaction of old tool results
//   - Emergency compaction for prompt_too_long errors
//   - All key parameters configurable via AgentSettings
// =============================================================================

import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { ModelRouter } from "../../models/router.js";
import { friendlyLLMError } from "../../models/auth-profiles.js";
import { ToolRegistry } from "./tool-registry.js";
import { ContextManager } from "./context-manager.js";
import { CompactionEngine, injectPostCompactFiles, injectPostCompactFilesForCollapse, runPostCompactCleanup, auditSummaryQuality } from "./compaction.js";
import { MicroCompactor } from "./micro-compact.js";
import { SessionMemoryManager, replaceSessionMemoryInjection } from "./session-memory.js";
import { AsyncSessionMemoryExtractor } from "./session-memory-async.js";
import { getCachedEvolutionConfig } from "./evolution-config.js";
import { getRepos } from "../../store/repos/index.js";
import { DisplayResolver } from "../display-resolver.js";
import { maybePersistToolResult } from "./tool-result-storage.js";
import { ToolResultCache } from "./tool-result-cache.js";
import { SearchResultIndex } from "./search-result-index.js";
import { TokenGrowthTracker } from "./token-growth-tracker.js";
import { safeTruncateJSON } from "./json-truncate.js";
import { CostTracker } from "./cost-tracker.js";
import type {
  AgentDefinition,
  AgentRunOptions,
  AgentResult,
  AgentEvent,
  AgentProgressEntry,
  AgentSettings,
  CompactBoundaryMeta,
  AgentTool,
  CollapseSummaryInfo,
  SessionMemoryNote,
} from "./types.js";
import { DEFAULT_AGENT_SETTINGS } from "./types.js";
import type { ReadFileStateEntry, InvokedSkillEntry } from "./types.js";
import { SUB_AGENT_BLOCKED_TOOLS } from "./tool-setup.js";
import { getAntiHallucinationSection } from "./anti-hallucination.js";
import { getLanguageRule } from "./agent-definitions.js";
import { orchestrateToolCalls } from "./tool-orchestration.js";
import { TokenEstimator } from "./token-estimator.js";
import { needsContinuation, buildContinuationMessage, buildStreamErrorContinuationMessage, DEFAULT_CONTINUATION_CONFIG } from "./long-io.js";
import { applyCacheEditing, applySmartCacheEditing } from "./cache-editing.js";
import { CollapseStore, applyCollapseProjection, createMicroCollapseEntries, createCollapseFromSummary } from "./context-collapse.js";
import { resolveFeatureFlags } from "./feature-flags.js";
import { StreamingToolExecutor } from "./streaming-tool-executor.js";
import { markCacheBreakpoints } from "./prompt-cache.js";
import { SystemPromptBuilder } from "./system-prompt.js";
import { PromptCacheDetector } from "./prompt-cache-detector.js";
import { saveCacheSafeParams, computeCacheSafeParams } from "./cache-safe-params.js";
import { getTokenBudgetState, checkBudgetStateChange, type BudgetState } from "./token-budget-state.js";
import type { HookManager } from "./hooks.js";
import type { HookContext } from "./hook-types.js";
import { writerRegistry } from "../session/jsonl-writer.js";
import { getSessionSubagentsDir, makeAgentFilename, resolveSessionOutputPath, isSharedDataPath } from "../session/session-paths.js";
import type { JsonlWriter } from "../session/jsonl-writer.js";
import type {
  ChatMessage,
  ChatResponse,
  ChatOptions,
  ToolCall,
  ToolDefinition,
  ModelRole,
  StreamChunk,
} from "../../models/provider.js";

// ---------------------------------------------------------------------------
// JSON repair for tool arguments (handles common streaming/model errors)
// ---------------------------------------------------------------------------

/**
 * Extract the first complete JSON object from a string that may contain
 * multiple concatenated objects or trailing garbage.
 * Uses brace-counting with string awareness to find the boundary.
 */
function extractFirstJSONObject(str: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return str.slice(0, i + 1);
    }
  }
  return null;
}

/**
 * Attempt to repair malformed JSON from model tool call arguments.
 * Common issues:
 *   - Multiple tool call arguments concatenated: }{"sql":"..."}
 *   - Truncated JSON (streaming interrupted)
 *   - Unescaped backslashes in regex patterns (\d, \w, etc.)
 * Returns parsed object on success, null if unrepairable.
 */
function tryRepairToolArguments(raw: string): Record<string, unknown> | null {
  if (!raw || raw.trim().length === 0) return null;
  const str = raw.trim();

  // Attempt 1: Extract first complete JSON object (handles concatenated objects)
  const firstObj = extractFirstJSONObject(str);
  if (firstObj) {
    try {
      return JSON.parse(firstObj);
    } catch {
      // first complete object is still invalid, try further repairs
    }
  }

  // Attempt 2: Close unclosed braces/brackets (truncated JSON)
  let repaired = str;
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;

  if (openBraces > closeBraces) {
    // Truncated mid-value — trim back to last complete key-value pair
    const lastComma = repaired.lastIndexOf(",");
    const lastColon = repaired.lastIndexOf(":");
    if (lastColon > lastComma) {
      const prevComma = repaired.lastIndexOf(",", lastComma - 1);
      if (prevComma > 0) repaired = repaired.slice(0, prevComma);
      else return null;
    }
    // Close open strings and braces
    const uq = (repaired.match(/(?<!\\)"/g) || []).length;
    if (uq % 2 !== 0) repaired += '"';
    const cb = (repaired.match(/\{/g) || []).length - (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < cb; i++) repaired += "}";
    try {
      return JSON.parse(repaired);
    } catch {
      // fall through
    }
  }

  // Attempt 3: Fix unescaped backslashes (common in regex: \d → \\d)
  const fixed = str.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
  if (fixed !== str) {
    const fixedFirst = extractFirstJSONObject(fixed);
    if (fixedFirst) {
      try { return JSON.parse(fixedFirst); } catch { /* fall through */ }
    }
    try { return JSON.parse(fixed); } catch { /* fall through */ }
  }

  return null;
}

/**
 * Split tool calls that contain concatenated JSON arguments.
 *
 * GLM5.1 (and potentially other models) sometimes emit multiple JSON objects
 * concatenated in a single tool_call's arguments field, e.g.:
 *   {"docId":"abc","targetLevel":"L1"}{"docId":"def","targetLevel":"L1"}
 *
 * This function detects such cases and splits them into separate ToolCall
 * entries, assigning a new UUID to each split call.
 */
function splitConcatenatedToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const result: ToolCall[] = [];

  for (const tc of toolCalls) {
    const raw = tc.function.arguments;

    // Fast path: if the arguments parse as-is, no splitting needed
    try {
      JSON.parse(raw);
      result.push(tc);
      continue;
    } catch {
      // Arguments are invalid JSON — check for concatenated objects
    }

    // Extract all complete JSON objects from the string
    const objects: string[] = [];
    let depth = 0;
    let inString = false;
    let escape = false;
    let startPos = -1;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') {
        if (depth === 0) startPos = i;
        depth++;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0 && startPos >= 0) {
          objects.push(raw.slice(startPos, i + 1));
          startPos = -1;
        }
      }
    }

    if (objects.length <= 1) {
      // Arguments are invalid JSON and couldn't be split.
      // Repair now to prevent API rejection when the tool call is sent back
      // in the conversation history (executeToolCall repair only fixes execution,
      // not the stored arguments in messages sent to the API).
      console.warn(`[AgentRunner] INVALID JSON for "${tc.function.name}" — raw length=${raw.length}`);
      console.warn(`[AgentRunner] RAW ARGS (first 500): ${raw.slice(0, 500)}`);
      const repaired = tryRepairToolArguments(raw);
      if (repaired !== null) {
        const repairedJson = JSON.stringify(repaired);
        console.warn(`[AgentRunner] REPAIRED → length=${repairedJson.length}, keys=[${Object.keys(repaired).join(",")}]`);
        result.push({
          ...tc,
          function: { ...tc.function, arguments: repairedJson },
        });
      } else {
        // Unrepairable — replace with empty valid JSON to prevent API 400 errors
        console.warn(`[AgentRunner] Could not repair tool call arguments for "${tc.function.name}", replacing with {}. Original: ${raw.slice(0, 200)}`);
        result.push({
          ...tc,
          function: { ...tc.function, arguments: "{}" },
        });
      }
    } else {
      // Multiple objects found — split into separate tool calls
      console.log(`[AgentRunner] Split concatenated tool call "${tc.function.name}" into ${objects.length} separate calls (original length=${raw.length})`);
      for (const objStr of objects) {
        result.push({
          id: randomUUID(), // Assign new unique ID for each split
          type: "function",
          function: {
            name: tc.function.name,
            arguments: objStr,
          },
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Default agent definition (used when no agent type is specified)
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_DEFINITION: AgentDefinition = {
  agentType: "general",
  description: "General-purpose agent for any task",
  // [ORIGINAL ENGLISH] "You are a helpful AI assistant. Analyze the user's request carefully and use available tools as needed to accomplish the task. When you have completed the task, call the 'finish' tool with your final answer."
  systemPrompt:
    "你是一个有帮助的 AI 助手。请仔细分析用户的请求，根据需要使用可用工具来完成任务。" +
    "当你完成任务时，调用 'finish' 工具返回最终答案。\n\n" +
    getLanguageRule() + "\n\n" +
    "## 完成规则（非常重要）\n" +
    "当你认为已经充分回答了用户的问题或完成了任务时，必须调用 'finish' 工具提交最终结果。" +
    "不要在没有调用 finish 的情况下结束。如果还有未完成的工作，继续使用工具。\n" +
    "如果所有搜索策略都已尝试但仍未找到确切答案，也要调用 finish 提交最佳推测。\n" +
    "绝对不要输出只有推理过程而没有结论的文本。如果你有答案，调用 finish。如果没有答案，给出最有可能的推测并调用 finish。\n\n" +
    "## 答案格式规则\n" +
    "调用 finish 工具时，summary 参数应该是最终的简洁答案。" +
    "如果问题是要求具体数值、名称或简短回答，summary 中只包含该值。" +
    "例如：如果问 'how many'，summary 只写数字；如果问 'what name'，summary 只写名称。" +
    "不要在 summary 中包含解释或推理过程，只包含最终答案。\n\n" +
    "## 搜索策略\n" +
    "如果第一次搜索没有结果：\n" +
    "1. 尝试更短或更通用的关键词\n" +
    "2. 使用 web_fetch 直接访问相关网站\n" +
    "3. 使用 wikipedia 工具搜索背景信息\n" +
    "4. 搜索间接来源：博客、论坛、社交媒体讨论可能引用或总结了目标内容\n" +
    "5. 对于学术论文/报告：直接访问机构网站的 /journals/、/publications/ 等路径\n" +
    "6. 对于视频内容：当 transcript 工具失败时，搜索视频标题+关键信息找第三方总结\n" +
    "7. 如果所有策略都失败，基于已有信息给出最佳推测并调用 finish\n\n" +
    getAntiHallucinationSection("basic"),
  tools: ["*"],
  modelRole: "main",
  maxTurns: -1,
  readOnly: false,
};

// Finish reasons that indicate the model stopped naturally (provider-agnostic)
const STOP_FINISH_REASONS = new Set([
  "stop",
  "end_turn",
  "STOP",
  "EndTurn",
  "ended",
]);

// ---------------------------------------------------------------------------
// Language detection for bilingual intervention messages
// ---------------------------------------------------------------------------

type DetectedLanguage = "zh" | "en";

function detectLanguage(text: string): DetectedLanguage {
  const zhChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return zhChars > text.length * 0.1 ? "zh" : "en";
}

// ---------------------------------------------------------------------------
// R4.6: Dynamic turn budget — task complexity estimation
// ---------------------------------------------------------------------------

type TaskComplexity = "simple" | "moderate" | "complex";

/**
 * Estimate task complexity from the user input and agent type.
 * Used to set an appropriate advisory turn limit when no explicit maxTurns is provided.
 *
 * - Simple: short questions, single facts → 15 turns
 * - Moderate: analysis, comparison, multi-step reasoning → 40 turns
 * - Complex: deep research, multi-doc analysis, synthesis → 100 turns
 */
function estimateTaskComplexity(input: string, agentType: string): TaskComplexity {
  const text = input.toLowerCase().trim();

  // Agent type hints: certain agent types imply higher complexity
  const complexAgentTypes = new Set(["report", "research", "analysis", "deep-analyze"]);
  if (complexAgentTypes.has(agentType)) return "complex";

  // Length heuristic: very short inputs are typically simple questions
  if (text.length < 30) return "simple";

  // Keyword-based heuristics for complexity detection
  const complexKeywords = [
    "analyze", "analysis", "compare", "comparison", "comprehensive",
    "deep", "detailed", "research", "investigate", "synthesis",
    "summarize all", "all documents", "multiple documents", "cross-reference",
    "报告", "分析", "对比", "比较", "全面", "详细", "深入", "综合",
    "研究", "调查", "总结所有", "多文档", "交叉引用", "梳理",
  ];

  const moderateKeywords = [
    "explain", "describe", "how does", "what are the differences",
    "list", "find", "search for", "show me", "help me understand",
    "解释", "描述", "列出", "查找", "搜索", "帮我理解", "有哪些",
    "区别", "异同", "分类", "概述",
  ];

  const simpleKeywords = [
    "what is", "who is", "when was", "where is",
    "define", "yes or no", "true or false",
    "是什么", "是谁", "什么时候", "在哪里", "有多少", "定义",
    "是否",
  ];

  // Score each complexity level
  let complexScore = 0;
  let moderateScore = 0;
  let simpleScore = 0;

  for (const kw of complexKeywords) {
    if (text.includes(kw)) complexScore += 2;
  }
  for (const kw of moderateKeywords) {
    if (text.includes(kw)) moderateScore += 1.5;
  }
  for (const kw of simpleKeywords) {
    if (text.includes(kw)) simpleScore += 2;
  }

  // Multi-sentence or multi-clause inputs suggest moderate+ complexity
  const sentences = text.split(/[.!?。！？\n]+/).filter(s => s.trim().length > 0);
  if (sentences.length >= 3) moderateScore += 1;
  if (sentences.length >= 5) complexScore += 1;

  // Explicit enumeration of items suggests higher complexity
  if ((text.match(/[、,;，；]/g) || []).length >= 4) moderateScore += 1;

  // Determine winner
  if (complexScore >= moderateScore && complexScore >= simpleScore && complexScore > 0) return "complex";
  if (moderateScore >= simpleScore && moderateScore > 0) return "moderate";
  if (simpleScore > 0) return "simple";

  // Default by input length: longer inputs tend to need more turns
  if (text.length > 100) return "moderate";
  return "simple";
}

/** Map task complexity to minimum turn guarantee (adaptive system will extend as needed) */
function complexityToMinTurns(complexity: TaskComplexity): number {
  switch (complexity) {
    case "simple": return 15;
    case "moderate": return 30;
    case "complex": return 60;
  }
}

// ---------------------------------------------------------------------------
// R4.6: Adaptive Progress Tracker (replaces fixed turn budgets)
// ---------------------------------------------------------------------------

interface ProgressTracker {
  /** Minimum turns before any progress check */
  minTurns: number;
  /** Current checkpoint interval (increases when making progress) */
  checkpointInterval: number;
  /** Turn at which the next checkpoint will be evaluated */
  nextCheckpointAt: number;
  /** Number of consecutive stalls detected */
  consecutiveStalls: number;
  /** Track how many times each tool has been called */
  toolCallCounts: Map<string, number>;
  /** Total tool calls */
  totalToolCalls: number;
  /** Whether any production tool (write_file, edit_file, push_content) has been called */
  hasProducedOutput: boolean;
  /** Total turns spent on exploration-only tools without any production */
  consecutiveExplorationTurns: number;
}

function createProgressTracker(minTurns: number): ProgressTracker {
  return {
    minTurns,
    checkpointInterval: 10,
    nextCheckpointAt: Math.max(10, minTurns),
    consecutiveStalls: 0,
    toolCallCounts: new Map(),
    totalToolCalls: 0,
    hasProducedOutput: false,
    consecutiveExplorationTurns: 0,
  };
}

/** Production tools that indicate the agent is creating output, not just exploring. */
const PRODUCTION_TOOLS = new Set(["write_file", "edit_file", "push_content"]);

/** Check if the model should be nudged at this turn. Returns a hint message or null. */
function evaluateProgress(
  tracker: ProgressTracker,
  turn: number,
  hadNewSearches: boolean,
  toolNamesThisTurn?: string[],
): { hint: string | null; shouldContinue: boolean } {
  // Update tool call tracking
  if (toolNamesThisTurn) {
    let turnHasProduction = false;
    for (const name of toolNamesThisTurn) {
      tracker.toolCallCounts.set(name, (tracker.toolCallCounts.get(name) || 0) + 1);
      tracker.totalToolCalls++;
      if (PRODUCTION_TOOLS.has(name)) {
        tracker.hasProducedOutput = true;
        turnHasProduction = true;
      }
    }
    // Track exploration/production balance
    if (turnHasProduction) {
      tracker.consecutiveExplorationTurns = 0;
    } else if (toolNamesThisTurn.length > 0) {
      tracker.consecutiveExplorationTurns++;
    }
  }

  // Detect exploration without production: agent has been reading/exploring for many turns
  // but hasn't written any output yet. Nudge to start producing results.
  // Only trigger after enough turns for legitimate exploration, and only every 5 turns.
  if (!tracker.hasProducedOutput && tracker.consecutiveExplorationTurns >= 8 && turn % 5 === 0) {
    return {
      hint: "你已进行了多轮探索和读取操作，但尚未生成任何输出内容。如果你已经收集到足够的信息，请开始使用 write_file 将结果写入文件。如果确实还需要更多信息，请继续，但请注意轮次预算。",
      shouldContinue: true,
    };
  }

  // Detect tool over-specialization: if one tool accounts for >60% of all tool calls
  // and total calls > 20, the agent is likely stuck in a repetitive pattern
  if (tracker.totalToolCalls > 20) {
    for (const [toolName, count] of tracker.toolCallCounts) {
      const ratio = count / tracker.totalToolCalls;
      if (ratio > 0.6 && count > 15) {
        // Heavy single-tool usage detected — nudge to diversify or wrap up
        if (turn % 10 === 0 || count % 10 === 0) {
          return {
            hint: `你已大量使用 ${toolName}（${count}次，占所有工具调用的${Math.round(ratio * 100)}%）。请评估：是否有足够信息来完成任务了？如果是，请停止重复操作，整理已有发现并输出完整结果。如果确实还需要更多操作，请考虑是否有更高效的方式获取剩余信息。`,
            shouldContinue: true,
          };
        }
      }
    }
  }

  // Soft wrap-up nudge when far past the minimum turns — suggest, don't force
  // Only nudge every 15 turns to avoid being annoying
  if (turn >= tracker.minTurns * 2 && turn % 15 === 0) {
    return {
      hint: "你已经工作了很多轮。如果核心问题已有充分信息，可以考虑整理发现并输出结果。尚未覆盖的部分坦诚说明即可。如果确实还有重要信息需要获取，继续工作也没问题。",
      shouldContinue: true,
    };
  }

  // Before minimum turns, never nudge
  if (turn < tracker.nextCheckpointAt) {
    return { hint: null, shouldContinue: true };
  }

  // Checkpoint reached — evaluate progress
  if (hadNewSearches) {
    // Making progress — extend checkpoint interval
    tracker.checkpointInterval = Math.min(tracker.checkpointInterval + 10, 50);
    tracker.consecutiveStalls = 0;
  } else {
    tracker.consecutiveStalls++;
  }

  tracker.nextCheckpointAt = turn + tracker.checkpointInterval;

  // Stall detection
  if (tracker.consecutiveStalls >= 3) {
    tracker.consecutiveStalls = 0;
    return {
      hint: "你似乎陷入了重复操作，没有获得新信息。请评估：是否有足够信息来回答问题了？如果是，请整理结果并输出。如果确实需要更多信息，请尝试完全不同的策略。",
      shouldContinue: true,
    };
  }

  if (tracker.consecutiveStalls >= 1) {
    return {
      hint: "最近几轮没有获得明显新信息。请评估是否需要换用不同的搜索策略或工具组合。如果已有足够信息，请整理结果并调用 finish。",
      shouldContinue: true,
    };
  }

  return { hint: null, shouldContinue: true };
}

// ---------------------------------------------------------------------------
// C3.6: Proactive compaction timing constants
// ---------------------------------------------------------------------------

/** Proactive compaction fires when context is in this range (70-85% of effective window). */
const PROACTIVE_COMPACT_LOWER_RATIO = 0.70;
const PROACTIVE_COMPACT_UPPER_RATIO = 0.85;

/** Minimum turns between proactive compaction triggers to avoid thrashing. */
const PROACTIVE_COMPACT_MIN_INTERVAL_TURNS = 5;

// ---------------------------------------------------------------------------
// Stuck-loop detection
// ---------------------------------------------------------------------------
// Search saturation detection
// ---------------------------------------------------------------------------

/** Tracks search results and detects when results overlap significantly. */
class SearchSaturationDetector {
  private searchResults: string[][] = [];
  private readonly maxHistory = 10;
  private readonly overlapThreshold: number;
  private saturationDetected = false;
  // Track consecutive search-heavy turns (no synthesis in between)
  private consecutiveSearchTurns = 0;
  private readonly searchHeavyThreshold = 4;

  constructor(overlapThreshold: number = 0.8) {
    this.overlapThreshold = overlapThreshold;
  }

  /**
   * Record results from a search tool call.
   * @param toolName The search tool name (kb_search, web_search, etc.)
   * @param result The tool result object (expects results array or string content)
   */
  recordSearch(toolName: string, result: unknown): void {
    const resultKeys = this.extractResultKeys(result);
    if (resultKeys.length === 0) return;

    this.searchResults.push(resultKeys);
    if (this.searchResults.length > this.maxHistory) {
      this.searchResults.shift();
    }

    // Check saturation: compare last 3 searches
    if (this.searchResults.length >= 3) {
      const last3 = this.searchResults.slice(-3);
      const overlap12 = this.computeOverlap(last3[0]!, last3[1]!);
      const overlap23 = this.computeOverlap(last3[1]!, last3[2]!);
      if (overlap12 >= this.overlapThreshold && overlap23 >= this.overlapThreshold) {
        this.saturationDetected = true;
      }
    }
  }

  /**
   * Record that a turn contained search tool calls.
   * Tracks consecutive search-heavy turns to detect excessive searching.
   */
  recordSearchTurn(searchCount: number, synthesisAction: boolean): void {
    if (searchCount > 0 && !synthesisAction) {
      this.consecutiveSearchTurns++;
    } else {
      this.consecutiveSearchTurns = 0;
    }
    if (this.consecutiveSearchTurns >= this.searchHeavyThreshold) {
      this.saturationDetected = true;
    }
  }

  /**
   * Check if search saturation has been detected.
   * Returns an intervention message if saturated, null otherwise.
   */
  checkAndIntervene(lang: DetectedLanguage): string | null {
    if (!this.saturationDetected) return null;

    // Only intervene once
    this.saturationDetected = false;
    this.consecutiveSearchTurns = 0;

    if (lang === "zh") {
      return (
        `[系统提示] 检测到连续多轮以搜索为主，未进行综合分析或输出。\n` +
        `建议：停止继续搜索，基于已收集的信息开始分析和输出结果。\n` +
        `如果信息仍有明显遗漏，尝试完全不同的搜索角度。`
      );
    }
    return (
      `[System-Notice] Multiple consecutive turns spent searching without synthesis.\n` +
      `Suggestion: Stop searching and start analyzing/outputting based on what you've gathered.\n` +
      `If critical information is clearly missing, try a completely different search angle.`
    );
  }

  /** Extract identifying keys from a search result for overlap comparison. */
  private extractResultKeys(result: unknown): string[] {
    if (!result || typeof result !== "object") return [];
    const obj = result as Record<string, unknown>;

    // Handle kb_search results: { results: [{ pageId, docId, title }] }
    if (Array.isArray(obj.results)) {
      return obj.results.map((r: any) =>
        r.pageId ?? r.docId ?? r.title ?? r.url ?? String(r)
      ).filter(Boolean) as string[];
    }

    // Handle web_search results: array of { title, url }
    if (Array.isArray(obj.items)) {
      return obj.items.map((r: any) =>
        r.url ?? r.title ?? String(r)
      ).filter(Boolean) as string[];
    }

    return [];
  }

  /** Compute Jaccard-like overlap ratio between two sets of keys. */
  private computeOverlap(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const setB = new Set(b);
    const common = a.filter(k => setB.has(k)).length;
    return common / Math.min(a.length, b.length);
  }

  /** Reset state (e.g., after compaction). */
  reset(): void {
    this.searchResults = [];
    this.saturationDetected = false;
  }
}

// ---------------------------------------------------------------------------

interface ToolCallRecord {
  toolName: string;
  turn: number;
  inputHash: string;
}

/**
 * Detects when the agent is stuck in a repetitive tool-call loop.
 * Tracks recent tool calls and checks for patterns indicating no progress.
 * Injects a guidance message when stuck behavior is detected.
 */
class StuckDetector {
  private history: ToolCallRecord[] = [];
  private readonly maxHistory = 20;
  private interventionCount = 0;
  private readonly maxInterventions = 5;
  private readonly threshold: number;
  private readonly lang: DetectedLanguage;
  private outputTokenHistory: number[] = [];
  private static readonly STALL_THRESHOLD = 5;
  private static readonly STALL_TOKEN_LIMIT = 100;

  /** Tools exempt from stuck detection — these are inherently batch/iterative operations. */
  private static readonly EXEMPT_TOOLS = new Set([
    "expand", "kb_search",         // batch operations on different docs
    "read_file", "edit_file",      // reading/writing different files is normal
    "write_file", "push_content",  // writing different files/chapters is normal
    "agent_todo",                  // task management updates
    "glob", "grep", "doc_grep",   // searching with different patterns is normal
    "run_sql",                     // different queries are normal
  ]);

  constructor(threshold: number = 5, lang: DetectedLanguage = "zh") {
    this.threshold = threshold;
    this.lang = lang;
  }

  /**
   * Record a tool call and check if the agent appears stuck.
   * Returns an intervention message if stuck is detected, null otherwise.
   */
  recordAndCheck(toolName: string, input: Record<string, unknown>, turn: number): string | null {
    // Skip stuck detection for exempt tools — but still record for error tracking
    if (StuckDetector.EXEMPT_TOOLS.has(toolName)) {
      // Still record the call for error-pattern detection
      const primaryInput = this.extractPrimaryInput(toolName, input);
      this.history.push({ toolName, turn, inputHash: `${toolName}:${primaryInput}` });
      if (this.history.length > this.maxHistory) {
        this.history = this.history.slice(-this.maxHistory);
      }
      return null;
    }

    const primaryInput = this.extractPrimaryInput(toolName, input);
    this.history.push({ toolName, turn, inputHash: `${toolName}:${primaryInput}` });

    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    return this.detectStuckPattern(turn);
  }

  /**
   * Record that a tool call returned an error. Checks if exempt tools are
   * repeatedly failing with the same error (which indicates a stuck pattern
   * that the exemption was not designed to cover).
   */
  recordError(toolName: string, input: Record<string, unknown>, turn: number): string | null {
    const primaryInput = this.extractPrimaryInput(toolName, input);
    const errorHash = `${toolName}:ERROR:${primaryInput}`;
    this.history.push({ toolName, turn, inputHash: errorHash });

    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    return this.detectStuckPattern(turn);
  }

  /**
   * Record output tokens for a turn (used for progress stall detection).
   */
  recordOutputTokens(tokens: number): void {
    this.outputTokenHistory.push(tokens);
    if (this.outputTokenHistory.length > 10) {
      this.outputTokenHistory.shift();
    }
  }

  private extractPrimaryInput(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "web_search":
      case "kb_search":
        return String(input.query ?? "").toLowerCase().trim();
      case "bash":
        return String(input.command ?? "").toLowerCase().trim();
      default:
        return JSON.stringify(input).toLowerCase().substring(0, 100);
    }
  }

  private detectStuckPattern(turn: number): string | null {
    if (this.interventionCount >= this.maxInterventions) return null;
    if (this.history.length < this.threshold) return null;

    // Pattern 0: Hard limit on consecutive think-only calls (max 8)
    const thinkOnlyLimit = 8;
    if (this.history.length >= thinkOnlyLimit) {
      const lastN = this.history.slice(-thinkOnlyLimit);
      if (lastN.every(r => r.toolName === "think")) {
        this.interventionCount++;
        return this.buildIntervention("think", thinkOnlyLimit, turn);
      }
    }

    // Pattern 1: Same tool called threshold+ times with IDENTICAL input in the last threshold+3 calls
    // Key fix: only trigger when the same tool+input combination repeats, not just the tool name.
    // Calling the same tool with different inputs (e.g., write_file to different paths) is NOT stuck.
    const recent = this.history.slice(-(this.threshold + 3));
    const hashCounts = new Map<string, { tool: string; count: number }>();
    for (const r of recent) {
      const entry = hashCounts.get(r.inputHash);
      if (entry) {
        entry.count++;
      } else {
        hashCounts.set(r.inputHash, { tool: r.toolName, count: 1 });
      }
    }
    for (const [, { tool, count }] of hashCounts) {
      if (count >= this.threshold) {
        this.interventionCount++;
        return this.buildIntervention(tool, count, turn);
      }
    }

    // Pattern 2: threshold+ consecutive calls with the same tool AND same input (true loop)
    const lastN2 = this.history.slice(-this.threshold);
    if (lastN2.length >= this.threshold &&
        lastN2.every(r => r.inputHash === lastN2[0]!.inputHash)) {
      this.interventionCount++;
      return this.buildIntervention(lastN2[0]!.toolName, this.threshold, turn);
    }

    // Pattern 3: Progress stall — N consecutive turns with very low output
    if (this.outputTokenHistory.length >= StuckDetector.STALL_THRESHOLD) {
      const recent = this.outputTokenHistory.slice(-StuckDetector.STALL_THRESHOLD);
      if (recent.every(t => t < StuckDetector.STALL_TOKEN_LIMIT)) {
        return this.buildIntervention("low_output", StuckDetector.STALL_THRESHOLD, turn);
      }
    }

    // Pattern 4: Alternating A→B→A→B pattern
    if (this.history.length >= 6) {
      const last6 = this.history.slice(-6);
      const names = last6.map(h => h.toolName);
      if (names[0] === names[2] && names[2] === names[4] &&
          names[1] === names[3] && names[3] === names[5] &&
          names[0] !== names[1]) {
        this.interventionCount++;
        return this.buildIntervention("alternating", 6, turn);
      }
    }

    return null;
  }

  private buildIntervention(toolName: string, count: number, turn: number): string {
    // Handle progress stall pattern
    if (toolName === "low_output") {
      if (this.interventionCount >= this.maxInterventions) return null;
      this.interventionCount++;
      if (this.lang === "zh") {
        return `[系统干预] 连续 ${count} 轮输出极少，可能陷入无效循环。请立即使用 think 工具整理已有发现，然后调用 finish 提交结果。`;
      }
      return `[System Intervention] ${count} consecutive turns with minimal output. Use think to organize findings, then call finish to submit results.`;
    }

    // Handle alternating tool pattern
    if (toolName === "alternating") {
      if (this.interventionCount >= this.maxInterventions) return null;
      this.interventionCount++;
      if (this.lang === "zh") {
        return `[系统干预] 检测到工具交替循环模式。请换一种策略或调用 finish 提交当前结果。`;
      }
      return `[System Intervention] Alternating tool loop detected. Change strategy or call finish to submit current results.`;
    }

    const alternatives = this.getAlternatives(toolName);
    // Special handling for think-only loops
    if (toolName === "think") {
      if (this.lang === "zh") {
        return (
          `[系统提示-强制] 你已连续 ${count} 次仅调用 think 工具，没有执行任何实际操作。` +
          `这表明你陷入了纯思考循环，必须立即停止！\n\n` +
          `你必须立即采取以下行动之一：\n` +
          `1. 使用 web_search 或 wikipedia 工具搜索相关信息\n` +
          `2. 使用 web_fetch 访问相关 URL\n` +
          `3. 使用 bash 工具执行计算或数据处理\n` +
          `4. 如果你已经有足够信息，立即调用 finish 工具给出最终答案\n\n` +
          `不要再调用 think 工具！选择一个行动工具立即执行。`
        );
      } else {
        return (
          `[System-Intervention] You have called the think tool ${count} consecutive times without taking any action. ` +
          `This indicates you are stuck in a thinking loop — stop immediately!\n\n` +
          `You must take one of these actions now:\n` +
          `1. Use web_search or wikipedia to search for information\n` +
          `2. Use web_fetch to access a relevant URL\n` +
          `3. Use bash to run calculations or data processing\n` +
          `4. If you have enough information, call finish with your final answer\n\n` +
          `Do NOT call think again. Choose an action tool and execute it now.`
        );
      }
    }
    if (this.lang === "zh") {
      return (
        `[系统提示] 你已连续 ${count} 次调用 ${toolName}，但似乎没有取得明显进展。\n` +
        `建议策略调整：\n` +
        `1. 停止重复使用 ${toolName}，尝试其他方法\n` +
        `2. ${alternatives}\n` +
        `3. 基于已有信息进行推理，给出带置信度的答案\n` +
        `4. 如果无法继续取得进展，调用 finish 给出最佳推断答案`
      );
    } else {
      return (
        `[System-Intervention] You have called ${toolName} ${count} consecutive times without making noticeable progress.\n` +
        `Suggested strategy adjustment:\n` +
        `1. Stop repeating ${toolName}, try a different approach\n` +
        `2. ${alternatives}\n` +
        `3. Reason based on the information you already have and provide an answer with confidence level\n` +
        `4. If you cannot make further progress, call finish with your best inference`
      );
    }
  }

  private getAlternatives(toolName: string): string {
    switch (toolName) {
      case "web_search":
      case "mcp__minimax_websearch__web_search":
        return this.lang === "zh"
          ? "尝试 browser 工具直接访问已知 URL，或使用不同的关键词策略"
          : "Try the browser tool to access a known URL directly, or use different keyword strategies";
      case "kb_search":
        return this.lang === "zh"
          ? "尝试 wiki_browse(listDocuments=true) 查看完整文档列表，或用 doc_grep 精确搜索"
          : "Try wiki_browse(listDocuments=true) to see the full document list, or use doc_grep for precise search";
      case "bash":
        return this.lang === "zh"
          ? "检查代码逻辑，考虑手动计算或换一种实现方式"
          : "Check your code logic, consider manual calculation or a different implementation approach";
      default:
        return this.lang === "zh"
          ? "换一种完全不同的方法来解决这个问题"
          : "Try a completely different approach to solve this problem";
    }
  }
}

// ---------------------------------------------------------------------------
// Background workflow completion formatter
// ---------------------------------------------------------------------------

function formatWorkflowCompletion(wf: import("./workflow-manager.js").ActiveWorkflow): string {
  const durationSec = wf.endTime
    ? Math.round((wf.endTime - wf.startTime) / 1000)
    : "unknown";

  if (wf.status === "failed") {
    return `[工作流失败通知] 目标: "${wf.goal}" | 状态: failed | 耗时: ${durationSec}s | 错误: ${wf.error ?? "未知错误"}`;
  }

  if (wf.status === "cancelled") {
    return `[工作流取消通知] 目标: "${wf.goal}" | 状态: cancelled | 耗时: ${durationSec}s`;
  }

  // Completed — include synthesis with structured agent summaries
  const result = wf.result;
  if (!result) {
    return `[工作流完成通知] 目标: "${wf.goal}" | 状态: completed | 耗时: ${durationSec}s | (无结果)`;
  }

  // Build per-agent summary using structured summary data (not raw output truncation)
  const agentSummary = result.agentResults
    .map((ar) => {
      if (ar.status === "failed") {
        return `- ✗ ${ar.role}: 失败 | 原因: ${ar.error ?? "未知错误"}`;
      }
      const parts: string[] = [];
      if (ar.summary?.finishSummary) {
        parts.push(ar.summary.finishSummary.substring(0, 500).replace(/\n/g, " "));
      } else if (ar.output) {
        parts.push(ar.output.substring(0, 300).replace(/\n/g, " "));
      }
      if (ar.summary?.keyFindings && ar.summary.keyFindings.length > 0) {
        parts.push(`关键发现: ${ar.summary.keyFindings.slice(0, 5).join("; ")}`);
      }
      if (ar.summary?.filesWritten && ar.summary.filesWritten.length > 0) {
        parts.push(`生成文件: ${ar.summary.filesWritten.join(", ")}`);
      }
      if (ar.resultFiles?.outputPath) {
        parts.push(`报告路径: ${ar.resultFiles.outputPath}`);
      }
      const detail = parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
      const warningTag = ar.warning ? ` ⚠️${ar.warning}` : "";
      return `- ✓ ${ar.role}: 完成${detail}${warningTag}`;
    })
    .join("\n");

  // Build closing guidance based on whether there are failed/flagged agents
  const hasFailures = result.agentResults.some(ar => ar.status === "failed");
  const hasFlagged = result.agentResults.some(ar =>
    ar.status === "completed" && ar.warning
  );
  const guidance = hasFailures || hasFlagged
    ? "处理要求：检查上方推送清单，✓（审核通过）的用 push_content 推送，⚠（失败或审核未通过）的不要推送，用 delegate_task 派发新子Agent补做。补做完成后再推送。全部推送完毕后调用 finish。"
    : "处理要求：检查上方推送清单，✓ 的文件用 push_content 逐一推送给用户。推送完毕后调用 finish。";

  // Use synthesis as-is — it already contains the push catalog and audit results
  return [
    `[工作流完成通知] 目标: "${wf.goal}" | 状态: ${result.status} | 耗时: ${durationSec}s | Agent数: ${result.agentResults.length}`,
    result.synthesis || "",
    agentSummary ? `各Agent结果详情:\n${agentSummary}` : "",
    guidance,
  ].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// L1: Embedded <think/> block stripping for models that emit reasoning in text
// ---------------------------------------------------------------------------

/**
 * Extract visible (non-thinking) text from a buffer that may contain <think/> tags.
 * Handles streaming chunks where tags may be split across chunks.
 *
 * @param buffer The accumulated text buffer
 * @param inside Whether we're currently inside a <think/> block
 * @returns visible text to emit, thinking content from inside tags, updated inside state, and remaining buffer
 */
function extractNonThinkingText(
  buffer: string,
  inside: boolean,
): { visible: string; thinking: string; inside: boolean; remaining: string } {
  let visible = "";
  let thinking = "";
  let pos = 0;
  const len = buffer.length;

  while (pos < len) {
    if (inside) {
      // Look for closing tag
      const closeIdx = buffer.indexOf("</think", pos);
      if (closeIdx === -1) {
        // Still inside think block — capture thinking content so far, keep buffering
        thinking += buffer.slice(pos);
        return { visible, thinking: "", inside: true, remaining: buffer.slice(pos) };
      }
      // Capture thinking content before the closing tag
      thinking += buffer.slice(pos, closeIdx);
      // Find the end of the closing tag
      const tagEnd = buffer.indexOf(">", closeIdx);
      if (tagEnd === -1) {
        // Partial closing tag, keep buffering
        return { visible, thinking: "", inside: true, remaining: buffer.slice(closeIdx) };
      }
      inside = false;
      pos = tagEnd + 1;
    } else {
      // Look for opening tag
      const openIdx = buffer.indexOf("<think", pos);
      if (openIdx === -1) {
        // No opening tag found — emit everything up to a safe point
        // Keep last 6 chars in case "<think" is split across chunks
        const safeEnd = Math.max(pos, len - 6);
        visible += buffer.slice(pos, safeEnd);
        return { visible, thinking, inside: false, remaining: buffer.slice(safeEnd) };
      }
      // Emit everything before the opening tag
      visible += buffer.slice(pos, openIdx);
      // Check if the opening tag is complete
      const tagEnd = buffer.indexOf(">", openIdx);
      if (tagEnd === -1) {
        // Partial opening tag, keep buffering from the tag start
        return { visible, thinking, inside: true, remaining: buffer.slice(openIdx) };
      }
      inside = true;
      pos = tagEnd + 1;
    }
  }

  return { visible, thinking, inside, remaining: "" };
}

// ---------------------------------------------------------------------------
// MCP search result compaction
// ---------------------------------------------------------------------------

const MAX_SEARCH_SNIPPET_CHARS = 500;

/**
 * Unwrap an MCP tool result from the MiniMax web search server into compact
 * flat text that mirrors the built-in web_search output format.
 *
 * Input (MCP envelope — what the server returns):
 *   { content: [{ type: "text", text: "{\"organic\":[...]}" }] }
 *
 * Output (compact text — what the LLM sees):
 *   [1] Title
 *       URL
 *       Snippet (capped at 500 chars)
 *
 * Returns null if the result cannot be parsed (non-search MCP results, errors, etc.).
 */
function compactMcpSearchResult(result: unknown): string | null {
  try {
    if (!result || typeof result !== "object") return null;
    const r = result as Record<string, unknown>;

    // MCP envelope: { content: [{ type: "text", text: "..." }] }
    const content = r.content;
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0] as Record<string, unknown>;
    if (first.type !== "text" || typeof first.text !== "string") return null;

    // Inner JSON: { organic: [{ title, link, snippet }] }
    const inner = JSON.parse(first.text);
    if (!inner || !Array.isArray(inner.organic)) return null;
    const organic = inner.organic as Array<Record<string, string>>;
    if (organic.length === 0) return null;

    // Format identically to built-in web_search: [N] Title\n    URL\n    Snippet
    const lines: string[] = [];
    for (let i = 0; i < organic.length; i++) {
      const item = organic[i];
      const title = item.title ?? "";
      const link = item.link ?? item.url ?? "";
      const rawSnippet = item.content ?? item.snippet ?? "";
      const snippet = rawSnippet.length > MAX_SEARCH_SNIPPET_CHARS
        ? rawSnippet.slice(0, MAX_SEARCH_SNIPPET_CHARS)
          + `\n    [... ${rawSnippet.length} chars total, showing first ${MAX_SEARCH_SNIPPET_CHARS}]`
        : rawSnippet;
      lines.push(`[${i + 1}] ${title}\n    ${link}\n    ${snippet}`);
    }
    return lines.join("\n\n");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-agent output routing helpers
// ---------------------------------------------------------------------------

/**
 * Wrap the parent's onEvent callback for sub-agent execution.
 * Filters text_delta and complete events so sub-agent text doesn't stream
 * directly to the frontend SSE. Keeps tool_call/tool_result/turn for progress.
 */
function wrapSubAgentOnEvent(
  parentOnEvent: ((event: import("./types.js").AgentEvent) => void) | undefined,
  _skillName: string,
): ((event: import("./types.js").AgentEvent) => void) | undefined {
  if (!parentOnEvent) return undefined;
  return (event: import("./types.js").AgentEvent) => {
    // Sub-agent streaming text does NOT go to the frontend
    if (event.type === "text_delta") return;
    // Sub-agent complete event is replaced by the parent's tool_result
    if (event.type === "complete") return;
    // Keep tool_call, tool_result, turn, error, compaction etc. for progress display
    parentOnEvent(event);
  };
}

/**
 * Save sub-agent's full output to a file for parent to read on demand.
 * Returns the relative path from dataDir, or null on failure.
 */
function saveSubAgentOutput(
  dataDir: string,
  sessionId: string,
  source: string,
  output: string,
): string | null {
  try {
    const safeName = source.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = getSessionSubagentsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const prefixedName = makeAgentFilename("sub", `${safeName}.md`);
    const filePath = join(dir, prefixedName);
    writeFileSync(filePath, output, "utf-8");
    return filePath.replace(dataDir + "/", "").replace(/\\/g, "/");
  } catch {
    return null;
  }
}

/**
 * Build adaptive sub-agent result based on what the sub-agent actually did.
 *
 * Strategy:
 * - Has finish summary → summary is primary content, full output saved to file if much larger
 * - Has files written → include file path list
 * - No summary, no files → return full output directly (it must be short)
 */
function buildSubAgentResult(
  skillName: string,
  skillResult: import("./types.js").AgentResult,
  mode: "fork" | "sub_agent",
  dataDir?: string,
  sessionId?: string,
): Record<string, unknown> {
  const fullOutput = skillResult.output || "";
  const finishSummary = skillResult.finishSummary;
  const filesWritten = skillResult.filesWritten || [];

  // Sub-agent wrote a finish summary — this is the primary content for the parent
  if (finishSummary && finishSummary.length > 20) {
    let output = finishSummary;

    // Attach file paths if sub-agent wrote files
    if (filesWritten.length > 0) {
      output += `\n\n生成的文件:\n${filesWritten.map(f => `- ${f}`).join("\n")}`;
    }

    // If the full output is significantly larger than the summary,
    // save it to a file for the parent to read on demand
    if (fullOutput.length > finishSummary.length * 3 && fullOutput.length > 2000 && dataDir && sessionId) {
      const filePath = saveSubAgentOutput(dataDir, sessionId, skillName, fullOutput);
      if (filePath) {
        output += `\n\n完整输出已保存: ${filePath}`;
      }
    }

    return {
      skillName,
      output,
      turnsUsed: skillResult.turnsUsed,
      toolCallsCount: skillResult.toolCallsCount,
      mode,
      finishSummary,
      filesWritten: filesWritten.length > 0 ? filesWritten : undefined,
    };
  }

  // No summary — return the full output directly.
  // If the sub-agent didn't write a summary, the output is probably short/direct.
  // But if it's very large and there are files, still save to file for efficiency.
  if (fullOutput.length > 8000 && dataDir && sessionId) {
    const filePath = saveSubAgentOutput(dataDir, sessionId, skillName, fullOutput);
    if (filePath) {
      let output = fullOutput.slice(0, 3000) + "\n\n[...输出较长，已保存到文件]";
      if (filesWritten.length > 0) {
        output += `\n\n生成的文件:\n${filesWritten.map(f => `- ${f}`).join("\n")}`;
      }
      output += `\n完整输出已保存: ${filePath}`;
      return {
        skillName,
        output,
        turnsUsed: skillResult.turnsUsed,
        toolCallsCount: skillResult.toolCallsCount,
        mode,
        filesWritten: filesWritten.length > 0 ? filesWritten : undefined,
      };
    }
  }

  // Short output, no summary — return directly (most common for simple search/QA tasks)
  return {
    skillName,
    output: fullOutput,
    turnsUsed: skillResult.turnsUsed,
    toolCallsCount: skillResult.toolCallsCount,
    mode,
    filesWritten: filesWritten.length > 0 ? filesWritten : undefined,
  };
}

// ---------------------------------------------------------------------------
// Per-run isolated state
// ---------------------------------------------------------------------------

/** Mutable state that is isolated per-run via Map<taskId, RunState>.
 *  Created at the start of each run() call, cleaned up in the finally block.
 *  This ensures concurrent runner.run() calls (e.g., from executeParallel) don't
 *  corrupt each other's state. */
interface RunState {
  /** Tool names blocked for this agent (sub-agents cannot call push_content/workflow_run). */
  blockedTools: ReadonlySet<string> | null;
  /** JSONL writer for lossless session persistence. */
  jsonlWriter: JsonlWriter | undefined;
  jsonlSessionId: string | undefined;
  jsonlTaskId: string | undefined;
  /** Token budget state machine. */
  budgetState: BudgetState;
  /** Prompt cache break detector. */
  promptCacheDetector: PromptCacheDetector;
  /** ToolRegistry execution context (signal, sessionId, etc.) isolated per-run. */
  executionContext: Record<string, unknown>;
  /** Per-task pushed content deduplication. Replaces shared _pushedContentKeys. */
  pushedContentKeys: Set<string>;
  /** Per-task file read tracking for edit_file enforcement. Replaces shared _readFilesThisSession. */
  readFilesTracker: Set<string>;
  /** Session ID for this run (used for cross-task push dedup). */
  sessionId: string | undefined;
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/** Entry tracking a successful push within a session. Used for cross-task dedup
 *  and exposed to the Agent (via list_pushed_content tool) so it can query what
 *  has already been delivered to the frontend. */
export interface SessionPushedEntry {
  /** MD5 hash of the pushed content (file bytes or data string). */
  hash: string;
  /** Tool that performed the push. */
  toolName: "push_file" | "push_content";
  /** Title from the tool input. */
  title: string;
  /** ISO timestamp of the push. */
  timestamp: string;
  /** File name (for push_file / filePath-based push_content). */
  fileName?: string;
  /** File size in bytes (for push_file / filePath-based push_content). */
  fileSize?: number;
  /** MIME type (for push_file). */
  mimeType?: string;
}

export class AgentRunner {
  private modelRouter: ModelRouter;
  private toolRegistry: ToolRegistry;
  private agentDefinitions = new Map<string, AgentDefinition>();
  private displayResolver: DisplayResolver | null = null;
  private hookManager: HookManager | null = null;
  private tokenEstimator = new TokenEstimator();

  // -----------------------------------------------------------------------
  // Per-run isolated state (safe for concurrent run() calls)
  // -----------------------------------------------------------------------

  /** Per-run state indexed by taskId. Created in run(), cleaned up in finally.
   *  Isolates mutable fields so concurrent runner.run() calls don't corrupt each other. */
  private _runStates = new Map<string, RunState>();

  /** Session-level push dedup: maps sessionId → list of pushed entries (with MD5 + metadata).
   *  Persists across tasks within the same session, preventing the same file from
   *  being pushed again in a later turn. Bounded per session to prevent leaks.
   *  Also exposed to push tools (via execution context) and list_pushed_content tool
   *  so the Agent can query what has already been pushed. */
  private _sessionPushedEntries = new Map<string, SessionPushedEntry[]>();
  private static readonly MAX_SESSION_PUSHED_ENTRIES = 500;

  /** Get (or create) the session-level pushed-entries list. */
  private getSessionPushedEntries(sessionId: string | undefined): SessionPushedEntry[] | null {
    if (!sessionId) return null;
    let list = this._sessionPushedEntries.get(sessionId);
    if (!list) {
      list = [];
      this._sessionPushedEntries.set(sessionId, list);
    }
    return list;
  }

  /** Public accessor for tools (list_pushed_content) to query pushed items. */
  public getSessionPushedHistory(sessionId?: string): SessionPushedEntry[] {
    if (!sessionId) return [];
    return this._sessionPushedEntries.get(sessionId) ?? [];
  }

  /** Compute MD5 hash of a file's content for push deduplication.
   *  Resolves relative paths against dataDir (matching push_content tool behavior)
   *  so that dedup works even when the agent passes a relative filePath. */
  private async hashFilePath(filePath: string, sessionId?: string): Promise<string | null> {
    try {
      const resolved = await this.resolvePushFilePath(filePath, sessionId);
      const buf = await readFile(resolved);
      return createHash("md5").update(buf).digest("hex");
    } catch {
      return null;
    }
  }

  /** Resolve a push filePath the same way push_content tool does.
   *  This ensures dedup hashing reads the same file the tool will push. */
  private async resolvePushFilePath(filePath: string, sessionId?: string): Promise<string> {
    if (isAbsolute(filePath)) return filePath;
    // Strip leading "data/" if present — same normalization as push_content tool
    const normalized = filePath.startsWith("data/") || filePath.startsWith("data\\")
      ? filePath.slice(5)
      : filePath;
    // Try direct resolution against dataDir
    const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
    const dataDir = DEEPANALYZE_CONFIG.dataDir as string;
    const resolved = resolve(dataDir, normalized);
    if (existsSync(resolved)) return resolved;
    // Fallback: session output directory fuzzy matching (write_file may have remapped the name)
    if (sessionId && !isSharedDataPath(normalized)) {
      const sessionPath = resolveSessionOutputPath(normalized, dataDir, sessionId);
      if (sessionPath !== resolved && existsSync(sessionPath)) {
        return sessionPath;
      }
    }
    return resolved; // Return best-effort path even if it doesn't exist (will fail in hashFilePath)
  }

  /** Compute MD5 hash of a string for push deduplication. */
  private hashString(s: string): string {
    return createHash("md5").update(s, "utf8").digest("hex");
  }

  /** Get the RunState for a given taskId. Throws if not found (should never happen). */
  private getRunState(taskId: string): RunState {
    const state = this._runStates.get(taskId);
    if (!state) throw new Error(`[AgentRunner] RunState not found for taskId=${taskId}`);
    return state;
  }

  constructor(modelRouter: ModelRouter, toolRegistry: ToolRegistry, hookManager?: HookManager) {
    this.modelRouter = modelRouter;
    this.toolRegistry = toolRegistry;
    if (hookManager) this.hookManager = hookManager;
    this.registerAgent(DEFAULT_AGENT_DEFINITION);
  }

  /** Set or replace the hook manager. */
  setHookManager(hookManager: HookManager): void {
    this.hookManager = hookManager;
  }

  /** Get the current hook manager (if any). */
  getHookManager(): HookManager | null {
    return this.hookManager;
  }

  // -----------------------------------------------------------------------
  // Agent definition management
  // -----------------------------------------------------------------------

  registerAgent(definition: AgentDefinition): void {
    this.agentDefinitions.set(definition.agentType, definition);
  }

  registerAgents(definitions: AgentDefinition[]): void {
    for (const definition of definitions) {
      this.agentDefinitions.set(definition.agentType, definition);
    }
  }

  getAgentDefinition(agentType: string): AgentDefinition | undefined {
    return this.agentDefinitions.get(agentType);
  }

  getAgentTypes(): string[] {
    return Array.from(this.agentDefinitions.keys());
  }

  // -----------------------------------------------------------------------
  // Generator-based execution (feature-flag gated)
  // -----------------------------------------------------------------------

  /**
   * Async generator version of run().
   * Yields AgentEvent objects as they occur, then returns AgentResult.
   *
   * This is an adapter over run() — no core logic is duplicated.
   * Controlled by DA_GENERATOR_RUN=true environment variable.
   *
   * Usage:
   *   const gen = runner.runGenerator(options);
   *   for await (const event of gen) {
   *     // handle event
   *   }
   *   const result = gen.return(); // or it's returned when the generator completes
   */
  async *runGenerator(options: AgentRunOptions): AsyncGenerator<AgentEvent, AgentResult> {
    type EventQueueEntry = { event: AgentEvent } | { done: AgentResult } | { error: unknown };

    const queue: EventQueueEntry[] = [];
    let resolveNext: ((entry: EventQueueEntry) => void) | null = null;

    const enqueue = (entry: EventQueueEntry) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(entry);
      } else {
        queue.push(entry);
      }
    };

    const getNext = (): Promise<EventQueueEntry> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise<EventQueueEntry>((r) => { resolveNext = r; });
    };

    // Wire up the onEvent callback to push into the queue
    const originalOnEvent = options.onEvent;
    const generatorOnEvent = (event: AgentEvent) => {
      enqueue({ event });
      // Also call the original callback if provided (e.g., for orchestrator bookkeeping)
      if (originalOnEvent) {
        try { originalOnEvent(event); } catch { /* swallow */ }
      }
    };

    // Start run() in the background
    const runPromise = this.run({ ...options, onEvent: generatorOnEvent })
      .then((result) => {
        enqueue({ done: result });
      })
      .catch((err) => {
        enqueue({ error: err });
      });

    try {
      // Yield events as they arrive
      while (true) {
        const entry = await getNext();

        if ("event" in entry) {
          yield entry.event;
        } else if ("done" in entry) {
          return entry.done;
        } else if ("error" in entry) {
          throw entry.error;
        }
      }
    } finally {
      // If the generator is abandoned (consumer stopped iterating),
      // ensure the run() promise doesn't leak.
      // The run() itself handles cleanup via AbortSignal if configured.
    }
  }

  // -----------------------------------------------------------------------
  // Main execution loop
  // -----------------------------------------------------------------------

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const taskId = options.taskId ?? randomUUID();
    const agentType = options.agentType ?? "general";

    // Create isolated per-run state. Each concurrent run() gets its own RunState
    // indexed by taskId, so parallel sub-agents don't corrupt each other.
    this._runStates.set(taskId, {
      blockedTools: null,
      jsonlWriter: undefined,
      jsonlSessionId: undefined,
      jsonlTaskId: undefined,
      budgetState: "normal",
      promptCacheDetector: new PromptCacheDetector(),
      executionContext: {},
      pushedContentKeys: new Set<string>(),
      readFilesTracker: new Set<string>(),
      sessionId: options.sessionId,
    });

    let definition = this.agentDefinitions.get(agentType);
    if (!definition) {
      definition = DEFAULT_AGENT_DEFINITION;
    }

    try {
    return await this._runImpl(options, taskId, agentType, definition!);
    } finally {
      // Clean up per-run state to prevent memory leaks
      this._runStates.delete(taskId);
    }
  }

  private async _runImpl(
    options: AgentRunOptions,
    taskId: string,
    agentType: string,
    definition: AgentDefinition,
  ): Promise<AgentResult> {
    // Get per-run isolated state (created in run(), cleaned up in finally)
    const rs = this.getRunState(taskId);

    // Load agent settings from DB
    let agentSettings;
    try {
      const repos = await getRepos();
      const raw = await repos.settings.get("agent_settings");
      agentSettings = raw ? JSON.parse(raw) : {};
      // Merge with defaults
      agentSettings = { ...DEFAULT_AGENT_SETTINGS, ...agentSettings };
    } catch (err) {
      console.error("[AgentRunner] Failed to load agent settings:", err instanceof Error ? err.message : String(err));
      throw err;
    }

    // Resolve feature flags (env var > DB config > defaults)
    const featureFlags = resolveFeatureFlags({
      concurrentToolExecution: agentSettings.concurrentToolExecution,
      promptCaching: agentSettings.promptCaching,
      cacheEditing: agentSettings.cacheEditing,
      streamingToolExecution: agentSettings.streamingToolExecution,
      hierarchicalCompression: agentSettings.hierarchicalCompression,
      longOutputContinuation: agentSettings.longOutputContinuation,
    });

    // Resolve effective turn limit (API override > settings > definition > dynamic estimation > default)
    // R4.6: Adaptive turn management — estimate min turns, use ProgressTracker for adaptive extension
    let advisoryLimit = options.maxTurns ?? definition.maxTurns ?? agentSettings.maxTurns;
    let minTurns: number;
    if (advisoryLimit === -1) {
      // No explicit limit configured — use dynamic task complexity estimation
      const complexity = estimateTaskComplexity(options.input, agentType);
      minTurns = complexityToMinTurns(complexity);
      advisoryLimit = minTurns;
      console.log(`[AgentRunner] R4.6: Adaptive turn budget: complexity=${complexity}, minTurns=${minTurns}`);
    } else {
      minTurns = advisoryLimit;
    }
    const progressTracker = createProgressTracker(minTurns);
    const isUnlimited = false; // R4.6: Adaptive budget always provides a finite limit
    const hardLimit = Math.max(Math.ceil(advisoryLimit * 2), 200);

    // C3.4: Resolve output token budget (definition > settings > model registry > default)
    // Analysis/report agents need more output space; simple Q&A needs less
    let outputTokenBudget = definition.outputTokenBudget ?? agentSettings.outputTokenBudget ?? 16_384;

    // --- Main/Sub model split ---
    // Primary agents (general, report) use 'main' model
    // Sub agents (explore, compile, verify, coordinator) use 'summarizer' model
    const effectiveAgentType = options.agentType ?? definition.agentType ?? "general";
    const SUB_AGENT_TYPES = new Set(["explore", "compile", "verify", "coordinator"]);
    const isSubAgent = SUB_AGENT_TYPES.has(effectiveAgentType);
    const modelRole = options.modelRole ?? definition.modelRole ?? (isSubAgent ? "summarizer" : "main");
    const fallbackRole: ModelRole = modelRole === "main" ? "summarizer" : "main";
    let usingFallback = false;

    let modelId: string;
    try {
      // Ensure the router has the latest provider config before resolving
      // the default model — otherwise we may use a stale model ID.
      await this.modelRouter.ensureCurrent();
      modelId = this.modelRouter.getDefaultModel(modelRole);
    } catch (err) {
      console.error(`[AgentRunner] Failed to resolve default model for role "${modelRole}":`, err instanceof Error ? err.message : String(err));
      console.error(`[AgentRouter] Available providers: ${this.modelRouter.listProviderNames().join(", ")}`);
      throw err;
    }
    // Enrich output budget from model registry: use model's max output as upper bound
    {
      const { getMaxOutputTokensForModel } = await import("../../models/provider-registry.js");
      const maxOutput = getMaxOutputTokensForModel(modelId);
      if (maxOutput && outputTokenBudget < maxOutput) {
        outputTokenBudget = maxOutput;
      }
    }
    // Use SystemPromptBuilder for static/dynamic separation (prompt caching optimization)
    const promptBuilder = new SystemPromptBuilder();

    if (options.systemPromptOverride && options.isSkillInvocation && definition.systemPrompt) {
      // Skill invocation: merge base prompt (cacheable) with skill guidance.
      // Skills augment the agent's capabilities — they should not replace the base
      // system prompt which contains tool usage patterns, anti-hallucination rules,
      // and output format guidance essential for correct tool usage.
      // skill-guidance is per-invocation stable (built once, reused across turns)
      // → goes into static prefix for cache_control coverage.
      promptBuilder.addCachedStaticSection("agent-definition", () => definition.systemPrompt);
      promptBuilder.addStaticSection("skill-guidance",
        `# 技能指导（Skill Guidance）\n\n以下是当前激活的技能提供的专门指导，在上述通用能力基础上遵循：\n\n${options.systemPromptOverride}`,
      );
    } else {
      // Non-skill invocations (sub-agents, workflows): use override or base prompt
      const effectiveSystemPrompt = options.systemPromptOverride ?? definition.systemPrompt;
      promptBuilder.addCachedStaticSection("agent-definition", () => effectiveSystemPrompt);
    }

    // Inject scope constraints into system prompt if scope is provided.
    // Note: scope / kb-filesystem / project-config / session-memory / skills /
    // agent-memory are all built ONCE before the LLM loop and remain stable
    // across all turns within this run. They go into the static prefix so
    // cache_control covers them — this gives ~99% cache hit on turn 2+
    // instead of reprocessing 5KB+ of context each turn.
    let scopeInjection = "";
    let scopeKbIds: string[] = [];
    if (options.scope) {
      // Support two scope formats:
      // 1. Frontend: { knowledgeBases: [{ kbId, mode, documentIds? }], webSearch }
      // 2. API: { kbIds: ["id1", "id2"] }
      let docDetails: string[] = [];

      const knowledgeBases = options.scope.knowledgeBases as Array<{ kbId: string; mode: string; documentIds?: string[] }> | undefined;
      const simpleKbIds = options.scope.kbIds as string[] | undefined;

      if (knowledgeBases && knowledgeBases.length > 0) {
        scopeKbIds = knowledgeBases.map(kb => kb.kbId);
      } else if (simpleKbIds && simpleKbIds.length > 0) {
        scopeKbIds = simpleKbIds;
      }

      if (scopeKbIds.length > 0) {
        try {
          const repos = await getRepos();
          const allKbs = await repos.knowledgeBase.list();
          const kbDetails: string[] = [];

          if (knowledgeBases) {
            for (const kbScope of knowledgeBases) {
              const kb = allKbs.find(k => k.id === kbScope.kbId);
              const kbLabel = kb ? `"${kb.name}"` : kbScope.kbId;
              kbDetails.push(`${kbLabel} (${kbScope.kbId})`);

              if (kbScope.mode === "selected" && kbScope.documentIds && kbScope.documentIds.length > 0) {
                try {
                  const docs = await repos.document.getByKbId(kbScope.kbId);
                  const selectedDocs = docs.filter(d => kbScope.documentIds!.includes(d.id));
                  for (const doc of selectedDocs) {
                    docDetails.push(`- ${doc.filename || doc.id} (${doc.id}) in ${kbLabel}`);
                  }
                } catch {
                  // Non-critical
                }
              }
            }
          } else {
            // Simple kbIds format - resolve names
            for (const kbId of scopeKbIds) {
              const kb = allKbs.find(k => k.id === kbId);
              kbDetails.push(kb ? `"${kb.name}" (${kbId})` : kbId);
            }
          }

          const kbNames = kbDetails.join(", ");
          let injection = `\n\n## 搜索范围限制\n当前对话限定了搜索范围。你只能在以下知识库中搜索：${kbNames}。\n使用 kb_search 和 doc_grep 工具时，务必将 kbIds 参数设为 [${scopeKbIds.map(id => `"${id}"`).join(", ")}]。\n使用 wiki_browse 工具时，只使用上述知识库的 kbId。\n使用 run_sql 查询时，务必在 WHERE 条件中限定 kb_id IN (${scopeKbIds.map(id => `'${id}'`).join(", ")})。\n不要搜索此范围之外的知识库。`;

          if (docDetails.length > 0) {
            injection += `\n\n用户特别关注以下文档，请优先分析：\n${docDetails.join("\n")}`;
          }

          scopeInjection = injection;
        } catch {
          scopeInjection = `\n\n## 搜索范围限制\n当前对话限定了搜索范围。使用 kb_search 和 doc_grep 时将 kbIds 设为 [${scopeKbIds.map(id => `"${id}"`).join(", ")}]，使用 run_sql 时限定 kb_id IN (${scopeKbIds.map(id => `'${id}'`).join(", ")})。\n不要搜索此范围之外的知识库。`;
        }
      }
    }
    if (scopeInjection) {
      promptBuilder.addStaticSection("scope", scopeInjection);
    }

    // Inject KB filesystem info if scoped KBs are available
    if (scopeKbIds.length > 0) {
      try {
        const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
        const { buildKbFilesystemSection } = await import("../../wiki/manifest.js");
        const fsSection = await buildKbFilesystemSection(scopeKbIds, DEEPANALYZE_CONFIG.dataDir);
        if (fsSection) {
          promptBuilder.addStaticSection("kb-filesystem", fsSection);
        }
      } catch {
        // Non-critical: filesystem section is optional guidance
      }
    }

    // Load .deepanalyze.md project config
    try {
      const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
      const mdPath = join(DEEPANALYZE_CONFIG.dataDir, ".deepanalyze.md");
      const md = await readFile(mdPath, "utf-8");
      if (md.trim()) {
        promptBuilder.addStaticSection("project-config", "## 项目配置\n" + md.trim());
      }
    } catch {
      // File does not exist — normal, skip
    }

    // Initialize SessionMemory early so we can include it in the built prompt
    let sessionMemory: SessionMemoryManager | null = null;
    let loadedMemory: SessionMemoryNote | null = null;
    if (options.sessionId) {
      sessionMemory = new SessionMemoryManager(this.modelRouter, options.sessionId, agentSettings);
      loadedMemory = await sessionMemory.load();
      if (loadedMemory) {
        promptBuilder.addStaticSection("session-memory", sessionMemory.buildPromptInjection(loadedMemory));
      }
    }

    // Inject available skills list as a dynamic section
    try {
      const repos = await getRepos();
      const allSkills = await repos.agentSkill.listActive();
      if (allSkills.length > 0) {
        // Deduplicate by name: keep highest-priority source per skill name
        const sourcePriority: Record<string, number> = { builtin: 0, hub: 1, plugin: 2, manual: 3 };
        const deduped = new Map<string, typeof allSkills[number]>();
        for (const skill of allSkills) {
          const existing = deduped.get(skill.name);
          if (!existing || (sourcePriority[skill.source] ?? 99) < (sourcePriority[existing.source] ?? 99)) {
            deduped.set(skill.name, skill);
          }
        }
        // Quality gate: skip skills with empty or too-short descriptions
        const visibleSkills = [...deduped.values()]
          .filter(s => s.description && s.description.trim().length >= 10);

        // Budget control: cap skill listing at ~6000 chars to avoid bloating the prompt
        const MAX_SKILL_BUDGET = 6000;
        const skillLines: string[] = [];
        let budgetUsed = 0;
        for (const s of visibleSkills) {
          const isHighCost = s.description.startsWith("[高成本/按需触发]");
          const prefix = isHighCost ? "🔴 " : "";
          const line = `${prefix}${s.name}: ${s.description}`;
          if (budgetUsed + line.length + 1 > MAX_SKILL_BUDGET && skillLines.length > 0) {
            skillLines.push(`... (其余 ${visibleSkills.length - skillLines.length} 个技能省略，用 list_skills 查看)`);
            break;
          }
          skillLines.push(line);
          budgetUsed += line.length + 1;
        }

        if (skillLines.length > 0) {
          promptBuilder.addStaticSection("available-skills", [
            "",
            "<available-skills>",
            "以下技能可用。当技能匹配用户请求时，使用 skill_invoke 调用：",
            skillLines.join("\n"),
            "",
            "⚠️ 标记为 🔴 的高成本技能运行时间长、资源消耗极大，仅在用户明确要求时才可调用。",
            "如果用户只是搜索、分析、总结等普通需求，绝对不要调用高成本技能。",
            "</available-skills>",
            "",
          ].join("\n"));
        }
      }
    } catch { /* non-critical: skills list injection best-effort */ }

    // Inject agent memory (self-evolution persistent experience) as dynamic section
    try {
      const evolutionCfg = getCachedEvolutionConfig();
      if (evolutionCfg?.enabled && evolutionCfg.modules.persistentMemory) {
        const repos = await getRepos();
        const budget = evolutionCfg.params.memoryBudget ?? 8000;
        const memories = await repos.agentMemory.list({ limit: 50 });
        if (memories.length > 0) {
          const memoryLines = memories.map(m =>
            `[${m.category}] ${m.content}`
          ).join("\n");
          promptBuilder.addStaticSection("agent-memory", [
            "",
            "<agent-memory>",
            "以下是从过往工作中积累的经验笔记，供你参考和借鉴：",
            memoryLines,
            "</agent-memory>",
            "",
          ].join("\n"));
          // Bump use count for telemetry (fire-and-forget)
          repos.agentMemory.bumpUse(memories.map(m => m.id)).catch(() => {});
        }
      }
    } catch { /* non-critical: agent memory injection best-effort */ }

    // Inject context self-management guidance when working with knowledge bases
    if (scopeKbIds.length > 0) {
      promptBuilder.addStaticSection("context-self-management", [
        "",
        "<context-self-management>",
        "## 上下文自我管理提示",
        "你的上下文窗口有限（约 200K token）。处理大量文档时，以下策略有助于保持工作质量：",
        "",
        "- **按需加载**：根据当前分析需要 expand 文档，避免一次展开过多文档导致上下文溢出",
        "- **即时保存**：分析结果及时用 write_file 保存，不依赖上下文长期持有已分析内容",
        "- **可回读可编辑**：已保存的内容可随时用 read_file 回读、用 edit_file 修订",
        "- **大规模任务可渐进**：文档较多时，可按章节/维度分步推进，每步 expand 相关文档 → 分析 → 保存",
        "",
        "以上是建议而非强制要求。简单任务直接处理即可，复杂任务灵活运用。",
        "</context-self-management>",
        "",
      ].join("\n"));
    }

    const builtPrompt = promptBuilder.build();
    const systemPromptWithScope = builtPrompt.full;

    console.log(`[AgentRunner] Starting agent run: taskId=${taskId}, agentType=${agentType}, modelRole=${modelRole}, modelId=${modelId}, providers=${this.modelRouter.listProviderNames().join(",")}`);

    // Detect language from user input for bilingual intervention messages
    const detectedLang = detectLanguage(options.input);

    // Resolve media attachments if present
    let mediaRefs: Array<{ mediaId: string; mimeType: string; fileName: string; size: number; dataUri: string }> = [];
    let nonMediaFileDescs: string[] = [];
    let inlineFileTexts: string[] = [];
    if (options.sessionId && options.mediaIds && options.mediaIds.length > 0) {
      const { DEEPANALYZE_CONFIG: _mediaConfig } = await import("../../core/config.js");
      const { MediaStore } = await import("../session/media-store.js");
      for (const mediaId of options.mediaIds) {
        const meta = await MediaStore.getMeta(_mediaConfig.dataDir, options.sessionId, mediaId);
        if (!meta) continue;

        const isMedia = meta.mimeType.startsWith("image/") || meta.mimeType.startsWith("video/") || meta.mimeType.startsWith("audio/");
        if (isMedia) {
          const dataUri = await MediaStore.toDataUri(_mediaConfig.dataDir, options.sessionId, mediaId);
          if (dataUri) {
            mediaRefs.push({ mediaId, mimeType: meta.mimeType, fileName: meta.fileName, size: meta.size, dataUri });
          }
        } else {
          // Non-media file: try lightweight parse for inline text injection
          const sizeStr = meta.size >= 1_000_000
            ? `${(meta.size / 1_000_000).toFixed(1)} MB`
            : `${(meta.size / 1_000).toFixed(1)} KB`;
          const originalPath = MediaStore.getOriginalPath(_mediaConfig.dataDir, options.sessionId, mediaId);
          let inlineText: string | null = null;

          if (originalPath) {
            try {
              const ext = meta.fileName.split(".").pop()?.toLowerCase() ?? "";

              // For plain-text file types, read directly instead of going through
              // the heavy ProcessorFactory pipeline (which routes through Docling subprocess).
              const PLAIN_TEXT_EXTS = new Set(["txt", "md", "markdown", "json", "xml", "yaml", "yml", "csv", "html", "htm", "log", "ini", "cfg", "env"]);
              let parseResult: { text: string; success: boolean } | null = null;

              if (PLAIN_TEXT_EXTS.has(ext)) {
                const { readFileSync: _readFileSync } = await import("fs");
                const text = _readFileSync(originalPath, "utf-8");
                parseResult = { text, success: true };
              } else if (ext === "pdf") {
                // PDF fast path: use pdf-parse (<1s) instead of Docling (10-30s)
                const { readFileSync: _readFileSync } = await import("fs");
                const { extractPdfText } = await import("./tools/pdf-reader.js");
                const buffer = _readFileSync(originalPath);
                const pdfText = await extractPdfText(buffer);
                if (pdfText && pdfText.trim().length > 0) {
                  parseResult = { text: pdfText, success: true };
                }
              } else {
                // Other binary formats (docx, xlsx, etc.) — use ProcessorFactory with timeout
                const { ProcessorFactory } = await import("../document-processors/processor-factory.js");
                const factory = ProcessorFactory.getInstance();
                const PARSE_TIMEOUT_MS = 30000;
                let timedOut = false;
                parseResult = await Promise.race([
                  factory.parseWithFallback(originalPath, ext),
                  new Promise<null>(resolve => {
                    setTimeout(() => { timedOut = true; resolve(null); }, PARSE_TIMEOUT_MS);
                  }),
                ]);
                if (timedOut && !parseResult) {
                  console.warn(`[AgentRunner] Inline parse timed out (${PARSE_TIMEOUT_MS}ms) for ${meta.fileName}, falling back to text description`);
                }
              }

              if (parseResult && parseResult.success && parseResult.text?.trim()) {
                const MAX_INLINE_CHARS = 50000;
                const text = parseResult.text.length > MAX_INLINE_CHARS
                  ? parseResult.text.substring(0, MAX_INLINE_CHARS)
                    + `\n\n[...文件内容已截断（原文 ${parseResult.text.length} 字符），完整内容将通过知识库处理后可用...]`
                  : parseResult.text;
                inlineText = `[用户上传文件: ${meta.fileName} (${meta.mimeType}, ${sizeStr})]\n`
                  + `--- 文件内容 ---\n${text}\n--- 文件内容结束 ---`;
              }
            } catch {
              // Parse failed — fall through to text description
            }
          }

          if (inlineText) {
            inlineFileTexts.push(inlineText);
          } else {
            nonMediaFileDescs.push(
              `[用户上传文件: ${meta.fileName} (${meta.mimeType}, ${sizeStr})]\n` +
              `文件路径: ${originalPath ?? `(mediaId: ${mediaId})`}\n可通过 bash 或 read_file 读取处理。`
            );
          }
        }
      }
    }

    // Build initial messages
    // Prepend inline file contents and fallback descriptions to the user input
    let effectiveInput = options.input;
    const allFileDescs = [...inlineFileTexts, ...nonMediaFileDescs];
    if (allFileDescs.length > 0) {
      effectiveInput = allFileDescs.join("\n\n") + "\n\n" + options.input;
    }
    const messages = await this.buildMessages(
      systemPromptWithScope,
      effectiveInput,
      options.contextMessages,
      detectedLang,
      mediaRefs,
      modelId,
    );

    // Inject cache breakpoints for prompt caching optimization
    // NOTE: When contextCollapse is enabled, breakpoints are applied at projection time
    // (in the projection pipeline at the API call point), not here.
    if (featureFlags.promptCaching && !featureFlags.contextCollapse) {
      const marked = markCacheBreakpoints(messages);
      messages.length = 0;
      messages.push(...marked);
    }

    // Initialize CollapseStore for context collapse (non-destructive projection)
    const collapseStore = featureFlags.contextCollapse
      ? new CollapseStore(messages)
      : null;

    const effectiveTools = options.toolsOverride ?? definition.tools;
    // Apply recursive guard: block management tools for sub-agents (skill/workflow spawned)
    // Skill invocations are exempt — they need workflow_run to dispatch parallel analysis.
    const needsRecursiveGuard = !options.isSkillInvocation && !!(options.systemPromptOverride || options.toolsOverride);
    const filteredTools = needsRecursiveGuard
      ? effectiveTools.filter(t => !SUB_AGENT_BLOCKED_TOOLS.has(t))
      : effectiveTools;
    let toolDefs;
    try {
      toolDefs = this.toolRegistry.buildToolDefinitions(filteredTools);
      // Post-filter: remove blocked tools that survived wildcard expansion
      if (needsRecursiveGuard) {
        const before = toolDefs.length;
        const blocked = toolDefs.filter(td => SUB_AGENT_BLOCKED_TOOLS.has(td.name)).map(td => td.name);
        toolDefs = toolDefs.filter(td => !SUB_AGENT_BLOCKED_TOOLS.has(td.name));
        if (blocked.length > 0) {
          console.log(`[AgentRunner] Post-filter removed ${blocked.length} blocked tools: [${blocked.join(", ")}] (${before} → ${toolDefs.length})`);
        }
        // Store blocked set for runtime enforcement in executeToolCall
        this.getRunState(taskId).blockedTools = SUB_AGENT_BLOCKED_TOOLS;
      } else {
        this.getRunState(taskId).blockedTools = null;
      }
      // Filter out context_expand if contextCollapse is not enabled
      if (!featureFlags.contextCollapse) {
        toolDefs = toolDefs.filter(d => d.name !== "context_expand");
      }
    } catch (err) {
      console.error("[AgentRunner] Failed to build tool definitions:", err instanceof Error ? err.message : String(err));
      throw err;
    }
    console.log(`[AgentRunner] Built ${toolDefs.length} tool definitions, starting LLM loop...`);

    // Sort tool definitions alphabetically by name for cache stability
    toolDefs.sort((a, b) => a.name.localeCompare(b.name));

    // Log if this is a workflow sub-agent run (for tracing)
    const isWorkflowSubAgent = !!(options.systemPromptOverride || options.toolsOverride);
    if (isWorkflowSubAgent) {
      console.log(`[AgentRunner] Sub-agent detected: taskId=${taskId}, tools=${toolDefs.length} (${filteredTools.length} names), maxTurns=${options.maxTurns ?? "default"}, isSkill=${!!options.isSkillInvocation}`);
    }

    // Track execution state
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const costTracker = new CostTracker(modelId);
    let lastAssistantContent = "";
    let accumulatedContent = "";  // Accumulates all meaningful content across turns
    let hadInjectedMessages = false; // Tracks if ANY injected messages were processed this run
    let pushedContentAccum = "";  // Accumulates push_content data (reports pushed to frontend)
    const pushedContentItems: string[] = [];  // Collects all push_content data items
    let finishSummaryContent = "";  // Content from finish tool's summary argument
    const compactionEvents: Array<{ turn: number; method: string; tokensSaved: number }> = [];
    const writtenFilePaths = new Map<string, number>();  // Track write_file paths and content lengths
    const pushedFilePaths = new Set<string>();  // Track push_content filePath parameters
    const fileOriginalPaths = new Map<string, string>(); // resolved path → original path (for cross-referencing)

    // Stuck-loop and error detection
    const stuckDetector = new StuckDetector(agentSettings.stuckDetectionThreshold, detectedLang);
    const searchSaturation = new SearchSaturationDetector();
    let consecutiveToolErrors = 0;

    // Per-run tool result cache — isolated per session, not shared across runs
    const toolResultCache = new ToolResultCache();

    // C3.5: Lightweight search result index — survives compaction so the model
    // doesn't re-search the same queries after context compression.
    const searchResultIndex = new SearchResultIndex();
    // Restore search index from persisted session memory
    if (loadedMemory?.searchIndexJson) {
      searchResultIndex.restoreEntries(loadedMemory.searchIndexJson);
    }

    // Post-compact file re-injection: track file reads during agent execution
    // so that after compaction, recently-read files can be re-injected into context.
    const readFileState = new Map<string, ReadFileStateEntry>();

    // Post-compact skill re-injection: track invoked inline skills
    // so that after compaction, active skill instructions can be re-injected into context.
    const invokedSkills = new Map<string, InvokedSkillEntry>();

    // Track accessed wiki pages for source tracing
    const accessedPages = new Map<string, {
      pageId: string;
      title: string;
      docId?: string;
      originalName?: string;
      kbName?: string;
      sectionTitle?: string;
      pageNumber?: number | null;
      anchorId?: string;
    }>();

    // Initialize context management components (reused across turns, L1/L2 fix)
    const contextManager = new ContextManager(this.modelRouter, modelId, toolDefs, agentSettings);
    const microCompactor = new MicroCompactor();
    const tokenGrowthTracker = new TokenGrowthTracker(); // C3.6: track token growth rate
    const compactionEngine = new CompactionEngine(this.modelRouter, contextManager, agentSettings, options.sessionId);

    // Async session memory extractor (non-blocking background extraction)
    const asyncMemoryExtractor = sessionMemory
      ? new AsyncSessionMemoryExtractor(agentSettings)
      : null;

    // Emit start event
    this.emitEvent(options.onEvent, {
      type: "start",
      taskId,
      agentType,
    });

    // ── JSONL Writer for lossless persistence ──
    if (options.sessionId) {
      try {
        const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
        rs.jsonlWriter = await writerRegistry.getOrCreate(DEEPANALYZE_CONFIG.dataDir, options.sessionId, taskId);
        rs.jsonlSessionId = options.sessionId;
        rs.jsonlTaskId = taskId;
        await rs.jsonlWriter.append({ type: "session_meta", sessionId: options.sessionId });
        await rs.jsonlWriter.append({ type: "user", content: options.input, media: options.mediaIds?.map(id => ({ mediaId: id })), sessionId: options.sessionId });
      } catch (err) {
        console.warn("[AgentRunner] JSONL writer init failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Fire UserPromptSubmit hook (can block or modify user input)
    if (this.hookManager) {
      try {
        const promptResult = await this.hookManager.fireUserPromptSubmit(options.input, taskId);
        // If hook modifies the user prompt, we log it but don't change options.input here
        // since the messages are already built. The modifiedInput is available for future use.
        if (!promptResult.allowed) {
          console.warn(`[AgentRunner] UserPromptSubmit hook blocked execution: ${promptResult.error ?? "no reason"}`);
        }
      } catch {}
    }

    // Fire AgentStart hook (fire-and-forget)
    if (this.hookManager) {
      await this.hookManager.fire("AgentStart", {
        hookType: "AgentStart",
        taskId,
      }).catch(() => {});
    }

    // Inject signal into per-task context and link RunState trackers.
    // With ALS, the context is per-task — direct mutation is safe and avoids
    // the spread-merge race condition that overwrites other tasks' context.
    const ctx = this.toolRegistry.getExecutionContext();
    if (options.signal) ctx.signal = options.signal;
    // Link RunState's readFilesTracker into context for backward compatibility
    // (tools like edit_file read _readFilesTracker from context)
    ctx._readFilesTracker = rs.readFilesTracker;
    // Expose session-level pushed history accessor for list_pushed_content tool
    ctx._getPushedHistory = () => this.getSessionPushedHistory(rs.sessionId);

    // -------------------------------------------------------------------
    // Continuous TAOR Loop
    // -------------------------------------------------------------------
    let turn = 0;
    let emergencyCompactionCount = 0;
    const MAX_EMERGENCY_COMPACTIONS = 5;
    let lastProactiveCompactionTurn = -Infinity; // C3.6: track last proactive compaction turn
    let contextPressureWarnLevel = 0; // 0=none, 1=caution(50%), 2=urgent(60%)
    let consecutiveLLMErrors = 0;
    const MAX_CONSECUTIVE_LLM_ERRORS = 5;
    let continuations = 0;
    let outputTokenRecoveries = 0;
    let naturalTerminationResurrections = 0;
    let emptyTurnCount = 0;
    const MAX_NATURAL_TERMINATION_RESURRECTIONS = 4;
    let continuationBuffer = "";  // Accumulates content across continuation rounds

    let lastTurnToolNames: string[] = []; // Track tool names called in previous turn
    let repetitionDetectedPenalty = 0; // > 0 when degenerate repetition was detected; applies frequency_penalty

    while (true) {
      turn++;
      const searchIndexCountBefore = searchResultIndex.count; // Track search index growth for progress

      // 1. Cancellation check
      if (options.signal?.aborted) {
        this.emitEvent(options.onEvent, { type: "cancelled", taskId });
        if (this.hookManager) {
          await this.hookManager.fireStop(taskId).catch(() => {});
        }
        await this.closeJsonlWriter(taskId);
        return await this.buildResult(taskId, lastAssistantContent, messages, totalToolCalls, turn, totalInputTokens, totalOutputTokens, compactionEvents, undefined, options.onEvent, isWorkflowSubAgent, costTracker);
      }

      // 2. Hard limit check (absolute safety valve, only for non-unlimited)
      if (!isUnlimited && turn > hardLimit) {
        // Give the agent one final turn to call finish
        if (turn > hardLimit + 1) {
          break;
        }
        // Inject final wrap-up instruction
        messages.push({
          role: "user",
          content: detectedLang === "zh"
            ? "[系统提示] 已达到硬性轮次上限。必须立即调用 finish 工具提交当前最佳答案。不要再调用任何其他工具。"
            : "[System-Notice] The hard turn limit has been reached. You must call the finish tool immediately to submit your best answer. Do not call any other tools.",
        });
      }

      // 3. Adaptive progress check — evaluate at dynamic checkpoints
      // R4.6: Replaces fixed advisory/80% limits with adaptive progress tracking.
      // The tracker extends the budget when the model is making progress and
      // nudges it to change strategy when stalled.
      {
        const newSearches = searchResultIndex.count - searchIndexCountBefore;
        const progressResult = evaluateProgress(
          progressTracker,
          turn,
          newSearches > 0, // Had new searches = progress indicator
          lastTurnToolNames, // Tool names from previous turn for over-specialization detection
        );
        if (progressResult.hint) {
          messages.push({
            role: "user",
            content: detectedLang === "zh"
              ? `[系统提示] ${progressResult.hint}`
              : `[System-Notice] ${progressResult.hint}`,
          });
        }
      }

      // 3.5. Check for new user messages injected while the agent was working
      // This enables the coordinator to receive follow-up instructions mid-task.
      const execCtx = this.toolRegistry.getExecutionContext();
      const pendingMessages = execCtx.pendingUserMessages as
        | Array<{ role: "user"; content: string }>
        | undefined;
      let hasInjectedMessages = false;
      if (pendingMessages && pendingMessages.length > 0) {
        hasInjectedMessages = true;
        hadInjectedMessages = true;
        // Drain all pending messages into the conversation
        for (const msg of pendingMessages) {
          messages.push(msg);
        }
        pendingMessages.length = 0; // Clear the queue
        this.emitEvent(options.onEvent, {
          type: "progress",
          taskId,
          progress: {
            turn,
            timestamp: new Date().toISOString(),
            type: "text",
            content: `[用户追加了新消息，已注入到当前任务上下文]`,
            toolName: "system",
            toolInput: {},
            toolOutput: null,
          },
        });
      }

      // 3.6. Check for completed background workflows (non-blocking mode)
      let hasCompletedWorkflows = false;
      if (featureFlags.backgroundWorkflows) {
        const { getWorkflowManager } = await import("./workflow-manager.js");
        const wm = getWorkflowManager();
        const sessionId = execCtx.sessionId as string | undefined;
        if (sessionId) {
          const completed = wm.drainCompleted(sessionId);
          if (completed.length > 0) {
            hasCompletedWorkflows = true;
            for (const wf of completed) {
              const summary = formatWorkflowCompletion(wf);
              messages.push({
                role: "user",
                content: summary,
              });
            }
            this.emitEvent(options.onEvent, {
              type: "progress",
              taskId,
              progress: {
                turn,
                timestamp: new Date().toISOString(),
                type: "text",
                content: `[${completed.length}个后台工作流已完成，结果已注入上下文]`,
                toolName: "system",
                toolInput: {},
                toolOutput: null,
              },
            });
          }

          // 3.7. Idle wait — active workflows but no new messages, no completed results,
          // and no injected messages this iteration. Skip the LLM call and poll again.
          // Only the MAIN agent polls for background workflows; sub-agents must not
          // enter this path (they share the parent's sessionId and would spin forever).
          if (!isWorkflowSubAgent && wm.hasActive(sessionId) && !hasCompletedWorkflows &&
              !hasInjectedMessages &&
              (!pendingMessages || pendingMessages.length === 0)) {
            turn--; // Don't count idle-wait polls as actual turns
            await new Promise(r => setTimeout(r, 500));
            continue; // Skip LLM call, retry loop
          }
        }
      }

      // Projection pipeline: collapse → cache editing → cache breakpoints
      // Each stage creates a derived array without modifying the original messages.
      let messagesForApi: ChatMessage[] = messages;
      // Stage 1: Collapse projection (replaces collapsed regions with summaries)
      if (featureFlags.contextCollapse && collapseStore) {
        messagesForApi = applyCollapseProjection(messagesForApi, collapseStore);
      }
      // Stage 2: Cache editing (truncates old tool results for context management)
      // When contextCollapse is enabled, use basic truncation (CollapseStore handles the heavy lifting).
      // When contextCollapse is disabled, use smart editing that preserves citation data longer.
      if (featureFlags.cacheEditing) {
        if (featureFlags.contextCollapse) {
          messagesForApi = applyCacheEditing(messagesForApi);
        } else {
          messagesForApi = applySmartCacheEditing(messagesForApi);
        }
      }
      // Stage 3: Prompt caching breakpoints (marks cache_control on messages)
      if (featureFlags.promptCaching) {
        messagesForApi = markCacheBreakpoints(messagesForApi);
      }

      // Inject collapse status notice when there are active collapses
      if (featureFlags.contextCollapse && collapseStore && collapseStore.hasCollapses) {
        const collapseCount = collapseStore.count;
        const collapseNotice = {
          role: "user" as const,
          content: `[系统通知] 当前有 ${collapseCount} 个对话区域已被压缩以节省上下文空间。` +
            `如果你需要回引之前的搜索结果或分析细节，使用 context_expand 工具恢复。` +
            `使用 context_expand({ collapse_id: "list" }) 查看所有可展开的区域。`,
        };
        // Append to projected messages (NOT to original messages)
        messagesForApi = [...messagesForApi, collapseNotice];
      }

      // Context pressure reactive guidance: when context usage is high but not yet at compaction
      // threshold, remind the agent to save important findings to files before they get compressed.
      // This is general — any task that accumulates information in context benefits from the reminder.
      // Warning escalates: level 1 at 50% (caution), level 2 at 60% (urgent).
      // Proactive compaction triggers at 70%, so this gives the agent 1-2 turns to react.
      {
        const pressureTokens = contextManager.estimateMessagesTokens(messagesForApi);
        const pressureInfo = contextManager.getContextWindow();
        const pressureRatio = pressureInfo.effectiveWindow > 0 ? pressureTokens / pressureInfo.effectiveWindow : 0;
        const newLevel = pressureRatio >= 0.60 ? 2 : pressureRatio >= 0.50 ? 1 : 0;
        if (newLevel > contextPressureWarnLevel) {
          contextPressureWarnLevel = newLevel;
          const pct = Math.round(pressureRatio * 100);
          const urgency = newLevel >= 2
            ? `上下文使用率已达 ${pct}%，接近压缩阈值。`
            : `上下文使用率已达 ${pct}%。`;
          const pressureNotice = {
            role: "user" as const,
            content: `[系统提示] ${urgency}如果你已收集了大量信息但尚未保存，建议现在用 write_file 将重要发现保存到文件，避免后续上下文压缩时丢失细节。已保存的内容可随时用 read_file 回读、用 edit_file 修订。`,
          };
          messagesForApi = [...messagesForApi, pressureNotice];
        } else if (newLevel === 0 && contextPressureWarnLevel > 0) {
          // Reset level after compaction brought ratio back down
          contextPressureWarnLevel = 0;
        }
      }

      let assistantContent: string;
      let toolCalls: ToolCall[] | undefined;
      let finishReason: string | undefined;
      let turnUsage: { inputTokens: number; outputTokens: number; cachedTokens?: number } | undefined;
      let speculativeToolResults: ChatMessage[] | undefined;
      let turnReasoningDetails: unknown[] | undefined;

      // Pre-flight context overflow check: estimate token count before sending to LLM.
      // If near the limit, trigger emergency compaction proactively to avoid a wasted API call.
      {
        const preflightTokens = contextManager.estimateMessagesTokens(messagesForApi);
        const preflightInfo = contextManager.getContextWindow();
        const preflightRatio = preflightInfo.effectiveWindow > 0 ? preflightTokens / preflightInfo.effectiveWindow : 0;
        if (preflightRatio > 0.95 && emergencyCompactionCount < MAX_EMERGENCY_COMPACTIONS) {
          console.warn(`[AgentRunner] Pre-flight check: context at ${(preflightRatio * 100).toFixed(1)}% (${preflightTokens}/${preflightInfo.effectiveWindow}), triggering emergency compaction BEFORE API call`);
          // Trigger compact via the existing proactive mechanism
          if (contextManager.shouldCompact(messages)) {
            const compactResult = compactionEngine.deterministicCompactPublic(messages);
            if (compactResult.method !== "none") {
              messages.length = 0;
              messages.push(...compactResult.messages);
              messagesForApi = [...messages];
              console.log(`[AgentRunner] Pre-flight deterministic compact saved ${compactResult.tokensSaved} tokens`);
            }
          }
        }
      }

      // R4.1: Build tool map before streaming so speculative execution can use it
      const toolMap = new Map<string, AgentTool>();
      for (const tool of this.toolRegistry.getAll()) {
        toolMap.set(tool.name, tool);
      }

      // R4.1: Prepare speculative execution params when streaming tool execution is enabled
      const speculativeTools = featureFlags.streamingToolExecution ? toolMap : undefined;
      const speculativeExecuteFn = featureFlags.streamingToolExecution ? (tc: ToolCall) => {
        if (options.signal?.aborted) {
          return Promise.resolve({ role: "tool" as const, content: JSON.stringify({ error: "Cancelled" }), toolCallId: tc.id });
        }
        return this.executeToolCall(tc, taskId, turn, options.onEvent, accessedPages, agentSettings, undefined, toolResultCache, options.signal, searchResultIndex, invokedSkills, messages);
      } : undefined;

      try {
        // Feature D (C-189): Record prompt state snapshot before API call for cache break detection
        if (messagesForApi.length > 0) {
          rs.promptCacheDetector.recordPreCallState("main", {
            systemPrompt: typeof messagesForApi[0]?.content === "string" ? messagesForApi[0].content : JSON.stringify(messagesForApi[0]?.content) ?? "",
            toolsJson: JSON.stringify(toolDefs.map(t => ({ name: t.name }))),
            model: modelId,
            messageCount: messagesForApi.length,
          });
        }

        const streamResult = await this.chatStreamWithFallback(
          messagesForApi, toolDefs, options,
          modelId, modelRole, fallbackRole,
          usingFallback,
          (newModelId: string) => { modelId = newModelId; usingFallback = true; },
          taskId, turn, outputTokenBudget,
          speculativeTools, speculativeExecuteFn,
          repetitionDetectedPenalty,
        );
        // Reset penalty after use (one-time application)
        if (repetitionDetectedPenalty > 0) repetitionDetectedPenalty = 0;
        assistantContent = streamResult.content;
        toolCalls = streamResult.toolCalls.length > 0 ? streamResult.toolCalls : undefined;
        finishReason = streamResult.finishReason;
        turnUsage = streamResult.usage;
        speculativeToolResults = streamResult.speculativeToolResults;
        turnReasoningDetails = streamResult.reasoningDetails;

        // Feature D (C-189): Check for cache break after API call
        if (turnUsage) {
          const breakResult = rs.promptCacheDetector.checkPostCallResponse("main", {
            cacheReadTokens: (turnUsage as any).cacheReadTokens,
            cacheCreationTokens: (turnUsage as any).cacheCreationTokens,
          });
          if (breakResult.broken) {
            console.warn(`[AgentRunner] Prompt cache break detected: ${breakResult.reason} (token drop: ${breakResult.tokenDrop})`);
          }
        }

        // Feature E (C-190): Save cache-safe params after each API call
        saveCacheSafeParams(computeCacheSafeParams({
          systemPrompt: typeof messagesForApi[0]?.content === "string" ? messagesForApi[0].content : JSON.stringify(messagesForApi[0]?.content) ?? "",
          toolsJson: JSON.stringify(toolDefs.map(t => ({ name: t.name }))),
          model: modelId,
          contextMessagesCount: messagesForApi.length,
        }));
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Emergency compaction: detect prompt_too_long errors
        if (this.isPromptTooLongError(errorMsg) && emergencyCompactionCount < MAX_EMERGENCY_COMPACTIONS) {
          console.log(`[AgentRunner] prompt_too_long detected, triggering emergency compaction (attempt ${emergencyCompactionCount + 1}/${MAX_EMERGENCY_COMPACTIONS})`);
          emergencyCompactionCount++;
          try {
            if (featureFlags.contextCollapse && collapseStore) {
              // Context Collapse path: create collapse entry instead of mutating messages
              const collapseInfo = await compactionEngine.generateCollapseSummary(messages, sessionMemory, options.signal);
              if (collapseInfo) {
                // Post-compact: inject recently read files into collapse replacement messages
                const recentMsgs = messages.slice(collapseInfo.endIndex);
                collapseInfo.replacementMessages = injectPostCompactFilesForCollapse(
                  collapseInfo.replacementMessages, recentMsgs,
                  readFileState, this.modelRouter, agentSettings, invokedSkills,
                );
                const entry = collapseStore.createCollapse(
                  collapseInfo.startIndex, collapseInfo.endIndex,
                  collapseInfo.replacementMessages,
                  "emergency-collapse" as import("./types.js").CollapseMethod,
                  collapseInfo.originalTokens, collapseInfo.replacementTokens, turn,
                  { messageCount: collapseInfo.endIndex - collapseInfo.startIndex, isEmergency: true },
                );
                if (entry) {
                  compactionEvents.push({ turn, method: `emergency-${entry.method}`, tokensSaved: entry.originalTokens - entry.replacementTokens });
                  this.emitEvent(options.onEvent, {
                    type: "compaction",
                    taskId,
                    turn,
                    method: `emergency-${entry.method}`,
                    tokensSaved: entry.originalTokens - entry.replacementTokens,
                  });
                  this.persistCompactBoundary(
                    options.sessionId,
                    `emergency-${entry.method}` as CompactBoundaryMeta["method"],
                    entry.originalTokens, turn, taskId,
                  );
                  // Post-compact cleanup
                  const totalTokensForCleanup = totalInputTokens + totalOutputTokens;
                  await runPostCompactCleanup(readFileState, sessionMemory, messages, totalTokensForCleanup, { tokenEstimator: this.tokenEstimator, collapseStore, searchSaturation, hookManager: this.hookManager ?? undefined });
                  continue;
                }
              }
            }
            // Legacy path: mutate messages in place
            let result = await compactionEngine.compact(messages, sessionMemory, options.signal);
            if (result.method !== "none") {
              // Post-compact: re-inject recently read files and skills
              result = injectPostCompactFiles(result, readFileState, this.modelRouter, agentSettings, invokedSkills);
              messages.length = 0;
              messages.push(...result.messages);
              compactionEvents.push({ turn, method: result.method, tokensSaved: result.tokensSaved });
              this.emitEvent(options.onEvent, {
                type: "compaction",
                taskId,
                turn,
                method: `emergency-${result.method}`,
                tokensSaved: result.tokensSaved,
              });
              // Persist compact boundary (emergency)
              this.persistCompactBoundary(
                options.sessionId,
                `emergency-${result.method}` as CompactBoundaryMeta["method"],
                result.preCompactTokens, turn, taskId,
              );
              // Post-compact cleanup
              const totalTokensForCleanup = totalInputTokens + totalOutputTokens;
              await runPostCompactCleanup(readFileState, sessionMemory, messages, totalTokensForCleanup, { tokenEstimator: this.tokenEstimator, collapseStore, searchSaturation, hookManager: this.hookManager ?? undefined });
              // Retry the LLM call after compaction
              continue;
            }
          } catch {
            // Emergency compaction failed — try deterministic compact as last resort
            try {
              const detResult = compactionEngine.deterministicCompactPublic(messages);
              if (detResult.method !== "none") {
                if (featureFlags.contextCollapse && collapseStore) {
                  // Apply via collapse store
                  const detEntry = collapseStore.createCollapse(
                    1, detResult.messages.length,
                    detResult.messages, "emergency-collapse" as import("./types.js").CollapseMethod,
                    detResult.preCompactTokens, contextManager.estimateMessagesTokens(detResult.messages), turn,
                    { messageCount: detResult.messages.length, isEmergency: true },
                  );
                  if (detEntry) {
                    console.log(`[AgentRunner] Emergency deterministic compact saved ${detEntry.originalTokens - detEntry.replacementTokens} tokens`);
                    continue;
                  }
                } else {
                  // Legacy: replace in place
                  messages.length = 0;
                  messages.push(...detResult.messages);
                  console.log(`[AgentRunner] Emergency deterministic compact saved ${detResult.tokensSaved} tokens`);
                  continue;
                }
              }
            } catch (detErr) {
              // Deterministic compact failed — force truncate oldest messages as absolute last resort
              console.warn("[AgentRunner] All compaction methods failed, force-truncating oldest messages:", detErr instanceof Error ? detErr.message : String(detErr));
              const truncateCount = Math.max(2, Math.floor(messages.length * 0.4));
              const truncated = messages.splice(0, truncateCount);
              const summary = `Earlier conversation (${truncated.length} messages) was force-truncated due to context overflow. Key topics: ${truncated.filter(m => m.role === "user").map(m => (m.content ?? "").slice(0, 80)).filter(Boolean).slice(0, 5).join("; ")}`;
              messages.unshift({ role: "user", content: `[System: ${summary}]` });
              console.log(`[AgentRunner] Force-truncated ${truncated.length} messages, ${messages.length} remaining`);
            }
          }
        }

        // Transient error retry (rate limit, network, server errors)
        if (this.isTransientError(errorMsg) && consecutiveLLMErrors < MAX_CONSECUTIVE_LLM_ERRORS) {
          consecutiveLLMErrors++;
          const backoff = Math.min(5000, 1000 * Math.pow(2, consecutiveLLMErrors - 1));
          console.warn(`[AgentRunner] Transient error (attempt ${consecutiveLLMErrors}/${MAX_CONSECUTIVE_LLM_ERRORS}), retrying in ${backoff}ms: ${errorMsg}`);
          this.recordProgress(options.onEvent, taskId, turn, "error", `Transient error, retrying (${consecutiveLLMErrors}/${MAX_CONSECUTIVE_LLM_ERRORS}): ${errorMsg}`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          turn--; // Don't count this as a turn
          continue;
        }

        consecutiveLLMErrors = 0; // Reset on non-transient or exhausted retries
        this.recordProgress(options.onEvent, taskId, turn, "error", `Model call failed: ${errorMsg}`);
        this.emitEvent(options.onEvent, { type: "error", taskId, error: errorMsg });

        // Fire StopFailure hook
        if (this.hookManager) {
          await this.hookManager.fireStopFailure(errorMsg, taskId).catch(() => {});
        }

        // Build a user-friendly error with classification + suggestions
        const availableProviders = this.modelRouter.listProviderNames();
        const friendly = friendlyLLMError(err);
        const providerHint = availableProviders.length > 0
          ? `当前可用 provider: ${availableProviders.join(", ")}。`
          : "当前没有配置任何 provider。";
        const remediationHint = friendly.category === "auth_permanent" || friendly.category === "billing"
          ? "请到「设置 → 模型配置」检查 API key 和 provider 账户状态。"
          : friendly.category === "aborted"
            ? "任务已取消，无需修复。"
            : friendly.isRetryable
              ? "已多次重试仍失败，建议切换 provider 或稍后再试。"
              : "请检查 provider 配置后重试。";
        const userMessage = `${friendly.userMessage}\n${providerHint}\n${remediationHint}\n原始错误（仅供诊断）: ${errorMsg.slice(0, 300)}`;

        await this.closeJsonlWriter(taskId);
        return await this.buildResult(taskId, lastAssistantContent, messages, totalToolCalls, turn, totalInputTokens, totalOutputTokens, compactionEvents, userMessage, options.onEvent, isWorkflowSubAgent, costTracker);
      }

      // 5. Track token usage
      consecutiveLLMErrors = 0; // Reset on successful response
      if (turnUsage) {
        totalInputTokens += turnUsage.inputTokens;
        totalOutputTokens += turnUsage.outputTokens;
        // Cache tokens are accumulated inside costTracker (see cost-tracker.ts).
        // buildResult reads them back to populate AgentResult.usage.cachedTokens
        // so callers can report cache hit rate without re-parsing JSONL.
        stuckDetector.recordOutputTokens(turnUsage.outputTokens);
        // Record cost for this turn
        const turnCost = costTracker.recordTurn(turn, turnUsage);
        // Emit turn_usage event for real-time status display
        this.emitEvent(options.onEvent, { type: "turn_usage", taskId, turn, usage: { ...turnUsage, estimatedCostUsd: turnCost > 0 ? turnCost : undefined } });
        // Record API-reported usage for token estimation
        if (turnUsage.inputTokens) {
          this.tokenEstimator.reportUsage(`turn-${turn}`, turnUsage.inputTokens);
          this.tokenEstimator.reportApiUsage(turnUsage.inputTokens, messages.length);
        }
      }

      if (assistantContent) {
        lastAssistantContent = assistantContent;
        // Accumulate meaningful content — actual output, not just thinking/whitespace
        const trimmedLen = assistantContent.trim().length;
        if (hadInjectedMessages && trimmedLen > 10) {
          // With injected messages, each turn is a distinct response to a
          // different question. Concatenate all meaningful turn outputs to
          // preserve responses to injected messages.
          accumulatedContent = accumulatedContent
            ? accumulatedContent + "\n\n" + assistantContent
            : assistantContent;
        } else if (trimmedLen > 50 && trimmedLen > accumulatedContent.trim().length) {
          // Without injections, keep the longest (most comprehensive output).
          // This avoids concatenating partial analysis with final summary.
          accumulatedContent = assistantContent;
        }
      }

      if (assistantContent) {
        this.recordProgress(options.onEvent, taskId, turn, "text", assistantContent);
      }

      // Emit turn as boundary signal — content was already streamed via text_delta
      this.emitEvent(options.onEvent, { type: "turn", taskId, turn, content: assistantContent });

      // R4.2: max_output_tokens recovery — when output is truncated by token limit,
      // retry with progressively higher maxTokens before falling back to continuation.
      // C3.4: Recovery tiers start from the agent's outputTokenBudget, not a fixed 16K.
      if (needsContinuation(finishReason, assistantContent) && (!toolCalls || toolCalls.length === 0)) {
        const baseBudget = outputTokenBudget ?? 16_384;
        const MAX_TOKEN_TIERS = [baseBudget * 2, baseBudget * 4, 65_536, 131_072];
        // Find the next tier above the current budget
        const nextTier = MAX_TOKEN_TIERS[outputTokenRecoveries] ?? MAX_TOKEN_TIERS[MAX_TOKEN_TIERS.length - 1];
        if (outputTokenRecoveries < 3) {
          outputTokenRecoveries++;
          console.log(`[AgentRunner] Output truncated (${finishReason}), retrying with maxTokens=${nextTier} (recovery ${outputTokenRecoveries}/3)`);
          const recoveryOpts: ChatOptions = {
            model: modelId,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            signal: options.signal,
            maxTokens: nextTier,
            enableCaching: featureFlags.promptCaching,
          };
          try {
            // Signal SSE layer to clear accumulated fullContent before retry —
            // the first attempt's partial text_delta events would otherwise
            // be concatenated with the retry's output, producing duplicated content.
            this.emitEvent(options.onEvent, {
              type: "content_reset",
              taskId,
              turn,
              reason: `max_tokens_recovery_${nextTier}`,
            });
            const recoveryResult = await this.consumeStream(
              this.modelRouter.chatStream(messagesForApi, recoveryOpts),
              options.onEvent, taskId, turn,
            );
            if (recoveryResult.finishReason !== "length" || recoveryResult.content.length > assistantContent.length) {
              assistantContent = recoveryResult.content;
              toolCalls = recoveryResult.toolCalls.length > 0 ? recoveryResult.toolCalls : undefined;
              finishReason = recoveryResult.finishReason;
              turnUsage = recoveryResult.usage;
              console.log(`[AgentRunner] Output recovery succeeded: ${assistantContent.length} chars, finishReason=${finishReason}`);
            }
          } catch (recoveryErr) {
            console.warn(`[AgentRunner] Output recovery failed: ${recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)}`);
          }
        }
      }

      // R4.3: Tool call truncation recovery — when the stream is interrupted
      // (stream_error, undefined finishReason, or "length") mid-tool-call, the
      // tool call arguments will be incomplete JSON. tryRepairToolArguments will
      // produce a valid but incomplete JSON (e.g. {"mode":"parallel"} missing
      // the "agents" array). Detect this and retry the same turn so the model
      // can regenerate the complete tool call.
      const isStreamInterrupted = finishReason === "stream_error" || finishReason === "length" || finishReason === undefined;
      if (isStreamInterrupted && toolCalls && toolCalls.length > 0 && outputTokenRecoveries < 3) {
        // Check if any tool call appears truncated — its arguments were repaired
        // and lost significant content (the repaired JSON is much shorter than raw)
        let hasTruncatedToolCall = false;
        for (const tc of toolCalls) {
          try {
            const parsed = JSON.parse(tc.function.arguments);
            const keys = Object.keys(parsed);
            // workflow_run with only "mode" but no "agents" is clearly truncated
            if (tc.function.name === "workflow_run" && parsed.mode && !parsed.agents && !parsed.teamName) {
              hasTruncatedToolCall = true;
              console.warn(`[AgentRunner] Tool call truncation detected: workflow_run has mode="${parsed.mode}" but no agents/teamName. Retrying turn ${turn}.`);
              break;
            }
            // workflow_run with agents array but only 0-1 agents is likely truncated
            // (tryRepairToolArguments closes unclosed JSON, silently dropping agents)
            if (tc.function.name === "workflow_run" && parsed.agents && Array.isArray(parsed.agents) && parsed.agents.length <= 1 && finishReason !== "stop") {
              hasTruncatedToolCall = true;
              console.warn(`[AgentRunner] Tool call truncation detected: workflow_run has only ${parsed.agents.length} agent(s) with finishReason="${finishReason}". Retrying turn ${turn}.`);
              break;
            }
            // write_file with path but no data/content is truncated
            if (tc.function.name === "write_file" && (parsed.filePath || parsed.path) && !parsed.data && !parsed.content) {
              hasTruncatedToolCall = true;
              console.warn(`[AgentRunner] Tool call truncation detected: write_file has path but no data/content. Retrying turn ${turn}.`);
              break;
            }
            // Generic heuristic: if arguments are suspiciously short (< 100 chars)
            // for a tool that typically has large arguments, likely truncated
            if (tc.function.arguments.length < 100 && tc.function.arguments.length > 2) {
              const largeArgTools = ["write_file", "workflow_run", "delegate_task", "push_content"];
              if (largeArgTools.includes(tc.function.name) && keys.length <= 2) {
                hasTruncatedToolCall = true;
                console.warn(`[AgentRunner] Tool call truncation detected: ${tc.function.name} has only ${keys.length} keys (${tc.function.arguments.length} chars). Retrying turn ${turn}.`);
                break;
              }
            }
          } catch {
            // Arguments are not even valid JSON — definitely truncated
            hasTruncatedToolCall = true;
            break;
          }
        }
        if (hasTruncatedToolCall) {
          outputTokenRecoveries++;
          // Discard truncated tool calls and retry with explicit maxTokens
          const retryMaxTokens = outputTokenBudget ? outputTokenBudget * 2 : 65_536;
          console.log(`[AgentRunner] Retrying truncated tool call with maxTokens=${retryMaxTokens} (recovery ${outputTokenRecoveries}/3)`);
          const retryOpts: ChatOptions = {
            model: modelId,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            signal: options.signal,
            maxTokens: retryMaxTokens,
            enableCaching: featureFlags.promptCaching,
          };
          try {
            // Signal SSE layer to clear accumulated fullContent before retry —
            // the truncated attempt's partial text_delta must not pollute the
            // retry's streamed output.
            this.emitEvent(options.onEvent, {
              type: "content_reset",
              taskId,
              turn,
              reason: `tool_call_truncation_retry`,
            });
            const retryResult = await this.consumeStream(
              this.modelRouter.chatStream(messagesForApi, retryOpts),
              options.onEvent, taskId, turn,
            );
            // Accept retry result if it has valid tool calls or is not worse
            if (retryResult.toolCalls.length > 0) {
              let retryHasTruncatedCall = false;
              for (const tc of retryResult.toolCalls) {
                try {
                  const parsed = JSON.parse(tc.function.arguments);
                  const keys = Object.keys(parsed);
                  if (tc.function.name === "workflow_run" && parsed.mode && !parsed.agents && !parsed.teamName) {
                    retryHasTruncatedCall = true;
                    break;
                  }
                  if (tc.function.name === "workflow_run" && parsed.agents && Array.isArray(parsed.agents) && parsed.agents.length <= 1 && retryResult.finishReason !== "stop") {
                    retryHasTruncatedCall = true;
                    break;
                  }
                  if (tc.function.name === "write_file" && (parsed.filePath || parsed.path) && !parsed.data && !parsed.content) {
                    retryHasTruncatedCall = true;
                    break;
                  }
                  const largeArgTools = ["write_file", "workflow_run", "delegate_task", "push_content"];
                  if (tc.function.arguments.length < 100 && tc.function.arguments.length > 2
                    && largeArgTools.includes(tc.function.name) && keys.length <= 2) {
                    retryHasTruncatedCall = true;
                    break;
                  }
                } catch { retryHasTruncatedCall = true; break; }
              }
              if (!retryHasTruncatedCall) {
                assistantContent = retryResult.content || assistantContent;
                toolCalls = retryResult.toolCalls;
                finishReason = retryResult.finishReason;
                turnUsage = retryResult.usage;
                console.log(`[AgentRunner] Tool call retry succeeded: ${toolCalls.length} tool calls, finishReason=${finishReason}`);
              } else {
                console.warn(`[AgentRunner] Tool call retry still truncated, keeping original result`);
              }
            }
          } catch (retryErr) {
            console.warn(`[AgentRunner] Tool call retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
          }
        }
      }

      // Long output continuation: if output was truncated, inject continuation message
      // Also handles stream_error: when the provider terminates mid-stream, treat partial
      // output as truncated and continue from where it left off.
      if (featureFlags.longOutputContinuation && needsContinuation(finishReason, assistantContent) && (!toolCalls || toolCalls.length === 0)) {
        continuations++;
        if (continuations <= DEFAULT_CONTINUATION_CONFIG.maxContinuations) {
          continuationBuffer += assistantContent;
          messages.push({ role: "assistant", content: assistantContent } as ChatMessage);
          const continuationMsg = finishReason === "stream_error"
            ? buildStreamErrorContinuationMessage()
            : buildContinuationMessage();
          messages.push(continuationMsg);
          console.log(`[AgentRunner] Output ${finishReason === "stream_error" ? "interrupted by stream error" : "truncated"}, continuation ${continuations}/${DEFAULT_CONTINUATION_CONFIG.maxContinuations} (buffer: ${continuationBuffer.length} chars)`);
          continue;
        }
        console.warn(`[AgentRunner] Max continuations (${DEFAULT_CONTINUATION_CONFIG.maxContinuations}) reached`);
        // Flush continuation buffer into final output
        if (continuationBuffer) {
          lastAssistantContent = continuationBuffer + assistantContent;
          accumulatedContent = lastAssistantContent;
          continuationBuffer = "";
        }
      } else {
        // Reset continuations counter when we get a non-truncated response
        if (continuationBuffer) {
          // Final continuation chunk — combine everything
          lastAssistantContent = continuationBuffer + assistantContent;
          accumulatedContent = lastAssistantContent;
          continuationBuffer = "";
        }
        continuations = 0;
      }

      // Build the assistant message
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: assistantContent,
      };
      // Preserve reasoning_details for thinking models (e.g. MiniMax M2.7)
      if (turnReasoningDetails) {
        assistantMessage.reasoningDetails = turnReasoningDetails;
      }

      // Process tool calls
      let agentCalledFinish = false;

      if (toolCalls && toolCalls.length > 0) {
        assistantMessage.toolCalls = toolCalls;
        messages.push(assistantMessage);
        emptyTurnCount = 0; // Reset on successful tool call

        // Count tool calls and check for finish / capture push_content / finish summary
        const currentTurnToolNames: string[] = [];
        for (const toolCall of toolCalls) {
          totalToolCalls++;
          currentTurnToolNames.push(toolCall.function.name);
          if (toolCall.function.name === "finish") {
            agentCalledFinish = true;
            // Capture finish summary content (as fallback when text output is missing)
            try {
              const args = JSON.parse(toolCall.function.arguments);
              if (args.summary && typeof args.summary === "string" && args.summary.trim().length > 0) {
                finishSummaryContent = args.summary;
              }
            } catch { /* ignore parse errors */ }
          }
          if (toolCall.function.name === "push_content") {
            // Capture push_content data for use in final output
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const data = args.data as string | undefined;
              const filePath = args.filePath as string | undefined;
              if (filePath) {
                pushedFilePaths.add(filePath);
              }
              if (data && data.trim().length > 0) {
                pushedContentItems.push(data);
                if (data.length > pushedContentAccum.length) {
                  pushedContentAccum = data;
                }
              }
            } catch { /* ignore parse errors */ }
          }
          if (toolCall.function.name === "write_file") {
            // Track written file paths for auto-push compensation
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const content = args.content as string | undefined;
              const path = args.path as string | undefined;
              if (path) {
                writtenFilePaths.set(path, content?.length ?? 0);
              }
              // NOTE: write_file content is intentionally NOT captured into
              // pushedContentAccum.  write_file is a utility tool — the agent
              // may write intermediate files, scratch data, or duplicate its
              // text output into a file.  The bestOutput selector should
              // prefer the agent's actual streamed text (accumulatedContent)
              // over file content to avoid replacing correct answers with
              // unrelated file data.
            } catch { /* ignore parse errors */ }
          }
        }

        // Auto-push compensation: if agent called finish and wrote files without pushing them,
        // automatically push the largest unpushed file so the user sees the content.
        // Only for main agents — sub-agents in workflows should NOT auto-push;
        // the workflow engine builds a push catalog and the main agent decides what to push.
        if (!isWorkflowSubAgent && agentCalledFinish && writtenFilePaths.size > 0 && options.onEvent) {
          // Find written files that were NOT pushed via push_content.
          // Compare against both the resolved path (in writtenFilePaths) and the
          // original path (in fileOriginalPaths) because push_content tracks the
          // original path the agent specified, not the write_file resolved path.
          const unpushedFiles = [...writtenFilePaths.entries()]
            .filter(([path]) => {
              if (pushedFilePaths.has(path)) return false;
              const origPath = fileOriginalPaths.get(path);
              if (origPath && pushedFilePaths.has(origPath)) return false;
              return true;
            })
            .sort((a, b) => b[1] - a[1]); // Sort by content length, largest first

          if (unpushedFiles.length > 0 && accumulatedContent.trim().length < 500) {
            // Agent didn't output much text and has unpushed files — auto-push the largest
            const [filePath, _contentLen] = unpushedFiles[0];
            try {
              const fs = await import("fs");
              const nodePath = await import("path");
              const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
              // filePath is relative to dataDir (returned by write_file execute)
              const resolvedPath = nodePath.isAbsolute(filePath)
                ? filePath
                : nodePath.resolve(DEEPANALYZE_CONFIG.dataDir, filePath);
              const fullContent = fs.readFileSync(resolvedPath, "utf-8");
              if (fullContent.trim().length > 500) {
                // Emit as a synthetic tool_result for push_content so the SSE route picks it up
                this.emitEvent(options.onEvent, {
                  type: "tool_result",
                  taskId,
                  turn,
                  toolName: "push_content",
                  result: {
                    pushed: true,
                    type: "markdown",
                    title: "Analysis Report",
                    data: fullContent,
                    dataLength: fullContent.length,
                  },
                });
                pushedContentItems.push(fullContent);
                if (fullContent.length > pushedContentAccum.length) {
                  pushedContentAccum = fullContent;
                }
                console.log(`[AgentRunner] Auto-pushed unpushed file: ${filePath} (${fullContent.length} chars)`);
              }
            } catch { /* file may not exist or not readable */ }
          }
        }

        // Handle context_expand tool calls (Context Collapse feature)
        const contextExpandResults: Map<string, ChatMessage> = new Map();
        if (collapseStore && collapseStore.hasCollapses) {
          for (const toolCall of toolCalls) {
            if (toolCall.function.name !== "context_expand") continue;
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const collapseId = args.collapse_id ?? "auto";

              if (collapseId === "list") {
                // List all available collapse entries
                const entries = collapseStore.getEntries();
                const list = entries.map(e => ({
                  id: e.collapseId,
                  method: e.method,
                  messageCount: e.metadata?.messageCount ?? (e.endIndex - e.startIndex),
                  hasSearchContent: e.hasSearchContent,
                  turnNumber: e.turnNumber,
                }));
                contextExpandResults.set(toolCall.id, {
                  role: "tool",
                  content: JSON.stringify({ available_collapses: list, total: list.length }),
                  toolCallId: toolCall.id,
                });
              } else {
                let expansionResult;
                if (collapseId === "auto") {
                  expansionResult = collapseStore.autoExpandForReference();
                } else {
                  expansionResult = collapseStore.expand(collapseId);
                }
                if (expansionResult) {
                  const entry = expansionResult.expandedEntry;
                  contextExpandResults.set(toolCall.id, {
                    role: "tool",
                    content: JSON.stringify({
                      expanded: true,
                      method: entry.method,
                      messages_restored: entry.endIndex - entry.startIndex,
                      tokens_restored: entry.originalTokens,
                      has_search_content: entry.hasSearchContent,
                      note: "原始消息已恢复到上下文中。下一轮对话你将能看到这些内容。",
                    }),
                    toolCallId: toolCall.id,
                  });
                } else {
                  contextExpandResults.set(toolCall.id, {
                    role: "tool",
                    content: JSON.stringify({
                      expanded: false,
                      message: collapseId === "auto"
                        ? "没有可展开的折叠区域。"
                        : `未找到 ID 为 ${collapseId} 的折叠区域。`,
                    }),
                    toolCallId: toolCall.id,
                  });
                }
              }
            } catch {
              contextExpandResults.set(toolCall.id, {
                role: "tool",
                content: JSON.stringify({ error: "Failed to parse context_expand arguments" }),
                toolCallId: toolCall.id,
              });
            }
          }
        }

        // toolMap is already built before the stream call (R4.1: reused for speculative execution)

        // Compute context fullness ratio for adaptive tool result trimming (T1.2)
        const contextInfo = contextManager.getContextWindow();
        const currentTokens = contextManager.estimateMessagesTokens(messages);
        const contextFullness = contextInfo.effectiveWindow > 0
          ? Math.min(1, currentTokens / contextInfo.effectiveWindow)
          : 0;

        // Feature I (C-194): Check token budget state and emit change events
        const budgetChangeEvent = checkBudgetStateChange(
          rs.budgetState, currentTokens, contextInfo.effectiveWindow,
        );
        if (budgetChangeEvent) {
          rs.budgetState = budgetChangeEvent.newState;
          this.emitEvent(options.onEvent, {
            type: "budget_state",
            taskId,
            turn,
            previousState: budgetChangeEvent.previousState,
            newState: budgetChangeEvent.newState,
            info: budgetChangeEvent.info,
          });
          console.log(`[AgentRunner] Token budget state: ${budgetChangeEvent.previousState} → ${budgetChangeEvent.newState} (${Math.round(contextFullness * 100)}%)`);
        }

        // C3.6: Record token count for growth rate prediction
        tokenGrowthTracker.record(turn, currentTokens);

        // Execute tools with concurrent orchestration (guarded by feature flag)
        // Read-only tools run in parallel, write tools run serially
        let toolResultMessages: ChatMessage[];
        if (featureFlags.streamingToolExecution) {
          // R4.1: Use speculative results from mid-stream execution when available
          if (speculativeToolResults && speculativeToolResults.length > 0) {
            // Speculative execution already ran tools during streaming
            toolResultMessages = speculativeToolResults;
            // Only execute tools that were NOT in the speculative results
            const executedIds = new Set(speculativeToolResults.map(r => r.toolCallId));
            const remaining = toolCalls.filter(tc => !executedIds.has(tc.id));
            if (remaining.length > 0) {
              // Execute remaining tools that weren't speculatively executed
              const executor = new StreamingToolExecutor(
                toolMap,
                (tc) => {
                  if (options.signal?.aborted) {
                    return Promise.resolve({ role: "tool" as const, content: JSON.stringify({ error: "Cancelled" }), toolCallId: tc.id });
                  }
                  return this.executeToolCall(tc, taskId, turn, options.onEvent, accessedPages, agentSettings, contextFullness, toolResultCache, options.signal, searchResultIndex, invokedSkills, messages);
                },
                featureFlags.maxToolConcurrency,
              );
              for (const tc of remaining) executor.addTool(tc);
              const remainingResults = await executor.getResults();
              toolResultMessages = [...toolResultMessages, ...remainingResults];
            }
          } else {
            // No speculative results — execute all tools normally
            const executor = new StreamingToolExecutor(
              toolMap,
              (tc) => {
                if (options.signal?.aborted) {
                  return Promise.resolve({ role: "tool" as const, content: JSON.stringify({ error: "Cancelled" }), toolCallId: tc.id });
                }
                return this.executeToolCall(tc, taskId, turn, options.onEvent, accessedPages, agentSettings, contextFullness, toolResultCache, options.signal, searchResultIndex, invokedSkills, messages);
              },
              featureFlags.maxToolConcurrency,
            );
            for (const tc of toolCalls) {
              executor.addTool(tc);
            }
            toolResultMessages = await executor.getResults();
          }
        } else if (featureFlags.concurrentToolExecution) {
          const batchResult = await orchestrateToolCalls(
            toolCalls,
            toolMap,
            (tc) => {
              // Check abort signal before each tool execution
              if (options.signal?.aborted) {
                return Promise.resolve({ role: "tool" as const, content: JSON.stringify({ error: "Cancelled" }), toolCallId: tc.id });
              }
              return this.executeToolCall(tc, taskId, turn, options.onEvent, accessedPages, agentSettings, contextFullness, toolResultCache, options.signal, searchResultIndex, invokedSkills, messages);
            },
          );
          toolResultMessages = batchResult.messages;
        } else {
          // Fallback to serial execution
          toolResultMessages = [];
          for (const toolCall of toolCalls) {
            // Check abort signal before each tool execution
            if (options.signal?.aborted) {
              toolResultMessages.push({ role: "tool", content: JSON.stringify({ error: "Cancelled" }), toolCallId: toolCall.id });
              continue;
            }
            const result = await this.executeToolCall(toolCall, taskId, turn, options.onEvent, accessedPages, agentSettings, contextFullness, toolResultCache, options.signal, searchResultIndex, invokedSkills, messages);
            toolResultMessages.push(result);
          }
        }
        messages.push(...toolResultMessages);

        // Save tool names for next turn's progress evaluation
        lastTurnToolNames = currentTurnToolNames;

        // Post-execution capture: extract push_content results (handles filePath case
        // where args.data is undefined but the result contains the actual file content)
        // Also track file reads/writes for post-compact re-injection.
        for (const toolCall of toolCalls) {
          if (toolCall.function.name === "push_content") {
            const resultMsg = toolResultMessages.find(
              m => "toolCallId" in m && m.toolCallId === toolCall.id
            );
            if (resultMsg) {
              try {
                const rawContent = typeof resultMsg.content === "string"
                  ? resultMsg.content
                  : JSON.stringify(resultMsg.content);
                const parsed = JSON.parse(rawContent);
                if (parsed?.pushed && parsed?.data && typeof parsed.data === "string"
                    && parsed.data.trim().length > 0) {
                  pushedContentItems.push(parsed.data);
                  if (parsed.data.length > pushedContentAccum.length) {
                    pushedContentAccum = parsed.data;
                  }
                }
              } catch { /* ignore parse errors */ }
            }
          }

          // Track file reads/writes for post-compact re-injection
          if (["read_file", "write_file", "edit_file"].includes(toolCall.function.name)) {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const filePath = (args.filePath ?? args.path ?? args.file_path) as string | undefined;
              if (filePath) {
                const resultMsg = toolResultMessages.find(
                  m => "toolCallId" in m && m.toolCallId === toolCall.id
                );
                if (resultMsg) {
                  const rawContent = typeof resultMsg.content === "string"
                    ? resultMsg.content
                    : JSON.stringify(resultMsg.content ?? "");
                  // Only track successful reads — skip error results
                  if (!rawContent.includes('"error"') && rawContent.length > 10) {
                    const tokenEstimate = this.modelRouter.estimateTokens(rawContent);
                    readFileState.set(filePath, {
                      content: rawContent,
                      timestamp: Date.now(),
                      tokenEstimate,
                    });
                  }
                }
              }
            } catch { /* ignore parse errors */ }
          }

          // Update writtenFilePaths with actual resolved paths from write_file results.
          // write_file remaps paths (e.g., "tmp/report.md" → "sessions/{sid}/output/main_123_report.md")
          // so the original path tracked before execution is incorrect.
          if (toolCall.function.name === "write_file") {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const origPath = (args.path as string) || "";
              const resultMsg = toolResultMessages.find(
                m => "toolCallId" in m && m.toolCallId === toolCall.id
              );
              if (resultMsg && origPath) {
                const rawResult = typeof resultMsg.content === "string"
                  ? resultMsg.content
                  : JSON.stringify(resultMsg.content);
                const parsed = JSON.parse(rawResult);
                if (parsed?.success && parsed?.path) {
                  const contentLen = writtenFilePaths.get(origPath) ?? 0;
                  writtenFilePaths.delete(origPath);
                  writtenFilePaths.set(parsed.path, contentLen);
                  fileOriginalPaths.set(parsed.path, origPath);
                }
              }
            } catch { /* ignore parse errors */ }
          }
        }
        if (contextExpandResults.size > 0) {
          for (const [, expandResult] of contextExpandResults) {
            messages.push(expandResult);
          }
        }

        // Handle inline skill invocation: inject skill prompt as user message
        // Detect __skill_inline__ markers in tool results and replace with skill instructions
        for (let i = 0; i < toolResultMessages.length; i++) {
          const resultMsg = toolResultMessages[i]!;
          const rawResult = typeof resultMsg.content === "string"
            ? resultMsg.content
            : JSON.stringify(resultMsg.content);
          try {
            const parsedResult = JSON.parse(rawResult);
            if (parsedResult?.__skill_inline__) {
              // Replace tool result with a confirmation message
              resultMsg.content = JSON.stringify({
                status: "inline_skill_loaded",
                skillName: parsedResult.skillName,
                message: `技能 "${parsedResult.skillName}" 已作为内联指令加载。`,
              });

              // Inject the skill prompt as a user message wrapped in system-reminder
              const skillInjection: ChatMessage = {
                role: "user",
                content: [
                  "<system-reminder>",
                  `Skill: ${parsedResult.skillName}`,
                  "",
                  parsedResult.skillPrompt,
                  "",
                  `Task: ${parsedResult.input}`,
                  "</system-reminder>",
                ].join("\n"),
              };
              messages.push(skillInjection);

              console.log(`[AgentRunner] Inline skill injected: ${parsedResult.skillName}`);
            }
          } catch { /* not JSON or not inline skill */ }
        }

        // 5a-err. Error-based stuck detection (before regular stuck detection)
        let interventionMessage: string | null = null;

        // Track consecutive tool errors across all results
        for (const resultMsg of toolResultMessages) {
          const rawResult = typeof resultMsg.content === "string"
            ? resultMsg.content
            : JSON.stringify(resultMsg.content);
          let isError = false;
          try {
            const parsedResult = JSON.parse(rawResult);
            if (parsedResult?.error === true || parsedResult?.error) {
              isError = true;
              consecutiveToolErrors++;
            } else {
              consecutiveToolErrors = 0;
            }
          } catch {
            // Non-JSON result — check for schema validation errors (<tool_use_error>)
            if (rawResult.includes("<tool_use_error>") || rawResult.includes("InputValidationError")) {
              isError = true;
              consecutiveToolErrors++;
            } else {
              consecutiveToolErrors = 0;
            }
          }
          // Record error patterns in StuckDetector for ALL tools (including exempt ones)
          // so that repeated errors on the same tool+input trigger stuck intervention
          if (isError && "toolCallId" in resultMsg) {
            const matchingCall = toolCalls.find(tc => tc.id === resultMsg.toolCallId);
            if (matchingCall) {
              try {
                const parsedInput = JSON.parse(matchingCall.function.arguments);
                const stuckMsg = stuckDetector.recordError(matchingCall.function.name, parsedInput, turn);
                if (stuckMsg && !interventionMessage) {
                  interventionMessage = stuckMsg;
                }
              } catch { /* ignore parse errors */ }
            }
          }
        }

        // Handle tool_discover: dynamically inject deferred tools
        for (const toolCall of toolCalls) {
          if (toolCall.function.name === "tool_discover") {
            // Find the corresponding result message
            const resultMsg = toolResultMessages.find(
              m => "toolCallId" in m && m.toolCallId === toolCall.id
            );
            if (resultMsg) {
              try {
                const rawContent = typeof resultMsg.content === "string"
                  ? resultMsg.content
                  : JSON.stringify(resultMsg.content);
                const parsed = JSON.parse(rawContent);
                if (parsed?.__activate_tools__ && Array.isArray(parsed.__activate_tools__)) {
                  const newDefs = this.toolRegistry.buildToolDefinitions(parsed.__activate_tools__, true);
                  if (newDefs.length > 0) {
                    const existingNames = new Set(toolDefs.map(d => d.name));
                    for (const def of newDefs) {
                      if (!existingNames.has(def.name)) {
                        toolDefs.push(def);
                        existingNames.add(def.name);
                      }
                    }
                    console.log(`[AgentRunner] Dynamically activated ${newDefs.length} tool(s): ${newDefs.map(d => d.name).join(", ")}`);
                  }
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        }

        // 5b. Stuck-loop detection and intervention
        for (const toolCall of toolCalls) {
          let parsedInput: Record<string, unknown>;
          try { parsedInput = JSON.parse(toolCall.function.arguments); } catch { continue; }
          const msg = stuckDetector.recordAndCheck(toolCall.function.name, parsedInput, turn);
          if (msg && !interventionMessage) { interventionMessage = msg; }
        }
        if (interventionMessage) {
          messages.push({ role: "user", content: interventionMessage });
          console.log(`[AgentRunner] Stuck intervention injected at turn ${turn}`);
        }

        // 5b1. Language drift detection — detect if agent switched language after tool calls
        // Only check when user language is Chinese but agent output is mostly English
        if (detectedLang === "zh" && assistantContent && assistantContent.length > 20) {
          const outputLang = detectLanguage(assistantContent);
          if (outputLang === "en") {
            const langReminder = "[提醒] 请使用中文回复。你的输出切换成了英语，请立即切换回中文继续。工具返回的内容可能包含英文，但你的分析和回复必须用中文。";
            messages.push({ role: "user", content: langReminder });
            console.log(`[AgentRunner] Language drift detected at turn ${turn}: user=zh, output=en. Reminder injected.`);
          }
        }

        // 5b2. Search saturation detection — track search tool results
        const SEARCH_TOOLS = new Set(["kb_search", "web_search", "mcp__minimax_websearch__web_search", "wikipedia"]);
        let searchToolCount = 0;
        for (const toolCall of toolCalls) {
          if (SEARCH_TOOLS.has(toolCall.function.name)) {
            searchToolCount++;
            const resultMsg = toolResultMessages.find(
              m => "toolCallId" in m && m.toolCallId === toolCall.id
            );
            if (resultMsg) {
              try {
                const raw = typeof resultMsg.content === "string"
                  ? resultMsg.content
                  : JSON.stringify(resultMsg.content);
                const parsed = JSON.parse(raw);
                searchSaturation.recordSearch(toolCall.function.name, parsed);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
        // Track consecutive search-heavy turns (detect excessive searching without synthesis)
        const synthesisActions = toolCalls.some(tc =>
          !SEARCH_TOOLS.has(tc.function.name) && tc.function.name !== "think" && tc.function.name !== "agent_todo"
        );
        searchSaturation.recordSearchTurn(searchToolCount, synthesisActions);

        const saturationMsg = searchSaturation.checkAndIntervene(detectedLang);
        if (saturationMsg) {
          messages.push({ role: "user", content: saturationMsg });
          console.log(`[AgentRunner] Search saturation detected at turn ${turn}`);
        }

        // 5c. Consecutive tool error intervention
        if (consecutiveToolErrors >= agentSettings.consecutiveErrorThreshold) {
          const errorMsg = detectedLang === "zh"
            ? `[系统提示] 最近 ${consecutiveToolErrors} 次工具调用都返回了错误。\n` +
              `请停止重复相同的操作，尝试以下策略之一：\n` +
              `1. 使用 think 工具分析错误原因，换一种完全不同的方法\n` +
              `2. 如果是外部服务不可用，基于已有信息给出最佳推断\n` +
              `3. 调用 finish 提交当前已有的最佳答案，标注不确定性`
            : `[System-Intervention] The last ${consecutiveToolErrors} tool calls all returned errors.\n` +
              `Please stop repeating the same operation and try one of these strategies:\n` +
              `1. Use the think tool to analyze the error cause, then try a completely different approach\n` +
              `2. If an external service is unavailable, give your best inference based on existing information\n` +
              `3. Call finish to submit your best answer so far, noting the uncertainty`;
          messages.push({ role: "user", content: errorMsg });
          consecutiveToolErrors = 0; // Reset to avoid re-triggering
          console.log(`[AgentRunner] Consecutive error intervention at turn ${turn}`);
        }
      } else {
        messages.push(assistantMessage);

        // Natural termination: model returned text without calling any tools.
        // This means the model considers itself done. End the loop.
        if (assistantContent.trim().length > 0) {
          lastAssistantContent = assistantContent;
          emptyTurnCount = 0; // Reset on successful content

          // Detect leaked tool call patterns in text — this happens when the model
          // outputs tool calls as text instead of using the API's tool calling mechanism.
          // Patterns: <invoke name=...>, <parameter name=...>, [tool_use: name(...)], etc.
          const leakedToolCallPattern = /<(?:invoke|parameter|function_call|tool_call)\s+name\s*=|<(?:minimax|anthropic):tool_call>|\[tool_use:\s*\w+/i;
          const hasLeakedToolCalls = leakedToolCallPattern.test(assistantContent);

          // Short content likely means the model only output thinking/reasoning content.
          // Inject a continuation prompt instead of terminating, to give it another
          // chance to use tools. Also detect leaked tool calls — the model wanted to
          // use tools but output them as text instead.
          // Skip continuation if the task was aborted — let the next turn's cancel
          // check handle termination cleanly without another LLM call.
          if (naturalTerminationResurrections < MAX_NATURAL_TERMINATION_RESURRECTIONS
              && !options.signal?.aborted
              && (assistantContent.length < 50 || hasLeakedToolCalls)) {
            naturalTerminationResurrections++;
            const reason = hasLeakedToolCalls ? "leaked tool calls in text" : `short content (${assistantContent.length} chars)`;
            console.log(
              `[AgentRunner] Natural termination with ${reason} at turn ${turn}, ` +
              `injecting continuation prompt (${naturalTerminationResurrections}/${MAX_NATURAL_TERMINATION_RESURRECTIONS})`,
            );
            const continuationMsg = hasLeakedToolCalls
              ? (detectedLang === "zh"
                ? "你的工具调用没有正确执行——你将工具调用写成了文本而非使用工具调用功能。请使用系统提供的工具调用功能来调用工具（如 web_search、agent_todo 等），不要在文本中描述工具调用。"
                : "Your tool calls were not executed — you wrote tool calls as text instead of using the tool calling feature. Please use the system's tool calling feature to invoke tools (e.g., web_search, agent_todo, etc.), do not describe tool calls in text.")
              : (detectedLang === "zh"
                ? "请继续使用工具完成任务。如果已经得到答案，请调用 finish 工具提交答案。"
                : "Please continue using tools to complete the task. If you already have the answer, call the finish tool to submit it.");
            messages.push({
              role: "user",
              content: continuationMsg,
            });
            continue;
          }

          // Summary-after-work detection: when the model has done extensive tool calls
          // (many turns) but produces a short natural output, it likely summarized
          // instead of outputting full content. Inject a continuation to request full output.
          // The threshold grows with turns: after more work, a longer output is expected
          // (1500 chars after 5 turns is too short; but 1500 chars after 50 turns is fine).
          const summaryThreshold = turn > 20 ? 5000 : 3000;
          if (naturalTerminationResurrections < MAX_NATURAL_TERMINATION_RESURRECTIONS
              && !options.signal?.aborted
              && turn > 5
              && assistantContent.length >= 50
              && assistantContent.length < summaryThreshold
              && !hasLeakedToolCalls) {
            naturalTerminationResurrections++;
            console.log(
              `[AgentRunner] Summary-after-work detected: ${assistantContent.length} chars after ${turn} turns, ` +
              `requesting full output (${naturalTerminationResurrections}/${MAX_NATURAL_TERMINATION_RESURRECTIONS})`,
            );
            messages.push({
              role: "user",
              content: detectedLang === "zh"
                ? "你之前的输出过短，只输出了摘要或总结，没有输出完整的详细内容。请将你收集到的所有信息以文字形式直接输出完整的分析内容，不要压缩、省略或只给出摘要。"
                : "Your previous output was too short — it appears to be a summary rather than the full content. Please output the complete detailed analysis of all the information you have gathered. Do not compress, omit, or provide only a summary.",
            });
            continue;
          }

          // Thinking-only detection: when the model outputs only planning/thinking
          // text (e.g., within olta/thinking tags or just planning prose) without
          // having called any production tools (write_file/edit_file) or finish,
          // the agent should NOT terminate — it hasn't actually produced any output.
          // This prevents the common failure mode where sub-agents plan their work
          // in thinking text but never execute the planned write_file calls.
          // Note: Markdown headings (# title) are excluded for longer content (>500 chars)
          // because writing tasks legitimately start with headings as actual content.
          const startsWithHeading = /^#+\s/.test(assistantContent.trimStart());
          const looksLikeContent = assistantContent.length > 300 && startsWithHeading
            && (assistantContent.match(/\n\n/g) || []).length >= 2; // 2+ paragraph breaks = real content
          const isThinkingOnly = (
            assistantContent.length >= 50
            && assistantContent.length < 10000
            && !progressTracker.hasProducedOutput
            && !agentCalledFinish
            && !looksLikeContent
            && !startsWithHeading
            && (
              /<thinking|<altra|<!--.*-->|^\s*让?我|^\s*我需要|^\s*首先|^\s*用户要求/i.test(assistantContent.trimStart().substring(0, 30))
              || /^(好的|我将|让我|首先|我已|我已经|我需要|现在|接下来|让我先|我应该)/.test(assistantContent.trimStart().substring(0, 10))
            )
          );
          if (naturalTerminationResurrections < MAX_NATURAL_TERMINATION_RESURRECTIONS
              && isThinkingOnly) {
            naturalTerminationResurrections++;
            console.log(
              `[AgentRunner] Thinking-only termination detected: ${assistantContent.length} chars at turn ${turn}, ` +
              `no production tools used. Injecting write prompt (${naturalTerminationResurrections}/${MAX_NATURAL_TERMINATION_RESURRECTIONS})`,
            );
            messages.push({
              role: "user",
              content: detectedLang === "zh"
                ? "你之前的输出只是规划或思考，没有实际产出任何内容。请立即开始执行：使用 write_file 将你的工作成果写入文件，然后调用 finish 提交结果。不要再做更多的规划或探索。"
                : "Your previous output was only planning or thinking — no actual content was produced. Please start executing now: use write_file to write your work output to a file, then call finish to submit. Do not do more planning or exploration.",
            });
            continue;
          }

          // Degenerate repetition detection: when the model generates a very long
          // text-only output with massive paragraph-level repetition, it's stuck in
          // a planning loop. Resurrect with a gentle hint to use tools.
          // This only triggers when ALL three conditions are met:
          //   1. No tool calls in this turn
          //   2. Text is very long (> 8000 chars)
          //   3. The same paragraph appears 5+ times (exact fingerprint match)
          // This is extremely conservative — legitimate reports have diverse content
          // and will never trigger this. Only pure degenerate loops qualify.
          if (naturalTerminationResurrections < MAX_NATURAL_TERMINATION_RESURRECTIONS
              && assistantContent.length > 8000
              && !hasLeakedToolCalls
              && this.hasMassiveRepetition(assistantContent)) {
            naturalTerminationResurrections++;
            repetitionDetectedPenalty = 0.1; // Gentle frequency_penalty for next turn
            console.log(
              `[AgentRunner] Degenerate repetition detected: ${assistantContent.length} chars with repeated paragraphs at turn ${turn}, ` +
              `injecting tool-use hint (${naturalTerminationResurrections}/${MAX_NATURAL_TERMINATION_RESURRECTIONS})`,
            );
            messages.push({
              role: "user",
              content: detectedLang === "zh"
                ? "你的输出中存在大段重复内容，请关注是否存在重复生成，继续推进任务。"
                : "Your output contains large repeated sections. Please check for repeated generation and continue progressing the task.",
            });
            continue;
          }

          // Check for pending user messages before terminating.
          // If the user injected a message while the agent was generating its final
          // response, we should process it instead of ending the loop.
          const pendingBeforeExit = execCtx.pendingUserMessages as
            | Array<{ role: "user"; content: string }>
            | undefined;
          if (pendingBeforeExit && pendingBeforeExit.length > 0) {
            console.log(
              `[AgentRunner] Natural termination at turn ${turn}, but ${pendingBeforeExit.length} pending user message(s) found. Continuing.`,
            );
            hadInjectedMessages = true;
            for (const msg of pendingBeforeExit) {
              messages.push(msg);
            }
            pendingBeforeExit.length = 0;
            this.emitEvent(options.onEvent, {
              type: "progress",
              taskId,
              progress: {
                turn,
                timestamp: new Date().toISOString(),
                type: "text",
                content: `[用户追加了新消息，Agent将继续处理]`,
                toolName: "system",
                toolInput: {},
                toolOutput: null,
              },
            });
            continue;
          }

          // Check for active background workflows before terminating.
          // If sub-agents are still running, keep the loop alive to receive their results.
          // Sub-agents must skip this check — they share the parent's sessionId.
          if (featureFlags.backgroundWorkflows && !isWorkflowSubAgent) {
            try {
              const { getWorkflowManager } = await import("./workflow-manager.js");
              const wm = getWorkflowManager();
              const activeSessionId = execCtx.sessionId as string | undefined;
              if (activeSessionId && wm.hasActive(activeSessionId)) {
                console.log(
                  `[AgentRunner] Natural termination at turn ${turn}, but background workflow(s) still active. Continuing to wait.`,
                );
                // Don't count idle-wait polls as actual turns; decrement the turn++ from loop top
                turn--;
                // Don't call LLM — just loop back to poll for workflow completion
                await new Promise(r => setTimeout(r, 500));
                continue;
              }
            } catch { /* best effort */ }
          }

          console.log(`[AgentRunner] Natural termination at turn ${turn} (no tool calls, ${assistantContent.length} chars)`);
          break;
        } else {
          // Model returned empty content with no tool calls.
          // This can happen when the API returns degenerate responses (rate limiting, insufficient balance, etc.)
          // Track consecutive empty turns and attempt model fallback before terminating.
          emptyTurnCount++;

          // On first consecutive empty turn, try switching to fallback model immediately
          // (previously waited until 2nd empty turn, which wastes one of the 3 allowed attempts)
          if (emptyTurnCount === 1 && !usingFallback) {
            try {
              let fallbackModelId = this.modelRouter.getDefaultModel(fallbackRole);
              // If the configured fallback is the same as the primary, find a different provider.
              if (fallbackModelId === modelId) {
                const alternate = this.modelRouter.getAlternateChatModel(modelId);
                if (alternate) {
                  console.warn(`[AgentRunner] Empty response: configured fallback is same as primary (${modelId}), using alternate: ${alternate}`);
                  fallbackModelId = alternate;
                }
              }
              if (fallbackModelId !== modelId) {
                console.warn(`[AgentRunner] Empty response fallback: switching from ${modelRole}(${modelId}) to ${fallbackRole}(${fallbackModelId}) at turn ${turn}`);
                modelId = fallbackModelId;
                usingFallback = true;
                // Don't increment naturalTerminationResurrections for this switch
                messages.push({
                  role: "user",
                  content: detectedLang === "zh"
                    ? "主模型暂时不可用，已切换到备用模型。请继续使用工具完成任务。"
                    : "Primary model unavailable, switched to backup. Please continue using tools to complete the task.",
                });
                continue;
              }
            } catch {
              // Fallback resolution failed — continue with existing model
            }
          }

          if (emptyTurnCount >= 3) {
            console.log(`[AgentRunner] ${emptyTurnCount} consecutive empty turns at turn ${turn}, terminating`);
            break;
          }
          console.log(`[AgentRunner] Empty response with no tool calls at turn ${turn} (${emptyTurnCount}/3)`);

          // Remove the empty assistant message to avoid accumulating them in context
          if (messages.length > 0 && messages[messages.length - 1]!.role === "assistant" &&
              (!messages[messages.length - 1]!.content || String(messages[messages.length - 1]!.content).trim() === "")) {
            messages.pop();
          }

          // Inject a continuation prompt to try to recover
          if (naturalTerminationResurrections < MAX_NATURAL_TERMINATION_RESURRECTIONS) {
            naturalTerminationResurrections++;
            messages.push({
              role: "user",
              content: detectedLang === "zh"
                ? "你刚才的回复为空。请使用工具完成任务，或调用 finish 工具提交答案。"
                : "Your previous response was empty. Please use tools to complete the task, or call the finish tool to submit your answer.",
            });
          }
        }
      }

      // 6. Context management
      // 6a. Microcompact — use token-aware pruning when possible
      if (contextManager.shouldMicrocompact(messages)) {
        if (featureFlags.contextCollapse && collapseStore) {
          // Context Collapse path: create collapse entries for pruned ranges
          const ranges = microCompactor.identifyPrunedRanges(messages, {
            keepRecent: agentSettings.toolResultKeepRecent,
            maxTokens: agentSettings.toolResultMaxTokens,
            modelRouter: this.modelRouter,
          });
          for (const range of ranges) {
            // Skip ranges already covered by an existing collapse entry
            if (collapseStore.isRangeCovered(range.startIndex, range.endIndex)) {
              continue;
            }
            // Create a placeholder replacement for the pruned range
            const placeholderMsgs: ChatMessage[] = [];
            for (let ri = range.startIndex; ri < range.endIndex; ri++) {
              const origMsg = messages[ri]!;
              if (origMsg.role === "tool") {
                placeholderMsgs.push({
                  ...origMsg,
                  content: `[Tool result pruned to save context — use context_expand to restore]`,
                });
              } else {
                placeholderMsgs.push(origMsg);
              }
            }
            collapseStore.createCollapse(
              range.startIndex, range.endIndex,
              placeholderMsgs,
              "micro-collapse",
              range.originalTokens, 50, turn,
              { messageCount: range.endIndex - range.startIndex },
            );
          }
        } else {
          // Legacy path: mutate messages in place
          const result = microCompactor.prune(messages, {
            keepRecent: agentSettings.toolResultKeepRecent,
            maxTokens: agentSettings.toolResultMaxTokens,
            modelRouter: this.modelRouter,
          });
          if (result.prunedCount > 0) {
            messages.length = 0;
            messages.push(...result.messages);
          }
        }
      }

      // 6a-2. C3.6: Proactive compaction — lightweight middle compression before hitting hard threshold
      // Two triggers:
      //   A) Static ratio: context is between 70-85% of effective window
      //   B) Predictive: token growth rate suggests context will be full within HORIZON turns
      // When triggered, compress only the middle portion, preserving early instructions and recent work.
      {
        const contextInfo = contextManager.getContextWindow();
        const currentTokens = contextManager.estimateMessagesTokens(messages);
        const ratio = contextInfo.effectiveWindow > 0
          ? currentTokens / contextInfo.effectiveWindow
          : 0;

        const inProactiveRange = ratio >= (agentSettings.proactiveCompactLowerRatio ?? PROACTIVE_COMPACT_LOWER_RATIO) && ratio < (agentSettings.proactiveCompactUpperRatio ?? PROACTIVE_COMPACT_UPPER_RATIO);
        const predictedOverflow = tokenGrowthTracker.shouldTriggerEarlyCompaction(
          currentTokens, contextInfo.effectiveWindow,
        );
        const notTooSoon = (turn - lastProactiveCompactionTurn) >= PROACTIVE_COMPACT_MIN_INTERVAL_TURNS;
        const notAtHardThreshold = !contextManager.shouldCompact(messages);

        const shouldProactive = (inProactiveRange || predictedOverflow) && notTooSoon && notAtHardThreshold && messages.length > 6;

        if (shouldProactive) {
          // Adjust compaction range based on growth aggressiveness
          const aggressiveness = tokenGrowthTracker.getAggressivenessFactor();
          // Need enough messages to have a meaningful middle section
          // Find the middle third indices for compactMiddle
          const systemMsgCount = 1; // system prompt at index 0
          // Higher aggressiveness → keep fewer recent messages → compress more
          // Keep at least 3 recent messages (1-2 tool-call rounds) to preserve working context
          // while still allowing meaningful compaction to free up space
          const recentRatio = 0.2 * aggressiveness;
          const recentCount = Math.max(3, Math.min(6, Math.floor(messages.length * recentRatio)));
          const fromIndex = systemMsgCount + 1; // start after system prompt + first exchange
          const toIndex = messages.length - recentCount;

          const triggerReason = predictedOverflow ? "predictive" : "ratio";
          const growthRate = tokenGrowthTracker.getGrowthRate();

          if (toIndex > fromIndex + 1) {
            console.log(
              `[AgentRunner] C3.6: Proactive compaction at turn ${turn} (trigger: ${triggerReason}, ` +
              `context ratio: ${(ratio * 100).toFixed(1)}%, growth: ${Math.round(growthRate)} tokens/turn, ` +
              `aggressiveness: ${aggressiveness.toFixed(2)}, tokens: ${currentTokens}/${contextInfo.effectiveWindow}, ` +
              `range: [${fromIndex}, ${toIndex})`,
            );
            try {
              if (featureFlags.contextCollapse && collapseStore) {
                // Context Collapse path: create collapse entry
                const collapseInfo = await compactionEngine.generateMiddleSummary(messages, fromIndex, toIndex, options.signal);
                if (collapseInfo) {
                  // Post-compact: inject recently read files and skills
                  const recentMsgs = messages.slice(collapseInfo.endIndex);
                  collapseInfo.replacementMessages = injectPostCompactFilesForCollapse(
                    collapseInfo.replacementMessages, recentMsgs,
                    readFileState, this.modelRouter, agentSettings, invokedSkills,
                  );
                  const entry = collapseStore.createCollapse(
                    collapseInfo.startIndex, collapseInfo.endIndex,
                    collapseInfo.replacementMessages, "proactive-collapse",
                    collapseInfo.originalTokens, collapseInfo.replacementTokens, turn,
                    { messageCount: collapseInfo.endIndex - collapseInfo.startIndex },
                  );
                  if (entry) {
                    lastProactiveCompactionTurn = turn;
                    const tokensSaved = entry.originalTokens - entry.replacementTokens;
                    compactionEvents.push({ turn, method: "proactive-collapse", tokensSaved });
                    this.emitEvent(options.onEvent, { type: "compaction", taskId, turn, method: "proactive-collapse", tokensSaved });
                    this.persistCompactBoundary(options.sessionId, "proactive-collapse" as CompactBoundaryMeta["method"], collapseInfo.originalTokens, turn, taskId);
                    console.log(`[AgentRunner] C3.6: Proactive collapse complete: saved ${tokensSaved} tokens`);
                    // Post-compact cleanup
                    const totalTokensForCleanup = totalInputTokens + totalOutputTokens;
                    await runPostCompactCleanup(readFileState, sessionMemory, messages, totalTokensForCleanup, { tokenEstimator: this.tokenEstimator, collapseStore, searchSaturation, hookManager: this.hookManager ?? undefined });
                  }
                }
              } else {
                // Legacy path: mutate messages in place
                let result = await compactionEngine.compactMiddle(messages, fromIndex, toIndex, options.signal);
                if (result.method !== "none") {
                  // Post-compact: re-inject recently read files and skills
                  result = injectPostCompactFiles(result, readFileState, this.modelRouter, agentSettings, invokedSkills);
                  messages.length = 0;
                  messages.push(...result.messages);
                  lastProactiveCompactionTurn = turn;
                  compactionEvents.push({ turn, method: `proactive-${result.method}`, tokensSaved: result.tokensSaved });
                  this.emitEvent(options.onEvent, {
                    type: "compaction",
                    taskId,
                    turn,
                    method: `proactive-${result.method}`,
                    tokensSaved: result.tokensSaved,
                  });
                  this.persistCompactBoundary(options.sessionId, `proactive-${result.method}` as CompactBoundaryMeta["method"], result.preCompactTokens, turn, taskId);
                  console.log(
                    `[AgentRunner] C3.6: Proactive compaction complete: saved ${result.tokensSaved} tokens (method: ${result.method})`,
                  );
                  // Post-compact cleanup
                  const totalTokensForCleanup = totalInputTokens + totalOutputTokens;
                  await runPostCompactCleanup(readFileState, sessionMemory, messages, totalTokensForCleanup, { tokenEstimator: this.tokenEstimator, collapseStore, searchSaturation, hookManager: this.hookManager ?? undefined });
                }
              }
            } catch (err) {
              console.warn("[AgentRunner] C3.6: Proactive compaction failed:", err instanceof Error ? err.message : String(err));
              // Non-fatal: full compaction will catch this if context continues to grow
            }
          }
        }
      }

      // 6b. Auto-compaction
      if (contextManager.shouldCompact(messages)) {
        // PreCompact hook — can block compaction
        let compactAllowed = true;
        if (this.hookManager) {
          try {
            const preResult = await this.hookManager.fire("PreCompact", {
              hookType: "PreCompact",
              taskId,
            });
            if (!preResult.allowed) {
              compactAllowed = false;
              console.log(`[AgentRunner] Compaction blocked by PreCompact hook: ${preResult.error ?? "no reason given"}`);
            }
          } catch {
            // Hook error — allow compaction to proceed
          }
        }

        if (compactAllowed) {
          try {
            if (featureFlags.contextCollapse && collapseStore) {
              // Context Collapse path: create collapse entry instead of mutating messages
              const collapseInfo = await compactionEngine.generateCollapseSummary(messages, sessionMemory, options.signal);
              if (collapseInfo) {
                // Post-compact: inject recently read files and skills into collapse replacement messages
                const recentMsgs = messages.slice(collapseInfo.endIndex);
                collapseInfo.replacementMessages = injectPostCompactFilesForCollapse(
                  collapseInfo.replacementMessages, recentMsgs,
                  readFileState, this.modelRouter, agentSettings, invokedSkills,
                );
                const entry = collapseStore.createCollapse(
                  collapseInfo.startIndex, collapseInfo.endIndex,
                  collapseInfo.replacementMessages,
                  collapseInfo.method,
                  collapseInfo.originalTokens, collapseInfo.replacementTokens, turn,
                  { messageCount: collapseInfo.endIndex - collapseInfo.startIndex },
                );
                if (entry) {
                  const tokensSaved = entry.originalTokens - entry.replacementTokens;
                  compactionEvents.push({ turn, method: entry.method, tokensSaved });
                  this.emitEvent(options.onEvent, { type: "compaction", taskId, turn, method: entry.method, tokensSaved });
                  this.persistCompactBoundary(options.sessionId, entry.method as CompactBoundaryMeta["method"], collapseInfo.originalTokens, turn, taskId);
                  console.log(`[AgentRunner] Collapse complete: saved ${tokensSaved} tokens (method: ${entry.method})`);

                  // Quality audit: check summary preserves identifiers
                  // If identifiers are missing, inject a compact reminder to prevent context loss
                  const summaryText = collapseInfo.replacementMessages.map(m =>
                    typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
                  ).join("\n");
                  const missingIds = auditSummaryQuality(messages.slice(collapseInfo.startIndex, collapseInfo.endIndex), summaryText);
                  if (missingIds.length > 0) {
                    // Deduplicate and limit to most important identifiers (paths and UUIDs first)
                    const uniqueIds = [...new Set(missingIds)];
                    const pathIds = uniqueIds.filter(id => id.includes("/") || id.includes("\\"));
                    const uuidIds = uniqueIds.filter(id => /[0-9a-f]{8}-/.test(id));
                    const otherIds = uniqueIds.filter(id => !pathIds.includes(id) && !uuidIds.includes(id));
                    const prioritized = [...pathIds, ...uuidIds, ...otherIds].slice(0, 300);
                    if (prioritized.length > 0) {
                      messages.push({
                        role: "user",
                        content: `[上下文压缩后保留的关键标识符]\n${prioritized.join("\n")}\n以上是压缩前上下文中的关键路径和标识符，如需回引请使用。`,
                      });
                    }
                  }
                  // Post-compact cleanup: clear readFileState and update session memory
                  const totalTokensForCleanup = totalInputTokens + totalOutputTokens;
                  await runPostCompactCleanup(readFileState, sessionMemory, messages, totalTokensForCleanup, { tokenEstimator: this.tokenEstimator, collapseStore, searchSaturation, hookManager: this.hookManager ?? undefined });
                }
              }
            } else {
              // Legacy path: mutate messages in place
              let result = await compactionEngine.compact(messages, sessionMemory, options.signal);
              if (result.method !== "none") {
                // Quality audit: check summary preserves identifiers
                // Only audit the messages that were actually compacted (skip system + recent)
                const compactedCount = messages.length - result.messages.length;
                const compactedMessages = compactedCount > 0 ? messages.slice(0, Math.min(compactedCount + 1, messages.length)) : [...messages];
                const summaryText = result.messages.slice(0, 2).map(m =>
                  typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
                ).join("\n");
                const missingIds = auditSummaryQuality(compactedMessages, summaryText);

                // Post-compact: re-inject recently read files and skills
                result = injectPostCompactFiles(result, readFileState, this.modelRouter, agentSettings, invokedSkills);
                messages.length = 0;
                messages.push(...result.messages);

                // Inject missing identifiers as a compact reminder
                if (missingIds.length > 0) {
                  const uniqueIds = [...new Set(missingIds)];
                  const pathIds = uniqueIds.filter(id => id.includes("/") || id.includes("\\"));
                  const uuidIds = uniqueIds.filter(id => /[0-9a-f]{8}-/.test(id));
                  const otherIds = uniqueIds.filter(id => !pathIds.includes(id) && !uuidIds.includes(id));
                  const prioritized = [...pathIds, ...uuidIds, ...otherIds].slice(0, 300);
                  if (prioritized.length > 0) {
                    messages.push({
                      role: "user",
                      content: `[上下文压缩后保留的关键标识符]\n${prioritized.join("\n")}\n以上是压缩前上下文中的关键路径和标识符，如需回引请使用。`,
                    });
                  }
                }
                compactionEvents.push({ turn, method: result.method, tokensSaved: result.tokensSaved });
                this.emitEvent(options.onEvent, {
                  type: "compaction",
                  taskId,
                  turn,
                  method: result.method,
                  tokensSaved: result.tokensSaved,
                });
                // Persist compact boundary to DB so next request knows where to load from
                this.persistCompactBoundary(options.sessionId, result.method as CompactBoundaryMeta["method"], result.preCompactTokens, turn, taskId);

                // PostCompact hook — fire-and-forget
                if (this.hookManager) {
                  await this.hookManager.fire("PostCompact", {
                    hookType: "PostCompact",
                    taskId,
                  }).catch(() => {});
                }

                // Post-compact cleanup: clear readFileState and update session memory
                const totalTokensForCleanup = totalInputTokens + totalOutputTokens;
                await runPostCompactCleanup(readFileState, sessionMemory, messages, totalTokensForCleanup, { tokenEstimator: this.tokenEstimator, collapseStore, searchSaturation, hookManager: this.hookManager ?? undefined });
              }
            }
          } catch (err) {
            console.warn("[AgentRunner] Compaction failed:", err instanceof Error ? err.message : String(err));
          }
        }
      }

      // 6c. Session Memory update — async background extraction (non-blocking)
      // Trigger async session memory extraction in background.
      // On the NEXT turn, the already-extracted memory will be used.
      if (sessionMemory && asyncMemoryExtractor && messages.length > 0) {
        const totalTokens = totalInputTokens + totalOutputTokens;
        asyncMemoryExtractor.tryExtract(totalTokens, async () => {
          const memory = await sessionMemory.load();
          // C3.5: Append search result index detailed summary so memory extraction
          // can include what has already been searched (with snippets).
          // C3.3: Also inject programmatic keyword list for dedup guidance.
          const searchSummary = searchResultIndex.getDetailedSummary();
          const keywordList = searchResultIndex.getKeywordList();
          const extraContext = [searchSummary, keywordList].filter(Boolean).join("\n\n");
          const messagesWithContext = extraContext
            ? [...messages, { role: "user" as const, content: extraContext }]
            : messages;
          if (!memory && sessionMemory.shouldInitialize(totalTokens)) {
            const newMemory = await sessionMemory.initialize(messagesWithContext, options.signal);
            newMemory.lastTokenPosition = totalTokens;
            // C3.5: Persist search result index to DB for cross-turn continuity
            if (searchResultIndex.count > 0) {
              newMemory.searchIndexJson = JSON.stringify(searchResultIndex.getEntries());
            }
            await sessionMemory.save(newMemory);
            // Note: prompt injection update happens on next turn load, not here
          } else if (memory && sessionMemory.shouldUpdate(totalTokens, memory)) {
            // C3.5: Update search index JSON before saving
            if (searchResultIndex.count > 0) {
              memory.searchIndexJson = JSON.stringify(searchResultIndex.getEntries());
            }
            await sessionMemory.update(memory, messagesWithContext, totalTokens, options.signal);
            // Note: prompt injection update happens on next turn load, not here
          }
        }, totalToolCalls);
      }

      // 7. Completion check — only explicit finish tool call terminates the loop.
      // The hard turn limit (hardLimit) prevents infinite loops. The model
      // re-evaluates context on each turn and will eventually call finish.
      // Exception: if the agent called finish with only planning/thinking content
      // and hasn't produced any real output, resurrect it (premature finish).
      if (agentCalledFinish && naturalTerminationResurrections < MAX_NATURAL_TERMINATION_RESURRECTIONS) {
        const finishText = assistantContent || finishSummaryContent || "";
        const hasRealOutput = progressTracker.hasProducedOutput
          || pushedContentItems.length > 0
          || pushedContentAccum.trim().length > 100;
        // Check if accumulatedContent has substantial non-planning text
        const accumLooksLikeOutput = accumulatedContent.trim().length > 200
          && !/^(好的|我将|让我|首先|我已|我已经|我需要|现在|接下来|让我先|我应该|我现在)/.test(accumulatedContent.trimStart().substring(0, 10));
        const finishIsPlanning = finishText.length < 500 && (
          /^(好的|我将|让我|首先|我已|我已经|我需要|现在|接下来|让我先|我应该|我现在)/.test(finishText.trimStart().substring(0, 10))
          || /策略|计划|步骤|将采取|将使用|委派|分批|并行|逐步|规划/.test(finishText.substring(0, 100))
        );
        if (!options.signal?.aborted && !hasRealOutput && !accumLooksLikeOutput && finishIsPlanning) {
          naturalTerminationResurrections++;
          agentCalledFinish = false; // Reset so the loop continues
          console.log(
            `[AgentRunner] Premature finish detected: ${finishText.length} chars at turn ${turn}, ` +
            `no real output produced. Injecting continuation prompt (${naturalTerminationResurrections}/${MAX_NATURAL_TERMINATION_RESURRECTIONS})`,
          );
          messages.push({
            role: "user",
            content: detectedLang === "zh"
              ? "你刚才调用了 finish 但没有产出任何实际内容（只有规划文本）。请立即开始实际分析和输出：直接输出你的分析结果，或使用 push_content/write_file 写出内容，然后调用 finish。不要再做更多规划。"
              : "You called finish but produced no actual content (only planning text). Please start producing real output now: output your analysis directly, or use push_content/write_file to write content, then call finish. Do not plan more.",
          });
          continue;
        }
      }
      // Check for pending user messages before the final isDone check.
      // This handles the case where the agent called `finish` while the user
      // injected a message mid-stream. Without this check, the injected message
      // would be silently discarded because isDone() returns true immediately.
      const pendingBeforeFinish = execCtx.pendingUserMessages as
        | Array<{ role: "user"; content: string }>
        | undefined;
      if (pendingBeforeFinish && pendingBeforeFinish.length > 0) {
        console.log(
          `[AgentRunner] Agent called finish at turn ${turn}, but ${pendingBeforeFinish.length} pending user message(s) found. Continuing.`,
        );
        hadInjectedMessages = true;
        for (const msg of pendingBeforeFinish) {
          messages.push(msg);
        }
        pendingBeforeFinish.length = 0;
        agentCalledFinish = false; // Reset so the loop continues
        this.emitEvent(options.onEvent, {
          type: "progress",
          taskId,
          progress: {
            turn,
            timestamp: new Date().toISOString(),
            type: "text",
            content: `[用户追加了新消息，Agent将继续处理]`,
            toolName: "system",
            toolInput: {},
            toolOutput: null,
          },
        });
        continue;
      }
      if (this.isDone(assistantContent, toolCalls, finishReason, agentCalledFinish)) {
        break;
      }

    }

    // Build final result — select the best output from all available sources.
    // The model should output its answer as text (visible to user), then call finish.
    // Priority: pushedContent > accumulatedContent > lastAssistantContent > finishSummary
    // finishSummary is a completion note, NOT the primary answer.
    // Exception: if accumulated content looks like thinking (not real output), prefer finishSummary.
    let bestOutput = "";

    // Check if content looks like model thinking/reasoning rather than actual output
    const isThinkingContent = (text: string): boolean => {
      const trimmed = text.trimStart();
      // Thinking typically starts with < or \n and contains reasoning markers
      if (trimmed.startsWith('<')) return true;
      if (trimmed.startsWith('\n') && (
        trimmed.includes('We need to') ||
        trimmed.includes('Let me') ||
        trimmed.includes('I need to') ||
        trimmed.includes("I've tried") ||
        trimmed.includes('I have spent')
      )) return true;
      // Chinese planning/thinking patterns — match common planning intros
      // that indicate the model is reasoning rather than producing output
      const first50 = trimmed.substring(0, 50);
      if (/^(好的|我将|让我|首先|我已|我已经|我需要|现在|接下来|让我先|我应该|我现在)/.test(trimmed.substring(0, 10))) {
        // Additional check: planning text typically contains strategy/plan keywords
        if (first50.includes('策略') || first50.includes('计划') || first50.includes('步骤') ||
            first50.includes('将采取') || first50.includes('将使用') || first50.includes('委派') ||
            first50.includes('分批') || first50.includes('并行') || first50.includes('逐步') ||
            first50.includes('规划')) {
          return true;
        }
      }
      return false;
    };

    if (pushedContentItems.length > 1) {
      // Multiple push_content calls — concatenate all items
      bestOutput = pushedContentItems.join("\n\n---\n\n");
    } else if (pushedContentAccum.trim().length > 50) {
      // Single push_content (or fallback to largest) — highest quality
      bestOutput = pushedContentAccum;
    } else if (accumulatedContent.trim().length > 20 && !isThinkingContent(accumulatedContent)) {
      // Agent output its answer as text — this is the primary output
      bestOutput = accumulatedContent;
    } else if (lastAssistantContent.trim().length > 20 && !isThinkingContent(lastAssistantContent)) {
      // Last turn's text output
      bestOutput = lastAssistantContent;
    } else if (finishSummaryContent.trim().length > 0) {
      // Fallback: use finish summary (the model may have put answer here instead of text)
      bestOutput = finishSummaryContent;
    } else {
      // Last resort: use accumulated content even if it looks like thinking
      bestOutput = accumulatedContent || lastAssistantContent;
    }
    const result = await this.buildResult(taskId, bestOutput, messages, totalToolCalls, turn, totalInputTokens, totalOutputTokens, compactionEvents, undefined, options.onEvent, isWorkflowSubAgent, costTracker);

    // Attach finish summary and files written for sub-agent output routing
    if (finishSummaryContent) {
      result.finishSummary = finishSummaryContent;
    }
    if (writtenFilePaths.size > 0) {
      result.filesWritten = [...writtenFilePaths.keys()];
    }

    // Execution summary log
    const subAgentLabel = isWorkflowSubAgent ? " [sub-agent]" : "";
    const costLabel = costTracker.hasPricing ? `, cost=$${costTracker.totalCostUsd.toFixed(4)}` : "";
    console.log(
      `[AgentRunner]${subAgentLabel} Run complete: taskId=${taskId}, turns=${turn}, toolCalls=${totalToolCalls}, ` +
      `tokens=${totalInputTokens}+${totalOutputTokens}, model=${modelId}, fallback=${usingFallback}${costLabel}`
    );

    // Auto-compound on task completion — emit event and write back to wiki
    const finalOutput = result.output;
    const kbId = options.kbId;
    if (finalOutput && finalOutput.trim().length >= 100 && kbId) {
      try {
        const { eventBus } = await import("../event-bus.js");
        eventBus.emit({
          type: "agent_task_complete",
          sessionId: options.sessionId ?? "",
          taskId,
          agentType,
          output: finalOutput,
        });

        const { KnowledgeCompounder, compoundWithAnchors } = await import("../../wiki/knowledge-compound.js");
        const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
        const compounder = new KnowledgeCompounder(DEEPANALYZE_CONFIG.dataDir);
        const anchorData = Array.from(accessedPages.values())
          .filter(p => p.anchorId && p.docId)
          .map(p => ({
            anchorId: p.anchorId!,
            docId: p.docId!,
            originalName: p.originalName ?? p.docId ?? p.pageId,
            sectionTitle: p.sectionTitle ?? null,
            pageNumber: p.pageNumber ?? null,
            role: "supporting" as const,
          }));
        if (anchorData.length > 0) {
          const anchorContent = compoundWithAnchors(kbId, agentType, options.input, finalOutput, anchorData);
          if (anchorContent) {
            await compounder.compoundAgentResult(kbId, agentType, options.input, finalOutput + "\n\n" + anchorContent);
          }
        } else {
          await compounder.compoundWithTracing(
            kbId, agentType, options.input, finalOutput,
            Array.from(accessedPages.values()).map(p => ({ pageId: p.pageId, title: p.title })),
          );
        }
      } catch (err) {
        console.warn("[AgentRunner] Auto-compound failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // Fire Stop hook (agent ending normally, fire-and-forget)
    if (this.hookManager) {
      await this.hookManager.fireStop(taskId).catch(() => {});
    }

    // Fire AgentComplete hook (fire-and-forget)
    if (this.hookManager) {
      await this.hookManager.fire("AgentComplete", {
        hookType: "AgentComplete",
        taskId,
      }).catch(() => {});
    }

    // Close JSONL writer — flush all buffered entries
    await this.closeJsonlWriter(taskId);

    return result;
  }

  // -----------------------------------------------------------------------
  // Chat with automatic model fallback
  // -----------------------------------------------------------------------

  /**
   * Call the LLM with automatic fallback to the alternate model role
   * if the primary model fails. On fallback success, updates the caller's
   * modelId and usingFallback via the onFallback callback so subsequent
   * turns use the fallback model directly.
   */
  private async chatWithFallback(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    options: AgentRunOptions,
    modelId: string,
    modelRole: string,
    fallbackRole: ModelRole,
    usingFallback: boolean,
    onFallback: (newModelId: string) => void,
  ): Promise<ChatResponse> {
    try {
      return await this.modelRouter.chat(messages, {
        model: modelId,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        signal: options.signal,
      });
    } catch (primaryError) {
      const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
      // Try fallback model if not already using it
      if (!usingFallback) {
        try {
          let fallbackModelId = this.modelRouter.getDefaultModel(fallbackRole);
          // If the configured fallback is the same as the primary, find a different provider.
          if (fallbackModelId === modelId) {
            const alternate = this.modelRouter.getAlternateChatModel(modelId);
            if (alternate) {
              console.warn(`[AgentRunner] chatWithFallback: configured fallback is same as primary (${modelId}), using alternate: ${alternate}`);
              fallbackModelId = alternate;
            } else {
              console.warn(`[AgentRunner] Primary model (${modelRole}: ${modelId}) failed, no alternate provider available. Error: ${primaryMsg}`);
              throw primaryError;
            }
          }
          console.warn(`[AgentRunner] Primary model (${modelRole}: ${modelId}) failed (${primaryMsg.substring(0, 200)}), switching to fallback (${fallbackRole}: ${fallbackModelId})`);
          onFallback(fallbackModelId);
          return await this.modelRouter.chat(messages, {
            model: fallbackModelId,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            signal: options.signal,
          });
        } catch (fallbackError) {
          const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          if (fallbackMsg !== primaryMsg) {
            console.warn(`[AgentRunner] Fallback model (${fallbackRole}) also failed: ${fallbackMsg.substring(0, 200)}`);
          }
          throw primaryError;
        }
      }
      throw primaryError;
    }
  }

  // -----------------------------------------------------------------------
  // Streaming: consume stream + stream with fallback
  // -----------------------------------------------------------------------

  /**
   * Consume an AsyncGenerator<StreamChunk>, emitting text_delta events for
   * each content chunk and accumulating the full result.
   *
   * R4.1: When speculativeTools and speculativeExecuteFn are provided, tool
   * execution starts mid-stream. Tool N begins executing as soon as its
   * arguments are complete (signaled by the arrival of the next tool_call
   * chunk or the done chunk), while the model is still streaming arguments
   * for tool N+1.
   */
  private async consumeStream(
    stream: AsyncGenerator<StreamChunk>,
    onEvent: ((event: AgentEvent) => void) | undefined,
    taskId: string,
    turn: number,
    speculativeTools?: Map<string, AgentTool>,
    speculativeExecuteFn?: (toolCall: ToolCall) => Promise<ChatMessage>,
  ): Promise<{ content: string; toolCalls: ToolCall[]; finishReason?: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number }; speculativeToolResults?: ChatMessage[]; reasoningDetails?: unknown[] }> {
    let fullContent = "";
    const toolCallMap = new Map<number, ToolCall>();
    let finishReason: string | undefined;
    let usage: { inputTokens: number; outputTokens: number; cachedTokens?: number } | undefined;
    let reasoningDetails: unknown[] | undefined;

    // R4.1: Speculative tool execution — start tools mid-stream
    let streamingExecutor: StreamingToolExecutor | null = null;
    let currentTcId: string | null = null;

    // L1: Track whether we're inside an embedded <think/> block to strip it from output.
    // Some models (e.g. GLM) emit thinking as text within <think/>...</think/> tags rather
    // than using the API-level extended thinking. This filter strips those blocks from the
    // user-visible content stream while still accumulating the full text for tool call parsing.
    let insideThinkBlock = false;
    let thinkBuffer = "";

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "text":
          if (chunk.content) {
            fullContent += chunk.content;

            // L1: Strip embedded <think/> blocks from user-visible output.
            // Some models (e.g. GLM) emit reasoning within <think/> tags in their text output.
            // We track state across chunks and emit only non-thinking text as text_delta.
            thinkBuffer += chunk.content;
            const { visible, thinking, inside: newInside, remaining } = extractNonThinkingText(thinkBuffer, insideThinkBlock);
            insideThinkBlock = newInside;
            thinkBuffer = remaining;
            // Emit thinking content from <think/> tags as thinking_delta
            // so it is visible in the UI and persisted alongside API-level reasoning.
            if (thinking) {
              this.emitEvent(onEvent, { type: "thinking_delta", taskId, turn, delta: thinking });
            }
            if (visible) {
              this.emitEvent(onEvent, { type: "text_delta", taskId, turn, delta: visible });
            }
          }
          break;
        case "thinking":
          // Reasoning content — emit as thinking_delta, NOT text_delta
          // This prevents model thinking from leaking into user-visible content stream
          if (chunk.content) {
            this.emitEvent(onEvent, { type: "thinking_delta", taskId, turn, delta: chunk.content });
          }
          break;
        case "tool_call":
          if (chunk.toolCall?.id) {
            // Use toolCallIndex from streaming adapter if available, otherwise sequential
            const idx = chunk.toolCallIndex ?? toolCallMap.size;
            toolCallMap.set(idx, chunk.toolCall as ToolCall);

            // R4.1: Start speculative execution for the PREVIOUS tool call now
            // that its arguments are complete (next tool_call arrived).
            if (speculativeTools && speculativeExecuteFn && currentTcId !== null) {
              if (!streamingExecutor) {
                streamingExecutor = new StreamingToolExecutor(
                  speculativeTools,
                  speculativeExecuteFn,
                );
              }
              const previousTc = Array.from(toolCallMap.values()).find(tc => tc.id === currentTcId);
              if (previousTc) {
                streamingExecutor.addTool(previousTc);
              }
            }
            currentTcId = chunk.toolCall.id;
          }
          break;
        case "tool_call_delta":
          if (chunk.toolCall?.function?.arguments && toolCallMap.size > 0) {
            // Route delta to the correct tool call using toolCallIndex
            const deltaIdx = chunk.toolCallIndex;
            if (deltaIdx !== undefined && toolCallMap.has(deltaIdx)) {
              const target = toolCallMap.get(deltaIdx)!;
              target.function.arguments += chunk.toolCall.function.arguments;
            } else {
              // Fallback: append to last tool call (preserves old behavior)
              const last = Array.from(toolCallMap.values()).pop()!;
              last.function.arguments += chunk.toolCall.function.arguments;
            }
          }
          break;
        case "done":
          finishReason = chunk.finishReason;
          if (chunk.usage) {
            usage = chunk.usage;
          }
          if (chunk.reasoningDetails) {
            reasoningDetails = chunk.reasoningDetails;
          }
          // R4.1: Start speculative execution for the LAST tool call when
          // the done chunk arrives (no more tool_calls coming).
          if (speculativeTools && speculativeExecuteFn && currentTcId !== null) {
            if (!streamingExecutor) {
              streamingExecutor = new StreamingToolExecutor(
                speculativeTools,
                speculativeExecuteFn,
              );
            }
            const lastTc = Array.from(toolCallMap.values()).find(tc => tc.id === currentTcId);
            if (lastTc) {
              streamingExecutor.addTool(lastTc);
            }
            currentTcId = null;
          }
          break;
        case "error": {
          const streamErrMsg = chunk.error ?? "Stream error";
          console.warn(`[AgentRunner] Stream error after ${fullContent.length} chars, ${toolCallMap.size} partial tool call(s): ${streamErrMsg}`);
          // CRITICAL: When partial tool calls exist, THROW for clean retry.
          // Returning partial tool calls is dangerous because tryRepairToolArguments
          // would close incomplete JSON braces, producing valid-looking but TRUNCATED
          // tool call arguments (e.g. workflow_run with 1 agent instead of 6).
          // Throwing lets chatStreamWithFallback retry or fall back cleanly.
          //
          // When only text content exists (no tool calls), return partial for
          // continuation — the caller can append and continue generating text.
          if (fullContent.length > 0 && toolCallMap.size === 0) {
            return {
              content: fullContent,
              toolCalls: [],
              finishReason: "stream_error" as string,
              usage,
              reasoningDetails,
            };
          }
          throw new Error(streamErrMsg);
        }
      }
    }

    // R4.1: Collect speculative tool results
    const speculativeToolResults = streamingExecutor ? await streamingExecutor.getResults() : undefined;

    // Split any tool calls that have concatenated JSON arguments (GLM5.1 issue)
    const rawToolCalls = Array.from(toolCallMap.values());
    const splitToolCalls = splitConcatenatedToolCalls(rawToolCalls);

    // L1: Strip embedded <think/> blocks from the returned content.
    // fullContent preserves the raw text for tool call parsing, but the returned
    // content should be clean (no model reasoning visible to users).
    const cleanContent = fullContent.replace(/<think[^>]*>[\s\S]*?<\/think>/g, "").trim();

    return { content: cleanContent, toolCalls: splitToolCalls, finishReason, usage, speculativeToolResults, reasoningDetails };
  }

  /**
   * Streaming version of chatWithFallback: calls chatStream() with automatic
   * model fallback, emitting text_delta events for each content chunk.
   */
  private async chatStreamWithFallback(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    options: AgentRunOptions,
    modelId: string,
    modelRole: string,
    fallbackRole: ModelRole,
    usingFallback: boolean,
    onFallback: (newModelId: string) => void,
    taskId: string,
    turn: number,
    outputTokenBudget?: number,
    speculativeTools?: Map<string, AgentTool>,
    speculativeExecuteFn?: (toolCall: ToolCall) => Promise<ChatMessage>,
    repetitionPenalty?: number,
  ): Promise<{ content: string; toolCalls: ToolCall[]; finishReason?: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number }; speculativeToolResults?: ChatMessage[]; reasoningDetails?: unknown[] }> {
    const tools = toolDefs.length > 0 ? toolDefs : undefined;
    // Do NOT set initial maxTokens — let the model output freely.
    // maxTokens is only set during truncation recovery (see recovery tiers).
    const opts: ChatOptions = {
      model: modelId, tools, signal: options.signal, enableCaching: true,
      ...(repetitionPenalty && repetitionPenalty > 0 ? { frequencyPenalty: repetitionPenalty } : {}),
    };

    // Strategy: prefer retrying primary model once before falling back.
    // If the primary model times out or errors, retrying more than once is
    // unlikely to help and wastes time that the fallback model could use.
    // Rate-limit and server-overload errors may still benefit from a single retry.

    const MAX_PRIMARY_RETRIES = 1;
    const RETRY_DELAYS = [3000]; // single retry delay

    let lastError: unknown = null;

    // Try primary model with retries
    for (let attempt = 0; attempt <= MAX_PRIMARY_RETRIES; attempt++) {
      try {
        return await this.consumeStream(
          this.modelRouter.chatStream(messages, opts),
          options.onEvent, taskId, turn,
          speculativeTools, speculativeExecuteFn,
        );
      } catch (err) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTransient = this.isTransientError(errMsg);

        if (attempt < MAX_PRIMARY_RETRIES && isTransient) {
          const delay = RETRY_DELAYS[attempt] ?? 10000;
          console.warn(`[AgentRunner] Primary model attempt ${attempt + 1} failed (transient), retrying in ${delay}ms: ${errMsg.substring(0, 200)}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        // Non-transient error or max retries reached — stop retrying
        console.warn(`[AgentRunner] Primary model failed after ${attempt + 1} attempts: ${errMsg.substring(0, 200)}`);
        break;
      }
    }

    // Fallback to alternative model — keep tools so the agent can continue working.
    if (!usingFallback) {
      let fallbackModelId = this.modelRouter.getDefaultModel(fallbackRole);
      // If the configured fallback is the same as the primary, find a different provider.
      if (fallbackModelId === modelId) {
        const alternate = this.modelRouter.getAlternateChatModel(modelId);
        if (alternate) {
          console.warn(`[AgentRunner] Configured fallback is same as primary (${modelId}), using alternate: ${alternate}`);
          fallbackModelId = alternate;
        }
      }
      if (fallbackModelId !== modelId) {
        console.warn(`[AgentRunner] Switching to fallback model (${fallbackRole}: ${fallbackModelId}) with tools preserved`);
        onFallback(fallbackModelId);
        try {
          // Try fallback model WITH tools first — most providers support compatible tool formats.
          return await this.consumeStream(
            this.modelRouter.chatStream(messages, { ...opts, model: fallbackModelId }),
            options.onEvent, taskId, turn,
          );
        } catch (fallbackErr) {
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.warn(`[AgentRunner] Fallback model with tools failed: ${fbMsg.substring(0, 200)}`);
          // Last resort: try fallback model WITHOUT tools (avoids format incompatibilities)
          try {
            return await this.consumeStream(
              this.modelRouter.chatStream(messages, { ...opts, model: fallbackModelId, tools: undefined }),
              options.onEvent, taskId, turn,
            );
          } catch (finalErr) {
            console.warn(`[AgentRunner] Fallback model without tools also failed`);
          }
        }
      }
    }

    throw lastError;
  }

  // -----------------------------------------------------------------------
  // Message building
  // -----------------------------------------------------------------------

  private async buildMessages(
    systemPrompt: string,
    input: string,
    contextMessages: Array<{ role: "user" | "assistant"; content: string }> | undefined,
    lang: DetectedLanguage = "zh",
    mediaRefs?: Array<{ mediaId: string; mimeType: string; dataUri: string }>,
    modelId?: string,
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    if (contextMessages && contextMessages.length > 0) {
      for (const ctx of contextMessages) {
        if (ctx.role === "user") {
          // Try to extract text from media JSON content
          let ctxContent = ctx.content;
          try {
            const parsed = JSON.parse(ctx.content);
            if (parsed.text) ctxContent = parsed.text;
          } catch { /* not JSON */ }
          messages.push({ role: "user", content: ctxContent });
        } else {
          messages.push(ctx);
        }
      }

      // Context boundary: mark where history ends and the new request begins.
      //
      // Design philosophy (inspired by Claude Code):
      // - Do NOT try to classify "new task" vs "continuation" — let the model judge.
      // - A light boundary marker helps the model distinguish history from the
      //   current request without breaking legitimate follow-up questions.
      // - The key guidance: read the user's actual intent carefully, rather than
      //   automatically copying the pattern of the most recent conversation.
      //   This prevents "context inertia" where a long previous task (e.g.
      //   file classification) bleeds into a different request (e.g. skill
      //   invocation) while still allowing natural continuations like
      //   "go deeper on that" or "now do the same for X".
      const framedInput = lang === "zh"
        ? "以下是用户的最新请求。请仔细判断用户的真实意图：如果是对上面工作的追问或延续，则在已有成果基础上继续；如果是新的独立任务，则不要照搬上面的工作模式，而应根据新请求本身来执行。\n重要提醒：压缩摘要中的「待处理任务」如果与当前请求无关，属于已完成的历史任务，应当忽略。不要主动去执行或总结之前已完成的工作。\n\n" +
          input
        : "Below is the user's latest request. Carefully judge the user's true intent: if it is a follow-up to the work above, continue building on those results; if it is a new independent task, do not copy the work pattern from above — execute based on the new request itself.\nImportant: \"pending tasks\" in the compaction summary that are unrelated to the current request belong to completed historical tasks — ignore them. Do not proactively re-execute or re-summarize previously completed work.\n\n" +
          input;

      // Build user input with optional media
      if (mediaRefs && mediaRefs.length > 0 && modelId) {
        const { getSupportsVision } = await import("../../models/provider-registry.js");
        const hasVision = getSupportsVision(modelId);

        if (hasVision) {
          // Model supports vision — send media inline as multimodal content
          const contentParts: Array<import("../../models/provider.js").ContentPart> = [];
          for (const ref of mediaRefs) {
            if (ref.mimeType.startsWith("image/")) {
              contentParts.push({
                type: "image_url",
                image_url: { url: ref.dataUri },
              });
            }
          }
          contentParts.push({ type: "text", text: framedInput });
          messages.push({ role: "user", content: contentParts });
        } else {
          // VLM fallback: analyze images and inject descriptions
          let descriptions: string[] = [];
          try {
            const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
            const dispatcher = new CapabilityDispatcher();
            for (const ref of mediaRefs) {
              if (ref.mimeType.startsWith("image/")) {
                try {
                  const result = await dispatcher.analyzeImage(
                    ref.dataUri,
                    "请详细描述这张图片的内容，包括所有可见的文本、数据、图表、物体等。",
                    { signal: AbortSignal.timeout(60_000) },
                  );
                  descriptions.push(`[图片 ${ref.mediaId.slice(0, 8)} 描述]: ${result.content}`);
                } catch {
                  descriptions.push(`[图片 ${ref.mediaId.slice(0, 8)} 描述获取失败]`);
                }
              }
            }
          } catch {
            // VLM not available
          }

          if (descriptions.length > 0) {
            const enrichedInput = `${descriptions.join("\n\n")}\n\n用户问题：${framedInput}`;
            messages.push({ role: "user", content: enrichedInput });
          } else {
            messages.push({ role: "user", content: framedInput });
          }
        }
      } else {
        messages.push({ role: "user", content: framedInput });
      }
    } else {
      // No context messages — build user message with optional media
      if (mediaRefs && mediaRefs.length > 0 && modelId) {
        const { getSupportsVision } = await import("../../models/provider-registry.js");
        const hasVision = getSupportsVision(modelId);

        if (hasVision) {
          const contentParts: Array<import("../../models/provider.js").ContentPart> = [];
          for (const ref of mediaRefs) {
            if (ref.mimeType.startsWith("image/")) {
              contentParts.push({
                type: "image_url",
                image_url: { url: ref.dataUri },
              });
            }
          }
          contentParts.push({ type: "text", text: input });
          messages.push({ role: "user", content: contentParts });
        } else {
          let descriptions: string[] = [];
          try {
            const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
            const dispatcher = new CapabilityDispatcher();
            for (const ref of mediaRefs) {
              if (ref.mimeType.startsWith("image/")) {
                try {
                  const result = await dispatcher.analyzeImage(
                    ref.dataUri,
                    "请详细描述这张图片的内容，包括所有可见的文本、数据、图表、物体等。",
                    { signal: AbortSignal.timeout(60_000) },
                  );
                  descriptions.push(`[图片 ${ref.mediaId.slice(0, 8)} 描述]: ${result.content}`);
                } catch {
                  descriptions.push(`[图片 ${ref.mediaId.slice(0, 8)} 描述获取失败]`);
                }
              }
            }
          } catch {
            // VLM not available
          }

          if (descriptions.length > 0) {
            const enrichedInput = `${descriptions.join("\n\n")}\n\n用户问题：${input}`;
            messages.push({ role: "user", content: enrichedInput });
          } else {
            messages.push({ role: "user", content: input });
          }
        }
      } else {
        messages.push({ role: "user", content: input });
      }
    }

    return messages;
  }

  // -----------------------------------------------------------------------
  // Tool execution
  // -----------------------------------------------------------------------

  private async executeToolCall(
    toolCall: ToolCall,
    taskId: string,
    turn: number,
    onEvent?: (event: AgentEvent) => void,
    accessedPages?: Map<string, { pageId: string; title: string }>,
    agentSettings?: AgentSettings,
    contextFullnessRatio?: number,
    toolResultCache?: ToolResultCache,
    signal?: AbortSignal,
    searchResultIndex?: SearchResultIndex,
    invokedSkills?: Map<string, InvokedSkillEntry>,
    messages?: ChatMessage[],
  ): Promise<ChatMessage> {
    const toolName = toolCall.function.name;
    let toolInput: Record<string, unknown>;

    // Log tool calls for observability
    console.log(`[AgentRunner] Tool call: turn=${turn}, tool=${toolName}, task=${taskId}`);

    try {
      toolInput = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      // Attempt JSON repair for common streaming/model errors
      const rawArgs = toolCall.function.arguments;
      const repaired = tryRepairToolArguments(rawArgs);
      if (repaired !== null) {
        console.log(`[AgentRunner] Tool arguments repaired for "${toolName}" (original was invalid JSON)`);
        toolInput = repaired;
      } else {
        const parseError = e instanceof Error ? e.message : String(e);
        const errorMsg = `Failed to parse tool arguments for "${toolName}": ${parseError}. The arguments were: ${toolCall.function.arguments.slice(0, 200)}`;
        this.recordProgress(onEvent, taskId, turn, "error", errorMsg);
        return { role: "tool", content: JSON.stringify({ error: errorMsg }), toolCallId: toolCall.id };
      }
    }

    // Stage 2: Schema validation
    const toolDef = this.toolRegistry.get(toolName);
    if (toolDef?.inputSchema) {
      const validation = this.toolRegistry.validateToolInput(toolName, toolInput, toolDef.inputSchema);
      if (!validation.valid) {
        const errorMsg = `<tool_use_error>InputValidationError for "${toolName}": ${validation.error}</tool_use_error>`;
        this.recordProgress(onEvent, taskId, turn, "error", errorMsg);
        this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: { error: validation.error } });
        return { role: "tool", content: errorMsg, toolCallId: toolCall.id };
      }
    }

    this.emitEvent(onEvent, { type: "tool_call", taskId, turn, toolName, input: toolInput });
    this.recordProgress(onEvent, taskId, turn, "tool_call", `Calling tool: ${toolName}`, toolName, toolInput);

    // PreToolUse hook — may block execution
    if (this.hookManager) {
      const preResult = await this.hookManager.fire("PreToolUse", { hookType: "PreToolUse", toolName, toolInput, taskId });
      if (!preResult.allowed) {
        const blockMsg = preResult.error ?? `Blocked by PreToolUse hook`;
        const errorResult = { error: blockMsg };
        this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: errorResult });
        return { role: "tool", content: JSON.stringify(errorResult), toolCallId: toolCall.id };
      }
    }

    // Feature B (C-187): Pre-read enforcement for edit_file — must read before editing
    if (toolName === "edit_file" && toolInput.file_path) {
      const targetPath = String(toolInput.file_path);
      const tracker = this.getRunState(taskId).readFilesTracker;
      if (!tracker.has(targetPath) && !tracker.has(targetPath.replace(/\\/g, "/"))) {
        const errorMsg = `<tool_use_error>文件尚未读取。请先使用 read_file 读取 "${targetPath}" 后再编辑。这是为了确保编辑操作的准确性。</tool_use_error>`;
        this.recordProgress(onEvent, taskId, turn, "error", errorMsg, toolName);
        this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: { error: errorMsg } });
        return { role: "tool", content: errorMsg, toolCallId: toolCall.id };
      }
    }

    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      const errorMsg = `Tool "${toolName}" not found in registry.`;
      const errorResult = { error: errorMsg };
      this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: errorResult });
      this.recordProgress(onEvent, taskId, turn, "error", errorMsg, toolName);
      return { role: "tool", content: JSON.stringify(errorResult), toolCallId: toolCall.id };
    }

    // Runtime guard: reject blocked tools that the model hallucinated despite not being in its tool list
    if (this.getRunState(taskId).blockedTools && this.getRunState(taskId).blockedTools.has(toolName)) {
      const errorMsg = `Tool "${toolName}" is not available in this context.`;
      console.warn(`[AgentRunner] Blocked hallucinated tool call: ${toolName} (turn=${turn})`);
      const errorResult = { error: errorMsg };
      this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: errorResult });
      this.recordProgress(onEvent, taskId, turn, "error", errorMsg, toolName);
      return { role: "tool", content: JSON.stringify(errorResult), toolCallId: toolCall.id };
    }

    // Runtime guard: enforce KB scope on tools that require it.
    // buildToolDefinitions() hides these tools from the LLM when no KB is in
    // scope, but a sub-agent may still hallucinate a call after seeing KB
    // references in its task description or inherited context. Without this
    // guard the call succeeds because toolRegistry.get() returns from the full
    // registry, bypassing the definition-level filter.
    if (tool.requiresKbScope) {
      const currentScopeKbIds = this.toolRegistry.getExecutionContext()?.scopeKbIds as string[] | undefined;
      if (!currentScopeKbIds || currentScopeKbIds.length === 0) {
        const errorMsg = `Tool "${toolName}" requires a knowledge base, but no KB is in scope for this session.`;
        console.warn(`[AgentRunner] Blocked KB-scoped tool call without KB in scope: ${toolName} (turn=${turn})`);
        const errorResult = { error: errorMsg };
        this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: errorResult });
        this.recordProgress(onEvent, taskId, turn, "error", errorMsg, toolName);
        return { role: "tool", content: JSON.stringify(errorResult), toolCallId: toolCall.id };
      }
    }

    // R4.7: Check tool result cache before executing
    let cachedResult: string | null = null;
    if (toolResultCache?.isCacheable(toolName, toolInput)) {
      cachedResult = toolResultCache.get(toolName, toolInput);
      if (cachedResult) {
        console.log(`[AgentRunner] Tool cache hit: ${toolName} (saved API call)`);
      }
    }

    let result: unknown;
    let execDurationMs = 0;
    if (cachedResult) {
      // Use cached result — skip tool execution (timing not applicable)
      try {
        result = JSON.parse(cachedResult);
      } catch {
        result = cachedResult;
      }
    } else {
      // Check abort signal before executing the tool
      if (signal?.aborted) {
        const cancelResult = { error: "Cancelled by user" };
        this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: cancelResult });
        return { role: "tool", content: JSON.stringify(cancelResult), toolCallId: toolCall.id };
      }

      // ---------------------------------------------------------------------------
      // P1-A: Push dedup — MD5-based, session-scoped (cross-task within same session).
      // Applies to BOTH push_file and push_content.
      // - push_file: MD5 of the file content at filePath
      // - push_content with filePath: MD5 of the file content
      // - push_content with inline data: MD5 of the data string
      // `force: true` bypasses dedup (lets the agent re-push on explicit user request).
      // ---------------------------------------------------------------------------
      if (toolName === "push_file" || toolName === "push_content") {
        const force = toolInput.force === true;
        const pFilePath = String(
          (toolName === "push_file" ? toolInput.filePath : toolInput.filePath) || "",
        );
        const pData = String(toolInput.data || "");

        if (!force) {
          // Compute content hash for dedup
          let contentHash: string | null = null;
          if (pFilePath) {
            // Get sessionId for path resolution (matches push_content tool behavior)
            const dedupRs = this.getRunState(taskId);
            contentHash = await this.hashFilePath(pFilePath, dedupRs.sessionId);
          } else if (pData.length > 0) {
            contentHash = this.hashString(pData);
          }

          if (contentHash) {
            const rs = this.getRunState(taskId);
            const sessionList = this.getSessionPushedEntries(rs.sessionId);
            // Session-level check (catches cross-task duplicates)
            const existing = sessionList?.find((e) => e.hash === contentHash);
            if (existing) {
              const skipResult = {
                skipped: true,
                reason: `Duplicate ${toolName} — same content (MD5: ${contentHash.substring(0, 8)}) was already pushed as "${existing.title}" at ${existing.timestamp}. Use force=true to re-push if the user explicitly requested it.`,
                contentHash,
                previousPush: existing,
              };
              this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result: skipResult });
              return { role: "tool", content: JSON.stringify(skipResult), toolCallId: toolCall.id };
            }
            // Task-level quick check (catches same-task duplicates before computing file hash)
            // NOTE: pushedContentKeys stores a legacy signature for backward compat.
            // The session-level MD5 set is the authoritative dedup mechanism now.
          }
        }
      }

      const execStart = Date.now();
      try {
        result = await tool.execute(toolInput);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result = { error: `Tool "${toolName}" execution failed: ${errorMsg}` };
        this.recordProgress(onEvent, taskId, turn, "error", String(result), toolName);
      }
      execDurationMs = Date.now() - execStart;

      // Record successful push for session-level dedup (both push_file and push_content).
      // Uses MD5 of the pushed content as the dedup key. Also stores metadata for
      // list_pushed_content tool and push result augmentation.
      if (
        (toolName === "push_file" || toolName === "push_content") &&
        result && typeof result === "object" && (result as Record<string, unknown>).pushed
      ) {
        const pTitle = String(toolInput.title || "");
        const pFilePath = String(toolInput.filePath || "");
        const pData = String(toolInput.data || "");
        let contentHash: string | null = null;
        if (pFilePath) {
          const recordRs = this.getRunState(taskId);
          contentHash = await this.hashFilePath(pFilePath, recordRs.sessionId);
        } else if (pData.length > 0) {
          contentHash = this.hashString(pData);
        }
        if (contentHash) {
          const rs = this.getRunState(taskId);
          const sessionList = this.getSessionPushedEntries(rs.sessionId);
          if (sessionList) {
            const res = result as Record<string, unknown>;
            const entry: SessionPushedEntry = {
              hash: contentHash,
              toolName: toolName as "push_file" | "push_content",
              title: pTitle,
              timestamp: typeof res.timestamp === "string" ? res.timestamp : new Date().toISOString(),
              fileName: typeof res.fileName === "string" ? res.fileName : undefined,
              fileSize: typeof res.fileSize === "number" ? res.fileSize : undefined,
              mimeType: typeof res.mimeType === "string" ? res.mimeType : undefined,
            };
            sessionList.push(entry);
            // Prevent unbounded growth — evict oldest entries
            if (sessionList.length > AgentRunner.MAX_SESSION_PUSHED_ENTRIES) {
              sessionList.splice(0, sessionList.length - AgentRunner.MAX_SESSION_PUSHED_ENTRIES);
            }
            // Augment result with pushedHistory so the Agent sees the full push context.
            // Truncate to the most recent 10 entries to avoid large tool messages.
            (result as Record<string, unknown>).pushedHistory = {
              totalPushed: sessionList.length,
              recent: sessionList.slice(-10).map((e) => ({
                title: e.title,
                toolName: e.toolName,
                fileName: e.fileName,
                fileSize: e.fileSize,
                timestamp: e.timestamp,
                hash: e.hash.substring(0, 8),
              })),
            };
          }
        }
      }
    }

    // PostToolUse hook — fire-and-forget (does not affect result)
    if (this.hookManager) {
      await this.hookManager.fire("PostToolUse", { hookType: "PostToolUse", toolName, toolInput, taskId }).catch(() => {});
      // Feature F: Fire PostToolUseFailure if the result is an error
      if (result && typeof result === "object" && (result as Record<string, unknown>).error) {
        await this.hookManager.firePostToolUseFailure(toolName, String((result as Record<string, unknown>).error), taskId).catch(() => {});
      }
    }

    // Feature B (C-187): Track files read by read_file tool
    if (toolName === "read_file" && toolInput.file_path) {
      const readPath = String(toolInput.file_path);
      const tracker = this.getRunState(taskId).readFilesTracker;
      tracker.add(readPath);
      tracker.add(readPath.replace(/\\/g, "/"));
    }

    this.emitEvent(onEvent, { type: "tool_result", taskId, turn, toolName, result });
    this.recordProgress(onEvent, taskId, turn, "tool_result", `Tool ${toolName} completed`, toolName, undefined, result);

    // Handle skill_invoke: dispatch based on mode (inline / fork / sub_agent)
    if (toolName === "skill_invoke" && result && typeof result === "object" && (result as Record<string, unknown>).__skill_invoke__) {
      const skillData = result as {
        skill: { name: string; prompt: string; tools: string[]; modelRole: string };
        input: string;
        mode: "inline" | "fork" | "sub_agent";
      };
      const skillMode = skillData.mode ?? "sub_agent";

      if (skillMode === "inline") {
        // Inline mode: mark result for injection in the TAOR loop
        // The TAOR loop will replace this with a user message containing the skill prompt
        result = {
          __skill_inline__: true,
          skillName: skillData.skill.name,
          skillPrompt: skillData.skill.prompt,
          input: skillData.input,
        };
        // Track in invokedSkills for post-compact re-injection
        if (invokedSkills) {
          const tokenEstimate = this.modelRouter.estimateTokens(skillData.skill.prompt);
          invokedSkills.set(skillData.skill.name, {
            name: skillData.skill.name,
            content: skillData.skill.prompt,
            input: skillData.input,
            timestamp: Date.now(),
            tokenEstimate,
            mode: "inline",
          });
        }
      } else if (skillMode === "fork") {
        // Fork mode: spawn sub-agent with inherited parent conversation history
        const contextMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
        if (messages) {
          for (const m of messages) {
            const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            if (m.role === "user") {
              contextMessages.push({ role: "user", content });
            } else if (m.role === "assistant") {
              contextMessages.push({ role: "assistant", content });
            }
            // Skip tool/system messages for context inheritance
          }
        }
        const subagentId = `skill-fork-${skillData.skill.name}`;
        const subTaskId = `${taskId}-fork-${Date.now()}`;
        if (this.hookManager) {
          await this.hookManager.fireSubagentStart(subagentId, taskId).catch(() => {});
        }
        // Record sub-agent start in parent's JSONL
        this.recordSubAgentStart(subTaskId, taskId, "skill-fork", skillData.skill.name);
        // Read parent's sessionId for the sub-agent — no need to clear/restore
        // parent's writer state because this.run() creates its own RunState
        // keyed by a new taskId, so the sub-agent never reads parentRs fields.
        const parentRs = this.getRunState(taskId);
        const parentSessionId = parentRs.jsonlSessionId;
        try {
          const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
          const wrappedOnEvent = wrapSubAgentOnEvent(onEvent, skillData.skill.name);
          // Inherit scope from current execution context (same as sub_agent mode)
          const currentScopeKbIds = this.toolRegistry.getExecutionContext()?.scopeKbIds as string[] | undefined;
          const scopeObj = currentScopeKbIds?.length ? { kbIds: currentScopeKbIds } : undefined;
          const skillResult = await this.run({
            input: skillData.input,
            systemPromptOverride: skillData.skill.prompt,
            toolsOverride: skillData.skill.tools,
            modelRole: skillData.skill.modelRole as "main" | "summarizer" | "embedding" | "vlm",
            isSkillInvocation: true,
            contextMessages,
            signal,
            onEvent: wrappedOnEvent,
            sessionId: parentSessionId,
            scope: scopeObj,
          });
          result = buildSubAgentResult(skillData.skill.name, skillResult, "fork", DEEPANALYZE_CONFIG.dataDir, parentSessionId);
        } catch (err) {
          result = {
            skillName: skillData.skill.name,
            error: `Skill (fork) execution failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        } finally {
          if (this.hookManager) {
            await this.hookManager.fireSubagentStop(subagentId, taskId).catch(() => {});
          }
        }
        // Track fork skills too for post-compact awareness
        if (invokedSkills) {
          invokedSkills.set(skillData.skill.name, {
            name: skillData.skill.name,
            content: skillData.skill.prompt,
            input: skillData.input,
            timestamp: Date.now(),
            tokenEstimate: this.modelRouter.estimateTokens(skillData.skill.prompt),
            mode: "fork",
          });
        }
      } else {
        // Sub-agent mode (default): spawn sub-agent with fresh context
        const subagentId = `skill-sub-${skillData.skill.name}`;
        const subTaskId = `${taskId}-sub-${Date.now()}`;
        if (this.hookManager) {
          await this.hookManager.fireSubagentStart(subagentId, taskId).catch(() => {});
        }
        // Record sub-agent start in parent's JSONL
        this.recordSubAgentStart(subTaskId, taskId, "skill-sub", skillData.skill.name);
        // Read parent's sessionId for the sub-agent — no need to clear/restore
        // parent's writer state because this.run() creates its own RunState
        // keyed by a new taskId, so the sub-agent never reads parentRs fields.
        const parentRs2 = this.getRunState(taskId);
        const parentSessionId = parentRs2.jsonlSessionId;
        try {
          const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
          const wrappedOnEvent = wrapSubAgentOnEvent(onEvent, skillData.skill.name);
          // Inherit scope from current execution context (singleton shared, sub-agent naturally inherits KB context)
          const currentScopeKbIds = this.toolRegistry.getExecutionContext()?.scopeKbIds as string[] | undefined;
          const scopeObj = currentScopeKbIds?.length ? { kbIds: currentScopeKbIds } : undefined;
          const skillResult = await this.run({
            input: skillData.input,
            systemPromptOverride: skillData.skill.prompt,
            toolsOverride: skillData.skill.tools,
            modelRole: skillData.skill.modelRole as "main" | "summarizer" | "embedding" | "vlm",
            isSkillInvocation: true,
            signal,
            onEvent: wrappedOnEvent,
            sessionId: parentSessionId,
            scope: scopeObj,
            // No maxTurns override — let estimateTaskComplexity() dynamically compute it
            // Skills are experience guides, not execution constraints
          });
          result = buildSubAgentResult(skillData.skill.name, skillResult, "sub_agent", DEEPANALYZE_CONFIG.dataDir, parentSessionId);
        } catch (err) {
          result = {
            skillName: skillData.skill.name,
            error: `Skill execution failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        } finally {
          if (this.hookManager) {
            await this.hookManager.fireSubagentStop(subagentId, taskId).catch(() => {});
          }
        }
      }
    }

    // Inject display names (originalName, kbName) into tool results FIRST
    // so that collectAccessedPages can pick up the injected names
    if (["kb_search", "wiki_browse", "expand"].includes(toolName)) {
      result = await this.injectDisplayNames(toolName, result);
    }

    // Collect accessed page IDs for source tracing (after display name injection)
    if (accessedPages) {
      this.collectAccessedPages(toolName, result, accessedPages);
    }

    // C3.5: Track search results in the lightweight index
    if (searchResultIndex) {
      const searchQuery = toolInput["query"] as string ?? toolInput["pattern"] as string ?? "";
      if (searchQuery) {
        searchResultIndex.addEntry(searchQuery, toolName, result);
      }
      // Track expand calls by docId(s) so compaction won't lose this info
      if (toolName === "expand") {
        const docIds = toolInput["docIds"] as string[] | undefined;
        const docId = toolInput["docId"] as string | undefined;
        const pageId = toolInput["pageId"] as string | undefined;
        const expandKey = (docIds && docIds.length > 0)
          ? docIds.join(",")
          : (docId ?? pageId ?? "");
        if (expandKey) {
          searchResultIndex.addEntry(expandKey, toolName, result);
        }
      }
      // Track image_analysis calls by imageRef so progress detection counts them
      if (toolName === "image_analysis") {
        const imageRef = toolInput["imageRef"] as string ?? "";
        if (imageRef) {
          searchResultIndex.addEntry(imageRef, toolName, result);
        }
      }
      // Track read_file calls by path
      if (toolName === "read_file") {
        const filePath = toolInput["path"] as string ?? "";
        if (filePath) {
          searchResultIndex.addEntry(filePath, toolName, result);
        }
      }
    }

    let resultContent: string;
    try {
      resultContent = JSON.stringify(result);

      // Compact MCP search results: unwrap MiniMax MCP envelope into flat text.
      // The MCP server returns {"content":[{"type":"text","text":"{\"organic\":[...]}"}]}
      // which JSON.stringify inflates to 13K+ chars of nested JSON.
      // We extract and format it identically to the built-in web_search output:
      //   [1] Title\n    URL\n    Snippet
      // This is purely a formatting transform — no information loss for short snippets,
      // and long snippets are capped at 500 chars (enough for a search summary).
      if (toolName === "mcp__minimax_websearch__web_search" && result && typeof result === "object") {
        const compact = compactMcpSearchResult(result);
        if (compact) resultContent = compact;
      }

      // T1.4: Inject lightweight metadata footer to help model judge tool result quality
      // Only inject for search/data tools where metadata is actionable
      const META_TOOLS = new Set(["kb_search", "web_search", "wiki_browse", "expand", "doc_grep", "run_sql"]);
      if (META_TOOLS.has(toolName) && result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        const metaParts: string[] = [];
        if (typeof r.total === "number") metaParts.push(`${r.total} results`);
        else if (Array.isArray(r.results)) metaParts.push(`${r.results.length} results`);
        else if (Array.isArray(r.rows)) metaParts.push(`${r.rows.length} rows`);
        else if (Array.isArray(r.documents)) metaParts.push(`${r.documents.length} documents`);
        else if (Array.isArray(r.matches)) metaParts.push(`${r.matches.length} matches`);
        if (execDurationMs > 0) metaParts.push(`${execDurationMs}ms`);
        if (metaParts.length > 0) {
          resultContent += `\n[_meta: ${metaParts.join(", ")}]`;
        }
      } else if (!META_TOOLS.has(toolName) && execDurationMs > 2000) {
        resultContent += `\n[_meta: ${execDurationMs}ms]`;
      }

      // T1.7: Tool chain short-circuit — when search tools return empty results,
      // append actionable suggestions to help the model adjust its strategy immediately
      // rather than repeating the same query or giving up.
      if (this.isEmptySearchResult(toolName, result)) {
        const suggestions = this.generateSearchSuggestions(toolName, toolInput);
        if (suggestions) {
          resultContent += `\n\n${suggestions}`;
        }
      }

      // T1.8: When MCP fetch tools fail, suggest internal web_fetch as fallback
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (r.isError === true || (typeof r.content === "string" && r.content.includes("<error>"))) {
          if (toolName.includes("fetch") && toolName.startsWith("mcp__")) {
            resultContent += "\n\n[MCP fetch failed. 内部 web_fetch 工具具有 5 种策略回退（直连→百度搜索→MiniMax搜索→Wayback→Google缓存），建议使用 web_fetch 重试同一 URL]";
          }
        }
      }

      // R4.7: Cache the full result for cacheable tools (before truncation)
      if (!cachedResult && toolResultCache?.isCacheable(toolName, toolInput) && resultContent.length < 100_000) {
        toolResultCache.set(toolName, toolInput, resultContent);
      }

      // Apply token-based tool result budget instead of fixed 100K char limit
      const estimatedTokens = this.modelRouter.estimateTokens(resultContent);
      // Allow more tokens for expand results since they contain document content
      const baseMaxTokens = agentSettings?.toolResultMaxTokens ?? 4_000;
      // Scale tool result budget based on context window: larger windows can hold larger results
      const ctxWindow = agentSettings?.contextWindow ?? 200_000;
      const scaleFactor = ctxWindow >= 500_000 ? 4 : ctxWindow >= 200_000 ? 2 : 1;
      let maxTokens = ["expand"].includes(toolName) ? baseMaxTokens * 3 * scaleFactor : baseMaxTokens * scaleFactor;

      // Special case: push_content results don't need full content in LLM context.
      // The full data was already sent to frontend via SSE (before truncation).
      // Only keep a compact summary so the model knows the push succeeded.
      if (toolName === "push_content" && result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (r.pushed) {
          const dataLen = typeof r.data === "string" ? r.data.length : 0;
          resultContent = JSON.stringify({
            pushed: true,
            type: r.type,
            title: r.title,
            dataLength: dataLen,
            format: r.format,
            timestamp: r.timestamp,
          });
        }
      }

      // T1.2: Adaptive trimming — when context is nearly full, reduce tool result
      // budget proportionally. At 80% fullness, reduce to 60% budget; at 95%, reduce to 25%.
      const fullness = contextFullnessRatio ?? 0;
      if (fullness > 0.8) {
        const reductionFactor = fullness > 0.95 ? 0.25 : fullness > 0.9 ? 0.4 : 0.6;
        maxTokens = Math.max(500, Math.floor(maxTokens * reductionFactor));
        if (maxTokens < baseMaxTokens) {
          console.log(`[AgentRunner] Adaptive trimming: context ${Math.round(fullness * 100)}% full, reducing ${toolName} budget to ${maxTokens} tokens`);
        }
      }
      if (estimatedTokens > maxTokens) {
        const previewChars = Math.floor(maxTokens * 3); // ~3 chars per token
        // Provide informative truncation message so the LLM can decide whether to read more
        const truncationHint = toolName === "expand"
          ? `[... 内容被截断: 共约 ${estimatedTokens} tokens, 已展示前 ~${maxTokens} tokens. 如需完整信息, 可用 heading 参数指定章节逐段阅读]`
          : toolName === "web_fetch"
          ? `[... 内容被截断: 共约 ${estimatedTokens} tokens, 已展示前 ~${maxTokens} tokens. 可用 offset 和 max_length 参数分段阅读, 或用 search 参数搜索关键词]`
          : `[... result truncated: ${estimatedTokens} tokens total, showing first ~${maxTokens} tokens]`;
        resultContent = safeTruncateJSON(resultContent, previewChars) + `\n\n${truncationHint}`;
      }
    } catch {
      resultContent = String(result);
    }

    // Persist large results to disk and return a preview
    const { DEEPANALYZE_CONFIG: _dac } = await import("../../core/config.js");
    const persisted = await maybePersistToolResult(
      _dac.dataDir,
      toolName,
      resultContent,
      this.getRunState(taskId).jsonlSessionId ?? taskId,
      toolCall.id,
      50_000,
    );
    if (persisted.persisted) {
      return { role: "tool", content: persisted.content, toolCallId: toolCall.id };
    }

    return { role: "tool", content: resultContent, toolCallId: toolCall.id };
  }

  // -----------------------------------------------------------------------
  // Source tracing: collect accessed page IDs from tool results
  // -----------------------------------------------------------------------

  /**
   * Extract page IDs and titles from tool results (kb_search, wiki_browse,
   * expand) and add them to the accessedPages map for source tracing.
   */
  private collectAccessedPages(
    toolName: string,
    result: unknown,
    accessedPages: Map<string, {
      pageId: string;
      title: string;
      docId?: string;
      originalName?: string;
      kbName?: string;
      sectionTitle?: string;
      pageNumber?: number | null;
      anchorId?: string;
    }>,
  ): void {
    try {
      const obj = result as Record<string, unknown>;
      if (!obj || typeof obj !== "object") return;

      if (toolName === "kb_search" && Array.isArray(obj.results)) {
        for (const r of obj.results as Array<Record<string, unknown>>) {
          if (typeof r.pageId === "string" && typeof r.title === "string") {
            accessedPages.set(r.pageId, {
              pageId: r.pageId,
              title: r.title,
              docId: typeof r.docId === "string" ? r.docId : undefined,
              originalName: typeof r.originalName === "string" ? r.originalName : undefined,
              kbName: typeof r.kbName === "string" ? r.kbName : undefined,
              sectionTitle: typeof r.sectionTitle === "string" ? r.sectionTitle : undefined,
              anchorId: typeof r.anchorId === "string" ? r.anchorId : undefined,
            });
          }
        }
      } else if (toolName === "wiki_browse") {
        // wiki_browse returns { page: { id, title } } when viewing a specific page
        const page = obj.page as Record<string, unknown> | undefined;
        if (page && typeof page.id === "string" && typeof page.title === "string") {
          accessedPages.set(page.id, {
            pageId: page.id,
            title: page.title,
            docId: typeof page.docId === "string" ? page.docId : undefined,
            originalName: typeof page.originalName === "string" ? page.originalName : undefined,
            kbName: typeof page.kbName === "string" ? page.kbName : undefined,
            sectionTitle: typeof page.sectionTitle === "string" ? page.sectionTitle : undefined,
            pageNumber: typeof page.pageNumber === "number" ? page.pageNumber : undefined,
            anchorId: typeof page.anchorId === "string" ? page.anchorId : undefined,
          });
        }
        // Also collect pages from listed results
        if (Array.isArray(obj.pages)) {
          for (const p of obj.pages as Array<Record<string, unknown>>) {
            if (typeof p.id === "string" && typeof p.title === "string") {
              accessedPages.set(p.id, { pageId: p.id, title: p.title });
            }
          }
        }
      } else if (toolName === "expand" && obj.result) {
        const expandResult = obj.result as Record<string, unknown>;
        if (typeof expandResult.pageId === "string" && typeof expandResult.title === "string") {
          accessedPages.set(expandResult.pageId, {
            pageId: expandResult.pageId,
            title: expandResult.title,
            docId: typeof expandResult.docId === "string" ? expandResult.docId : undefined,
            originalName: typeof expandResult.originalName === "string" ? expandResult.originalName : undefined,
            kbName: typeof expandResult.kbName === "string" ? expandResult.kbName : undefined,
            sectionTitle: typeof expandResult.sectionTitle === "string" ? expandResult.sectionTitle : undefined,
            pageNumber: typeof expandResult.pageNumber === "number" ? expandResult.pageNumber : undefined,
            anchorId: typeof expandResult.anchorId === "string" ? expandResult.anchorId : undefined,
          });
        }
      }
    } catch {
      // Non-critical: source tracing should never break tool execution
    }
  }

  // -----------------------------------------------------------------------
  // Display name injection
  // -----------------------------------------------------------------------

  /**
   * Inject originalName and kbName into tool results so the LLM sees
   * user-visible file names instead of internal UUIDs.
   */
  private async injectDisplayNames(toolName: string, result: unknown): Promise<unknown> {
    try {
      if (!this.displayResolver) {
        this.displayResolver = new DisplayResolver();
      }

      const obj = result as Record<string, unknown>;
      if (!obj || typeof obj !== "object") return result;

      // Extract docIds from the result structure
      const docIds: string[] = [];

      if (toolName === "kb_search" && Array.isArray(obj.results)) {
        for (const r of obj.results as Array<Record<string, unknown>>) {
          if (typeof r.docId === "string") docIds.push(r.docId);
        }
      } else if (toolName === "wiki_browse") {
        const page = obj.page as Record<string, unknown> | undefined;
        if (page && typeof page.docId === "string") docIds.push(page.docId);
      } else if (toolName === "expand" && obj.result) {
        const expandResult = obj.result as Record<string, unknown>;
        if (typeof expandResult.docId === "string") docIds.push(expandResult.docId);
      }

      if (docIds.length === 0) return result;

      const displayMap = await this.displayResolver.resolveBatch(docIds);

      // Inject display names into result objects
      if (toolName === "kb_search" && Array.isArray(obj.results)) {
        for (const r of obj.results as Array<Record<string, unknown>>) {
          const display = displayMap[r.docId as string];
          if (display) {
            (r as Record<string, unknown>).originalName = display.originalName;
            (r as Record<string, unknown>).kbName = display.kbName;
          }
        }
      } else if (toolName === "wiki_browse") {
        const page = obj.page as Record<string, unknown> | undefined;
        if (page) {
          const display = displayMap[page.docId as string];
          if (display) {
            (page as Record<string, unknown>).originalName = display.originalName;
            (page as Record<string, unknown>).kbName = display.kbName;
          }
        }
      } else if (toolName === "expand" && obj.result) {
        const expandResult = obj.result as Record<string, unknown>;
        const display = displayMap[expandResult.docId as string];
        if (display) {
          (expandResult as Record<string, unknown>).originalName = display.originalName;
          (expandResult as Record<string, unknown>).kbName = display.kbName;
        }
      }
    } catch {
      // Non-critical: display name injection should never break tool execution
    }

    return result;
  }
  // -----------------------------------------------------------------------

  private isDone(
    content: string,
    toolCalls: ToolCall[] | undefined,
    finishReason?: string,
    agentCalledFinish?: boolean,
  ): boolean {
    // Explicit finish tool call terminates the loop.
    // Note: Natural termination (model returns text without tool calls) is handled
    // separately in the else branch of the tool call processing, before reaching here.
    // This method handles the explicit finish tool call path.
    if (agentCalledFinish) return true;
    return false;
  }

  // -----------------------------------------------------------------------
  // Emergency compaction detection
  // -----------------------------------------------------------------------

  private isPromptTooLongError(errorMsg: string): boolean {
    const lower = errorMsg.toLowerCase();
    return (
      lower.includes("prompt_too_long") ||
      lower.includes("context_length_exceeded") ||
      lower.includes("maximum context length") ||
      lower.includes("too many tokens") ||
      lower.includes("token limit exceeded") ||
      lower.includes("context window exceeds limit") ||
      lower.includes("context_length_exceeds")
    );
  }

  // -----------------------------------------------------------------------
  // Compact boundary persistence
  // -----------------------------------------------------------------------

  /**
   * Persist a compact boundary marker to the session's message history.
   * This allows the route handler's context loader to skip pre-boundary
   * messages on subsequent requests, avoiding loading already-compacted
   * history that would waste the context budget.
   *
   * Fire-and-forget: boundary persistence failure is non-critical.
   */
  private persistCompactBoundary(
    sessionId: string | undefined,
    method: CompactBoundaryMeta["method"],
    preCompactTokens: number,
    turnNumber: number,
    taskId?: string,
  ): void {
    if (!sessionId) return;

    const meta: CompactBoundaryMeta = {
      type: "compact_boundary",
      method,
      preCompactTokens,
      turnNumber,
      timestamp: new Date().toISOString(),
    };

    const content = `[COMPACT_BOUNDARY:${JSON.stringify(meta)}]`;

    // Fire-and-forget: don't block the TAOR loop
    getRepos()
      .then((repos) => repos.message.create(sessionId, "user", content))
      .catch((err) => {
        console.warn(
          "[AgentRunner] Failed to persist compact boundary:",
          err instanceof Error ? err.message : String(err),
        );
      });

    // Also persist to JSONL (lossless, parentUuid=null breaks chain)
    if (taskId) {
      const runState = this._runStates.get(taskId);
      if (runState?.jsonlWriter) {
        try {
          void runState.jsonlWriter.appendCompactBoundary({
            type: "compact_boundary",
            sessionId,
            meta: { trigger: method, tokensBefore: preCompactTokens },
          });
        } catch { /* non-critical */ }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Emergency compaction detection
  // -----------------------------------------------------------------------

  /**
   * Detect degenerate repetition in text output.
   * Returns true only when the same paragraph (exact first-100-chars fingerprint)
   * appears 5+ times — a hallmark of model output stuck in a planning loop.
   * Legitimate reports, analyses, and reasoning have diverse content per paragraph
   * and will never trigger this.
   */
  private hasMassiveRepetition(text: string): boolean {
    const MIN_PARAGRAPH_LENGTH = 50;
    const FINGERPRINT_LENGTH = 100;
    const DUPLICATE_THRESHOLD = 5;

    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > MIN_PARAGRAPH_LENGTH);
    if (paragraphs.length < DUPLICATE_THRESHOLD) return false;

    // Simple hash: use first N chars as fingerprint
    const fingerprints = paragraphs.map(p => {
      const trimmed = p.trim();
      const fp = trimmed.length > FINGERPRINT_LENGTH ? trimmed.slice(0, FINGERPRINT_LENGTH) : trimmed;
      // Basic hash to avoid Map key overhead with long strings
      let hash = 0;
      for (let i = 0; i < fp.length; i++) {
        hash = ((hash << 5) - hash + fp.charCodeAt(i)) | 0;
      }
      return hash;
    });

    const counts = new Map<number, number>();
    for (const fp of fingerprints) {
      counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }

    return Array.from(counts.values()).some(c => c >= DUPLICATE_THRESHOLD);
  }

  private isTransientError(errorMsg: string): boolean {
    const lower = errorMsg.toLowerCase();
    // Stream idle timeout means the model is stuck in extended thinking.
    // Retrying the same model will likely result in another long wait.
    // Fall back to a different model instead. This early-return takes priority
    // over the "stream error" check below, since idle timeout messages contain
    // both "stream error" and "stream idle timeout".
    if (lower.includes("stream idle timeout")) {
      return false;
    }
    // Permanent auth/billing errors — retrying will never succeed.
    // Must be checked BEFORE the "network error" / "stream error" checks below,
    // because the provider layer wraps all errors (including 401/403) into
    // "Network error from provider ..." messages.
    if (
      lower.includes("http 401") || lower.includes("http 403") || lower.includes("http 402") ||
      lower.includes("authorized_error") || lower.includes("login fail") ||
      lower.includes("unauthorized") || lower.includes("authentication failed") ||
      lower.includes("api key") && (lower.includes("invalid") || lower.includes("expired")) ||
      lower.includes("insufficient_quota") || lower.includes("billing")
    ) {
      return false;
    }
    return (
      // Rate limiting
      lower.includes("rate_limit") ||
      lower.includes("rate limit") ||
      lower.includes("429") ||
      // Server overload
      lower.includes("503") ||
      lower.includes("529") ||
      lower.includes("server error") ||
      lower.includes("internal server error") ||
      lower.includes("service unavailable") ||
      lower.includes("overloaded") ||
      lower.includes("capacity") ||
      // Network errors — but NOT stream idle timeouts (model stuck, retrying same model won't help)
      (lower.includes("timeout") && !lower.includes("stream idle timeout")) ||
      lower.includes("econnrefused") ||
      lower.includes("econnreset") ||
      lower.includes("socket hang up") ||
      lower.includes("fetch failed") ||
      lower.includes("network error") ||
      // Stream errors
      lower.includes("stream error") ||
      lower.includes("terminated") ||
      lower.includes("stream_error") ||
      // Model-side transient errors (malformed tool JSON, can be fixed by regenerating)
      lower.includes("invalid function arguments") ||
      (lower.includes("invalid params") && !lower.includes("context window exceeds limit") && !lower.includes("context_length_exceeds")) ||
      lower.includes("tool_use_mismatch") ||
      lower.includes("unexpected tool result") ||
      lower.includes("duplicate_tool_use") ||
      // Model server errors (502 bad gateway, etc.)
      lower.includes("502") ||
      lower.includes("bad gateway")
    );
  }

  // -----------------------------------------------------------------------
  // Result builder
  // -----------------------------------------------------------------------

  private async buildResult(
    taskId: string,
    lastAssistantContent: string,
    messages: ChatMessage[],
    totalToolCalls: number,
    turn: number,
    totalInputTokens: number,
    totalOutputTokens: number,
    compactionEvents: Array<{ turn: number; method: string; tokensSaved: number }>,
    overrideOutput?: string,
    onEvent?: (event: AgentEvent) => void,
    isSubAgent?: boolean,
    costTracker?: CostTracker,
  ): Promise<AgentResult> {
    let finalOutput = overrideOutput ?? lastAssistantContent;

    // Output selection is already handled by the caller (priority-based selection
    // with pushedContent > accumulatedContent > lastAssistantContent > finishSummary).
    // Do NOT scan historical context messages — they are from previous runs and
    // would incorrectly replace short valid answers with unrelated older content.

    if (!finalOutput) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant" && messages[i].content) {
          const c = messages[i].content;
          finalOutput = typeof c === "string" ? c : JSON.stringify(c);
          break;
        }
      }
    }

    const output = finalOutput || "Task completed with no output.";
    this.emitEvent(onEvent, { type: "complete", taskId, output });

    // Write transcript for sub-agent runs (skill invocations and workflow agents)
    let transcriptPath: string | undefined;
    if (isSubAgent && messages.length > 0) {
      transcriptPath = await this.writeTranscript(taskId, messages, turn, totalInputTokens, totalOutputTokens);
    }

    return {
      taskId,
      output,
      toolCallsCount: totalToolCalls,
      turnsUsed: turn,
      // Surface cache totals from costTracker so callers (workflow engine, REST
      // API, observability dashboards) can report cache hit rate without
      // re-parsing the JSONL transcript. costTracker is always constructed at
      // the top of run(); the cachedTokens alias matches the existing
      // AgentResult.usage shape in types.ts.
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedTokens: costTracker ? costTracker.totalCacheReadTokensValue : undefined,
        cacheReadTokens: costTracker ? costTracker.totalCacheReadTokensValue : undefined,
        cacheCreationTokens: costTracker ? costTracker.totalCacheCreationTokensValue : undefined,
      },
      compactionEvents: compactionEvents.length > 0 ? compactionEvents : undefined,
      transcriptPath,
      estimatedCostUsd: costTracker && costTracker.hasPricing ? costTracker.totalCostUsd : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Transcript writer for sub-agent debugging
  // -----------------------------------------------------------------------

  /**
   * Write a transcript file for a sub-agent run.
   * Contains the full message history for debugging and recovery.
   */
  private async writeTranscript(
    taskId: string,
    messages: ChatMessage[],
    turnsUsed: number,
    inputTokens: number,
    outputTokens: number,
  ): Promise<string | undefined> {
    try {
      const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const transcriptDir = join(DEEPANALYZE_CONFIG.dataDir, "tmp", "transcripts");
      await mkdir(transcriptDir, { recursive: true });

      const transcriptPath = join(transcriptDir, `${taskId}.json`);
      const transcript = {
        taskId,
        recordedAt: new Date().toISOString(),
        turnsUsed,
        usage: { inputTokens, outputTokens },
        messageCount: messages.length,
        messages: messages.map(m => ({
          role: m.role,
          content: typeof m.content === "string"
            ? (m.content.length > 10000 ? m.content.slice(0, 10000) + "\n... [truncated]" : m.content)
            : m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls.map(tc => ({
            id: tc.id,
            function: { name: tc.function.name, arguments: tc.function.arguments?.slice(0, 2000) },
          })) } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        })),
      };

      await writeFile(transcriptPath, JSON.stringify(transcript, null, 2), "utf-8");
      return transcriptPath;
    } catch (err) {
      // Non-critical — transcript writing should never block the result
      console.warn(`[AgentRunner] Failed to write transcript for ${taskId}:`, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // T1.7: Tool chain short-circuit for empty search results
  // -----------------------------------------------------------------------

  /** Search tools that should receive short-circuit suggestions on empty results. */
  private static readonly SEARCH_TOOLS_FOR_SHORTCIRCUIT = new Set([
    "kb_search", "web_search", "wiki_browse", "doc_grep",
  ]);

  /**
   * Check if a search tool returned empty results.
   */
  private isEmptySearchResult(toolName: string, result: unknown): boolean {
    if (!AgentRunner.SEARCH_TOOLS_FOR_SHORTCIRCUIT.has(toolName)) return false;
    if (!result || typeof result !== "object") return false;

    const r = result as Record<string, unknown>;

    // Check various empty-result patterns from different search tools
    if (typeof r.total === "number" && r.total === 0) return true;
    if (Array.isArray(r.results) && r.results.length === 0) return true;
    if (Array.isArray(r.matches) && r.matches.length === 0) return true;
    if (Array.isArray(r.documents) && r.documents.length === 0) return true;
    if (Array.isArray(r.pages) && r.pages.length === 0) return true;

    return false;
  }

  /**
   * Generate actionable suggestions when a search returns empty results.
   * Helps the model adjust strategy immediately rather than repeating queries.
   */
  private generateSearchSuggestions(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): string | null {
    const query = String(toolInput.query || toolInput.keyword || toolInput.q || "");
    const suggestions: string[] = ["[搜索建议] 未找到结果。建议尝试："];

    // Suggest shorter/more generic keywords
    if (query.length > 10) {
      suggestions.push(`1. 使用更短的关键词重新搜索（如："${query.slice(0, Math.ceil(query.length / 2))}"）`);
    } else {
      suggestions.push("1. 使用同义词或更通用的关键词重新搜索");
    }

    // Suggest alternative tools based on current tool
    switch (toolName) {
      case "kb_search":
        suggestions.push("2. 尝试使用 wiki_browse 浏览知识库文档列表");
        suggestions.push("3. 尝试使用 doc_grep 进行精确文本匹配搜索");
        break;
      case "web_search":
        suggestions.push("2. 尝试使用 web_fetch 直接访问相关网站");
        suggestions.push("3. 尝试使用 wikipedia 搜索背景信息");
        break;
      case "doc_grep":
        suggestions.push("2. 尝试使用 kb_search 进行语义搜索");
        suggestions.push("3. 尝试放宽搜索模式或使用更短的模式");
        break;
      case "wiki_browse":
        suggestions.push("2. 尝试使用 kb_search 直接搜索内容");
        break;
    }

    suggestions.push("4. 使用 think 工具重新分析问题，考虑不同的搜索角度");

    return suggestions.join("\n");
  }

  // -----------------------------------------------------------------------
  // Event helpers
  // -----------------------------------------------------------------------

  private emitEvent(
    onEvent: ((event: AgentEvent) => void) | undefined,
    event: AgentEvent,
  ): void {
    if (onEvent) {
      try { onEvent(event); } catch { /* swallow */ }
    }

    // Lossless JSONL persistence
    this.recordToJsonl(event);
  }

  /** Record event to JSONL writer (non-blocking, failure is non-critical). */
  private recordToJsonl(event: AgentEvent): void {
    const e = event as Record<string, any>;
    const taskId = e.taskId as string | undefined;
    const runState = taskId ? this._runStates.get(taskId) : undefined;
    const w = runState?.jsonlWriter;
    if (!w) return;
    try {
      const tid = taskId ?? runState?.jsonlTaskId ?? "";
      const turn = e.turn ?? 0;
      switch (event.type) {
        case "text_delta":
          void w.append({ type: "assistant", content: e.delta, turn, taskId: tid });
          break;
        case "thinking_delta":
          void w.append({ type: "thinking", content: e.delta, turn, taskId: tid });
          break;
        case "tool_call":
          void w.append({ type: "tool_use", toolCallId: `${e.toolName}-${Date.now()}`, toolName: e.toolName, input: e.input, turn, taskId: tid });
          break;
        case "tool_result": {
          const output = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
          const isError = typeof e.result === "object" && e.result !== null && "error" in (e.result as object);
          void w.append({ type: "tool_result", toolCallId: `${e.toolName}-${Date.now()}`, toolName: e.toolName, output, error: isError || undefined, turn, taskId: tid });
          break;
        }
        case "turn_usage": {
          // Preserve full usage shape (including cache fields) so historical
          // transcripts can be used to reconstruct cache-hit rates. The runtime
          // usage (src/services/agent/types.ts:159) carries cachedTokens /
          // cacheCreationTokens / cacheReadTokens / estimatedCostUsd; stripping
          // them here made per-turn cache metrics unrecoverable from JSONL.
          const u = e.usage;
          void w.append({
            type: "turn_usage",
            turn,
            taskId: tid,
            usage: {
              inputTokens: u?.inputTokens ?? 0,
              outputTokens: u?.outputTokens ?? 0,
              cachedTokens: u?.cachedTokens ?? 0,
              cacheReadTokens: u?.cacheReadTokens,
              cacheCreationTokens: u?.cacheCreationTokens,
              estimatedCostUsd: u?.estimatedCostUsd,
            },
          });
          break;
        }
      }
    } catch { /* JSONL failure is non-critical */ }
  }

  /** Close the JSONL writer and clear instance state. */
  private async closeJsonlWriter(taskId: string): Promise<void> {
    const runState = this.getRunState(taskId);
    if (runState.jsonlWriter && runState.jsonlSessionId) {
      try {
        await writerRegistry.close(runState.jsonlSessionId, runState.jsonlTaskId ?? taskId);
      } catch {}
    }
    runState.jsonlWriter = undefined;
    runState.jsonlSessionId = undefined;
    runState.jsonlTaskId = undefined;
  }

  /** Record a sub-agent start entry in the parent's JSONL. */
  private recordSubAgentStart(subTaskId: string, parentTaskId: string, agentType: string, skillName: string): void {
    const runState = this.getRunState(parentTaskId);
    if (!runState.jsonlWriter || !runState.jsonlSessionId) return;
    try {
      const transcriptPath = `data/sessions/${runState.jsonlSessionId}/transcripts/${subTaskId}.jsonl`;
      void runState.jsonlWriter.append({
        type: "sub_agent",
        subTaskId,
        parentTaskId,
        agentType,
        transcriptPath,
        output: `Skill: ${skillName}`,
      });
    } catch { /* non-critical */ }
  }

  private recordProgress(
    onEvent: ((event: AgentEvent) => void) | undefined,
    taskId: string,
    turn: number,
    type: AgentProgressEntry["type"],
    content: string,
    toolName?: string,
    toolInput?: Record<string, unknown>,
    toolOutput?: unknown,
  ): void {
    const entry: AgentProgressEntry = {
      turn,
      timestamp: new Date().toISOString(),
      type,
      content,
      toolName,
      toolInput,
      toolOutput,
    };
    this.emitEvent(onEvent, { type: "progress", taskId, progress: entry });
  }
}
