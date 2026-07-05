// =============================================================================
// DeepAnalyze - Cost Tracker
// =============================================================================
// Tracks per-run API cost in USD based on model pricing data from the
// provider registry. Each turn's usage is recorded and the running total
// is available at any time.
//
// If a model has no pricing data, all cost calculations return 0.
// =============================================================================

import { getPricingForModel, type ModelPricing } from "../../models/provider-registry.js";

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export class CostTracker {
  private modelId: string;
  private pricing: ModelPricing | undefined;
  private totalCost = 0;
  // Cache-token accumulators. Tracked even when pricing is unavailable so
  // callers (e.g. AgentResult.usage) can report cache hit rate regardless of
  // whether the model has billing data.
  private totalCacheReadTokens = 0;
  private totalCacheCreationTokens = 0;

  constructor(modelId: string) {
    this.modelId = modelId;
    this.pricing = getPricingForModel(modelId);
  }

  /**
   * Record a turn's usage and return the cost for that turn.
   * Returns 0 if the model has no pricing data.
   */
  recordTurn(turn: number, usage: TurnUsage): number {
    // Accumulate cache totals regardless of pricing availability — these are
    // used by AgentResult.usage for observability, not just billing.
    this.totalCacheReadTokens += usage.cacheReadTokens ?? 0;
    this.totalCacheCreationTokens += usage.cacheCreationTokens ?? 0;

    if (!this.pricing) return 0;

    const p = this.pricing;
    const cacheWritePrice = p.cacheWritePerMillion ?? p.inputPerMillion;

    let cost = 0;
    // Input tokens (excluding cache reads/writes, which are billed separately)
    const nonCacheInputTokens = usage.inputTokens
      - (usage.cacheCreationTokens ?? 0)
      - (usage.cacheReadTokens ?? 0);
    if (nonCacheInputTokens > 0) {
      cost += (nonCacheInputTokens / 1_000_000) * p.inputPerMillion;
    }
    // Output tokens
    if (usage.outputTokens > 0) {
      cost += (usage.outputTokens / 1_000_000) * p.outputPerMillion;
    }
    // Cache write tokens
    if (usage.cacheCreationTokens && usage.cacheCreationTokens > 0) {
      cost += (usage.cacheCreationTokens / 1_000_000) * cacheWritePrice;
    }
    // Cache read tokens
    if (usage.cacheReadTokens && usage.cacheReadTokens > 0 && p.cacheReadPerMillion) {
      cost += (usage.cacheReadTokens / 1_000_000) * p.cacheReadPerMillion;
    }

    this.totalCost += cost;
    return cost;
  }

  /** Total accumulated cost in USD */
  get totalCostUsd(): number {
    return this.totalCost;
  }

  /** Total cache-read (cache-hit) tokens accumulated across all turns */
  get totalCacheReadTokensValue(): number {
    return this.totalCacheReadTokens;
  }

  /** Total cache-write (cache-creation) tokens accumulated across all turns */
  get totalCacheCreationTokensValue(): number {
    return this.totalCacheCreationTokens;
  }

  /** Whether pricing data is available for this model */
  get hasPricing(): boolean {
    return this.pricing !== undefined;
  }

  /** The model ID this tracker is for */
  get currentModelId(): string {
    return this.modelId;
  }

  /** Reset the tracker (e.g., after compaction) */
  reset(): void {
    this.totalCost = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
  }
}
