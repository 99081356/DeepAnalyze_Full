// =============================================================================
// DeepAnalyze - Workflow Engine
// =============================================================================
// Multi-agent workflow execution engine supporting 4 scheduling modes:
//   - Pipeline: sequential with accumulated context
//   - Graph (DAG): dependency-based with parallel ready nodes
//   - Council: parallel analysis + optional cross-review
//   - Parallel: all agents run concurrently
// =============================================================================

// Maximum number of sub-agents that can run concurrently.
// Limits API concurrency to prevent quota exhaustion when many sub-agents
// are spawned (e.g., 6 parallel agents × 70 turns = 420 API calls).
const MAX_CONCURRENT_AGENTS = 10;

// ---------------------------------------------------------------------------
// O5.6: Dynamic sub-agent timeout
// ---------------------------------------------------------------------------

/**
 * Estimate an appropriate timeout (in ms) based on task description and agent
 * role. More complex tasks receive longer timeouts.
 */
function estimateTimeout(task: string, agentRole: string): number {
  const combined = `${task} ${agentRole}`.toLowerCase();

  // Simple search / lookup tasks → 20 minutes
  if (
    combined.includes("search") ||
    combined.includes("查找") ||
    combined.includes("检索") ||
    combined.includes("lookup") ||
    combined.includes("find") ||
    combined.includes("query")
  ) {
    return 20 * 60 * 1000; // 1_200_000
  }

  // Analysis / compile tasks → 50 minutes
  if (
    combined.includes("analy") || // covers "analyze", "analysis", "analyst"
    combined.includes("分析") ||
    combined.includes("compile") ||
    combined.includes("编译") ||
    combined.includes("transform") ||
    combined.includes("convert") ||
    combined.includes("process")
  ) {
    return 50 * 60 * 1000; // 3_000_000
  }

  // Report generation → 100 minutes
  if (
    combined.includes("report") ||
    combined.includes("报告") ||
    combined.includes("generat") || // covers "generate", "generation"
    combined.includes("生成") ||
    combined.includes("summar") ||  // covers "summarize", "summary"
    combined.includes("总结") ||
    combined.includes("draft")
  ) {
    return 100 * 60 * 1000; // 6_000_000
  }

  // Deep research → 150 minutes
  if (
    combined.includes("research") ||
    combined.includes("调研") ||
    combined.includes("investigat") || // covers "investigate", "investigation"
    combined.includes("调查") ||
    combined.includes("deep ") ||
    combined.includes("comprehensive")
  ) {
    return 150 * 60 * 1000; // 9_000_000
  }

  // Default → 50 minutes
  return 50 * 60 * 1000; // 3_000_000
}

// ---------------------------------------------------------------------------
// O5.7: Adaptive parallelism
// ---------------------------------------------------------------------------

/**
 * Compute the maximum concurrency based on the number of agents.
 * Small teams don't need the full cap; large teams are capped to avoid
 * API quota exhaustion.
 */
function computeMaxConcurrency(agentCount: number): number {
  if (agentCount <= 3) return agentCount;
  if (agentCount <= 6) return Math.min(agentCount, 5);
  return Math.min(agentCount, MAX_CONCURRENT_AGENTS);
}

/** Extract key findings from a sub-agent's finish summary or output text. */
function extractKeyFindings(text: string, maxFindings: number = 5): string[] {
  if (!text || text.trim().length === 0) return [];
  const lines = text.split("\n")
    .map(l => l.replace(/^[\s#\-*•>]+/, "").trim())
    .filter(l => l.length > 10 && l.length < 300);
  return lines.slice(0, maxFindings);
}

/** Structured file annotation from a sub-agent's finish summary. */
export interface FileAnnotation {
  /** Resolved file path (relative to dataDir, as returned by write_file). */
  path: string;
  /** Human-readable description of what this file contains and its purpose. */
  description: string;
  /** Whether the sub-agent considers this its primary deliverable. */
  isPrimary: boolean;
}

/**
 * Parse structured file annotations from a sub-agent's finish summary.
 * Expected format: 【文件】{path}【用途】{description}
 * Falls back to extracting raw paths if the structured format is not found.
 */
function parseFileAnnotations(summary: string): FileAnnotation[] {
  if (!summary) return [];
  const annotations: FileAnnotation[] = [];
  // Match 【文件】path【用途】description format
  const regex = /【文件】\s*(\S+)\s*【用途】\s*(.+)/g;
  let match;
  while ((match = regex.exec(summary)) !== null) {
    const path = match[1];
    const desc = match[2].trim();
    // Determine if this is a primary deliverable based on description keywords
    const hasPrimaryKeyword = /主要|完整|报告|总结|最终|主报告|主输出/.test(desc);
    const hasSecondaryKeyword = /中间|辅助|临时|笔记|不需要|补充/.test(desc);
    annotations.push({
      path,
      description: desc,
      isPrimary: hasPrimaryKeyword && !hasSecondaryKeyword,
    });
  }
  return annotations;
}

/** Truncate a string for logging (prevent oversized DB rows). */
function truncate(str: string, maxLen: number): string {
  if (!str) return str;
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Persist a sub-agent's output and brief to disk files.
 * Returns the file paths so the parent agent can read them on demand.
 *
 * Design: Like Claude Code's approach — the parent agent first sees a brief,
 * then decides whether to read the full output file. This is adaptive rather
 * than fixed truncation.
 *
 * Files are stored in the data directory (under tmp/workflow-results/) so
 * the parent agent can access them via read_file.
 */
async function persistAgentOutput(
  dataDir: string,
  workflowId: string,
  agentId: string,
  role: string,
  output: string,
  finishSummary: string | undefined,
  filesWritten: string[],
  keyFindings: string[],
  sessionId?: string,
  fileAnnotations?: FileAnnotation[],
): Promise<{ briefPath: string; outputPath: string }> {
  // Store under session workflows dir if sessionId available, otherwise fallback to tmp/
  const baseDir = sessionId
    ? path.join(getSessionWorkflowsDir(dataDir, sessionId), workflowId)
    : path.join(dataDir, "tmp", "workflow-results", workflowId);
  if (!existsSync(baseDir)) {
    await mkdir(baseDir, { recursive: true });
  }

  // Write full output
  const safeAgentId = (agentId ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const outputPath = path.join(baseDir, `${safeAgentId}_output.md`);
  await writeFile(outputPath, output, "utf-8");

  // Write brief — a concise summary the parent agent uses to decide whether to read more
  const briefParts: string[] = [];
  briefParts.push(`# ${role} (${agentId}) — 工作简介`);
  briefParts.push("");

  if (finishSummary) {
    briefParts.push("## 总结");
    briefParts.push(finishSummary);
    briefParts.push("");
  }

  if (keyFindings.length > 0) {
    briefParts.push("## 核心发现");
    for (const f of keyFindings) {
      briefParts.push(`- ${f}`);
    }
    briefParts.push("");
  }

  if (fileAnnotations && fileAnnotations.length > 0) {
    briefParts.push("## 生成的文件");
    for (const fa of fileAnnotations) {
      const marker = fa.isPrimary ? "★" : "○";
      briefParts.push(`- ${marker} ${fa.path} — ${fa.description}`);
    }
    briefParts.push("");
  } else if (filesWritten.length > 0) {
    briefParts.push("## 生成的报告文件");
    for (const f of filesWritten) {
      briefParts.push(`- ${f}`);
    }
    briefParts.push("");
  }

  briefParts.push("## 完整输出");
  // Use relative path from dataDir so read_file can access it
  const relativeOutputPath = path.relative(dataDir, outputPath).replace(/\\/g, "/");
  briefParts.push(`文件路径: ${relativeOutputPath}`);
  briefParts.push(`输出长度: ${output.length} 字符`);
  briefParts.push("");
  briefParts.push("使用 read_file 读取完整输出文件以获取详细内容。");

  const briefPath = path.join(baseDir, `${safeAgentId}_brief.md`);
  await writeFile(briefPath, briefParts.join("\n"), "utf-8");

  // Return relative paths from dataDir (so read_file resolves them correctly)
  const relativeBriefPath = path.relative(dataDir, briefPath).replace(/\\/g, "/");
  return { briefPath: relativeBriefPath, outputPath: relativeOutputPath };
}

/** Truncate JSON for logging. */
function truncateJson(obj: unknown, maxLen = 2000): string {
  if (!obj) return "";
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return truncate(s, maxLen);
}

/**
 * Run promises with bounded concurrency. Unlike Promise.all which runs all
 * promises simultaneously, this limits how many can be in-flight at once.
 */
async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (err) {
        results[index] = { status: "rejected", reason: err };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}

import type { AgentRunner } from "./agent-runner.js";
import { DEFAULT_AGENT_SETTINGS, type AgentResult as RunnerAgentResult, type AgentSettings } from "./types.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { NewWorkflowLog } from "../../store/repos/index.js";
import { getLanguageRule } from "./agent-definitions.js";
import { getLastCacheSafeParams, computeCacheSafeParams, validateCacheSafety } from "./cache-safe-params.js";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getSessionWorkflowsDir } from "../session/session-paths.js";

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

/** Supported workflow scheduling modes. */
export type WorkflowMode = "pipeline" | "graph" | "council" | "parallel" | "single";

/** A single agent definition within a workflow. */
export interface WorkflowAgent {
  /** Unique identifier for this agent within the workflow. */
  id: string;
  /** Role name (e.g. "researcher", "analyst"). */
  role: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** The task instruction for this agent. */
  task: string;
  /** Perspective hint for council mode (e.g. "security", "performance"). */
  perspective?: string;
  /** IDs of agents this agent depends on (graph mode). */
  dependsOn?: string[];
  /** Conditional execution (graph mode). */
  condition?: {
    type: "output_contains" | "output_not_contains";
    node: string;
    text: string;
  };
  /** Tool names this agent may use. Use ["*"] for all. */
  tools: string[];
  /** Structured context from parent/coordinator to prevent redundant work. */
  context?: {
    /** Key findings already discovered by prior agents. */
    parentFindings?: string[];
    /** Directions already explored that yielded no results. */
    excludedDirections?: string[];
    /** Facts that have been confirmed and don't need re-verification. */
    confirmedFacts?: string[];
    /** Items still pending investigation. */
    pendingItems?: string[];
  };
  /** Free-text context from the parent agent (user question, doc list, team allocation). */
  contextText?: string;
  /** Whether to inherit the parent agent's conversation history. */
  inheritContext?: boolean;
}

/** Input for a workflow run. */
export interface WorkflowInput {
  /** Unique identifier for this workflow run. */
  workflowId: string;
  /** Session ID that owns this workflow, used for event routing. */
  sessionId?: string;
  /** The parent task that started this workflow, used for event filtering
   *  in parallel execution scenarios (prevents cross-task event leakage). */
  parentTaskId?: string;
  /** Logical team name. */
  teamName: string;
  /** Scheduling mode. */
  mode: WorkflowMode;
  /** High-level goal of the workflow. */
  goal: string;
  /** Agent definitions. */
  agents: WorkflowAgent[];
  /** Whether to run a cross-review round in council mode. Default: false. */
  crossReview?: boolean;
  /** Root data directory for persisting sub-agent output files. */
  dataDir?: string;
}

/** Result from a single agent within a workflow. */
export interface WorkflowAgentResult {
  agentId: string;
  role: string;
  /** The original task assignment for this agent — used for result attribution. */
  task?: string;
  status: "completed" | "failed" | "skipped";
  output: string;
  duration: number;
  error?: string;
  /** Warning annotation for agents with suspicious output quality (not necessarily failed). */
  warning?: string;
  /** Number of times this agent was retried (0 = first attempt succeeded). */
  retryCount?: number;
  /** Structured summary for the parent agent (avoids returning full output). */
  summary?: {
    taskCompleted: boolean;
    finishSummary?: string;
    pushedContent: Array<{ type: string; title: string; dataLength: number }>;
    filesWritten: string[];
    /** Structured file annotations from the sub-agent's finish summary. */
    fileAnnotations?: FileAnnotation[];
    keyFindings: string[];
    issues?: string;
  };
  /** Persisted file paths for adaptive reading by the parent agent. */
  resultFiles?: {
    /** Path to the brief/summary file */
    briefPath: string;
    /** Path to the full output file */
    outputPath: string;
  };
  /** Path to the sub-agent transcript file for debugging. */
  transcriptPath?: string;
  /** Execution statistics for audit agent context. */
  executionStats?: {
    turnsUsed: number;
    toolCallsCount: number;
    outputLength: number;
  };
}

/** Overall workflow result. */
export interface WorkflowResult {
  workflowId: string;
  status: "completed" | "partial" | "failed" | "cancelled";
  agentResults: WorkflowAgentResult[];
  synthesis: string;
  totalDuration: number;
}

// ---------------------------------------------------------------------------
// Workflow events
// ---------------------------------------------------------------------------

export interface WorkflowStartEvent {
  type: "workflow_start";
  workflowId: string;
  sessionId?: string;
  parentTaskId?: string;
  mode: WorkflowMode;
  goal: string;
  teamName?: string;
  agentCount?: number;
}

export interface WorkflowCompleteEvent {
  type: "workflow_complete";
  workflowId: string;
  sessionId?: string;
  parentTaskId?: string;
  status: WorkflowResult["status"];
  totalDuration: number;
}

export interface WorkflowAgentStartEvent {
  type: "workflow_agent_start";
  workflowId: string;
  agentId: string;
  role: string;
  task?: string;
}

export interface WorkflowAgentCompleteEvent {
  type: "workflow_agent_complete";
  workflowId: string;
  agentId: string;
  role: string;
  status: WorkflowAgentResult["status"];
  duration: number;
}

export interface WorkflowAgentChunkEvent {
  type: "workflow_agent_chunk";
  workflowId: string;
  agentId: string;
  content: string;
  /** Alias for content — matches WsServerMessage field name */
  chunk: string;
}

export interface WorkflowAgentToolCallEvent {
  type: "workflow_agent_tool_call";
  workflowId: string;
  agentId: string;
  toolName: string;
  /** Alias for toolName — matches WsServerMessage field name */
  tool: string;
  input: Record<string, unknown>;
  /** Alias for input — matches WsServerMessage field name */
  args: Record<string, unknown>;
}

export interface WorkflowAgentToolResultEvent {
  type: "workflow_agent_tool_result";
  workflowId: string;
  agentId: string;
  toolName: string;
  /** Alias for toolName — matches WsServerMessage field name */
  tool: string;
  result: unknown;
}

/** Union of all workflow event types. */
export type WorkflowEvent =
  | WorkflowStartEvent
  | WorkflowCompleteEvent
  | WorkflowAgentStartEvent
  | WorkflowAgentCompleteEvent
  | WorkflowAgentChunkEvent
  | WorkflowAgentToolCallEvent
  | WorkflowAgentToolResultEvent;

// ---------------------------------------------------------------------------
// Internal execution context
// ---------------------------------------------------------------------------

/** Internal state tracked per agent during execution. */
interface AgentExecState {
  agent: WorkflowAgent;
  result: WorkflowAgentResult | null;
  status: "pending" | "running" | "done";
}

// ---------------------------------------------------------------------------
// WorkflowEngine
// ---------------------------------------------------------------------------

/**
 * Engine that executes multi-agent workflows using one of four scheduling
 * modes: pipeline, graph (DAG), council, or parallel.
 *
 * The engine delegates actual agent execution to {@link AgentRunner.run} and
 * uses {@link ToolRegistry} for tool resolution. It emits granular events via
 * an `onEvent` callback for real-time progress reporting.
 *
 * This module has no direct dependency on any HTTP framework (Express/Hono).
 */
export class WorkflowEngine {
  private readonly runner: AgentRunner;
  private readonly toolRegistry: ToolRegistry;
  private readonly onEvent: ((event: WorkflowEvent) => void) | undefined;
  private readonly input: WorkflowInput;
  private abortController = new AbortController();
  /** Accumulated log entries, flushed to DB on workflow completion. */
  private logBuffer: NewWorkflowLog[] = [];
  /** Agent runtime settings, loaded once per execute() call. */
  private agentSettings: AgentSettings = DEFAULT_AGENT_SETTINGS;

  constructor(
    input: WorkflowInput,
    runner: AgentRunner,
    toolRegistry: ToolRegistry,
    onEvent?: (event: WorkflowEvent) => void,
    parentSignal?: AbortSignal,
  ) {
    this.input = input;
    this.runner = runner;
    this.toolRegistry = toolRegistry;
    this.onEvent = onEvent;

    // Chain parent signal to workflow's abort controller so that cancelling
    // the parent agent also cancels the entire workflow and all sub-agents.
    if (parentSignal) {
      if (parentSignal.aborted) {
        this.abortController.abort();
      } else {
        parentSignal.addEventListener("abort", () => this.abortController.abort(), { once: true });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Cancel the running workflow. */
  cancel(): void {
    this.abortController.abort();
  }

  /**
   * Execute the workflow according to its mode and return the aggregated
   * result.
   */
  async execute(): Promise<WorkflowResult> {
    const startTime = Date.now();

    // Load agent runtime settings once for all sub-agents
    try {
      const { getRepos } = await import("../../store/repos/index.js");
      const repos = await getRepos();
      const raw = await repos.settings.get("agent_settings");
      this.agentSettings = { ...DEFAULT_AGENT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      // Use defaults if settings can't be loaded
    }

    console.log(
      `[WF ${this.input.workflowId}] emit workflow_start parent=${this.input.parentTaskId ?? "(none)"} session=${this.input.sessionId ?? "(none)"} mode=${this.input.mode} agents=${this.input.agents.length}`,
    );
    this.emit({
      type: "workflow_start",
      workflowId: this.input.workflowId,
      sessionId: this.input.sessionId,
      parentTaskId: this.input.parentTaskId,
      mode: this.input.mode,
      goal: this.input.goal,
      teamName: this.input.teamName,
      agentCount: this.input.agents.length,
    });

    let agentResults: WorkflowAgentResult[];

    switch (this.input.mode) {
      case "single":
        agentResults = await this.executeSingle();
        break;
      case "pipeline":
        agentResults = await this.executePipeline();
        break;
      case "graph":
        agentResults = await this.executeGraph();
        break;
      case "council":
        agentResults = await this.executeCouncil();
        break;
      case "parallel":
        agentResults = await this.executeParallel();
        break;
      default:
        agentResults = this.skipAllAgents(
          `Unknown workflow mode: ${this.input.mode}`,
        );
    }

    // Persist each sub-agent's output and brief to disk files.
    const dataDir = this.input.dataDir;
    if (dataDir) {
      for (const r of agentResults) {
        if (r.status === "completed" && r.output) {
          try {
            const { briefPath, outputPath } = await persistAgentOutput(
              dataDir,
              this.input.workflowId,
              r.agentId,
              r.role,
              r.output,
              r.summary?.finishSummary,
              r.summary?.filesWritten ?? [],
              r.summary?.keyFindings ?? [],
              this.input.sessionId,
              r.summary?.fileAnnotations,
            );
            r.resultFiles = { briefPath, outputPath };
            r.output = `[输出已保存 | 简介: ${briefPath} | 完整: ${outputPath}]`;          } catch (err) {
            console.warn(`[WorkflowEngine] Failed to persist output for ${r.agentId}:`, err);
            r.output = r.summary?.finishSummary || r.output.substring(0, 1500);
          }
        }
      }
    } else {
      for (const r of agentResults) {
        if (r.status === "completed") {
          r.output = r.summary?.finishSummary || r.output.substring(0, 1500);
        }
      }
    }

    // ── Phase 2: Synthesis Audit ──────────────────────────────────────
    // After all sub-agents complete, run a dedicated audit agent that:
    // 1. Reads all sub-agent briefs (compact, ~500 tokens each)
    // 2. Cross-references findings, detects contradictions and gaps
    // 3. edit_file annotations on original reports where needed
    // 4. delegate_task targeted gap-filling if needed
    // 5. Writes audit notes
    //
    // Only runs for parallel/graph/council modes with 2+ completed agents.
    let auditResult: WorkflowAgentResult | null = null;
    // Use all completed agents for the audit count (not just those with resultFiles,
    // since persistAgentOutput may have failed for some agents).
    const completedAgents = agentResults.filter(r => r.status === "completed");
    // Only agents with persisted files can be listed in the audit brief
    const agentsWithFiles = completedAgents.filter(r => r.resultFiles);
    const needsAudit = (this.input.mode === "parallel" || this.input.mode === "graph" || this.input.mode === "council")
      && completedAgents.length >= 2;

    if (needsAudit && dataDir) {
      this.emit({
        type: "workflow_agent_start",
        workflowId: this.input.workflowId,
        agentId: "synthesis-audit",
        role: "综合审计",
        task: "交叉验证与查漏补缺",
      } as WorkflowEvent);

      // Build audit task — list all brief files for the audit agent to read
      const briefList = agentsWithFiles.map(r => {
        const stats = r.executionStats;
        const statInfo = stats
          ? ` | ${stats.turnsUsed}轮/${stats.toolCallsCount}次工具调用/输出${stats.outputLength}字`
          : "";
        return `- ${r.role} (${r.agentId}): 简介→${r.resultFiles!.briefPath} | 完整输出→${r.resultFiles!.outputPath}${statInfo}`;
      }).join("\n");

      // Include failed and warned agents info for audit context
      const failedAgents = agentResults.filter(r => r.status === "failed");
      const warnedAgents = completedAgents.filter(r => r.warning);
      const problemInfo: string[] = [];
      if (failedAgents.length > 0) {
        problemInfo.push(
          `\n\n## 失败的子Agent（未产出有效结果）\n` +
          failedAgents.map(r =>
            `- ✗ ${r.role} (${r.agentId}): ${r.error ?? "未知错误"}\n` +
            `  原始任务: ${(r.task ?? "").substring(0, 200)}` +
            (r.summary?.filesWritten && r.summary.filesWritten.length > 0
              ? `\n  已生成的文件: ${r.summary.filesWritten.join(", ")}（请检查这些文件是否存在且内容完整，如已完整则无需补做）`
              : "")
          ).join("\n")
        );
      }
      if (warnedAgents.length > 0) {
        problemInfo.push(
          `\n\n## 产出可疑的子Agent（需审核判断是否有效）\n` +
          warnedAgents.map(r =>
            `- ⚠ ${r.role}: ${r.warning}`
          ).join("\n") +
          `\n请判断这些Agent是真的失败了（需要补做），还是正常完成了不需要长输出的任务。`
        );
      }
      const problemSection = problemInfo.join("");

      const auditTask =
        `你是综合审计Agent。你的职责是确保每份子Agent报告都是**完整、正确、可独立呈现**的最终成果。\n\n` +
        `由于子Agent分别处理不同的数据/文档切片，它们各自只能看到局部信息。你的核心任务是用全局视野弥补因数据分块导致的：\n` +
        `1. **矛盾**：不同Agent对同一对象的不一致描述\n` +
        `2. **关联断裂**：不同Agent各自持有同一实体的部分信息，但未能建立关联\n` +
        `3. **分析遗漏**：需要综合多个数据切片才能得出的结论，各Agent都未能独立完成\n` +
        `4. **信息孤岛**：某个Agent的结论依赖某个前提，而另一个Agent持有该前提的完整信息\n\n` +
        `## 原始任务目标\n${this.input.goal}\n\n` +
        `## 子Agent输出文件清单\n${briefList}\n` +
        problemSection + `\n\n` +
        `## 审计流程\n\n` +
        `### Phase A: 渐进式阅读所有输出\n\n` +
        `**不要尝试一次性读取所有完整输出文件。** 按以下步骤分批处理：\n\n` +
        `1. 读取 tmp/audit_progressive_notes.md（首次不存在则跳过）\n` +
        `2. 从清单中选择下一批未处理的完整输出文件（每次2-3个），用 read_file 读取完整内容\n` +
        `3. 提取并更新到笔记中：\n` +
        `   - 关键实体（人物/组织/地点/物品/概念/术语等）及其属性\n` +
        `   - 关键数据（数值/日期/时间/度量等）\n` +
        `   - 关键结论和推理链\n` +
        `   - **内容质量评估**：对每份报告评估以下维度，标记不达标的：\n` +
        `     * **内容充实度**：报告标题承诺的分析维度是否都有实质内容？如果标题说"综合分析报告"但内容只是简要总结，标记为 ⚠ 并说明缺失\n` +
        `     * **数据支撑**：结论是否有具体数据/事实支撑？纯空泛论述的标记为 ⚠\n` +
        `     * **分析深度**：是否达到了"可独立呈现"的标准？如果内容过薄以至于作为独立卡片用户会困惑，标记为 ⚠ 并建议补充方向\n` +
        `   - 与笔记中已有信息的交叉比对结果：\n` +
        `     * ⚠️ 矛盾：同一实体的冲突描述\n` +
        `     * 🔗 可关联：不同Agent分别持有同一实体的互补信息\n` +
        `     * 🔄 可合成：多个Agent的部分发现可合并成更完整结论\n` +
        `     * 🔍 遗漏：原始目标中尚未被任何Agent覆盖的方面\n` +
        `4. 写回 tmp/audit_progressive_notes.md\n` +
        `5. 重复步骤1-4直到所有文件处理完毕\n\n` +
        `### Phase B: 关联补齐与修正\n\n` +
        `1. 读取完整的累积笔记\n` +
        `2. 逐一处理标记项：\n` +
        `   - ⚠️ 矛盾：用 grep 定位具体段落 → 判断正确版本 → edit_file 直接修正（不要在末尾追加注解说明"这里错了"，而是直接改成本身就是对的）\n` +
        `   - 🔗 可关联：将各Agent持有的互补信息用 edit_file 补充到对应报告的合适位置\n` +
        `   - 🔄 可合成：将综合结论补充到最相关的输出文件中\n` +
        `   - 🔍 遗漏：关键遗漏用 edit_file 补充或 delegate_task 派发新Agent\n` +
        `3. 对于需要精确定位的条目：用 grep 在原始输出中搜索验证\n\n` +
        `### Phase C: 完成\n\n` +
        `- 将审计概要写入 tmp/audit_notes.md（列出修改项及理由）\n` +
        `- 调用 finish 提交审计结果\n\n` +
        `## 真实性验证（重要）\n` +
        `在判断子Agent报告内容的真实性时，请注意以下数据访问方式都是合法的：\n` +
        `- **expand / doc_grep / kb_search**：通过知识库API获取文档内容\n` +
        `- **bash find + read_file**：直接从磁盘读取原始文件，完全绕过文件清单\n` +
        `- **glob / grep**：搜索文件系统中的文件\n` +
        `因此：**不能仅凭文件清单中是否有某类文件来判断子Agent是否"幻觉"**。\n` +
        `如果子Agent的工具调用统计显示它执行了大量操作（见简介中的轮次/工具调用/输出字数），它很可能确实读取了真实数据。\n` +
        `判断幻觉的正确方式：检查报告中的具体数据是否自相矛盾，或与多个独立来源不一致。\n\n` +
        `## 关键原则\n\n` +
        `- **笔记是外部记忆**：每个新批次开始前必须先读笔记，确保跨批次信息连续\n` +
        `- **保持笔记紧凑**：只记录实体/数据/结论/标记，不复制原文\n` +
        `- **恢复全局视野**：重点不仅是找表面矛盾，而是发现因数据分块而断裂的关联，补齐完整\n` +
        `- **直接修正**：用 edit_file 改正，不追加注解。修改后的每份报告应该是一篇独立完整、可读的文档，用户不需要看审计记录就能得到正确结论\n` +
        `- **有据可依**：所有修改必须有依据（来自其他子Agent的数据或原始材料），不凭空添加内容\n` +
        `- **小问题直接改，大问题派新Agent**：如果某个遗漏需要重新分析大量数据（如关键数据被分散在不同子Agent中导致无法对齐），用 delegate_task 派发新Agent重做特定部分\n` +
        `- **整合派发结果**：新派发的子Agent完成后的结果，同样用 edit_file 整合到对应报告中\n` +
        `- **补做前去重**：对失败的子Agent，先检查其已生成的文件是否已存在且内容完整。如果文件已存在且内容达标，不需要再派发新Agent重做`;

      try {
        auditResult = await this.runAgent(
          {
            id: "synthesis-audit",
            role: "综合审计",
            task: auditTask,
            tools: ["read_file", "write_file", "edit_file", "delegate_task", "bash", "grep", "glob", "think", "finish"],
            systemPrompt: undefined,
          },
          [],
        );

        // If audit produced an output file, add it to results for push
        if (auditResult.status === "completed" && dataDir) {
          try {
            const { briefPath, outputPath } = await persistAgentOutput(
              dataDir, this.input.workflowId, "synthesis-audit", "综合审计",
              auditResult.output,
              auditResult.summary?.finishSummary,
              auditResult.summary?.filesWritten ?? [],
              auditResult.summary?.keyFindings ?? [],
              this.input.sessionId,
              auditResult.summary?.fileAnnotations,
            );
            auditResult.resultFiles = { briefPath, outputPath };
          } catch { /* non-critical */ }
        }

        const auditCompleteEvent: WorkflowAgentCompleteEvent = {
          type: "workflow_agent_complete",
          workflowId: this.input.workflowId,
          agentId: "synthesis-audit",
          role: "综合审计",
          status: auditResult.status,
          duration: auditResult.duration,
        };
        this.emit(auditCompleteEvent);
      } catch (err) {
        console.warn(`[WorkflowEngine] Synthesis audit failed:`, err);
        // Emit completion event so the frontend doesn't show the audit stuck as "running"
        this.emit({
          type: "workflow_agent_complete",
          workflowId: this.input.workflowId,
          agentId: "synthesis-audit",
          role: "综合审计",
          status: "failed",
          duration: 0,
        } as WorkflowAgentCompleteEvent);
        // Non-fatal: workflow continues even if audit fails
      }
    }

    // ── Phase 3: Build Push Catalog (after audit, before coordinator) ──
    // Files have been audited and annotated by the audit Agent (edit_file).
    // Build a catalog with brief summaries so the coordinator can decide
    // what to push based on the user's original request.
    const pushCatalog: Array<{
      agentId: string;
      role: string;
      filePath: string;
      description?: string;
      contentLength: number;
      auditApproved: boolean;
      preview: string;
    }> = [];

    if (dataDir) {
      const { readFile } = await import("node:fs/promises");
      const { resolve, isAbsolute } = await import("node:path");

      // Parse audit output to detect which specific agents were flagged
      // (❌, 失败, 需补做 etc.).  Un-flagged agents get auditApproved=true.
      const auditFlaggedAgents = new Set<string>();
      if (auditResult) {
        try {
          // Collect all audit text: main output + finish summary + brief file
          const auditTexts: string[] = [];
          if (auditResult.output) auditTexts.push(auditResult.output);
          if (auditResult.summary?.finishSummary) auditTexts.push(auditResult.summary.finishSummary);

          // Also try to read the audit brief/output files for richer signal
          for (const p of [auditResult.resultFiles?.briefPath, auditResult.resultFiles?.outputPath]) {
            if (!p) continue;
            try {
              let fpath = p;
              if (!isAbsolute(fpath)) {
                const norm = fpath.startsWith("data/") || fpath.startsWith("data\\")
                  ? fpath.slice(5) : fpath;
                fpath = resolve(dataDir, norm);
              }
              const txt = await readFile(fpath, "utf-8");
              if (txt) auditTexts.push(txt);
            } catch { /* ignore */ }
          }

          const fullAuditText = auditTexts.join("\n");
          // For each completed agent, check if the audit text explicitly flags it
          for (const r of completedAgents) {
            const escapedRole = escapeRegex(r.role);
            const escapedId = escapeRegex(r.agentId);
            const flagPattern = new RegExp(
              `(?:${escapedRole}|${escapedId})[^\\n]{0,80}(?:❌|失败|需补做|需重做|不通过|不达标|严重问题)`,
            );
            if (flagPattern.test(fullAuditText)) {
              auditFlaggedAgents.add(r.agentId);
            }
          }
        } catch (err) {
          console.warn("[WorkflowEngine] Failed to parse audit flagged agents:", err);
        }
      }

      // Check if content looks like placeholder/empty output (not a real analysis).
      // This catches cases where sub-agents wrote minimal content before finishing.
      const isContentSuspicious = (content: string, role: string): boolean => {
        if (!content || content.trim().length === 0) return true;
        const trimmed = content.trim();
        // Explicit placeholder patterns
        const placeholderPatterns = [
          /^\s*$/,                  // Pure whitespace
          /^(TODO|待补充|暂无内容)\s*$/im,  // Explicit placeholders
        ];
        if (placeholderPatterns.some(p => p.test(trimmed))) return true;
        // For "analysis/report" type roles: check if the content has any structure.
        // A real report should have headings, lists, or paragraph breaks.
        if (/分析|报告|研究|综合|审计/.test(role)) {
          const hasHeading = /^#{1,4}\s+/m.test(trimmed);     // Markdown heading
          const hasList = /^[-*]\s|\d+\.\s/m.test(trimmed);   // List
          const hasParagraph = trimmed.includes("\n\n");        // Paragraph break
          const isVeryShort = trimmed.length < 80;
          // Very short + no structure = likely placeholder text
          if (isVeryShort && !hasHeading && !hasList && !hasParagraph) return true;
        }
        return false;
      };

      for (const r of completedAgents) {
        // Add the persisted output file (audited version) as the primary entry
        if (r.resultFiles?.outputPath) {
          try {
            let filePath = r.resultFiles.outputPath;
            if (!isAbsolute(filePath)) {
              const normalized = filePath.startsWith("data/") || filePath.startsWith("data\\")
                ? filePath.slice(5) : filePath;
              filePath = resolve(dataDir, normalized);
            }
            // Re-read files AFTER audit — they may have been modified by edit_file
            const content = await readFile(filePath, "utf-8");
            if (content && content.length > 0) {
              // Get description from fileAnnotations if available
              const primaryAnnotation = r.summary?.fileAnnotations?.find(a => a.isPrimary);
              pushCatalog.push({
                agentId: r.agentId,
                role: r.role,
                filePath: r.resultFiles.outputPath,
                description: primaryAnnotation?.description || "完整报告",
                contentLength: content.length,
                auditApproved: !auditFlaggedAgents.has(r.agentId) && !isContentSuspicious(content, r.role),
                preview: content.substring(0, 300).replace(/\n/g, " "),
              });
            }
          } catch (err) {
            console.warn(`[WorkflowEngine] Read failed for ${r.agentId}:`, err);
          }
        }

        // Add supplementary files from fileAnnotations (not the primary, which is already included)
        if (r.summary?.fileAnnotations && r.summary.fileAnnotations.length > 0) {
          for (const fa of r.summary.fileAnnotations) {
            // Skip primary files already represented by persistAgentOutput
            if (fa.isPrimary && r.resultFiles?.outputPath) continue;
            try {
              const resolved = isAbsolute(fa.path) ? fa.path : resolve(dataDir, fa.path);
              const content = await readFile(resolved, "utf-8");
              if (content && content.length > 0) {
                pushCatalog.push({
                  agentId: r.agentId,
                  role: r.role,
                  filePath: fa.path,
                  description: fa.description,
                  contentLength: content.length,
                  auditApproved: true, // Original data, not audited but trustworthy
                  preview: content.substring(0, 300).replace(/\n/g, " "),
                });
              }
            } catch { /* file may not exist */ }
          }
        }
      }

      // Add failed agents to catalog as warning entries
      const failedAgents = agentResults.filter(r => r.status === "failed");
      for (const r of failedAgents) {
        pushCatalog.push({
          agentId: r.agentId,
          role: r.role,
          filePath: "",
          description: `[失败]`,
          contentLength: 0,
          auditApproved: false,
          preview: `[失败] ${r.error ?? "未知错误"}`,
        });
      }

      // Add audit report to catalog if available
      if (auditResult?.resultFiles?.outputPath) {
        try {
          let auditPath = auditResult.resultFiles.outputPath;
          if (!isAbsolute(auditPath)) {
            const normalized = auditPath.startsWith("data/") || auditPath.startsWith("data\\")
              ? auditPath.slice(5) : auditPath;
            auditPath = resolve(dataDir, normalized);
          }
          const auditContent = await readFile(auditPath, "utf-8");
          if (auditContent && auditContent.length > 0) {
            pushCatalog.push({
              agentId: "synthesis-audit",
              role: "综合审计",
              filePath: auditResult.resultFiles.outputPath,
              contentLength: auditContent.length,
              auditApproved: true,
              preview: auditContent.substring(0, 300).replace(/\n/g, " "),
            });
          }
        } catch (err) {
          console.warn(`[WorkflowEngine] Audit read failed:`, err);
        }
      }
    }

    // Include audit result in the synthesis if available
    if (auditResult) {
      agentResults.push(auditResult);
    }

    const totalDuration = Date.now() - startTime;
    const status = this.computeOverallStatus(agentResults);
    const synthesis = this.synthesizeResults(agentResults, pushCatalog);

    console.log(
      `[WF ${this.input.workflowId}] emit workflow_complete parent=${this.input.parentTaskId ?? "(none)"} session=${this.input.sessionId ?? "(none)"} status=${status} duration=${totalDuration}ms`,
    );
    this.emit({
      type: "workflow_complete",
      workflowId: this.input.workflowId,
      sessionId: this.input.sessionId,
      parentTaskId: this.input.parentTaskId,
      status,
      totalDuration,
    });

    const result: WorkflowResult = {
      workflowId: this.input.workflowId,
      status,
      agentResults,
      synthesis,
      totalDuration,
    };

    // Persist workflow result to agent_tasks table
    try {
      const { getRepos } = await import("../../store/repos/index.js");
      const repos = await getRepos();
      const status = result.status === "completed" ? "completed" : "failed";
      const output = typeof result.synthesis === "string" ? result.synthesis : JSON.stringify(result);
      await repos.agentTask.updateStatus(this.input.workflowId, status, output);
    } catch (err) {
      console.error("[WorkflowEngine] Failed to persist result:", err);
    }

    // Flush accumulated logs to DB (non-blocking)
    this.flushLogs();

    return result;
  }

  // -----------------------------------------------------------------------
  // Single mode
  // -----------------------------------------------------------------------

  /**
   * Single agent delegation: runs exactly one agent directly, bypassing
   * the orchestration overhead of pipeline/graph/etc. Useful when the
   * caller just needs to delegate a focused task to one sub-agent.
   */
  private async executeSingle(): Promise<WorkflowAgentResult[]> {
    if (this.abortController.signal.aborted) {
      return this.buildCancelledResult().agentResults;
    }

    const agent = this.input.agents[0];
    if (!agent) {
      return this.skipAllAgents("No agent provided for single mode.");
    }

    const result = await this.runAgent(agent);
    return [result];
  }

  // -----------------------------------------------------------------------
  // Pipeline mode
  // -----------------------------------------------------------------------

  /**
   * Sequential execution with accumulated context. Each agent receives all
   * prior outputs. Stops on the first failure.
   */
  private async executePipeline(): Promise<WorkflowAgentResult[]> {
    if (this.abortController.signal.aborted) {
      return this.buildCancelledResult().agentResults;
    }

    const results: WorkflowAgentResult[] = [];
    const accumulatedContext: string[] = [];

    for (const agent of this.input.agents) {
      // Build context from prior outputs
      const contextMessages = this.buildContextMessages(accumulatedContext);

      const result = await this.runAgent(agent, contextMessages);

      results.push(result);

      if (result.status === "completed") {
        accumulatedContext.push(
          `## ${agent.role} (${agent.id})\n${result.output}`,
        );
      } else {
        // Pipeline stops on failure
        break;
      }
    }

    // Mark remaining agents as skipped if pipeline stopped early
    this.skipRemaining(results);

    return results;
  }

  // -----------------------------------------------------------------------
  // Graph (DAG) mode
  // -----------------------------------------------------------------------

  /**
   * Dependency-based scheduling. Runs ready nodes in parallel via
   * Promise.allSettled. Includes cycle detection and condition evaluation.
   * Skips nodes whose dependencies failed.
   */
  private async executeGraph(): Promise<WorkflowAgentResult[]> {
    if (this.abortController.signal.aborted) {
      return this.buildCancelledResult().agentResults;
    }

    const agents = this.input.agents;

    // Cycle detection
    this.detectCycles(agents);

    // Validate dependsOn references point to valid node IDs
    const agentIds = new Set(agents.map((a) => a.id));
    for (const agent of agents) {
      for (const depId of agent.dependsOn ?? []) {
        if (!agentIds.has(depId)) {
          throw new Error(
            `Invalid dependsOn: agent "${agent.id}" references non-existent agent "${depId}". Valid IDs: ${[...agentIds].join(", ")}`,
          );
        }
      }
    }

    // Build execution state map
    const stateMap = new Map<string, AgentExecState>();
    for (const agent of agents) {
      stateMap.set(agent.id, { agent, result: null, status: "pending" });
    }

    // Keep running until all nodes are done or no progress is made
    let progress = true;
    while (progress) {
      progress = false;

      // Find all ready nodes
      const readyNodes: WorkflowAgent[] = [];
      for (const [id, state] of stateMap) {
        if (state.status !== "pending") continue;

        const agent = state.agent;

        // Check dependencies
        const deps = agent.dependsOn ?? [];
        const allDepsDone = deps.every((depId) => {
          const depState = stateMap.get(depId);
          return depState && depState.status === "done";
        });

        if (!allDepsDone) continue;

        // Check conditions
        if (agent.condition && !this.evaluateCondition(agent.condition, stateMap)) {
          // Condition not met — skip this node
          state.status = "done";
          state.result = {
            agentId: agent.id,
            role: agent.role,
            status: "skipped",
            output: "",
            duration: 0,
          };
          progress = true;
          continue;
        }

        // Check if any dependency failed — if so, skip
        const anyDepFailed = deps.some((depId) => {
          const depState = stateMap.get(depId);
          return (
            depState &&
            depState.result &&
            depState.result.status !== "completed"
          );
        });

        if (anyDepFailed) {
          state.status = "done";
          state.result = {
            agentId: agent.id,
            role: agent.role,
            status: "skipped",
            output: "",
            duration: 0,
            error: "Skipped because a dependency did not complete successfully.",
          };
          progress = true;
          continue;
        }

        readyNodes.push(agent);
      }

      if (readyNodes.length === 0) continue;

      // Mark ready nodes as running
      for (const agent of readyNodes) {
        stateMap.get(agent.id)!.status = "running";
      }

      // Run ready nodes in parallel (with concurrency limit)
      const runTasks = readyNodes.map((agent) => {
        const deps = agent.dependsOn ?? [];
        const contextMessages = this.buildDepContextMessages(deps, stateMap);
        return () => this.runAgent(agent, contextMessages);
      });

      const settled = await parallelLimit(runTasks, computeMaxConcurrency(agents.length));

      // O5.4: Per-node retry — collect failed agents for a single retry attempt
      const failedAgents: { agent: WorkflowAgent; contextMessages: Array<{ role: "user" | "assistant"; content: string }> }[] = [];

      for (let i = 0; i < settled.length; i++) {
        const agent = readyNodes[i];
        const state = stateMap.get(agent.id)!;

        const outcome = settled[i];
        if (outcome.status === "fulfilled") {
          state.result = outcome.value;
        } else {
          const errorMsg =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          // Record the failure but don't mark as done yet — retry first
          failedAgents.push({
            agent,
            contextMessages: this.buildDepContextMessages(agent.dependsOn ?? [], stateMap),
          });
          state.result = {
            agentId: agent.id,
            role: agent.role,
            status: "failed",
            output: "",
            duration: 0,
            error: errorMsg,
          };
        }
      }

      // Retry failed agents once
      if (failedAgents.length > 0) {
        const retryTasks = failedAgents.map(({ agent, contextMessages }) =>
          () => this.runAgent(agent, contextMessages),
        );
        const retrySettled = await parallelLimit(retryTasks, computeMaxConcurrency(agents.length));

        for (let i = 0; i < retrySettled.length; i++) {
          const { agent } = failedAgents[i];
          const state = stateMap.get(agent.id)!;
          const retryOutcome = retrySettled[i];

          if (retryOutcome.status === "fulfilled") {
            // Retry succeeded — overwrite the failed result
            const retryResult = retryOutcome.value;
            retryResult.retryCount = 1;
            state.result = retryResult;
          } else {
            // Retry also failed — keep the original failure, add retryCount
            const retryError =
              retryOutcome.reason instanceof Error
                ? retryOutcome.reason.message
                : String(retryOutcome.reason);
            state.result = {
              agentId: agent.id,
              role: agent.role,
              status: "failed",
              output: "",
              duration: state.result?.duration ?? 0,
              error: `First attempt: ${state.result?.error ?? "unknown"}; Retry: ${retryError}`,
              retryCount: 1,
            };
          }
        }
      }

      // Mark all ready nodes as done after first attempt + optional retry
      for (const agent of readyNodes) {
        stateMap.get(agent.id)!.status = "done";
      }
      progress = true;
    }

    // Collect results in agent order
    const results: WorkflowAgentResult[] = [];
    for (const agent of agents) {
      const state = stateMap.get(agent.id);
      if (state && state.result) {
        results.push(state.result);
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Council mode
  // -----------------------------------------------------------------------

  /**
   * Round 1: all members analyze in parallel from their perspective.
   * Round 2 (optional crossReview): each member reviews others' outputs
   * and refines their own.
   */
  private async executeCouncil(): Promise<WorkflowAgentResult[]> {
    if (this.abortController.signal.aborted) {
      return this.buildCancelledResult().agentResults;
    }

    const agents = this.input.agents;

    // Round 1: parallel analysis (with concurrency limit)
    const round1Tasks = agents.map((agent) => {
      const perspective = agent.perspective
        ? `\n\nYour perspective: ${agent.perspective}`
        : "";
      const augmentedTask = `${agent.task}${perspective}\n\nOverall goal: ${this.input.goal}`;

      return () => this.runAgent(agent, [], augmentedTask);
    });

    const round1Settled = await parallelLimit(round1Tasks, computeMaxConcurrency(agents.length));

    // O5.4: Retry failed agents once (consistent with executeGraph/executeParallel)
    const failedIndices: number[] = [];
    for (let i = 0; i < round1Settled.length; i++) {
      if (round1Settled[i].status === "rejected") {
        failedIndices.push(i);
      }
    }

    if (failedIndices.length > 0) {
      console.warn(`[WorkflowEngine] Council Round 1: ${failedIndices.length} agent(s) failed, retrying...`);
      const retryTasks = failedIndices.map((idx) => {
        const agent = agents[idx];
        const perspective = agent.perspective
          ? `\n\nYour perspective: ${agent.perspective}`
          : "";
        const augmentedTask = `${agent.task}${perspective}\n\nOverall goal: ${this.input.goal}`;
        return () => this.runAgent(agent, [], augmentedTask);
      });
      const retrySettled = await parallelLimit(retryTasks, computeMaxConcurrency(agents.length));

      for (let j = 0; j < retrySettled.length; j++) {
        const originalIdx = failedIndices[j];
        const retryOutcome = retrySettled[j];
        if (retryOutcome.status === "fulfilled") {
          round1Settled[originalIdx] = retryOutcome;
          console.log(`[WorkflowEngine] Council Round 1 retry succeeded for agent ${agents[originalIdx].id}`);
        } else {
          const retryErr = retryOutcome.reason instanceof Error ? retryOutcome.reason.message : String(retryOutcome.reason);
          console.warn(`[WorkflowEngine] Council Round 1 retry failed for agent ${agents[originalIdx].id}: ${retryErr}`);
        }
      }
    }

    const round1Results: WorkflowAgentResult[] = round1Settled.map(
      (outcome, i) => {
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        const errorMsg =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        return {
          agentId: agents[i].id,
          role: agents[i].role,
          status: "failed",
          output: "",
          duration: 0,
          error: errorMsg,
        };
      },
    );

    // If no crossReview, return round 1 results
    if (!this.input.crossReview) {
      return round1Results;
    }

    // Round 2: cross-review (parallel)
    // Build per-agent inputs first, then run all reviews concurrently.
    const round2Inputs: Array<{
      agent: WorkflowAgent;
      round1Result: WorkflowAgentResult;
      contextMessages: Array<{ role: "user" | "assistant"; content: string }> | null;
    }> = [];

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const round1Result = round1Results[i];

      // Skip agents that failed in round 1
      if (round1Result.status !== "completed") {
        round2Inputs.push({ agent, round1Result, contextMessages: null });
        continue;
      }

      // Build the context from other members' outputs
      const otherOutputs = round1Results
        .filter((_, j) => j !== i && round1Results[j].status === "completed")
        .map(
          (r) =>
            `## ${r.role} (${r.agentId})\n${r.output}`,
        )
        .join("\n\n");

      if (!otherOutputs.trim()) {
        // No other outputs to review — keep round 1 result
        round2Inputs.push({ agent, round1Result, contextMessages: null });
        continue;
      }

      const reviewTask =
        `## 交叉审查任务\n\n` +
        `你是团队 Council 审查的成员。以下是第一轮分析的材料：\n\n` +
        `### 原始目标\n${this.input.goal}\n\n` +
        `### 你的第一轮分析\n${round1Result.output}\n\n` +
        `### 其他团队成员的分析\n${otherOutputs}\n\n` +
        `### 审查要求\n` +
        `请仔细阅读其他成员的分析，然后精炼你自己的输出。具体要求：\n\n` +
        `1. **吸纳遗漏洞察**：如果其他成员发现了你未涉及的重要信息或角度，将其整合到你的分析中\n` +
        `2. **处理分歧**：如果你的结论与其他成员有冲突，请基于证据和逻辑说明你的立场——如果对方更有道理，调整你的结论\n` +
        `3. **互补强化**：如果其他成员的分析可以补充或强化你的论证，引用并整合\n` +
        `4. **独立思考**：不要简单照搬他人结论，保持你独特的分析视角（${agent.perspective || "综合"}），但确保你的分析经得起交叉验证\n\n` +
        `最终输出应该是一份独立完整、经过交叉验证的精炼分析报告。`;

      const contextMessages = [
        {
          role: "user" as const,
          content: reviewTask,
        },
      ];

      round2Inputs.push({ agent, round1Result, contextMessages });
    }

    // Run all Round 2 reviews with concurrency limit
    const round2Tasks = round2Inputs.map((input) => {
      if (!input.contextMessages) {
        // No review needed — carry forward the round 1 result
        return () => Promise.resolve(input.round1Result);
      }
      return () => this.runAgent(input.agent, input.contextMessages);
    });

    const round2Settled = await parallelLimit(round2Tasks, computeMaxConcurrency(agents.length));
    const round2Results: WorkflowAgentResult[] = round2Settled.map(
      (outcome, i) => {
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        const errorMsg =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        return {
          agentId: round2Inputs[i].agent.id,
          role: round2Inputs[i].agent.role,
          status: "failed",
          output: "",
          duration: 0,
          error: errorMsg,
        };
      },
    );

    return round2Results;
  }

  // -----------------------------------------------------------------------
  // Parallel mode
  // -----------------------------------------------------------------------

  /**
   * All agents run in parallel. Results are synthesized.
   */
  private async executeParallel(): Promise<WorkflowAgentResult[]> {
    if (this.abortController.signal.aborted) {
      return this.buildCancelledResult().agentResults;
    }

    const agents = this.input.agents;

    const tasks = agents.map((agent) => () => {
      const augmentedTask = `${agent.task}\n\n[整体目标] ${this.input.goal}`;
      return this.runAgent(agent, [], augmentedTask);
    });
    const settled = await parallelLimit(tasks, computeMaxConcurrency(agents.length));

    // O5.4: Retry failed agents once (consistent with executeGraph behavior)
    const failedIndices: number[] = [];
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === "rejected") {
        failedIndices.push(i);
      }
    }

    if (failedIndices.length > 0) {
      console.warn(`[WorkflowEngine] Parallel mode: ${failedIndices.length} agent(s) failed, retrying...`);
      const retryTasks = failedIndices.map((idx) => () => {
        const agent = agents[idx];
        const augmentedTask = `${agent.task}\n\n[整体目标] ${this.input.goal}`;
        return this.runAgent(agent, [], augmentedTask);
      });
      const retrySettled = await parallelLimit(retryTasks, computeMaxConcurrency(agents.length));

      for (let j = 0; j < retrySettled.length; j++) {
        const originalIdx = failedIndices[j];
        const retryOutcome = retrySettled[j];
        if (retryOutcome.status === "fulfilled") {
          settled[originalIdx] = retryOutcome;
          console.log(`[WorkflowEngine] Parallel retry succeeded for agent ${agents[originalIdx].id}`);
        } else {
          const retryErr = retryOutcome.reason instanceof Error ? retryOutcome.reason.message : String(retryOutcome.reason);
          console.warn(`[WorkflowEngine] Parallel retry failed for agent ${agents[originalIdx].id}: ${retryErr}`);
        }
      }
    }

    return settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") {
        return outcome.value;
      }
      const errorMsg =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      return {
        agentId: agents[i].id,
        role: agents[i].role,
        status: "failed",
        output: "",
        duration: 0,
        error: errorMsg,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Agent execution
  // -----------------------------------------------------------------------

  /**
   * Run a single agent via the AgentRunner, wrapping it with workflow-level
   * events, timing, and detailed logging.
   */
  private async runAgent(
    agent: WorkflowAgent,
    contextMessages?: Array<{ role: "user" | "assistant"; content: string }>,
    taskOverride?: string,
  ): Promise<WorkflowAgentResult> {
    const startTime = Date.now();
    let task = taskOverride ?? agent.task;

    // Inject structured context into task description to prevent redundant work
    if (agent.context) {
      const ctx = agent.context;
      const ctxParts: string[] = [];
      if (ctx.parentFindings && ctx.parentFindings.length > 0) {
        ctxParts.push(`## 已发现的关键信息\n${ctx.parentFindings.map(f => `- ${f}`).join("\n")}\n请勿重复搜索这些已确认的信息。`);
      }
      if (ctx.excludedDirections && ctx.excludedDirections.length > 0) {
        ctxParts.push(`## 已排除的方向（无需再试）\n${ctx.excludedDirections.map(d => `- ${d}`).join("\n")}`);
      }
      if (ctx.confirmedFacts && ctx.confirmedFacts.length > 0) {
        ctxParts.push(`## 已确认事实（可直接引用，无需重新验证）\n${ctx.confirmedFacts.map(f => `- ${f}`).join("\n")}`);
      }
      if (ctx.pendingItems && ctx.pendingItems.length > 0) {
        ctxParts.push(`## 待调查项目（优先处理）\n${ctx.pendingItems.map(p => `- ${p}`).join("\n")}`);
      }
      if (ctxParts.length > 0) {
        task = `${task}\n\n---\n以下是协调器提供的上下文信息，帮助你避免重复工作：\n\n${ctxParts.join("\n\n")}`;
      }
    }

    // Inject free-text context (user question, doc list, team allocation)
    if (agent.contextText) {
      task = `[任务上下文]\n${agent.contextText}\n\n---\n\n${task}`;
    }

    // Inherit parent agent's conversation context (like Claude Code's Fork mode)
    // But skip if the parent is a preprocessing session to maintain isolation
    if (agent.inheritContext && this.toolRegistry) {
      const ctx = this.toolRegistry.getExecutionContext();
      const isPreprocessing = ctx.isPreprocessingSession === true;
      if (!isPreprocessing) {
        const parentMessages = ctx.parentMessages as
          | Array<{ role: "user" | "assistant"; content: string }>
          | undefined;
        if (parentMessages && parentMessages.length > 0) {
          const maxInheritMessages = 20;
          const inherited = parentMessages.slice(-maxInheritMessages);
          contextMessages = [...inherited, ...(contextMessages || [])];
        }
      }
    }

    // Detect KB presence for conditional boundary constraints
    let hasKbDocs = false;
    let inheritedScopeKbIds: string[] | undefined;

    // Inherit parent session memory — pass accumulated knowledge so sub-agents
    // don't re-search what the parent already found
    if (this.toolRegistry) {
      const ctx = this.toolRegistry.getExecutionContext();
      const parentSessionMemory = ctx.sessionMemory as string | undefined;
      if (parentSessionMemory) {
        const memoryPrefix: Array<{ role: "user" | "assistant"; content: string }> = [
          { role: "assistant", content: `[会话记忆摘要]\n${parentSessionMemory.substring(0, 3000)}` },
        ];
        contextMessages = [...(contextMessages || []), ...memoryPrefix];
      }

      // Inherit scope information — tell sub-agents which KBs they should search in
      inheritedScopeKbIds = ctx.scopeKbIds as string[] | undefined;
      hasKbDocs = !!(inheritedScopeKbIds && inheritedScopeKbIds.length > 0);
      if (hasKbDocs) {
        const scopeHint = `[搜索范围限制] 你只能在以下知识库中搜索: ${inheritedScopeKbIds!.join(", ")}` +
          `。使用 kb_search/doc_grep 时将 kbIds 设为 ${JSON.stringify(inheritedScopeKbIds)}。`;
        task = `${scopeHint}\n\n---\n\n${task}`;
      }
    }

    // Inject boundary constraints for sub-agents without custom systemPrompt.
    // Boundary constraints are split into two parts:
    //   1. Universal constraints (output spec, finish requirements) — always included
    //   2. Document analysis guidance — only when session has KB documents (hasKbDocs)
    // Analysis guidance is omitted for non-KB sessions to avoid priming the model
    // for "analysis mode" on creation/writing/coding tasks.
    if (!agent.systemPrompt) {
      let constraints = "【重要约束】你是并行工作流中的子Agent，负责完成分配给你的任务。\n";

      // Document analysis guidance — only when session has knowledge base documents
      if (hasKbDocs) {
        constraints +=
          "- 只分析task中指定范围内的文档，不要跨范围分析其他文档。task可能以目录路径、文档类型或文件名特征指定范围——用 wiki_browse(listDocuments=true) 发现范围内的具体文件\n" +
          "- expand 支持 docIds 数组参数批量展开多个文档（每次最多20个），优先使用批量模式\n" +
          "- expand 支持 tokenBudget 参数限制返回长度；对大型文档可设置 tokenBudget=4000 先快速浏览\n" +
          "- 图片文件的 VLM 描述已在 L1 层预编译好，使用 expand(docId, targetLevel=\"L1\") 即可获取\n" +
          "\n【渐进式工作方法】当任务涉及大量文档（>20个）时，必须采用渐进式分析：\n" +
          "1. 先通过 wiki_browse(listDocuments=true, kbId=...) 浏览全部文档摘要，规划分析顺序\n" +
          "2. 分批处理：先用 wiki_browse 获取范围内文档的 docId，再用 expand(docIds=[...]) 批量展开10-20个\n" +
          "3. 即时记录：每处理完一批，用 write_file 将关键发现写入工作文件（如 tmp/你的角色_findings.md）\n" +
          "4. 断点续传：上下文被压缩后，先 read_file 读取工作文件恢复进度，不要重新分析\n" +
          "5. 不重复读取：已分析的文档不要再次 expand——通过工作文件确认哪些已完成\n" +
          "6. 最终报告从工作文件编译输出，而非依赖上下文记忆\n" +
          "7. 完成后调用 finish 提交结果，summary 中包含核心发现（3-5条要点）和生成的文件路径列表\n";
      }

      // Universal constraints — always included regardless of task type
      constraints +=
        "\n【输出规范——所有实质内容必须用 write_file】\n" +
        "所有需要交付给用户的内容（报告、分析结果、创作内容、文章等）都必须用 write_file 写入文件，由主Agent统一推送。\n" +
        "不要尝试在对话中直接输出长内容——直接输出会因为上下文截断、轮次限制等原因丢失。\n" +
        "每次 write_file 调用应写入完整的实质内容，不要只写标题或大纲。\n" +
        "如果任务要求生成长内容，分段写入不同文件，或分次 append 到同一文件。\n" +
        "\n【文件路径规则】\n" +
        "- write_file 会自动将文件保存到会话专用目录，返回值中的 path 字段是实际保存路径\n" +
        "- 后续 read_file、push_content 引用文件时，使用 write_file 返回的 path，不要用你传入的原始路径\n" +
        "- 不要用 bash（wc、cat等）验证 write_file 写入的文件——它们的工作目录与 write_file 不同\n" +
        "- 如需验证或回读文件内容，使用 read_file 并传入 write_file 返回的 path\n" +
        "\n【finish 摘要要求】调用 finish 时，summary 必须包含：\n" +
        "- 核心发现（3-5条要点）\n" +
        "- 生成的文件清单，每个文件一行，格式：\n" +
        "  【文件】{write_file返回的path}【用途】{该文件的用途和内容简述}\n" +
        "  用途说明中：完整报告/主输出标记为主要输出，中间笔记/辅助材料标记为非主要\n" +
        "  示例：\n" +
        "  【文件】sessions/xxx/output/main_xxx_report.md【用途】完整分析报告，涵盖核心发现和数据支撑\n" +
        "  【文件】sessions/xxx/output/main_xxx_appendix.md【用途】附录数据表，补充材料\n\n";

      task = constraints + task;
    }

    // Inject essential constraints for sub-agents with custom systemPrompt.
    // Custom systemPrompt provides domain guidance but may lack operational rules.
    // Skip document analysis guidance (the systemPrompt handles domain specifics)
    // but always inject file path rules, output spec, and finish requirements.
    if (agent.systemPrompt) {
      const essentialConstraints =
        getLanguageRule() + "\n\n" +
        "【输出规范——所有实质内容必须用 write_file】\n" +
        "所有需要交付给用户的内容都必须用 write_file 写入文件，由主Agent统一推送。\n" +
        "不要尝试在对话中直接输出长内容——直接输出会因为上下文截断、轮次限制等原因丢失。\n" +
        "\n【文件路径规则】\n" +
        "- write_file 会自动将文件保存到会话专用目录，返回值中的 path 字段是实际保存路径\n" +
        "- 后续 read_file、push_content 引用文件时，使用 write_file 返回的 path，不要用你传入的原始路径\n" +
        "- 不要用 bash（wc、cat等）验证 write_file 写入的文件——它们的工作目录与 write_file 不同\n" +
        "- 如需验证或回读文件内容，使用 read_file 并传入 write_file 返回的 path\n" +
        "\n【finish 摘要要求】调用 finish 时，summary 必须包含：\n" +
        "- 核心发现（3-5条要点）\n" +
        "- 生成的文件清单，每个文件一行，格式：\n" +
        "  【文件】{write_file返回的path}【用途】{该文件的用途和内容简述}\n" +
        "  用途说明中：完整报告/主输出标记为主要输出，中间笔记/辅助材料标记为非主要\n" +
        "  示例：\n" +
        "  【文件】sessions/xxx/output/main_xxx_report.md【用途】完整分析报告，涵盖核心发现和数据支撑\n" +
        "  【文件】sessions/xxx/output/main_xxx_appendix.md【用途】附录数据表，补充材料\n\n";
      task = `${essentialConstraints}---\n\n${task}`;
    }

    this.emit({
      type: "workflow_agent_start",
      workflowId: this.input.workflowId,
      agentId: agent.id,
      role: agent.role,
      task,
    });

    // Log agent start
    this.log(agent.id, agent.role, null, "agent_start", {
      task: truncate(task, 2000),
      tools: agent.tools ?? ["*"],
      hasContextMessages: !!(contextMessages && contextMessages.length > 0),
      contextMessageCount: contextMessages?.length ?? 0,
    });

    // Track per-agent turn stats
    let agentTurnCount = 0;
    let agentToolCallCount = 0;
    let agentTotalTokensIn = 0;
    let agentTotalTokensOut = 0;

    // Per-agent timeout: dynamically estimated based on task complexity.
    // Prevents a stalled LLM stream from blocking the entire workflow.
    const agentTimeoutMs = estimateTimeout(task, agent.role);
    const agentTimeoutController = new AbortController();
    const agentTimeoutTimer = setTimeout(
      () => agentTimeoutController.abort(),
      agentTimeoutMs,
    );

    try {
      // Combine the workflow-level signal with the per-agent timeout
      const combinedSignal = AbortSignal.any
        ? AbortSignal.any([this.abortController.signal, agentTimeoutController.signal])
        : this.abortController.signal;

      // Track sub-agent tool calls for structured summary
      const pushedContentTracker: Array<{ type: string; title: string; dataLength: number }> = [];
      const filesWrittenTracker: string[] = [];
      let finishSummary: string | undefined;
      let fileAnnotations: FileAnnotation[] = [];

      // Fire SubagentStart hook
      const subagentId = `wf-${agent.id}`;
      const hookMgr = this.runner.getHookManager();
      if (hookMgr) {
        await hookMgr.fireSubagentStart(subagentId).catch(() => {});
      }

      // Feature E (C-190): Validate cache safety before sub-agent creation
      // Only check for sub-agents WITHOUT custom prompt/tools overrides.
      // Sub-agents with custom systemPrompt/tools intentionally differ from the parent
      // and cannot share the parent's prompt cache — this is expected, not a violation.
      const hasCustomPrompt = !!agent.systemPrompt;
      const hasCustomTools = !!(agent.tools && agent.tools.length > 0);
      const parentParams = getLastCacheSafeParams();
      if (parentParams && !hasCustomPrompt && !hasCustomTools) {
        const childParams = computeCacheSafeParams({
          systemPrompt: agent.systemPrompt ?? "",
          toolsJson: JSON.stringify(agent.tools ?? ["*"]),
          model: parentParams.model,
          contextMessagesCount: contextMessages?.length ?? 0,
        });
        const safety = validateCacheSafety(parentParams, childParams);
        if (!safety.safe) {
          console.warn(`[WorkflowEngine] Cache safety violation for sub-agent ${agent.id}: ${safety.violations.join("; ")}`);
        }
      }

      const runnerResult: RunnerAgentResult = await this.runner.run({
        input: task,
        agentType: "general",
        sessionId: this.input.sessionId,
        systemPromptOverride: agent.systemPrompt,
        toolsOverride: agent.tools,
        contextMessages,
        signal: combinedSignal,
        onEvent: (event) => {
          this.forwardAgentEvent(agent.id, event);
          this.logAgentEvent(agent.id, agent.role, event);
          // Track stats
          if (event.type === "turn") agentTurnCount++;
          if (event.type === "tool_call") {
            agentToolCallCount++;
            // Track key tool calls for structured summary
            if (event.toolName === "push_content") {
              const input = event.input as Record<string, unknown>;
              pushedContentTracker.push({
                type: String(input.type || ""),
                title: String(input.title || ""),
                dataLength: String(input.data || "").length,
              });
            }
            if (event.toolName === "write_file") {
              const input = event.input as Record<string, unknown>;
              filesWrittenTracker.push(String(input.path || ""));
            }
            if (event.toolName === "finish") {
              const input = event.input as Record<string, unknown>;
              if (input.summary && typeof input.summary === "string") {
                finishSummary = input.summary;
                // Parse structured file annotations from the finish summary
                const parsed = parseFileAnnotations(input.summary);
                if (parsed.length > 0) fileAnnotations = parsed;
              }
            }
          }
          // Update filesWrittenTracker with actual path from tool_result
          if (event.type === "tool_result" && event.toolName === "write_file") {
            const result = event.result as Record<string, unknown>;
            if (result?.success && result?.path) {
              const actualPath = String(result.path);
              // Replace the last written path (from original to actual)
              if (filesWrittenTracker.length > 0) {
                filesWrittenTracker[filesWrittenTracker.length - 1] = actualPath;
              }
            }
          }
          if (event.type === "turn_usage") {
            agentTotalTokensIn += event.usage.inputTokens;
            agentTotalTokensOut += event.usage.outputTokens;
          }
        },
        maxTurns: this.agentSettings.subAgentMaxTurns,
        scope: (inheritedScopeKbIds && inheritedScopeKbIds.length > 0) ? { kbIds: inheritedScopeKbIds } : undefined,
      });

      const duration = Date.now() - startTime;

      // Log agent completion with summary
      this.log(agent.id, agent.role, null, "agent_complete", {
        status: "completed",
        outputLength: runnerResult.output.length,
        outputPreview: truncate(runnerResult.output, 1000),
        turnsUsed: runnerResult.turnsUsed,
        toolCallsCount: runnerResult.toolCallsCount,
        totalTokensIn: runnerResult.usage.inputTokens,
        totalTokensOut: runnerResult.usage.outputTokens,
        durationMs: duration,
      });

      // Detect model failure: the "output" is actually an error message from
      // the model layer (e.g. quota exceeded, context overflow).  Mark these
      // as "failed" rather than "completed" so the orchestrator can retry or
      // skip them appropriately.
      const isModelFailure = runnerResult.output.startsWith("模型调用失败")
        || runnerResult.output.startsWith("Model call failed");

      // Detect empty/near-empty output: if the agent produced almost no text,
      // no finish summary, no files, and no pushed content, it likely failed
      // silently (e.g., degenerated due to repeated tool errors).
      const hasOutput = runnerResult.output.length > 200 && !isModelFailure;
      const hasFinishSummary = !!finishSummary && finishSummary.length > 50;
      const hasFiles = filesWrittenTracker.length > 0;
      const hasPushedContent = pushedContentTracker.length > 0;
      const effectivelyEmpty = !hasOutput && !hasFinishSummary && !hasFiles && !hasPushedContent;

      // Sub-agents write analysis to files (push_content is blocked for them).
      // The bestOutput selector in AgentRunner may pick up only the short finish
      // summary instead of the actual file content. Recover the real output by
      // reading the written files when the runner's text output is suspiciously short.
      let enrichedOutput = isModelFailure ? "" : runnerResult.output;
      if (!isModelFailure && hasFiles && enrichedOutput.length < 200 && this.input.dataDir) {
        const dataDir = this.input.dataDir;
        let enriched = false;

        // Strategy 1: Use the sub-agent's own annotation to identify primary output
        if (fileAnnotations.length > 0) {
          const primary = fileAnnotations.find(a => a.isPrimary);
          const target = primary || fileAnnotations[0];
          if (target) {
            try {
              const resolved = path.isAbsolute(target.path) ? target.path : path.resolve(dataDir, target.path);
              const fileContent = await readFile(resolved, "utf-8");
              if (fileContent && fileContent.trim().length > enrichedOutput.length) {
                console.log(
                  `[WorkflowEngine] Sub-agent ${agent.id} output enriched from annotated file: ` +
                  `${target.path} (${fileContent.length} chars, "${target.description}")`
                );
                enrichedOutput = fileContent;
                enriched = true;
              }
            } catch { /* file may not exist */ }
          }
        }

        // Strategy 2: Fallback — pick the largest file
        if (!enriched) {
          let bestFileContent = "";
          let bestFilePath = "";
          for (const fp of filesWrittenTracker) {
            try {
              const resolved = path.isAbsolute(fp) ? fp : path.resolve(dataDir, fp);
              const fileContent = await readFile(resolved, "utf-8");
              if (fileContent && fileContent.trim().length > bestFileContent.length) {
                bestFileContent = fileContent;
                bestFilePath = fp;
              }
            } catch { /* file may not exist or be readable */ }
          }
          if (bestFileContent.trim().length > enrichedOutput.length) {
            console.log(
              `[WorkflowEngine] Sub-agent ${agent.id} output enriched from largest file: ` +
              `${bestFilePath} (${bestFileContent.length} chars, text output was ${enrichedOutput.length})`
            );
            enrichedOutput = bestFileContent;
          }
        }
      }

      const result: WorkflowAgentResult = {
        agentId: agent.id,
        role: agent.role,
        task: agent.task,
        status: isModelFailure ? "failed" : "completed",
        output: enrichedOutput,
        error: isModelFailure ? runnerResult.output : undefined,
        duration,
        transcriptPath: runnerResult.transcriptPath,
        warning: !isModelFailure && effectivelyEmpty
          ? `产出极少（${runnerResult.output.length}字，${agentToolCallCount}次工具调用，${agentTurnCount}轮）。可能因工具错误退化终止，也可能本身不需要长输出。请审核Agent判断。`
          : undefined,
        summary: isModelFailure ? undefined : {
          taskCompleted: true,
          finishSummary,
          pushedContent: pushedContentTracker,
          filesWritten: filesWrittenTracker,
          fileAnnotations: fileAnnotations.length > 0 ? fileAnnotations : undefined,
          keyFindings: extractKeyFindings(finishSummary || enrichedOutput),
          issues: effectivelyEmpty ? `产出极低（${runnerResult.output.length}字）` : undefined,
        },
        executionStats: {
          turnsUsed: runnerResult.turnsUsed,
          toolCallsCount: runnerResult.toolCallsCount,
          outputLength: isModelFailure ? 0 : enrichedOutput.length,
        },
      };

      this.emit({
        type: "workflow_agent_complete",
        workflowId: this.input.workflowId,
        agentId: agent.id,
        role: agent.role,
        status: result.status,
        duration,
      });

      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      const isTimeout = agentTimeoutController.signal.aborted;
      const errorMsg = isTimeout
        ? `Agent timed out after ${agentTimeoutMs / 1000}s (${agentTurnCount} turns, ${agentToolCallCount} tool calls)`
        : (err instanceof Error ? err.message : String(err));

      // Log agent failure
      this.log(agent.id, agent.role, null, "agent_error", {
        status: "failed",
        error: truncate(errorMsg, 2000),
        turnsUsed: agentTurnCount,
        toolCallsCount: agentToolCallCount,
        totalTokensIn: agentTotalTokensIn,
        totalTokensOut: agentTotalTokensOut,
        durationMs: duration,
      });

      const result: WorkflowAgentResult = {
        agentId: agent.id,
        role: agent.role,
        task: agent.task,
        status: "failed",
        output: "",
        duration,
        error: errorMsg,
      };

      this.emit({
        type: "workflow_agent_complete",
        workflowId: this.input.workflowId,
        agentId: agent.id,
        role: agent.role,
        status: "failed",
        duration,
      });

      return result;
    } finally {
      clearTimeout(agentTimeoutTimer);
      // Fire SubagentStop hook
      const subagentId = `wf-${agent.id}`;
      const hookMgr = this.runner.getHookManager();
      if (hookMgr) {
        await hookMgr.fireSubagentStop(subagentId).catch(() => {});
      }
    }
  }

  // -----------------------------------------------------------------------
  // Event forwarding
  // -----------------------------------------------------------------------

  /**
   * Forward AgentRunner events as workflow events, tagging them with the
   * agentId so the consumer can attribute events to the right agent.
   */
  private forwardAgentEvent(
    agentId: string,
    event: import("./types.js").AgentEvent,
  ): void {
    switch (event.type) {
      case "turn":
        this.emit({
          type: "workflow_agent_chunk",
          workflowId: this.input.workflowId,
          agentId,
          content: event.content,
          chunk: event.content,
        });
        break;

      case "tool_call":
        this.emit({
          type: "workflow_agent_tool_call",
          workflowId: this.input.workflowId,
          agentId,
          toolName: event.toolName,
          tool: event.toolName,
          input: event.input,
          args: event.input,
        });
        break;

      case "tool_result":
        this.emit({
          type: "workflow_agent_tool_result",
          workflowId: this.input.workflowId,
          agentId,
          toolName: event.toolName,
          tool: event.toolName,
          result: event.result,
        });
        break;

      // start, complete, progress, error, cancelled, compaction,
      // advisory_limit_reached are not forwarded as separate workflow events
      // to keep the workflow event surface minimal.
      default:
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  /** Append a structured log entry to the buffer. */
  private log(
    agentId: string,
    role: string | undefined,
    turn: number | null,
    eventType: string,
    content: Record<string, unknown>,
    options?: { toolName?: string; durationMs?: number; modelId?: string; tokensIn?: number; tokensOut?: number },
  ): void {
    this.logBuffer.push({
      workflowId: this.input.workflowId,
      agentId,
      role: role ?? undefined,
      turn: turn ?? undefined,
      eventType,
      toolName: options?.toolName,
      content,
      durationMs: options?.durationMs,
      modelId: options?.modelId,
      tokensIn: options?.tokensIn,
      tokensOut: options?.tokensOut,
    });
  }

  /** Convert an AgentEvent from AgentRunner into structured log entries. */
  private logAgentEvent(
    agentId: string,
    role: string | undefined,
    event: import("./types.js").AgentEvent,
  ): void {
    switch (event.type) {
      case "turn":
        this.log(agentId, role, event.turn, "text", {
          contentPreview: truncate(event.content || "", 1000),
          contentLength: (event.content || "").length,
        });
        break;

      case "turn_usage":
        this.log(agentId, role, event.turn, "llm_usage", {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cachedTokens: event.usage.cachedTokens,
        }, {
          tokensIn: event.usage.inputTokens,
          tokensOut: event.usage.outputTokens,
        });
        break;

      case "tool_call":
        this.log(agentId, role, event.turn, "tool_call", {
          toolName: event.toolName,
          inputPreview: truncateJson(event.input, 2000),
        }, { toolName: event.toolName });
        console.log(`[WorkflowEngine] Agent=${agentId} Turn=${event.turn} tool_call=${event.toolName}`);
        break;

      case "tool_result": {
        const resultStr = truncateJson(event.result, 2000);
        this.log(agentId, role, event.turn, "tool_result", {
          toolName: event.toolName,
          resultPreview: resultStr,
          resultLength: typeof event.result === "string" ? event.result.length : JSON.stringify(event.result).length,
        }, { toolName: event.toolName });
        break;
      }

      case "error":
        this.log(agentId, role, null, "error", {
          error: truncate(event.error, 2000),
        });
        break;

      case "compaction":
        this.log(agentId, role, event.turn, "compaction", {
          method: event.method,
          tokensSaved: event.tokensSaved,
        });
        break;

      case "complete":
        this.log(agentId, role, null, "runner_complete", {
          outputLength: event.output.length,
          outputPreview: truncate(event.output, 500),
        });
        break;

      // start, progress, cancelled, text_delta, advisory_limit_reached
      // are too noisy or redundant to log individually.
      default:
        break;
    }
  }

  /** Flush accumulated logs to DB. Non-blocking — errors are logged but not thrown. */
  private flushLogs(): void {
    if (this.logBuffer.length === 0) return;
    const logs = [...this.logBuffer];
    this.logBuffer = [];
    const count = logs.length;
    // Fire-and-forget: don't block the workflow result return
    (async () => {
      try {
        const { getRepos } = await import("../../store/repos/index.js");
        const repos = await getRepos();
        await repos.workflowLog.insertBatch(logs);
        console.log(`[WorkflowEngine] Flushed ${count} log entries for workflow ${this.input.workflowId}`);
      } catch (err) {
        console.error(`[WorkflowEngine] Failed to flush ${count} log entries:`, err instanceof Error ? err.message : String(err));
      }
    })();
  }

  // -----------------------------------------------------------------------
  // Graph mode helpers
  // -----------------------------------------------------------------------

  /**
   * Detect cycles in the dependency graph using DFS. Throws if a cycle is
   * found.
   */
  private detectCycles(agents: WorkflowAgent[]): void {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const agentMap = new Map<string, WorkflowAgent>();
    for (const agent of agents) {
      agentMap.set(agent.id, agent);
    }

    const dfs = (id: string): boolean => {
      if (inStack.has(id)) return true; // cycle
      if (visited.has(id)) return false; // already fully explored

      visited.add(id);
      inStack.add(id);

      const agent = agentMap.get(id);
      if (agent) {
        const deps = agent.dependsOn ?? [];
        for (const depId of deps) {
          if (dfs(depId)) return true;
        }
      }

      inStack.delete(id);
      return false;
    };

    for (const agent of agents) {
      if (dfs(agent.id)) {
        throw new Error(
          `Workflow graph contains a cycle involving agent "${agent.id}".`,
        );
      }
    }
  }

  /**
   * Evaluate a condition on a dependency node's output.
   */
  private evaluateCondition(
    condition: WorkflowAgent["condition"] & {},
    stateMap: Map<string, AgentExecState>,
  ): boolean {
    const depState = stateMap.get(condition.node);
    if (!depState || !depState.result) return false;

    const output = depState.result.output ?? "";

    switch (condition.type) {
      case "output_contains":
        return output.includes(condition.text);
      case "output_not_contains":
        return !output.includes(condition.text);
      default:
        return true;
    }
  }

  /**
   * Build context messages from completed dependency outputs.
   */
  private buildDepContextMessages(
    depIds: string[],
    stateMap: Map<string, AgentExecState>,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const depId of depIds) {
      const state = stateMap.get(depId);
      if (state && state.result && state.result.status === "completed") {
        messages.push({
          role: "assistant",
          content: `[${state.agent.role} (${depId}) 的输出]:\n${state.result.output}`,
        });
      }
    }

    return messages;
  }

  // -----------------------------------------------------------------------
  // Context building helpers
  // -----------------------------------------------------------------------

  /**
   * Build context messages from an array of accumulated prior output strings
   * (used by pipeline mode).
   */
  private buildContextMessages(
    accumulated: string[],
  ): Array<{ role: "user" | "assistant"; content: string }> {
    if (accumulated.length === 0) return [];

    return [
      {
        role: "user" as const,
        content:
          `以下是此工作流中前置 Agent 的上下文：\n\n` +
          accumulated.join("\n\n"),
      },
    ];
  }

  // -----------------------------------------------------------------------
  // Result helpers
  // -----------------------------------------------------------------------

  private buildCancelledResult(): WorkflowResult {
    return {
      workflowId: this.input.workflowId,
      status: "cancelled",
      agentResults: [],
      synthesis: "工作流已取消。",
      totalDuration: 0,
    };
  }

  /**
   * Compute the overall workflow status from individual agent results.
   */
  private computeOverallStatus(
    results: WorkflowAgentResult[],
  ): WorkflowResult["status"] {
    const completed = results.filter((r) => r.status === "completed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const total = results.length;

    if (total === 0) return "failed";
    if (failed === 0) return "completed";
    if (completed === 0) return "failed";
    return "partial";
  }

  /**
   * Synthesize agent results into a compact summary string.
   * Design goal: minimize tokens returned to the parent agent's context.
   * Only includes status, push state, and file paths — the parent agent
   * uses push_content(filePath=...) to forward files without reading them.
   */
  /**
   * Synthesize agent results into a summary with enough detail for the
   * coordinator to make audit decisions. Provides brief summaries,
   * key findings, and file paths — not just status icons.
   */
  private synthesizeResults(
    results: WorkflowAgentResult[],
    pushCatalog?: Array<{ agentId: string; role: string; filePath: string; description?: string; contentLength: number; auditApproved: boolean; preview: string }>,
  ): string {
    const completed = results.filter((r) => r.status === "completed");
    const failed = results.filter((r) => r.status === "failed");

    if (results.length === 0) {
      return "No results were produced by any agent.";
    }

    const sections: string[] = [];
    sections.push(`## 工作流结果 (${completed.length}/${results.length} 完成)`);

    // Per-agent brief summary — enough detail for coordinator decisions
    for (const r of completed) {
      const s = r.summary;
      const parts: string[] = [];
      if (s?.finishSummary) {
        parts.push(s.finishSummary.substring(0, 300).replace(/\n/g, " "));
      }
      if (s?.keyFindings && s.keyFindings.length > 0) {
        parts.push(`发现: ${s.keyFindings.slice(0, 3).join("; ")}`);
      }
      if (r.resultFiles) {
        parts.push(`报告→${r.resultFiles.outputPath}`);
      }
      if (s?.pushedContent && s.pushedContent.length > 0) {
        parts.push(`**已自动推送，不要重复推送**`);
      }

      const detail = parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
      const warningTag = r.warning ? ` ⚠️${r.warning}` : "";
      sections.push(`- ✓ ${r.role}: 完成${detail}${warningTag}`);
    }

    for (const r of failed) {
      sections.push(`- ✗ ${r.role}: 失败 | ${r.error ?? "Unknown error"}`);
    }

    // Add audit result summary if available
    const auditAgent = results.find(r => r.agentId === "synthesis-audit");
    if (auditAgent?.summary) {
      sections.push("");
      sections.push(`## 综合审计`);
      if (auditAgent.summary.finishSummary) {
        sections.push(auditAgent.summary.finishSummary.substring(0, 500));
      }
      if (auditAgent.summary.keyFindings.length > 0) {
        sections.push("审计发现:");
        for (const f of auditAgent.summary.keyFindings.slice(0, 5)) {
          sections.push(`- ${f}`);
        }
      }
      if (auditAgent.resultFiles) {
        sections.push(`审计报告→${auditAgent.resultFiles.outputPath}`);
      }
    }

    // Coordinator guidance — push catalog
    sections.push("");
    sections.push("## 推送清单");
    sections.push("子Agent已完成分析并生成了完整报告文件。直接从下方清单中选择需要的文件用 push_content(filePath=路径) 推送，不要读取或改写子Agent的输出。");
    sections.push("推送原则：与用户需求相关的子Agent报告都应推送，而非只推送一份总结。中间产物（如辅助查询、数据预处理）不需要推送。不确定时优先推送。");
    sections.push("如需补充综合概览，可以自行输出简要总结，但不要重复推送与已有卡片相同的内容。推送完毕后调用 finish。");
    sections.push("");

    if (pushCatalog && pushCatalog.length > 0) {
      for (let i = 0; i < pushCatalog.length; i++) {
        const item = pushCatalog[i];
        const desc = item.description || item.preview.substring(0, 60);
        sections.push(`${i + 1}. **${item.role}** — ${desc.substring(0, 80)}（${item.contentLength}字）${item.auditApproved ? "✓" : "⚠"}`);
        sections.push(`   路径: \`${item.filePath}\``);
      }
    }

    return sections.join("\n");
  }

  /**
   * Mark all agents as skipped. Used for unknown modes.
   */
  private skipAllAgents(reason: string): WorkflowAgentResult[] {
    return this.input.agents.map((agent) => ({
      agentId: agent.id,
      role: agent.role,
      status: "skipped" as const,
      output: "",
      duration: 0,
      error: reason,
    }));
  }

  /**
   * For pipeline mode: mark any agents that come after the last result as
   * skipped.
   */
  private skipRemaining(results: WorkflowAgentResult[]): void {
    const completedIds = new Set(results.map((r) => r.agentId));
    for (const agent of this.input.agents) {
      if (!completedIds.has(agent.id)) {
        results.push({
          agentId: agent.id,
          role: agent.role,
          status: "skipped",
          output: "",
          duration: 0,
          error: "Pipeline stopped before this agent could run.",
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Event emitter
  // -----------------------------------------------------------------------

  private emit(event: WorkflowEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        // Swallow errors from event callbacks to avoid disrupting the workflow
      }
    }
  }
}
