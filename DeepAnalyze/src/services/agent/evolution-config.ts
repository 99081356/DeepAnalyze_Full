// =============================================================================
// DeepAnalyze - Self-Evolution Configuration
// Controls all self-evolution features. Stored in settings table.
// Default: OFF — user must explicitly enable.
// =============================================================================

export interface SelfEvolutionConfig {
  /** Master switch. When false, all self-evolution logic is completely skipped. */
  enabled: boolean;

  modules: {
    /** Persistent agent memory — inject accumulated experience into system prompt. */
    persistentMemory: boolean;
    /** Background Review extracts tool techniques and workflow improvements. */
    memoryAccumulation: boolean;
    /** Background Review creates/updates/patches skills. */
    skillEvolution: boolean;
    /** Curator periodically archives stale skills and merges similar ones. */
    skillMaintenance: boolean;
    /** Agent can search past sessions for relevant experience. */
    historyRecall: boolean;
    /** AutoDream — periodic cross-session knowledge integration. */
    autoDream: boolean;
  };

  params: {
    /** How many user turns before triggering a background review (default: 10). */
    nudgeInterval: number;
    /** Curator run interval in days (default: 7). */
    curatorIntervalDays: number;
    /** Days of inactivity before archiving a skill (default: 90). */
    archiveAfterDays: number;
    /** Days of inactivity before marking a skill stale (default: 30). */
    staleAfterDays: number;
    /** Token budget for agent memory injection (default: 8000). */
    memoryBudget?: number;
  };
}

export const DEFAULT_EVOLUTION_CONFIG: SelfEvolutionConfig = {
  enabled: false,
  modules: {
    persistentMemory: true,
    memoryAccumulation: true,
    skillEvolution: true,
    skillMaintenance: true,
    historyRecall: true,
    autoDream: true,
  },
  params: {
    nudgeInterval: 10,
    curatorIntervalDays: 7,
    archiveAfterDays: 90,
    staleAfterDays: 30,
  },
};

// In-memory cache, invalidated on write
let _cachedConfig: SelfEvolutionConfig | null = null;

export function getCachedEvolutionConfig(): SelfEvolutionConfig | null {
  return _cachedConfig;
}

export function invalidateEvolutionConfigCache(): void {
  _cachedConfig = null;
}

export function setCachedEvolutionConfig(config: SelfEvolutionConfig): void {
  _cachedConfig = config;
}

/** Parse and validate evolution config from raw JSON string. */
export function parseEvolutionConfig(raw: string | null | undefined): SelfEvolutionConfig {
  if (!raw) return { ...DEFAULT_EVOLUTION_CONFIG };
  try {
    const parsed = JSON.parse(raw);
    // Merge with defaults to handle missing fields
    return {
      enabled: parsed.enabled ?? DEFAULT_EVOLUTION_CONFIG.enabled,
      modules: {
        persistentMemory: parsed.modules?.persistentMemory ?? DEFAULT_EVOLUTION_CONFIG.modules.persistentMemory,
        memoryAccumulation: parsed.modules?.memoryAccumulation ?? DEFAULT_EVOLUTION_CONFIG.modules.memoryAccumulation,
        skillEvolution: parsed.modules?.skillEvolution ?? DEFAULT_EVOLUTION_CONFIG.modules.skillEvolution,
        skillMaintenance: parsed.modules?.skillMaintenance ?? DEFAULT_EVOLUTION_CONFIG.modules.skillMaintenance,
        historyRecall: parsed.modules?.historyRecall ?? DEFAULT_EVOLUTION_CONFIG.modules.historyRecall,
        autoDream: parsed.modules?.autoDream ?? DEFAULT_EVOLUTION_CONFIG.modules.autoDream,
      },
      params: {
        nudgeInterval: parsed.params?.nudgeInterval ?? DEFAULT_EVOLUTION_CONFIG.params.nudgeInterval,
        curatorIntervalDays: parsed.params?.curatorIntervalDays ?? DEFAULT_EVOLUTION_CONFIG.params.curatorIntervalDays,
        archiveAfterDays: parsed.params?.archiveAfterDays ?? DEFAULT_EVOLUTION_CONFIG.params.archiveAfterDays,
        staleAfterDays: parsed.params?.staleAfterDays ?? DEFAULT_EVOLUTION_CONFIG.params.staleAfterDays,
      },
    };
  } catch {
    return { ...DEFAULT_EVOLUTION_CONFIG };
  }
}
