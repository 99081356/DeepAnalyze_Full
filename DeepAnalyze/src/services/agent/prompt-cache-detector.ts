// =============================================================================
// DeepAnalyze - Prompt Cache Break Detector
// =============================================================================
// Two-phase detection for Anthropic prompt cache breaks.
// Phase 1 (pre-call): snapshots system prompt / tools / model hashes.
// Phase 2 (post-call): checks cache_read_tokens drop against thresholds.
// Diagnoses the likely cause of cache misses for cost optimization.
// =============================================================================

// ---------------------------------------------------------------------------
// Hash utility (djb2 — fast, good distribution, no dependencies)
// ---------------------------------------------------------------------------

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // Ensure unsigned
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PreCallSnapshot {
  systemHash: number;
  toolsHash: number;
  model: string;
  messageCount: number;
  timestamp: number;
}

export interface CacheBreakResult {
  broken: boolean;
  reason?: string;
  tokenDrop?: number;
  previousCacheRead?: number;
  currentCacheRead?: number;
}

interface TrackingState {
  prevSnapshot: PreCallSnapshot | null;
  prevCacheReadTokens: number | null;
  lastCallTimestamp: number;
  cacheDeletionsPending: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CACHE_MISS_TOKENS = 2000;
const CACHE_DROP_RATIO = 0.95; // Flag if cache_read drops below 95% of previous
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000;
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_SOURCES = 10;

// ---------------------------------------------------------------------------
// PromptCacheDetector
// ---------------------------------------------------------------------------

export class PromptCacheDetector {
  private stateBySource = new Map<string, TrackingState>();

  private getTrackingKey(source: string, agentId?: string): string {
    return agentId ? `${source}:${agentId}` : source;
  }

  private getOrCreateState(key: string): TrackingState {
    let state = this.stateBySource.get(key);
    if (!state) {
      // Evict oldest if at capacity
      if (this.stateBySource.size >= MAX_TRACKED_SOURCES) {
        let oldestKey = "";
        let oldestTime = Infinity;
        for (const [k, v] of this.stateBySource) {
          if (v.lastCallTimestamp < oldestTime) {
            oldestTime = v.lastCallTimestamp;
            oldestKey = k;
          }
        }
        if (oldestKey) this.stateBySource.delete(oldestKey);
      }
      state = {
        prevSnapshot: null,
        prevCacheReadTokens: null,
        lastCallTimestamp: 0,
        cacheDeletionsPending: false,
      };
      this.stateBySource.set(key, state);
    }
    return state;
  }

  /**
   * Phase 1: Record a snapshot of prompt state before an API call.
   * Call this before each LLM API call.
   */
  recordPreCallState(
    source: string,
    params: {
      systemPrompt: string;
      toolsJson: string;
      model: string;
      messageCount: number;
    },
    agentId?: string,
  ): void {
    const key = this.getTrackingKey(source, agentId);
    const state = this.getOrCreateState(key);

    state.prevSnapshot = {
      systemHash: djb2Hash(params.systemPrompt),
      toolsHash: djb2Hash(params.toolsJson),
      model: params.model,
      messageCount: params.messageCount,
      timestamp: Date.now(),
    };
    state.cacheDeletionsPending = false;
  }

  /**
   * Phase 2: Check the API response for cache break indicators.
   * Call this after each LLM API call that returns cache metrics.
   */
  checkPostCallResponse(
    source: string,
    response: {
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
    agentId?: string,
  ): CacheBreakResult {
    const key = this.getTrackingKey(source, agentId);
    const state = this.stateBySource.get(key);

    const currentCacheRead = response.cacheReadTokens ?? 0;

    // No previous state — can't detect break
    if (!state || state.prevCacheReadTokens === null) {
      // Store for next call
      if (state) {
        state.prevCacheReadTokens = currentCacheRead;
        state.lastCallTimestamp = Date.now();
      }
      return { broken: false };
    }

    const prevCacheRead = state.prevCacheReadTokens;

    // Update for next call
    state.prevCacheReadTokens = currentCacheRead;
    const now = Date.now();
    const timeSinceLastCall = now - state.lastCallTimestamp;
    state.lastCallTimestamp = now;

    // Skip detection if cache deletion was intentional (microcompact, etc.)
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false;
      return { broken: false };
    }

    // Check for cache break
    const tokenDrop = prevCacheRead - currentCacheRead;
    const dropThreshold = Math.max(prevCacheRead * (1 - CACHE_DROP_RATIO), MIN_CACHE_MISS_TOKENS);

    if (tokenDrop >= dropThreshold && prevCacheRead > 0) {
      // Diagnose cause
      const reasons: string[] = [];

      if (state.prevSnapshot) {
        // Check what changed since last call
        // (Note: we can't check current snapshot since we only have prev,
        //  but we can infer from timing)
      }

      // TTL-based diagnosis
      if (timeSinceLastCall > CACHE_TTL_1HOUR_MS) {
        reasons.push("可能的缓存 TTL 过期（>1小时）");
      } else if (timeSinceLastCall > CACHE_TTL_5MIN_MS) {
        reasons.push("可能的缓存 TTL 过期（>5分钟）");
      }

      if (reasons.length === 0) {
        reasons.push("可能的系统提示词或工具定义变更导致缓存失效");
      }

      return {
        broken: true,
        reason: reasons.join("; "),
        tokenDrop,
        previousCacheRead: prevCacheRead,
        currentCacheRead,
      };
    }

    return { broken: false };
  }

  /**
   * Notify that a microcompact cache deletion was performed.
   * Suppresses false-positive break detection for the next call.
   */
  notifyCacheDeletion(source: string, agentId?: string): void {
    const key = this.getTrackingKey(source, agentId);
    const state = this.stateBySource.get(key);
    if (state) {
      state.cacheDeletionsPending = true;
    }
  }

  /**
   * Notify that a compaction was performed.
   * Resets the cache read baseline to avoid false positives.
   */
  notifyCompaction(source: string, agentId?: string): void {
    const key = this.getTrackingKey(source, agentId);
    const state = this.stateBySource.get(key);
    if (state) {
      state.prevCacheReadTokens = null;
      state.prevSnapshot = null;
    }
  }

  /**
   * Clean up tracking state for a completed agent.
   */
  cleanupAgentTracking(agentId: string): void {
    for (const key of this.stateBySource.keys()) {
      if (key.endsWith(`:${agentId}`)) {
        this.stateBySource.delete(key);
      }
    }
  }
}
