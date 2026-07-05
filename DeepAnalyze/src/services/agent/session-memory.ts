// =============================================================================
// DeepAnalyze - Session Memory Manager
// =============================================================================
// Extracts and maintains structured notes from conversations. These notes
// are injected into the system prompt for context continuity and used by
// SM-compact to replace old messages with a compact summary.
// =============================================================================

import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ModelRouter } from "../../models/router.js";
import { getRepos } from "../../store/repos/index.js";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";
import { writeFileAtomic } from "../../utils/atomicWrite.js";
import type { ChatMessage } from "../../models/provider.js";
import type { SessionMemoryNote, AgentSettings } from "./types.js";
import { DEFAULT_AGENT_SETTINGS } from "./types.js";

// ---------------------------------------------------------------------------
// Unique injection markers (avoiding common Markdown patterns)
// ---------------------------------------------------------------------------

const MEMORY_START_MARKER = "<!-- SESSION_MEMORY_START -->";
const MEMORY_END_MARKER = "<!-- SESSION_MEMORY_END -->";

// Legacy markers for backward compatibility
const LEGACY_START_MARKER = "---\n## Session Memory (Auto-Extracted Context)";
const LEGACY_END_MARKER = "---";

// ---------------------------------------------------------------------------
// SessionMemoryManager
// ---------------------------------------------------------------------------

export class SessionMemoryManager {
  private modelRouter: ModelRouter;
  private sessionId: string;
  private settings: AgentSettings;

  constructor(
    modelRouter: ModelRouter,
    sessionId: string,
    settings?: Partial<AgentSettings>,
  ) {
    this.modelRouter = modelRouter;
    this.sessionId = sessionId;
    this.settings = { ...DEFAULT_AGENT_SETTINGS, ...settings };
  }

  // -----------------------------------------------------------------------
  // Load / Save
  // -----------------------------------------------------------------------

  /**
   * Load the session memory note from the database.
   * If a kbId is available in settings, also appends any cross-session
   * project memory to the returned content.
   * Returns null if no memory exists for this session.
   */
  async load(): Promise<SessionMemoryNote | null> {
    const repos = await getRepos();
    const row = await repos.sessionMemory.load(this.sessionId);

    if (!row) return null;

    let content = row.content;

    // Append cross-session project memory if a kbId is configured
    const kbId = this.settings.kbId;
    if (kbId) {
      const projectMemory = await this.loadProjectMemory(kbId);
      if (projectMemory) {
        content = content + "\n\n" + projectMemory;
      }
    }

    return {
      id: row.id,
      sessionId: row.sessionId,
      content,
      tokenCount: row.tokenCount,
      lastTokenPosition: row.lastTokenPosition,
      searchIndexJson: row.searchIndexJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Save (upsert) a session memory note.
   */
  async save(note: SessionMemoryNote): Promise<void> {
    const repos = await getRepos();
    await repos.sessionMemory.save(
      note.sessionId,
      note.content,
      note.tokenCount,
      note.lastTokenPosition,
      note.searchIndexJson,
    );
  }

  // -----------------------------------------------------------------------
  // Cross-session project memory
  // -----------------------------------------------------------------------

  /**
   * Persist cross-session memory for a project (kbId) to the filesystem.
   * The file is stored in the data directory as `.project-memory-{kbId}.md`.
   */
  async saveProjectMemory(kbId: string, memory: string): Promise<void> {
    try {
      const dataDir = DEEPANALYZE_CONFIG.dataDir;
      const filePath = join(dataDir, `.project-memory-${kbId}.md`);
      await mkdir(dataDir, { recursive: true });

      const header = [
        "# Project Memory (Auto-generated)",
        `> Last updated: ${new Date().toISOString()}`,
        "",
      ].join("\n");

      await writeFileAtomic(filePath, header + memory, { encoding: "utf-8" });
    } catch {
      // Fail silently — project memory is best-effort
    }
  }

  /**
   * Load cross-session project memory for a project (kbId) from the filesystem.
   * Returns null if no project memory file exists.
   */
  async loadProjectMemory(kbId: string): Promise<string | null> {
    try {
      const dataDir = DEEPANALYZE_CONFIG.dataDir;
      const filePath = join(dataDir, `.project-memory-${kbId}.md`);
      return await readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Extract the most important cross-session facts from session memory content.
   * Uses simple heuristic extraction: keeps lines that start with factual
   * statements (bullet points with key/important markers, headings, conclusion
   * lines) and skips task-specific transient details.
   */
  extractProjectMemory(sessionMemoryContent: string): string {
    const lines = sessionMemoryContent.split("\n");
    const extracted: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Keep section headings
      if (trimmed.startsWith("## ")) {
        extracted.push(trimmed);
        continue;
      }

      // Keep lines with importance markers [关键], [重要]
      if (trimmed.includes("[关键]") || trimmed.includes("[重要]")) {
        extracted.push(trimmed);
        continue;
      }

      // Keep confirmed facts: lines starting with "- " that contain
      // preference patterns or definitive statements
      if (trimmed.startsWith("- ")) {
        const lower = trimmed.toLowerCase();
        // Skip task-specific details (执行了, 正在, etc.)
        if (lower.includes("执行了") || lower.includes("正在处理") || lower.includes("已运行")) {
          continue;
        }
        // Keep preferences, confirmed facts, conclusions
        if (
          lower.includes("偏好") ||
          lower.includes("prefer") ||
          lower.includes("确认") ||
          lower.includes("confirmed") ||
          lower.includes("结论") ||
          lower.includes("conclusion") ||
          lower.includes("使用") ||
          lower.includes("always") ||
          lower.includes("never") ||
          lower.includes("默认")
        ) {
          extracted.push(trimmed);
          continue;
        }
      }
    }

    if (extracted.length === 0) return "";

    return "\n" + extracted.join("\n") + "\n";
  }

  // -----------------------------------------------------------------------
  // Initialization / Update gating
  // -----------------------------------------------------------------------

  /**
   * Should we initialize session memory for the first time?
   * Triggers when cumulative token usage first exceeds the threshold.
   */
  shouldInitialize(totalTokens: number): boolean {
    return totalTokens >= this.settings.sessionMemoryInitThreshold;
  }

  /**
   * Should we update the existing session memory?
   * Triggers when token usage has grown by the update interval since last update.
   */
  shouldUpdate(totalTokens: number, memory: SessionMemoryNote): boolean {
    return totalTokens - memory.lastTokenPosition >= this.settings.sessionMemoryUpdateInterval;
  }

  // -----------------------------------------------------------------------
  // Memory extraction (LLM-based)
  // -----------------------------------------------------------------------

  /**
   * Initialize session memory by extracting key information from the
   * conversation so far using the summarizer model.
   */
  async initialize(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<SessionMemoryNote> {
    const content = await this.extractMemory(messages, signal);
    const id = randomUUID();
    const tokenCount = this.modelRouter.estimateTokens(content);

    const note: SessionMemoryNote = {
      id,
      sessionId: this.sessionId,
      content,
      tokenCount,
      lastTokenPosition: 0, // Will be set by agent-runner with actual token count
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.save(note);
    return note;
  }

  /**
   * Update existing session memory with new conversation content.
   * Uses incremental extraction on messages since the last update.
   *
   * @param existingMemory The current memory note
   * @param messages The full message array
   * @param totalTokens Actual cumulative session token usage (from agent-runner)
   * @param signal Optional abort signal
   */
  async update(
    existingMemory: SessionMemoryNote,
    messages: ChatMessage[],
    totalTokens: number,
    signal?: AbortSignal,
  ): Promise<SessionMemoryNote> {
    const updatedContent = await this.extractMemoryUpdate(
      existingMemory.content,
      messages,
      signal,
    );

    const tokenCount = this.modelRouter.estimateTokens(updatedContent);

    const updated: SessionMemoryNote = {
      ...existingMemory,
      content: updatedContent,
      tokenCount,
      lastTokenPosition: totalTokens, // Use actual session token count
      updatedAt: new Date().toISOString(),
    };

    await this.save(updated);
    return updated;
  }

  // -----------------------------------------------------------------------
  // Prompt injection (using unique HTML-comment markers)
  // -----------------------------------------------------------------------

  /**
   * Build the text to inject into the system prompt.
   * Uses HTML comment markers that won't appear in normal content.
   */
  buildPromptInjection(note: SessionMemoryNote): string {
    // Feature G (C-192): Add category classification guidance
    const categoryHeader = [
      "",
      "> 记忆分类参考：user=用户偏好/角色/目标 | feedback=工作方式反馈 | project=项目特有信息 | reference=外部系统指针",
      "> 不要保存：代码模式/架构/文件路径（可从代码获取）、Git历史（可从git log获取）、调试方案（修复已在代码中）",
    ].join("\n");

    return [
      "",
      MEMORY_START_MARKER,
      "## 会话记忆（自动提取的上下文）",
      categoryHeader,
      "",
      note.content,
      "",
      MEMORY_END_MARKER,
      "",
    ].join("\n");
  }

  // -----------------------------------------------------------------------
  // Private: LLM memory extraction
  // -----------------------------------------------------------------------

  private async extractMemory(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const summarizerModel = this.modelRouter.getDefaultModel("summarizer");

    // [ORIGINAL ENGLISH] You are a session memory extractor. Analyze the conversation below and extract a structured summary...
    const extractionPrompt = `你是一个会话记忆提取器。分析下面的对话并提取结构化摘要，使用以下 Markdown 章节：

## 当前状态
- 当前正在处理什么？待完成的任务。即时的下一步。
- 用 [关键] 标记真正关键的项目
- ⚠️ 重要：只描述最后一个活跃任务的状态。如果对话中包含多个独立任务，之前的任务如果已完成，不要在此处描述

## 任务规格
- 用户要求做什么？设计决策、需求变化和上下文
- 用户的偏好和反馈

## 文件和路径
- 涉及的所有重要文件路径、目录结构、关键文件内容摘要
- 特别注意：记录所有读写过的文件路径，包括临时文件、输出文件、数据文件
- 格式：每行一个文件路径，用 - 开头，附带简要说明
- 这个 section 对压缩后恢复工作至关重要，不得遗漏任何文件路径

## 已执行的工作
- 已采取的行动、已执行的分析及其结果
- 每个工作项的当前状态
- 如果对话包含多个独立任务，用编号区分（如"任务1: ..."、"任务2: ..."）
- 已完成的任务标注 [已完成]，只保留关键结果，删减详细工作过程

## 决策和结论
- 已达成的结论、选择的方法及其原因

## 错误和修正
- 遇到的错误及修复方式
- 用户纠正过什么？哪些方法不应再尝试？

## 关键结果
- 用户要求的特定输出（如问题答案、表格、文档），精确重复结果
- 已推送到前端的内容及其推送方式

## 待处理任务
- 任何已明确请求但尚未完成的任务
- ⚠️ 重要：只列出真正未完成的任务。如果用户已经问了一个新问题，之前的问题已经被完整回答，则之前的任务不要出现在此列表中——它已经完成了

## 已搜索关键词
列出本会话中使用 kb_search、web_search、doc_grep 等工具搜索过的所有关键词。格式：每行一个关键词，用 - 开头。压缩后模型应参考此列表避免重复搜索相同关键词。

## 工作日志
- 简短的步骤日志，每步一行，按时间顺序记录

规则：
- 用 [关键]（关键）、[重要]（重要）标记项目，或不予标记（背景信息）
- 简洁但完整——包含具体的数值、名称和标识符
- "文件和路径" section 必须尽可能完整，包含所有涉及的文件路径
- 控制在 4000 字以内
- 专注于对后续继续任务有用的信息
- ⚠️ 多任务规则：当对话中用户提出多个独立问题时，每个问题是独立任务。Agent 完整回答了一个问题后，该任务即为[已完成]。只有最后一个未回答完的问题才是"当前状态"和"待处理任务"的内容

记忆分类规则（C-192）：
- 为每个提取的记忆条目标注类型标签：[user] [feedback] [project] [reference]
- user：用户的偏好、角色、目标、知识（跨项目持久的个人信息）
- feedback：用户对工作方式的反馈（包括纠正性的和肯定性的），包含"为什么"和"如何应用"
- project：项目特有的进行中工作、bug、事件、决策（不能从代码/git推导的信息）
- reference：外部系统指针（dashboard、issue tracker、文档链接）
- 不要保存：代码模式/架构/文件路径（可从代码获取）、Git历史（git log可获取）、调试方案（修复已在代码中）、临时任务细节`;

    const extractionMessages: ChatMessage[] = [
      { role: "system", content: extractionPrompt },
      { role: "user", content: this.serializeMessages(messages) },
    ];

    try {
      const response = await this.modelRouter.chat(extractionMessages, {
        model: summarizerModel,
        maxTokens: 4000,
        signal,
      });
      return response.content || "";
    } catch {
      return this.generateFallbackSummary(messages);
    }
  }

  private async extractMemoryUpdate(
    existingContent: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const summarizerModel = this.modelRouter.getDefaultModel("summarizer");

    // [ORIGINAL ENGLISH] You are a session memory updater. You have an existing session memory summary and new conversation messages...
    const updatePrompt = `你是一个会话记忆更新器。你已有现有的会话记忆摘要和新的对话消息。通过整合新信息来更新摘要。

规则：
- 保持相同的 Markdown 章节结构（当前状态、任务规格、文件和路径、已执行的工作、决策和结论、错误和修正、关键结果、待处理任务、已搜索关键词、工作日志）
- 添加新信息，不要重复已有内容
- 移除过时或已被取代的信息
- 保留所有 [关键] 和 [重要] 重要性标记
- "文件和路径" section 必须累积所有出现过的文件路径，不要删除仍然相关的文件
- 总字数控制在 4000 字以内
- 如果没有显著的新信息，返回原有摘要不做更改
- 特别注意"已搜索关键词"section的更新：将新出现的搜索关键词追加到列表中，保持去重。这个列表对避免压缩后重复搜索至关重要

⚠️ 任务生命周期管理（最重要）：
- 如果新消息显示用户提出了一个新的独立问题，则之前的问题/任务视为已完成
- 已完成的旧任务：在"已执行的工作"中标注 [已完成]，删减详细过程只保留关键结论
- "当前状态"必须只描述最新的活跃任务，不要描述已完成的旧任务
- "待处理任务"必须只包含最新请求中真正未完成的项目，旧任务的待办项要删除
- 如果新消息中 Agent 已经完整回答了用户的问题（没有遗留），则该任务无待处理项
- 错误判断：只保留与当前活跃任务相关的错误信息，旧任务的错误可以删减`;

    const updateMessages: ChatMessage[] = [
      { role: "system", content: updatePrompt },
      {
        role: "user",
        content: `## 现有会话记忆\n\n${existingContent}\n\n## 新消息\n\n${this.serializeMessages(messages)}`,
      },
    ];

    try {
      const response = await this.modelRouter.chat(updateMessages, {
        model: summarizerModel,
        maxTokens: 4000,
        signal,
      });
      return response.content || existingContent;
    } catch {
      return existingContent;
    }
  }

  /**
   * Serialize messages to a readable format for the summarizer.
   * Uses token-aware truncation: walks backward and truncates messages
   * when the serialized content would exceed the token budget.
   * Tool results get more space (3000 chars) since they carry important data.
   */
  private serializeMessages(messages: ChatMessage[]): string {
    // Target ~8000 tokens for serialized content (~24000 chars)
    const maxChars = 24_000;
    const serialized: string[] = [];
    let totalChars = 0;

    // Walk backward from the most recent messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      const content = m.content ?? "";
      const limit = m.role === "tool" ? 3000 : 1000;
      const entry = `[${m.role}]: ${content.slice(0, limit)}`;

      if (totalChars + entry.length + 2 > maxChars) {
        break;
      }

      serialized.unshift(entry);
      totalChars += entry.length + 2; // +2 for \n\n separator
    }

    return serialized.join("\n\n");
  }

  /**
   * Generate a basic fallback summary when LLM extraction is unavailable.
   */
  private generateFallbackSummary(messages: ChatMessage[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    const sections: string[] = [
      "## 当前状态",
      "- （会话记忆提取不可用）",
      "",
      "## 任务规格",
    ];

    if (userMessages.length > 0) {
      const lastUser = userMessages[userMessages.length - 1];
      sections.push(`- ${(lastUser.content ?? "").slice(0, 200)}`);
    } else {
      sections.push("- （尚无用户消息）");
    }

    sections.push("", "## 文件和路径", "- （尚未跟踪）");
    sections.push("", "## 已执行的工作", "- （尚未跟踪）");
    sections.push("", "## 决策和结论", "- （尚未跟踪）");
    sections.push("", "## 错误和修正", "- （尚未跟踪）");
    sections.push("", "## 关键结果", "- （尚未跟踪）");
    sections.push("", "## 待处理任务", "- （尚未跟踪）");

    // Extract file paths from tool calls as a best-effort fallback
    const filePaths = assistantMessages
      .filter(m => m.toolCalls)
      .flatMap(m => m.toolCalls!.flatMap(tc => {
        try {
          const args = JSON.parse(tc.function.arguments);
          return [args.filePath, args.path, args.file_path, args.source, args.target]
            .filter((v): v is string => typeof v === "string");
        } catch { return []; }
      }))
      .filter((v, i, a) => a.indexOf(v) === i);

    if (filePaths.length > 0) {
      // Replace the placeholder with actual file paths
      const filesIdx = sections.indexOf("## 文件和路径");
      if (filesIdx !== -1) {
        sections[filesIdx + 1] = filePaths.map(p => `- ${p}`).join("\n");
      }
    }

    sections.push(
      "",
      `> 会话包含 ${userMessages.length} 条用户消息和 ${assistantMessages.length} 条助手回复。`,
    );

    return sections.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Utility: replace session memory injection in system prompt
// ---------------------------------------------------------------------------

/**
 * Replace an existing session memory injection block in the system prompt
 * with a new one. Handles both new unique markers and legacy markers.
 * If no existing block is found, appends the new one.
 */
export function replaceSessionMemoryInjection(
  systemPrompt: string,
  newInjection: string,
): string {
  // Try new markers first
  const startIdx = systemPrompt.indexOf(MEMORY_START_MARKER);
  if (startIdx !== -1) {
    const endIdx = systemPrompt.indexOf(MEMORY_END_MARKER, startIdx + MEMORY_START_MARKER.length);
    if (endIdx !== -1) {
      const replaceEnd = endIdx + MEMORY_END_MARKER.length;
      return systemPrompt.slice(0, startIdx) + newInjection.trim() + systemPrompt.slice(replaceEnd);
    }
  }

  // Try legacy markers
  const legacyStartIdx = systemPrompt.indexOf(LEGACY_START_MARKER);
  if (legacyStartIdx !== -1) {
    const afterStart = legacyStartIdx + LEGACY_START_MARKER.length;
    const legacyEndIdx = systemPrompt.indexOf(LEGACY_END_MARKER, afterStart);
    if (legacyEndIdx !== -1) {
      const replaceEnd = legacyEndIdx + LEGACY_END_MARKER.length;
      return systemPrompt.slice(0, legacyStartIdx) + newInjection.trim() + systemPrompt.slice(replaceEnd);
    }
  }

  // No existing injection — append
  return systemPrompt + newInjection;
}
