// =============================================================================
// DeepAnalyze - Token Growth Rate Tracker (C3.6)
// =============================================================================
// Tracks per-turn token counts and predicts when the context window will be
// exhausted, enabling proactive compaction to fire earlier when the growth
// rate is high.
// =============================================================================

/** Number of turns ahead to predict context exhaustion. */
export const PREDICTIVE_COMPACTION_HORIZON = 8;

/** If growth rate exceeds this many tokens per turn, consider it "high growth". */
export const HIGH_GROWTH_THRESHOLD_TOKENS_PER_TURN = 8000;

/** Minimum data points (turns) before growth prediction is reliable. */
export const MIN_TURNS_FOR_PREDICTION = 3;

/** Upper proactive compaction ratio threshold (from agent-runner constants). */
export const PROACTIVE_COMPACT_UPPER_RATIO = 0.85;

/**
 * Tracks per-turn token counts and predicts when the context window will be
 * exhausted, enabling proactive compaction to fire earlier when the growth
 * rate is high.
 */
export class TokenGrowthTracker {
  private history: Array<{ turn: number; tokens: number }> = [];

  /**
   * Record the token count for a turn.
   * Keeps at most the last 20 data points to remain responsive to changing patterns.
   */
  record(turn: number, tokens: number): void {
    this.history.push({ turn, tokens });
    if (this.history.length > 20) {
      this.history.shift();
    }
  }

  /**
   * Calculate the average token growth rate (tokens/turn) over recent history.
   * Returns 0 if insufficient data.
   */
  getGrowthRate(): number {
    if (this.history.length < 2) return 0;
    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    const turnSpan = last.turn - first.turn;
    if (turnSpan <= 0) return 0;
    return (last.tokens - first.tokens) / turnSpan;
  }

  /**
   * Predict the token count `horizon` turns from now.
   * Returns null if insufficient data for prediction.
   */
  predictTokens(horizon: number, effectiveWindow: number): number | null {
    if (this.history.length < MIN_TURNS_FOR_PREDICTION) return null;
    const rate = this.getGrowthRate();
    if (rate <= 0) return null; // No growth or shrinking — no prediction needed
    const lastTokens = this.history[this.history.length - 1].tokens;
    return Math.min(lastTokens + rate * horizon, effectiveWindow * 2);
  }

  /**
   * Returns true if current growth rate suggests the context will be full
   * within `horizon` turns, even though the current ratio is below the
   * static proactive threshold.
   */
  shouldTriggerEarlyCompaction(
    currentTokens: number,
    effectiveWindow: number,
    horizon: number = PREDICTIVE_COMPACTION_HORIZON,
  ): boolean {
    if (this.history.length < MIN_TURNS_FOR_PREDICTION) return false;
    const predicted = this.predictTokens(horizon, effectiveWindow);
    if (predicted === null) return false;
    // Trigger early if prediction says we'll exceed the upper proactive threshold
    // within the horizon, and current ratio is at least 50% (avoid triggering too early)
    const currentRatio = currentTokens / effectiveWindow;
    return predicted >= effectiveWindow * PROACTIVE_COMPACT_UPPER_RATIO && currentRatio >= 0.50;
  }

  /**
   * Returns a factor (0.5-1.0) for how aggressive proactive compaction should be.
   * Higher growth rate → lower factor → more aggressive compaction (compress more).
   */
  getAggressivenessFactor(): number {
    const rate = this.getGrowthRate();
    if (rate <= 0) return 1.0;
    if (rate < HIGH_GROWTH_THRESHOLD_TOKENS_PER_TURN) {
      // Linear interpolation: 8K→1.0, 0→0.7
      return 0.7 + 0.3 * (rate / HIGH_GROWTH_THRESHOLD_TOKENS_PER_TURN);
    }
    // Very high growth: clamp at 0.5
    return 0.5;
  }
}
