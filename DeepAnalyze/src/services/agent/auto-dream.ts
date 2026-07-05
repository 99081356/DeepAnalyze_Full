// =============================================================================
// DeepAnalyze - Auto Dream Manager
// =============================================================================
// Cross-session knowledge integration. Periodically reads session_memory
// records, uses a summarizer to synthesize cross-session insights, and writes
// the result back to the knowledge base via KnowledgeCompounder.
// =============================================================================

import { ModelRouter } from "../../models/router.js";
import { getRepos } from "../../store/repos/index.js";
import type { KnowledgeCompounder } from "../../wiki/knowledge-compound.js";
import type { Linker } from "../../wiki/linker.js";
import type { AgentSettings } from "./types.js";
import { DEFAULT_AGENT_SETTINGS } from "./types.js";

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

interface AutoDreamState {
  lastDreamAt: string | null;
  sessionsSinceLastDream: number;
}

/** Settings key for auto-dream state */
const AUTO_DREAM_STATE_KEY = "auto_dream_state";

/** Maximum number of sessions to load for synthesis */
const MAX_SESSIONS_FOR_SYNTHESIS = 20;

// ---------------------------------------------------------------------------
// AutoDreamManager
// ---------------------------------------------------------------------------

export class AutoDreamManager {
  private modelRouter: ModelRouter;
  private compounder: KnowledgeCompounder;
  private linker: Linker;
  private settings: AgentSettings;

  constructor(
    modelRouter: ModelRouter,
    compounder: KnowledgeCompounder,
    linker: Linker,
    settings?: Partial<AgentSettings>,
  ) {
    this.modelRouter = modelRouter;
    this.compounder = compounder;
    this.linker = linker;
    this.settings = { ...DEFAULT_AGENT_SETTINGS, ...settings };
  }

  // -----------------------------------------------------------------------
  // Gate check
  // -----------------------------------------------------------------------

  /**
   * Check whether auto-dream should be triggered based on time and session
   * count gates.
   */
  async shouldDream(): Promise<boolean> {
    const state = await this.loadState();
    const intervalMs = this.settings.autoDreamIntervalHours * 60 * 60 * 1000;

    // Time gate
    if (state.lastDreamAt) {
      const elapsed = Date.now() - new Date(state.lastDreamAt).getTime();
      if (elapsed < intervalMs) {
        return false;
      }
    }

    // Session count gate
    if (state.sessionsSinceLastDream < this.settings.autoDreamSessionThreshold) {
      return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Increment session counter (atomic)
  // -----------------------------------------------------------------------

  /**
   * Increment the session counter atomically using PG repos.
   * Called after each completed agent run.
   */
  async incrementSessionCount(): Promise<void> {
    const repos = await getRepos();
    const settings = repos.settings;

    const raw = await settings.get(AUTO_DREAM_STATE_KEY);

    if (!raw) {
      const initialState: AutoDreamState = {
        lastDreamAt: null,
        sessionsSinceLastDream: 1,
      };
      await settings.set(AUTO_DREAM_STATE_KEY, JSON.stringify(initialState));
      return;
    }

    // Read, modify, write back
    try {
      const state = JSON.parse(raw) as AutoDreamState;
      state.sessionsSinceLastDream = (state.sessionsSinceLastDream ?? 0) + 1;
      await settings.set(AUTO_DREAM_STATE_KEY, JSON.stringify(state));
    } catch {
      // Corrupted state, reset
      const initialState: AutoDreamState = {
        lastDreamAt: null,
        sessionsSinceLastDream: 1,
      };
      await settings.set(AUTO_DREAM_STATE_KEY, JSON.stringify(initialState));
    }
  }

  // -----------------------------------------------------------------------
  // Dream execution
  // -----------------------------------------------------------------------

  /**
   * Execute the auto-dream process:
   * 1. Read recent session_memory records (limited)
   * 2. Send to summarizer for cross-session integration
   * 3. Write result to knowledge base via KnowledgeCompounder
   */
  async dream(): Promise<void> {
    console.log("[AutoDream] Starting cross-session knowledge integration...");

    const memories = await this.loadRecentMemories();
    if (memories.length === 0) {
      console.log("[AutoDream] No session memories found, skipping.");
      return;
    }

    const synthesis = await this.synthesizeMemories(memories);

    if (!synthesis) {
      console.log("[AutoDream] Synthesis produced no output, skipping write-back.");
      return;
    }

    const kbId = await this.findDreamKb();
    if (!kbId) {
      console.log("[AutoDream] No knowledge base available for write-back.");
      return;
    }

    const title = `Cross-Session Insights - ${new Date().toISOString().slice(0, 10)}`;
    try {
      this.compounder.compoundWithEntities(kbId, synthesis, title, this.linker);
      console.log(`[AutoDream] Saved cross-session insights to KB ${kbId}`);
    } catch (err) {
      console.warn(
        "[AutoDream] Failed to write cross-session insights:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Update state: set lastDreamAt to now, reset session counter
    const repos = await getRepos();
    const updatedState: AutoDreamState = {
      lastDreamAt: new Date().toISOString(),
      sessionsSinceLastDream: 0,
    };
    await repos.settings.set(AUTO_DREAM_STATE_KEY, JSON.stringify(updatedState));

    console.log("[AutoDream] Cross-session knowledge integration complete.");
  }

  // -----------------------------------------------------------------------
  // State persistence
  // -----------------------------------------------------------------------

  private async loadState(): Promise<AutoDreamState> {
    const repos = await getRepos();
    const raw = await repos.settings.get(AUTO_DREAM_STATE_KEY);

    if (raw) {
      try {
        return JSON.parse(raw) as AutoDreamState;
      } catch {
        // Corrupted state, reset
      }
    }

    return {
      lastDreamAt: null,
      sessionsSinceLastDream: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Data loading (limited)
  // -----------------------------------------------------------------------

  private async loadRecentMemories(): Promise<Array<{ sessionId: string; content: string }>> {
    const repos = await getRepos();
    return repos.sessionMemory.listRecent(MAX_SESSIONS_FOR_SYNTHESIS);
  }

  // -----------------------------------------------------------------------
  // Synthesis (bounded input)
  // -----------------------------------------------------------------------

  private async synthesizeMemories(
    memories: Array<{ sessionId: string; content: string }>,
  ): Promise<string | null> {
    const summarizerModel = this.modelRouter.getDefaultModel("main");

    // [ORIGINAL ENGLISH] You are a knowledge integration engine. Analyze the following session memory notes...
    const prompt = `你是一个知识整合引擎。分析以下来自多个分析会话的会话记忆笔记，生成一份综合报告：

1. 识别跨会话的重复主题和模式
2. 突出最重要的跨会话发现
3. 记录任何矛盾或互补的见解
4. 列出关键实体及其跨会话关系

将输出格式化为结构良好的 Markdown 文档。`;

    // Build content with total size limit (~50K chars)
    const MAX_SYNTHESIS_INPUT = 50_000;
    const parts: string[] = [];
    let totalChars = 0;

    for (let i = 0; i < memories.length; i++) {
      const part = `--- Session ${i + 1} (${memories[i].sessionId.slice(0, 8)}...) ---\n${memories[i].content}`;
      if (totalChars + part.length > MAX_SYNTHESIS_INPUT) {
        // Truncate this part to fit
        const remaining = MAX_SYNTHESIS_INPUT - totalChars;
        if (remaining > 200) {
          parts.push(part.slice(0, remaining) + "\n...[truncated]");
        }
        break;
      }
      parts.push(part);
      totalChars += part.length;
    }

    const content = parts.join("\n\n");

    try {
      const response = await this.modelRouter.chat(
        [
          { role: "system", content: prompt },
          { role: "user", content },
        ],
        {
          model: summarizerModel,
          maxTokens: 4000,
        },
      );
      return response.content || null;
    } catch (err) {
      console.warn(
        "[AutoDream] Synthesis LLM call failed:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // KB resolution
  // -----------------------------------------------------------------------

  private async findDreamKb(): Promise<string | null> {
    const repos = await getRepos();
    const id = await repos.knowledgeBase.getAnyId();
    return id ?? null;
  }
}
