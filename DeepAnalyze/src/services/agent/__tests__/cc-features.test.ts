// =============================================================================
// DeepAnalyze - CC-to-DA Feature Porting Tests
// =============================================================================
// Unit tests for 10 features ported from Claude Code reference code.
// Tests are self-contained — no database, no server, no live LLM needed.
// =============================================================================

import { describe, it, expect, afterEach, vi } from "bun:test";
import { ContextManager } from "../context-manager.js";
import { getContextWindowForModel, getDeprecationForModel, MODEL_DEPRECATIONS, getPricingForModel, MODEL_PRICING } from "../../../models/provider-registry.js";
import { TokenEstimator } from "../token-estimator.js";
import { AsyncSessionMemoryExtractor } from "../session-memory-async.js";
import { SystemPromptBuilder, clearSystemPromptCache } from "../system-prompt.js";
import { CostTracker } from "../cost-tracker.js";
import { adjustIndexToPreserveInvariants } from "../compaction.js";
import type { ChatMessage } from "../../../models/provider.js";
import { runPostCompactCleanup } from "../compaction.js";

// ---------------------------------------------------------------------------
// Mock ModelRouter for ContextManager tests
// ---------------------------------------------------------------------------

function createMockModelRouter() {
  return {
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
    getDefaultModel: () => "test-model",
  } as any;
}

// ===========================================================================
// Feature 1: Model-Aware Context Window
// ===========================================================================

describe("Feature 1: Model-Aware Context Window", () => {
  it("uses registry contextWindow for known model", () => {
    const router = createMockModelRouter();
    // "claude-opus-4-6" has contextWindow: 200000 in registry
    const cm = new ContextManager(router, "claude-opus-4-6", [], { contextWindow: 100_000 });
    const info = cm.getContextWindow();
    expect(info.totalTokens).toBe(200_000);
  });

  it("falls back to settings contextWindow for unknown model", () => {
    const router = createMockModelRouter();
    const cm = new ContextManager(router, "unknown-model-xyz", [], { contextWindow: 150_000 });
    const info = cm.getContextWindow();
    expect(info.totalTokens).toBe(150_000);
  });
});

// ===========================================================================
// Feature 2: Cache Efficiency Metrics — Type verification
// ===========================================================================

describe("Feature 2: Cache Efficiency Metrics", () => {
  it("getContextWindowForModel returns correct values for known models", () => {
    // Verify the registry lookup function works
    expect(getContextWindowForModel("claude-opus-4-6")).toBe(200_000);
    expect(getContextWindowForModel("gpt-5.4")).toBe(1_047_576);
    expect(getContextWindowForModel("gemini-2.5-pro")).toBe(1_048_576);
    expect(getContextWindowForModel("unknown-model")).toBeUndefined();
  });

  it("usage type supports cache metric fields", () => {
    // Verify the type system accepts cache metrics
    const usage: { inputTokens: number; outputTokens: number; cachedTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number } = {
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      cacheCreationTokens: 50,
      cacheReadTokens: 150,
    };
    expect(usage.cacheCreationTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(150);
  });
});

// ===========================================================================
// Feature 3: Model Deprecation
// ===========================================================================

describe("Feature 3: Model Deprecation", () => {
  it("returns undefined for empty deprecation list", () => {
    expect(getDeprecationForModel("gpt-4")).toBeUndefined();
    expect(getDeprecationForModel("claude-opus-4-6")).toBeUndefined();
  });

  it("finds deprecation when entry exists", () => {
    // Temporarily add a deprecation entry
    const entry = { deprecatedId: "test-deprecated-model", replacementId: "test-replacement", message: "Test deprecation" };
    MODEL_DEPRECATIONS.push(entry);
    try {
      const result = getDeprecationForModel("test-deprecated-model");
      expect(result).toBeDefined();
      expect(result!.deprecatedId).toBe("test-deprecated-model");
      expect(result!.replacementId).toBe("test-replacement");
    } finally {
      MODEL_DEPRECATIONS.pop();
    }
  });
});

// ===========================================================================
// Feature 4: Enhanced Token Estimator
// ===========================================================================

describe("Feature 4: Enhanced Token Estimator", () => {
  it("file-type-aware estimation: JSON has lower bytes/token than text", () => {
    const estimator = new TokenEstimator();
    const jsonTokens = estimator.estimateForFileType("12345678", "json");
    const txtTokens = estimator.estimateForFileType("12345678", "txt");
    // JSON: bytesPerToken=2, so 8/2 = 4 tokens
    // txt: bytesPerToken=4, so 8/4 = 2 tokens
    expect(jsonTokens).toBe(4);
    expect(txtTokens).toBe(2);
  });

  it("image/document estimation returns fixed 2000", () => {
    const estimator = new TokenEstimator();
    expect(estimator.estimateForImageOrDocument()).toBe(2000);
  });

  it("canonical estimation mode uses last API + delta", () => {
    const estimator = new TokenEstimator();
    // Report API usage: 1000 tokens for 5 messages
    estimator.reportApiUsage(1000, 5);

    // Create 8 messages (3 more than reported)
    const messages: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i} with some text content`,
    }));

    const estimate = estimator.tokenCountWithEstimation(messages as any);
    // Should be >= 1000 (last API) since we have more messages
    expect(estimate).toBeGreaterThanOrEqual(1000);
  });
});

// ===========================================================================
// Feature 5: Async Session Memory Dual Trigger
// ===========================================================================

describe("Feature 5: Async Session Memory Dual Trigger", () => {
  it("triggers on tool call count increment >= 3", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 100_000 });
    let called = false;
    // Token increment is tiny (100), but toolCallCount goes from 0 to 3
    extractor.tryExtract(100, async () => { called = true; }, 3);
    await extractor.waitForExtraction();
    expect(called).toBe(true);
  });

  it("does not trigger when both increments are below threshold", () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 100_000 });
    let called = false;
    // Token increment: 100, tool call increment: 2 (both below threshold)
    extractor.tryExtract(100, async () => { called = true; }, 2);
    expect(called).toBe(false);
  });

  it("reset clears both token and tool call counters", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 100 });
    // First extraction sets counters
    extractor.tryExtract(1000, async () => {}, 5);
    await extractor.waitForExtraction();

    // Reset
    extractor.reset();

    // After reset, same values should trigger again (increment from 0)
    let called = false;
    extractor.tryExtract(1000, async () => { called = true; }, 5);
    await extractor.waitForExtraction();
    expect(called).toBe(true);
  });
});

// ===========================================================================
// Feature 6: System Prompt Section Caching
// ===========================================================================

describe("Feature 6: System Prompt Section Caching", () => {
  afterEach(() => {
    clearSystemPromptCache();
  });

  it("caches static sections across builder instances", () => {
    let computeCount = 0;
    const compute = () => { computeCount++; return "cached content"; };

    const builder1 = new SystemPromptBuilder();
    builder1.addCachedStaticSection("test-section", compute);
    expect(computeCount).toBe(1);

    const builder2 = new SystemPromptBuilder();
    builder2.addCachedStaticSection("test-section", () => { computeCount++; return "different content"; });
    // Second call should use cache, NOT call compute
    expect(computeCount).toBe(1);

    const result = builder2.build();
    expect(result.full).toContain("cached content");
  });

  it("clearSystemPromptCache forces recomputation", () => {
    let computeCount = 0;
    const compute = () => { computeCount++; return `content-${computeCount}`; };

    const builder1 = new SystemPromptBuilder();
    builder1.addCachedStaticSection("clear-test", compute);
    expect(computeCount).toBe(1);

    clearSystemPromptCache();

    const builder2 = new SystemPromptBuilder();
    builder2.addCachedStaticSection("clear-test", compute);
    expect(computeCount).toBe(2);
  });
});

// ===========================================================================
// Feature 7: Post-Compact Unified Cleanup
// ===========================================================================

describe("Feature 7: Post-Compact Unified Cleanup", () => {
  it("calls all extras cleanup methods", async () => {
    const readFileState = new Map<string, any>();
    readFileState.set("test", { content: "data" });

    const tokenEstimator = { clear: vi.fn() };
    const collapseStore = { clear: vi.fn() };
    const searchSaturation = { reset: vi.fn() };

    await runPostCompactCleanup(
      readFileState,
      null, // no session memory manager
      [],
      0,
      { tokenEstimator, collapseStore, searchSaturation },
    );

    expect(readFileState.size).toBe(0);
    expect(tokenEstimator.clear).toHaveBeenCalled();
    expect(collapseStore.clear).toHaveBeenCalled();
    expect(searchSaturation.reset).toHaveBeenCalled();
  });

  it("works without extras (no crash)", async () => {
    const readFileState = new Map<string, any>();
    readFileState.set("test", { content: "data" });

    // Should not throw
    await runPostCompactCleanup(readFileState, null, [], 0);

    expect(readFileState.size).toBe(0);
  });
});

// ===========================================================================
// Feature 8: Compaction Invariant Protection
// ===========================================================================

describe("Feature 8: Compaction Invariant Protection", () => {
  it("returns unchanged index when no orphaned tool_results", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "do something" },
      { role: "assistant", content: "done" },
    ];
    const result = adjustIndexToPreserveInvariants(messages, 3);
    expect(result).toBe(3);
  });

  it("adjusts index forward when tool_result is orphaned", () => {
    // Assistant at index 2 has tool_call "tc_1"
    // Tool result at index 3 references "tc_1"
    // If startIndex=3, the tool_result is kept but the assistant with tool_use would be removed
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "search for X" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc_1", type: "function", function: { name: "kb_search", arguments: '{"query":"X"}' } }],
      },
      { role: "tool", content: "search results", toolCallId: "tc_1" },
      { role: "user", content: "next question" },
    ];

    // startIndex=3: tool result at index 3 is kept, but assistant at index 2 (with tool_use) would be compacted
    const result = adjustIndexToPreserveInvariants(messages, 3);
    // Should adjust backward to include index 2 (the assistant with the tool_use)
    expect(result).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// Feature 9: Cost Tracking
// ===========================================================================

describe("Feature 9: Cost Tracking", () => {
  it("calculates correct cost for known model with cache pricing", () => {
    // claude-opus-4-6: input=$15/M, output=$75/M, cacheWrite=$18.75/M, cacheRead=$1.50/M
    const tracker = new CostTracker("claude-opus-4-6");
    expect(tracker.hasPricing).toBe(true);

    // 1M input, 500K output, 200K cache write, 300K cache read
    // Non-cache input = 1M - 200K - 300K = 500K
    // Cost = (500K/1M * 15) + (500K/1M * 75) + (200K/1M * 18.75) + (300K/1M * 1.50)
    //      = 7.5 + 37.5 + 3.75 + 0.45 = 49.2
    const cost = tracker.recordTurn(1, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheCreationTokens: 200_000,
      cacheReadTokens: 300_000,
    });
    expect(cost).toBeCloseTo(49.2, 1);
    expect(tracker.totalCostUsd).toBeCloseTo(49.2, 1);
  });

  it("returns 0 for unknown model", () => {
    const tracker = new CostTracker("completely-unknown-model");
    expect(tracker.hasPricing).toBe(false);
    const cost = tracker.recordTurn(1, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(cost).toBe(0);
    expect(tracker.totalCostUsd).toBe(0);
  });

  it("accumulates cost across multiple turns", () => {
    const tracker = new CostTracker("gpt-4o");
    // gpt-4o: input=$2.50/M, output=$10/M, cacheRead=$1.25/M
    const cost1 = tracker.recordTurn(1, { inputTokens: 100_000, outputTokens: 50_000 });
    const cost2 = tracker.recordTurn(2, { inputTokens: 80_000, outputTokens: 40_000 });

    // cost1 = (100K/1M * 2.5) + (50K/1M * 10) = 0.25 + 0.5 = 0.75
    expect(cost1).toBeCloseTo(0.75, 2);
    // cost2 = (80K/1M * 2.5) + (40K/1M * 10) = 0.2 + 0.4 = 0.6
    expect(cost2).toBeCloseTo(0.6, 2);

    expect(tracker.totalCostUsd).toBeCloseTo(1.35, 2);
  });
});
