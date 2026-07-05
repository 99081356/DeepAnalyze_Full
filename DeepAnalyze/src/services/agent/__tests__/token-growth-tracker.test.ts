// =============================================================================
// DeepAnalyze - TokenGrowthTracker Unit Tests (C3.6)
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  TokenGrowthTracker,
  PREDICTIVE_COMPACTION_HORIZON,
  HIGH_GROWTH_THRESHOLD_TOKENS_PER_TURN,
  MIN_TURNS_FOR_PREDICTION,
  PROACTIVE_COMPACT_UPPER_RATIO,
} from "../token-growth-tracker.js";

describe("TokenGrowthTracker", () => {
  const EFFECTIVE_WINDOW = 200_000;

  describe("record()", () => {
    it("stores token history per turn", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 10_000);
      tracker.record(2, 15_000);
      tracker.record(3, 20_000);
      // Growth rate should be calculable from these 3 entries
      expect(tracker.getGrowthRate()).toBe(5000);
    });

    it("keeps at most 20 data points", () => {
      const tracker = new TokenGrowthTracker();
      for (let i = 1; i <= 25; i++) {
        tracker.record(i, i * 1000);
      }
      // After 25 records, only last 20 should be kept
      // Growth rate should be based on turns 6-25
      const rate = tracker.getGrowthRate();
      expect(rate).toBe(1000); // still 1000/turn since linear growth
    });
  });

  describe("getGrowthRate()", () => {
    it("returns 0 with fewer than 2 data points", () => {
      const tracker = new TokenGrowthTracker();
      expect(tracker.getGrowthRate()).toBe(0);
      tracker.record(1, 10_000);
      expect(tracker.getGrowthRate()).toBe(0);
    });

    it("calculates average growth rate correctly", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 10_000);
      tracker.record(5, 50_000);
      // 40000 tokens over 4 turns = 10000 per turn
      expect(tracker.getGrowthRate()).toBe(10_000);
    });

    it("returns 0 when there is no growth", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 50_000);
      tracker.record(2, 50_000);
      tracker.record(3, 50_000);
      expect(tracker.getGrowthRate()).toBe(0);
    });

    it("returns negative growth rate when tokens are shrinking", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 80_000);
      tracker.record(3, 60_000);
      // -20K tokens over 2 turns = -10K per turn
      expect(tracker.getGrowthRate()).toBe(-10_000);
    });
  });

  describe("predictTokens()", () => {
    it("returns null with fewer than MIN_TURNS_FOR_PREDICTION data points", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 10_000);
      tracker.record(2, 20_000);
      // Only 2 data points, need 3
      expect(tracker.predictTokens(PREDICTIVE_COMPACTION_HORIZON, EFFECTIVE_WINDOW)).toBeNull();
    });

    it("predicts future token count based on growth rate", () => {
      const tracker = new TokenGrowthTracker();
      // 10000 tokens/turn growth rate
      tracker.record(1, 10_000);
      tracker.record(2, 20_000);
      tracker.record(3, 30_000);
      const predicted = tracker.predictTokens(8, EFFECTIVE_WINDOW);
      expect(predicted).not.toBeNull();
      // Current: 30K, growth: 10K/turn, horizon: 8 → 30K + 10K*8 = 110K
      expect(predicted!).toBe(110_000);
    });

    it("returns null when growth rate is zero", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 50_000);
      tracker.record(2, 50_000);
      tracker.record(3, 50_000);
      expect(tracker.predictTokens(8, EFFECTIVE_WINDOW)).toBeNull();
    });

    it("caps prediction at 2x effective window", () => {
      const tracker = new TokenGrowthTracker();
      // Very high growth rate
      tracker.record(1, 10_000);
      tracker.record(2, 50_000);
      tracker.record(3, 90_000);
      const predicted = tracker.predictTokens(20, EFFECTIVE_WINDOW);
      // 90K + 40K*20 = 890K → capped at 400K (2x effectiveWindow)
      expect(predicted!).toBe(EFFECTIVE_WINDOW * 2);
    });
  });

  describe("shouldTriggerEarlyCompaction()", () => {
    it("returns false with fewer than MIN_TURNS_FOR_PREDICTION data points", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 100_000);
      tracker.record(2, 110_000);
      expect(tracker.shouldTriggerEarlyCompaction(110_000, EFFECTIVE_WINDOW)).toBe(false);
    });

    it("triggers when high growth rate predicts overflow within horizon", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate: 10K/turn
      // Current: 120K (60% of 200K)
      // Predicted in 8 turns: 120K + 10K*8 = 200K = 100% > 85% threshold
      tracker.record(1, 90_000);
      tracker.record(2, 100_000);
      tracker.record(3, 110_000);
      tracker.record(4, 120_000);
      expect(tracker.shouldTriggerEarlyCompaction(120_000, EFFECTIVE_WINDOW)).toBe(true);
    });

    it("does not trigger when growth rate is low", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate: 1K/turn — slow growth
      // Current: 120K (60% of 200K)
      // Predicted in 8 turns: 120K + 1K*8 = 128K = 64% < 85% threshold
      tracker.record(1, 117_000);
      tracker.record(2, 118_000);
      tracker.record(3, 119_000);
      tracker.record(4, 120_000);
      expect(tracker.shouldTriggerEarlyCompaction(120_000, EFFECTIVE_WINDOW)).toBe(false);
    });

    it("does not trigger when current ratio is below 50%", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate: 20K/turn — high
      // Current: 80K (40% of 200K) — below 50% threshold
      // Predicted: 80K + 20K*8 = 240K > 170K (85%) but current < 50%
      tracker.record(1, 20_000);
      tracker.record(2, 40_000);
      tracker.record(3, 60_000);
      tracker.record(4, 80_000);
      expect(tracker.shouldTriggerEarlyCompaction(80_000, EFFECTIVE_WINDOW)).toBe(false);
    });

    it("triggers at exactly 50% with high growth", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate: 20K/turn
      // Current: 100K (50% of 200K)
      // Predicted: 100K + 20K*8 = 260K > 170K (85%)
      tracker.record(1, 40_000);
      tracker.record(2, 60_000);
      tracker.record(3, 80_000);
      tracker.record(4, 100_000);
      expect(tracker.shouldTriggerEarlyCompaction(100_000, EFFECTIVE_WINDOW)).toBe(true);
    });
  });

  describe("getAggressivenessFactor()", () => {
    it("returns 1.0 with no data", () => {
      const tracker = new TokenGrowthTracker();
      expect(tracker.getAggressivenessFactor()).toBe(1.0);
    });

    it("returns 1.0 with zero growth rate", () => {
      const tracker = new TokenGrowthTracker();
      tracker.record(1, 50_000);
      tracker.record(2, 50_000);
      expect(tracker.getAggressivenessFactor()).toBe(1.0);
    });

    it("returns interpolated value for moderate growth", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate: 4000 tokens/turn (half of 8000 threshold)
      tracker.record(1, 10_000);
      tracker.record(2, 14_000);
      // Factor: 0.7 + 0.3 * (4000 / 8000) = 0.7 + 0.15 = 0.85
      expect(tracker.getAggressivenessFactor()).toBeCloseTo(0.85, 5);
    });

    it("returns 0.7 for very low positive growth", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate approaches 0 but is positive
      tracker.record(1, 10_000);
      tracker.record(100, 10_001);
      // Factor: 0.7 + 0.3 * (~0) ≈ 0.7
      expect(tracker.getAggressivenessFactor()).toBeCloseTo(0.7, 1);
    });

    it("returns 0.5 for growth rate at the high threshold", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate: exactly 8000 tokens/turn
      tracker.record(1, 10_000);
      tracker.record(2, 18_000);
      // At the threshold, factor = 0.7 + 0.3 * 1.0 = 1.0
      // Wait, the threshold check is `<` not `<=`, so 8000 exactly hits the high path → 0.5
      // Actually: `rate < HIGH_GROWTH_THRESHOLD` → 8000 < 8000 is false → returns 0.5
      expect(tracker.getAggressivenessFactor()).toBe(0.5);
    });

    it("returns 0.5 for very high growth rate", () => {
      const tracker = new TokenGrowthTracker();
      // Growth rate: 50000 tokens/turn
      tracker.record(1, 10_000);
      tracker.record(2, 60_000);
      expect(tracker.getAggressivenessFactor()).toBe(0.5);
    });
  });

  describe("integration scenarios", () => {
    it("scenario: slow growth → no early trigger, full aggressiveness", () => {
      const tracker = new TokenGrowthTracker();
      // Simulating 10 turns with 2K/turn growth
      for (let i = 1; i <= 10; i++) {
        tracker.record(i, 20_000 + i * 2000);
      }
      // Current at turn 10: 40K (20% of window)
      // Predicted in 8 turns: 40K + 2K*8 = 56K (28%) — no overflow
      expect(tracker.shouldTriggerEarlyCompaction(40_000, EFFECTIVE_WINDOW)).toBe(false);
      // Growth rate 2K → moderate aggressiveness
      const factor = tracker.getAggressivenessFactor();
      expect(factor).toBeGreaterThan(0.7);
      expect(factor).toBeLessThan(1.0);
    });

    it("scenario: rapid growth → early trigger, high aggressiveness", () => {
      const tracker = new TokenGrowthTracker();
      // Simulating 5 turns with 15K/turn growth
      for (let i = 1; i <= 5; i++) {
        tracker.record(i, 50_000 + i * 15_000);
      }
      // Current at turn 5: 125K (62.5% of window)
      // Predicted in 8 turns: 125K + 15K*8 = 245K > 170K (85%)
      expect(tracker.shouldTriggerEarlyCompaction(125_000, EFFECTIVE_WINDOW)).toBe(true);
      // High growth → very aggressive
      expect(tracker.getAggressivenessFactor()).toBe(0.5);
    });

    it("scenario: growth rate changes mid-conversation", () => {
      const tracker = new TokenGrowthTracker();
      // First 5 turns: slow growth (2K/turn)
      for (let i = 1; i <= 5; i++) {
        tracker.record(i, 20_000 + i * 2000);
      }
      // No trigger expected
      expect(tracker.shouldTriggerEarlyCompaction(30_000, EFFECTIVE_WINDOW)).toBe(false);

      // Next 5 turns: rapid growth (20K/turn)
      for (let i = 6; i <= 10; i++) {
        tracker.record(i, 30_000 + (i - 5) * 20_000);
      }
      // History window: turns 1-10, rate is now dominated by rapid growth
      // At turn 10: 30K + 5*20K = 130K (65%)
      // Rate: (130K - 22K) / 9 ≈ 12K/turn
      // Predicted: 130K + 12K*8 = 226K > 170K (85%) → trigger
      expect(tracker.shouldTriggerEarlyCompaction(130_000, EFFECTIVE_WINDOW)).toBe(true);
    });

    it("scenario: compaction reduces tokens → growth rate goes negative → no trigger", () => {
      const tracker = new TokenGrowthTracker();
      // Build up to 150K
      tracker.record(1, 50_000);
      tracker.record(2, 80_000);
      tracker.record(3, 120_000);
      tracker.record(4, 150_000);
      // Would trigger: 150K + 30K*8 = 390K > 170K
      expect(tracker.shouldTriggerEarlyCompaction(150_000, EFFECTIVE_WINDOW)).toBe(true);

      // After compaction, tokens drop to 80K
      tracker.record(5, 80_000);
      // History now: 50K→80K→120K→150K→80K
      // Growth rate: (80K - 50K) / 4 = 7.5K/turn (still positive but lower)
      // But predictTokens: rate is positive, predicted = 80K + 7.5K*8 = 140K < 170K
      // And current ratio: 80K/200K = 40% < 50% → no trigger
      expect(tracker.shouldTriggerEarlyCompaction(80_000, EFFECTIVE_WINDOW)).toBe(false);
    });
  });
});
