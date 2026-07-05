// =============================================================================
// DeepAnalyze - Integration Tests
// =============================================================================
// End-to-end integration tests for agent subsystems. Tests verify that
// multiple modules work together correctly across feature flags, prompt
// building, plugin loading, cache editing + tool orchestration, compression,
// long-IO continuation, session memory extraction, and token estimation.
// =============================================================================

import { describe, it, expect, afterEach, vi } from "bun:test";
import path from "path";

// ---------------------------------------------------------------------------
// 1. Feature Flags Integration
// ---------------------------------------------------------------------------
import {
  resolveFeatureFlags,
  DEFAULT_FEATURE_FLAGS,
} from "../feature-flags.js";

// ---------------------------------------------------------------------------
// 2. SystemPromptBuilder Integration
// ---------------------------------------------------------------------------
import { SystemPromptBuilder } from "../system-prompt.js";

// ---------------------------------------------------------------------------
// 3. Plugin Manager Auto-loading
// ---------------------------------------------------------------------------
import { AgentPluginManager } from "../plugin-manager.js";

// ---------------------------------------------------------------------------
// 4. Cache Editing + Tool Orchestration Combined
// ---------------------------------------------------------------------------
import { applyCacheEditing } from "../cache-editing.js";
import {
  partitionToolCalls,
  orchestrateToolCalls,
} from "../tool-orchestration.js";
import type { AgentTool } from "../types.js";
import type { ToolCall, ChatMessage } from "../../../models/provider.js";

// ---------------------------------------------------------------------------
// 5. Hierarchical Compressor + Compaction Integration
// ---------------------------------------------------------------------------
import { COMPRESSION_LEVELS } from "../hierarchical-compressor.js";

// ---------------------------------------------------------------------------
// 6. Long-IO Continuation Flow
// ---------------------------------------------------------------------------
import {
  needsContinuation,
  buildContinuationMessage,
  shouldSegmentOutput,
} from "../long-io.js";

// ---------------------------------------------------------------------------
// 7. AsyncSessionMemoryExtractor Integration
// ---------------------------------------------------------------------------
import { AsyncSessionMemoryExtractor } from "../session-memory-async.js";

// ---------------------------------------------------------------------------
// 8. TokenEstimator Dual-Layer Integration
// ---------------------------------------------------------------------------
import { TokenEstimator } from "../token-estimator.js";

// =============================================================================
// 1. Feature Flags Integration with AgentRunner
// =============================================================================

describe("Feature Flags Integration", () => {
  afterEach(() => {
    // Clean up env vars between tests
    delete process.env.DA_CONCURRENT_TOOLS;
    delete process.env.DA_CACHE_EDITING;
    delete process.env.DA_LONG_OUTPUT;
    delete process.env.DA_MAX_CONCURRENCY;
    delete process.env.DA_PROMPT_CACHING;
    delete process.env.DA_STREAMING_TOOLS;
    delete process.env.DA_HIERARCHICAL_COMPACT;
    delete process.env.DA_PLUGINS;
    delete process.env.DA_MARKDOWN_SKILLS;
  });

  it("default flags have concurrentToolExecution, cacheEditing, longOutputContinuation enabled", () => {
    const flags = resolveFeatureFlags();
    expect(flags.concurrentToolExecution).toBe(true);
    expect(flags.cacheEditing).toBe(true);
    expect(flags.longOutputContinuation).toBe(true);
  });

  it("all defaults match DEFAULT_FEATURE_FLAGS", () => {
    const flags = resolveFeatureFlags();
    expect(flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it("env var overrides take priority over defaults", () => {
    process.env.DA_CONCURRENT_TOOLS = "false";
    const flags = resolveFeatureFlags();
    expect(flags.concurrentToolExecution).toBe(false);
    // Others remain default
    expect(flags.cacheEditing).toBe(true);
  });

  it("env var overrides take priority over DB config", () => {
    process.env.DA_CACHE_EDITING = "true";
    const flags = resolveFeatureFlags({ cacheEditing: false });
    // env var wins over DB config
    expect(flags.cacheEditing).toBe(true);
  });

  it("DB config overrides work when no env var is set", () => {
    const flags = resolveFeatureFlags({
      concurrentToolExecution: false,
      longOutputContinuation: false,
    });
    expect(flags.concurrentToolExecution).toBe(false);
    expect(flags.longOutputContinuation).toBe(false);
  });

  it("numeric env var overrides maxToolConcurrency", () => {
    process.env.DA_MAX_CONCURRENCY = "3";
    const flags = resolveFeatureFlags({ maxToolConcurrency: 10 });
    expect(flags.maxToolConcurrency).toBe(3);
  });

  it("env var '1' is treated as true", () => {
    process.env.DA_STREAMING_TOOLS = "1";
    const flags = resolveFeatureFlags();
    expect(flags.streamingToolExecution).toBe(true);
  });

  it("DB config can set numeric fields", () => {
    const flags = resolveFeatureFlags({ maxToolConcurrency: 5 });
    expect(flags.maxToolConcurrency).toBe(5);
  });

  it("priority chain: env > dbConfig > defaults", () => {
    // Set env to enable, db to disable, default is true
    process.env.DA_LONG_OUTPUT = "false";
    const flags = resolveFeatureFlags({ longOutputContinuation: true });
    // env wins
    expect(flags.longOutputContinuation).toBe(false);
  });
});

// =============================================================================
// 2. SystemPromptBuilder Integration
// =============================================================================

describe("SystemPromptBuilder Integration", () => {
  it("produces a prompt with static/dynamic boundary", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("identity", "You are a helpful assistant.");
    builder.addDynamicSection("context", "Current time: 2026-04-30");

    const result = builder.build();

    expect(result.boundary).toBe("\n\n---DYNAMIC_BOUNDARY---\n\n");
    expect(result.full).toContain("---DYNAMIC_BOUNDARY---");
    expect(result.full).toContain("You are a helpful assistant.");
    expect(result.full).toContain("Current time: 2026-04-30");
  });

  it("static sections come before dynamic sections", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("identity", "STATIC_IDENTITY");
    builder.addStaticSection("rules", "STATIC_RULES");
    builder.addDynamicSection("context", "DYNAMIC_CONTEXT");
    builder.addDynamicSection("memory", "DYNAMIC_MEMORY");

    const result = builder.build();

    const staticIndex = result.full.indexOf("STATIC_IDENTITY");
    const dynamicIndex = result.full.indexOf("DYNAMIC_CONTEXT");
    expect(staticIndex).toBeLessThan(dynamicIndex);
    expect(staticIndex).toBeGreaterThan(-1);
    expect(dynamicIndex).toBeGreaterThan(-1);
  });

  it("full prompt is a proper non-empty string", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("id", "System prompt content here.");
    builder.addDynamicSection("session", "Session-specific data.");

    const result = builder.build();

    expect(typeof result.full).toBe("string");
    expect(result.full.length).toBeGreaterThan(0);
  });

  it("staticPart contains only static content", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("id", "STATIC_A");
    builder.addDynamicSection("ctx", "DYNAMIC_B");

    const result = builder.build();

    expect(result.staticPart).toContain("STATIC_A");
    expect(result.staticPart).not.toContain("DYNAMIC_B");
  });

  it("dynamicPart contains only dynamic content", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("id", "STATIC_A");
    builder.addDynamicSection("ctx", "DYNAMIC_B");

    const result = builder.build();

    expect(result.dynamicPart).toContain("DYNAMIC_B");
    expect(result.dynamicPart).not.toContain("STATIC_A");
  });

  it("handles builder with no dynamic sections", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("id", "Only static content.");

    const result = builder.build();

    expect(result.full).toContain("Only static content.");
    expect(result.dynamicPart).toBe("");
    // No boundary when there is no dynamic part
    expect(result.full).not.toContain("---DYNAMIC_BOUNDARY---");
  });

  it("reset clears all sections", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("id", "content");
    expect(builder.sectionCount).toBe(1);

    builder.reset();
    expect(builder.sectionCount).toBe(0);

    const result = builder.build();
    expect(result.full).toBe("");
  });

  it("sectionCount and dynamicSectionCount track correctly", () => {
    const builder = new SystemPromptBuilder();
    builder.addStaticSection("a", "A");
    builder.addDynamicSection("b", "B");
    builder.addStaticSection("c", "C");
    builder.addDynamicSection("d", "D");

    expect(builder.sectionCount).toBe(4);
    expect(builder.dynamicSectionCount).toBe(2);
  });
});

// =============================================================================
// 3. Plugin Manager Auto-loading (judicial-analysis plugin)
// =============================================================================

describe("Plugin Manager Auto-loading", () => {
  const pluginDir = path.resolve(
    process.cwd(),
    "plugins/judicial-analysis",
  );

  it("loads the judicial-analysis plugin from plugins/judicial-analysis/", async () => {
    const manager = new AgentPluginManager();
    const plugin = await manager.loadPlugin(pluginDir);

    expect(plugin).toBeDefined();
    expect(plugin.manifest.name).toBe("judicial-analysis");
    expect(plugin.manifest.version).toBe("1.0.0");
    expect(plugin.enabled).toBe(true);
  });

  it("loads 7 skills from the plugin", async () => {
    const manager = new AgentPluginManager();
    await manager.loadPlugin(pluginDir);

    const skills = manager.getAllSkills();
    expect(skills.length).toBe(7);

    const skillNames = skills.map((s) => s.name);
    expect(skillNames).toContain("evidence-chain");
    expect(skillNames).toContain("timeline-reconstruction");
    expect(skillNames).toContain("entity-network");
    expect(skillNames).toContain("cross-validation");
    expect(skillNames).toContain("fact-extraction");
    expect(skillNames).toContain("deep-case-analysis");
    expect(skillNames).toContain("report-generate");
  });

  it("loads 2 agents (verifier, extractor)", async () => {
    const manager = new AgentPluginManager();
    await manager.loadPlugin(pluginDir);

    const agents = manager.getAllAgents();
    expect(agents.length).toBe(2);

    const agentTypes = agents.map((a) => a.agentType);
    expect(agentTypes).toContain("judicial-verifier");
    expect(agentTypes).toContain("judicial-extractor");
  });

  it("skills contain anti-hallucination instructions", async () => {
    const manager = new AgentPluginManager();
    await manager.loadPlugin(pluginDir);

    const skills = manager.getAllSkills();
    expect(skills.length).toBeGreaterThan(0);

    // Every skill should contain anti-hallucination markers:
    // Keywords: 来源, 禁止, 不得, 标注
    for (const skill of skills) {
      const prompt = skill.systemPrompt;
      const hasSourceAnnotation =
        prompt.includes("来源") || prompt.includes("标注");
      const hasAntiHallucination =
        prompt.includes("禁止") ||
        prompt.includes("不得") ||
        prompt.includes("严禁");
      // At least one anti-hallucination marker should be present
      expect(
        hasSourceAnnotation || hasAntiHallucination,
        `Skill "${skill.name}" should contain anti-hallucination instructions`,
      ).toBe(true);
    }
  });

  it("plugin enable/disable controls skill and agent visibility", async () => {
    const manager = new AgentPluginManager();
    await manager.loadPlugin(pluginDir);

    expect(manager.getAllSkills().length).toBe(7);
    expect(manager.getAllAgents().length).toBe(2);

    manager.setEnabled("judicial-analysis", false);
    expect(manager.getAllSkills().length).toBe(0);
    expect(manager.getAllAgents().length).toBe(0);

    manager.setEnabled("judicial-analysis", true);
    expect(manager.getAllSkills().length).toBe(7);
    expect(manager.getAllAgents().length).toBe(2);
  });

  it("unload removes the plugin", async () => {
    const manager = new AgentPluginManager();
    await manager.loadPlugin(pluginDir);

    expect(manager.list().length).toBe(1);
    const removed = manager.unload("judicial-analysis");
    expect(removed).toBe(true);
    expect(manager.list().length).toBe(0);
  });

  it("get returns the loaded plugin by name", async () => {
    const manager = new AgentPluginManager();
    await manager.loadPlugin(pluginDir);

    const plugin = manager.get("judicial-analysis");
    expect(plugin).toBeDefined();
    expect(plugin!.manifest.name).toBe("judicial-analysis");

    const missing = manager.get("non-existent");
    expect(missing).toBeUndefined();
  });
});

// =============================================================================
// 4. Cache Editing + Tool Orchestration Combined
// =============================================================================

describe("Cache Editing + Tool Orchestration Combined", () => {
  it("cache editing truncates old results while recent are preserved", () => {
    const largeContent = "A".repeat(20000);
    const smallContent = "small result";

    const messages: ChatMessage[] = [
      { role: "system" as const, content: "system prompt" },
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "thinking..." },
      {
        role: "tool" as const,
        content: largeContent,
        toolCallId: "old-tool-1",
      },
      { role: "assistant" as const, content: "second turn" },
      {
        role: "tool" as const,
        content: smallContent,
        toolCallId: "new-tool-1",
      },
      { role: "assistant" as const, content: "final answer" },
    ];

    const edited = applyCacheEditing(messages, {
      keepRecentTurns: 1,
      maxResultChars: 1000,
    });

    // Old tool result should be truncated
    const oldTool = edited.find(
      (m) => m.role === "tool" && m.toolCallId === "old-tool-1",
    );
    expect(oldTool).toBeDefined();
    const oldContent =
      typeof oldTool!.content === "string"
        ? oldTool!.content
        : JSON.stringify(oldTool!.content);
    expect(oldContent.length).toBeLessThan(largeContent.length);
    expect(oldContent).toContain("truncated");

    // Recent tool result should be preserved
    const newTool = edited.find(
      (m) => m.role === "tool" && m.toolCallId === "new-tool-1",
    );
    expect(newTool).toBeDefined();
    expect(newTool!.content).toBe(smallContent);
  });

  it("orchestration executes concurrent-safe tools in parallel", async () => {
    const executionOrder: string[] = [];

    const readOnlyTool: AgentTool = {
      name: "search",
      description: "Read-only search",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => ({ result: "found" }),
    };

    const writeTool: AgentTool = {
      name: "write",
      description: "Write tool",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      execute: async () => ({ result: "written" }),
    };

    const toolsMap = new Map<string, AgentTool>();
    toolsMap.set("search", readOnlyTool);
    toolsMap.set("write", writeTool);

    const toolCalls: ToolCall[] = [
      {
        id: "tc-1",
        type: "function",
        function: { name: "search", arguments: '{"q":"a"}' },
      },
      {
        id: "tc-2",
        type: "function",
        function: { name: "search", arguments: '{"q":"b"}' },
      },
      {
        id: "tc-3",
        type: "function",
        function: { name: "write", arguments: '{"data":"c"}' },
      },
    ];

    async function mockExecute(tc: ToolCall): Promise<ChatMessage> {
      executionOrder.push(tc.id);
      return {
        role: "tool",
        content: `result for ${tc.id}`,
        toolCallId: tc.id,
      };
    }

    const result = await orchestrateToolCalls(
      toolCalls,
      toolsMap,
      mockExecute,
    );

    // All 3 should execute
    expect(result.messages.length).toBe(3);
    // 2 concurrent + 1 serial
    expect(result.concurrentCount).toBe(2);
    expect(result.serialCount).toBe(1);
  });

  it("partitionToolCalls groups concurrent-safe tools together", () => {
    const readOnlyTool: AgentTool = {
      name: "search",
      description: "Read-only search",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => null,
    };

    const writeTool: AgentTool = {
      name: "write",
      description: "Write tool",
      isReadOnly: () => false,
      execute: async () => null,
    };

    const toolsMap = new Map<string, AgentTool>();
    toolsMap.set("search", readOnlyTool);
    toolsMap.set("write", writeTool);

    const toolCalls: ToolCall[] = [
      {
        id: "tc-1",
        type: "function",
        function: { name: "search", arguments: '{"q":"a"}' },
      },
      {
        id: "tc-2",
        type: "function",
        function: { name: "search", arguments: '{"q":"b"}' },
      },
      {
        id: "tc-3",
        type: "function",
        function: { name: "write", arguments: '{"d":"c"}' },
      },
      {
        id: "tc-4",
        type: "function",
        function: { name: "search", arguments: '{"q":"d"}' },
      },
    ];

    const batches = partitionToolCalls(toolCalls, toolsMap);

    // Batch 1: concurrent (tc-1, tc-2), Batch 2: serial (tc-3), Batch 3: concurrent (tc-4)
    expect(batches.length).toBe(3);
    expect(batches[0].isConcurrent).toBe(true);
    expect(batches[0].toolCalls.length).toBe(2);
    expect(batches[1].isConcurrent).toBe(false);
    expect(batches[1].toolCalls.length).toBe(1);
    expect(batches[2].isConcurrent).toBe(true);
    expect(batches[2].toolCalls.length).toBe(1);
  });

  it("combined: cache editing then orchestration on tool results", async () => {
    // Simulate a full flow:
    // 1. Start with messages containing large tool results
    // 2. Apply cache editing to truncate old results
    // 3. Run orchestration on new tool calls
    // 4. Verify everything works together

    const largeData = "X".repeat(15000);

    const messages: ChatMessage[] = [
      { role: "system" as const, content: "system" },
      { role: "assistant" as const, content: "turn 1" },
      {
        role: "tool" as const,
        content: largeData,
        toolCallId: "old-result",
      },
      { role: "assistant" as const, content: "turn 2 (recent)" },
      {
        role: "tool" as const,
        content: "fresh data",
        toolCallId: "new-result",
      },
    ];

    // Step 1: Apply cache editing
    const edited = applyCacheEditing(messages, {
      keepRecentTurns: 1,
      maxResultChars: 500,
    });

    // Verify old result truncated
    const oldTool = edited.find(
      (m) => m.role === "tool" && m.toolCallId === "old-result",
    );
    const oldContent =
      typeof oldTool!.content === "string"
        ? oldTool!.content
        : JSON.stringify(oldTool!.content);
    expect(oldContent.length).toBeLessThan(largeData.length);

    // Verify new result preserved
    const newTool = edited.find(
      (m) => m.role === "tool" && m.toolCallId === "new-result",
    );
    expect(newTool!.content).toBe("fresh data");

    // Step 2: Run orchestration for next set of tool calls
    const searchTool: AgentTool = {
      name: "kb_search",
      description: "Search",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => "search results",
    };

    const toolsMap = new Map<string, AgentTool>();
    toolsMap.set("kb_search", searchTool);

    const newCalls: ToolCall[] = [
      {
        id: "nc-1",
        type: "function",
        function: { name: "kb_search", arguments: '{"query":"test"}' },
      },
      {
        id: "nc-2",
        type: "function",
        function: { name: "kb_search", arguments: '{"query":"test2"}' },
      },
    ];

    const orchestrationResult = await orchestrateToolCalls(
      newCalls,
      toolsMap,
      async (tc) => ({
        role: "tool" as const,
        content: `result-${tc.id}`,
        toolCallId: tc.id,
      }),
    );

    expect(orchestrationResult.messages.length).toBe(2);
    expect(orchestrationResult.concurrentCount).toBe(2);
    expect(orchestrationResult.serialCount).toBe(0);
  });
});

// =============================================================================
// 5. Hierarchical Compressor + Compaction Integration
// =============================================================================

describe("Hierarchical Compressor + Compaction Integration", () => {
  it("D2, D1, and Leaf levels are defined correctly", () => {
    expect(COMPRESSION_LEVELS.length).toBe(3);

    const [d2, d1, leaf] = COMPRESSION_LEVELS;

    expect(d2.name).toBe("D2");
    expect(d1.name).toBe("D1");
    expect(leaf.name).toBe("Leaf");

    // D2 has fewer tokens than D1 (coarser compression)
    expect(d2.maxTokens).toBeLessThan(d1.maxTokens);

    // Leaf has no compression
    expect(leaf.maxTokens).toBe(Infinity);
    expect(leaf.prompt).toBe("");
  });

  it("D2 prompt focuses on coarse summary", () => {
    const d2 = COMPRESSION_LEVELS[0];
    const prompt = d2.prompt;

    // D2 should focus on high-level conclusions and omit details
    expect(prompt).toContain("概括");
    expect(prompt).toContain("结论");
  });

  it("D1 prompt focuses on structured details", () => {
    const d1 = COMPRESSION_LEVELS[1];
    const prompt = d1.prompt;

    // D1 should preserve structured details
    expect(prompt).toContain("结构化");
    expect(prompt).toContain("决策");
    expect(prompt).toContain("重要事实");
  });

  it("D2 has smaller token budget than D1", () => {
    const d2 = COMPRESSION_LEVELS[0];
    const d1 = COMPRESSION_LEVELS[1];

    expect(d2.maxTokens).toBe(2000);
    expect(d1.maxTokens).toBe(4000);
    expect(d2.maxTokens).toBeLessThan(d1.maxTokens);
  });

  it("all prompts are non-empty for D2 and D1", () => {
    for (const level of COMPRESSION_LEVELS) {
      if (level.name === "Leaf") {
        expect(level.prompt).toBe("");
      } else {
        expect(level.prompt.length).toBeGreaterThan(0);
      }
    }
  });

  it("compression levels are ordered from most aggressive to least", () => {
    const [d2, d1, leaf] = COMPRESSION_LEVELS;
    expect(d2.maxTokens).toBeLessThan(d1.maxTokens);
    expect(d1.maxTokens).toBeLessThan(leaf.maxTokens);
  });
});

// =============================================================================
// 6. Long-IO Continuation Flow
// =============================================================================

describe("Long-IO Continuation Flow", () => {
  it("complete continuation flow: detect truncation -> build message -> verify format", () => {
    // Step 1: Detect truncation
    const truncated = needsContinuation("length");
    expect(truncated).toBe(true);

    const notTruncated = needsContinuation("stop");
    expect(notTruncated).toBe(false);

    const unknown = needsContinuation(undefined);
    expect(unknown).toBe(false);

    // Step 2: Build continuation message
    const msg = buildContinuationMessage();
    expect(msg.role).toBe("user");
    expect(typeof msg.content).toBe("string");
    expect(msg.content.length).toBeGreaterThan(0);

    // Step 3: Verify format is suitable for injection
    // Message should instruct the model to continue
    expect(msg.content).toContain("继续");
  });

  it("buildContinuationMessage with custom prompt", () => {
    const customPrompt = "Please continue from where you stopped.";
    const msg = buildContinuationMessage({ continuationPrompt: customPrompt });
    expect(msg.role).toBe("user");
    expect(msg.content).toBe(customPrompt);
  });

  it("shouldSegmentOutput detects large output", () => {
    // Above threshold
    expect(shouldSegmentOutput(100_000)).toBe(true);
    expect(shouldSegmentOutput(50_001)).toBe(true);

    // At threshold boundary
    expect(shouldSegmentOutput(50_000)).toBe(false);

    // Below threshold
    expect(shouldSegmentOutput(10_000)).toBe(false);
    expect(shouldSegmentOutput(0)).toBe(false);
  });

  it("needsContinuation only returns true for 'length' reason", () => {
    expect(needsContinuation("length")).toBe(true);
    expect(needsContinuation("stop")).toBe(false);
    expect(needsContinuation("tool_use")).toBe(false);
    expect(needsContinuation("end_turn")).toBe(false);
    expect(needsContinuation(undefined)).toBe(false);
  });

  it("continuation message can be serialized as ChatMessage", () => {
    const msg = buildContinuationMessage();
    // Should have exactly role and content fields
    expect(msg).toHaveProperty("role");
    expect(msg).toHaveProperty("content");
    expect(Object.keys(msg).length).toBe(2);
  });
});

// =============================================================================
// 7. AsyncSessionMemoryExtractor Integration
// =============================================================================

describe("AsyncSessionMemoryExtractor Integration", () => {
  it("extraction triggers when token increment exceeds threshold", async () => {
    let extractionCount = 0;
    const extractor = new AsyncSessionMemoryExtractor({
      sessionMemoryUpdateInterval: 1000,
    });

    // Below threshold — should not trigger
    extractor.tryExtract(2000, async () => {
      extractionCount++;
    });
    expect(extractionCount).toBe(0);

    // Wait for any async operations
    await extractor.waitForExtraction();

    // Above threshold (3x sessionMemoryUpdateInterval = 3000)
    extractor.tryExtract(4000, async () => {
      extractionCount++;
    });

    // Wait for extraction to complete
    await extractor.waitForExtraction();
    expect(extractionCount).toBe(1);
  });

  it("overlapping extractions are skipped", async () => {
    let extractionCount = 0;
    const extractor = new AsyncSessionMemoryExtractor({
      sessionMemoryUpdateInterval: 10,
    });

    // First call triggers extraction
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    extractor.tryExtract(1000, async () => {
      extractionCount++;
      await firstPromise;
    });

    // Second call while first is still running — should be skipped
    extractor.tryExtract(2000, async () => {
      extractionCount++;
    });

    expect(extractionCount).toBe(1); // Only first started

    // Resolve the first extraction
    resolveFirst!();
    await extractor.waitForExtraction();

    expect(extractionCount).toBe(1); // Second was skipped
  });

  it("waitForExtraction completes when no extraction is running", async () => {
    const extractor = new AsyncSessionMemoryExtractor();

    // Should resolve immediately
    await extractor.waitForExtraction();
    expect(extractor.isExtracting).toBe(false);
  });

  it("waitForExtraction completes after extraction finishes", async () => {
    const extractor = new AsyncSessionMemoryExtractor({
      sessionMemoryUpdateInterval: 10,
    });

    let resolved = false;
    extractor.tryExtract(1000, async () => {
      await new Promise((r) => setTimeout(r, 50));
      resolved = true;
    });

    expect(extractor.isExtracting).toBe(true);

    await extractor.waitForExtraction();
    expect(resolved).toBe(true);
    expect(extractor.isExtracting).toBe(false);
  });

  it("reset clears the lastExtractedTokens counter", async () => {
    const extractor = new AsyncSessionMemoryExtractor({
      sessionMemoryUpdateInterval: 100,
    });

    // Trigger extraction with 1000 tokens (threshold = 100*3 = 300, 1000 >= 300)
    extractor.tryExtract(1000, async () => {});
    await extractor.waitForExtraction();

    // After extraction, lastExtractedTokens is 1000
    // Try with increment below threshold: 1050 - 1000 = 50 < 300 (should not trigger)
    let called = false;
    extractor.tryExtract(1050, async () => {
      called = true;
    });
    expect(called).toBe(false);

    // Reset
    extractor.reset();

    // After reset, lastExtractedTokens = 0
    // Now 1000 - 0 = 1000 >= 300, so should trigger
    extractor.tryExtract(1000, async () => {
      called = true;
    });
    await extractor.waitForExtraction();
    expect(called).toBe(true);
  });

  it("isExtracting reflects current state", async () => {
    const extractor = new AsyncSessionMemoryExtractor({
      sessionMemoryUpdateInterval: 10,
    });

    expect(extractor.isExtracting).toBe(false);

    let resolveExtraction: () => void;
    extractor.tryExtract(1000, async () => {
      await new Promise<void>((r) => {
        resolveExtraction = r;
      });
    });

    expect(extractor.isExtracting).toBe(true);

    resolveExtraction!();
    await extractor.waitForExtraction();

    expect(extractor.isExtracting).toBe(false);
  });
});

// =============================================================================
// 8. TokenEstimator Dual-Layer Integration
// =============================================================================

describe("TokenEstimator Dual-Layer Integration", () => {
  it("API reported values take priority over estimation", () => {
    const estimator = new TokenEstimator();

    const msg = {
      role: "user" as const,
      content: "This is a test message for dual-layer estimation.",
    };

    // Without API value — conservative estimation
    const estimated = estimator.estimateMessage(msg);
    expect(estimated).toBeGreaterThan(0);

    // With API value — should return exact value
    const hash = `user|${msg.content.slice(0, 100)}`;
    estimator.reportUsage(hash, 15);

    const reported = estimator.estimateMessage(msg);
    expect(reported).toBe(15);
    expect(reported).not.toBe(estimated);
  });

  it("conservative fallback produces reasonable estimates", () => {
    const estimator = new TokenEstimator();

    // Short message
    const shortMsg = { role: "user" as const, content: "Hello" };
    const shortTokens = estimator.estimateMessage(shortMsg);
    expect(shortTokens).toBeGreaterThan(0);
    expect(shortTokens).toBeLessThan(50); // Very short message

    // Long message
    const longMsg = {
      role: "user" as const,
      content: "A".repeat(3000),
    };
    const longTokens = estimator.estimateMessage(longMsg);
    expect(longTokens).toBeGreaterThan(shortTokens);

    // Conservative estimate should be > chars/3 (overestimate by 4/3 factor)
    const charEstimate = Math.ceil(longMsg.content.length / 3);
    expect(longTokens).toBeGreaterThan(charEstimate);
  });

  it("total estimation across mixed messages", () => {
    const estimator = new TokenEstimator();

    const messages = [
      { role: "system" as const, content: "You are an assistant." },
      { role: "user" as const, content: "What is the capital of France?" },
      {
        role: "assistant" as const,
        content: "The capital of France is Paris.",
        toolCalls: [
          {
            function: {
              arguments: '{"query":"capital of France","limit":5}',
            },
          },
        ],
      },
      { role: "tool" as const, content: "Result: Paris is the capital..." },
      { role: "user" as const, content: "Thanks!" },
    ];

    const total = estimator.estimateMessages(messages);

    // Total should be greater than any individual message
    for (const msg of messages) {
      const individual = estimator.estimateMessage(msg);
      expect(total).toBeGreaterThanOrEqual(individual);
    }

    // Should be a reasonable positive number
    expect(total).toBeGreaterThan(0);
  });

  it("mixed API-reported and estimated messages", () => {
    const estimator = new TokenEstimator();

    const msg1 = {
      role: "user" as const,
      content: "First message content here.",
    };
    const msg2 = {
      role: "assistant" as const,
      content: "Second message response here.",
    };
    const msg3 = {
      role: "user" as const,
      content: "Third message question here.",
    };

    // Report API value for msg1 only
    const hash1 = `user|${msg1.content.slice(0, 100)}`;
    estimator.reportUsage(hash1, 8);

    const total = estimator.estimateMessages([msg1, msg2, msg3]);

    // msg1 should use API value (8)
    const msg1Tokens = estimator.estimateMessage(msg1);
    expect(msg1Tokens).toBe(8);

    // msg2 and msg3 use conservative estimation
    const msg2Tokens = estimator.estimateMessage(msg2);
    const msg3Tokens = estimator.estimateMessage(msg3);
    expect(msg2Tokens).toBeGreaterThan(0);
    expect(msg3Tokens).toBeGreaterThan(0);

    // Total should be sum of all three
    expect(total).toBe(msg1Tokens + msg2Tokens + msg3Tokens);
  });

  it("clear resets API-reported values", () => {
    const estimator = new TokenEstimator();

    const content = "Test message for clear operation.";
    const hash = `user|${content.slice(0, 100)}`;

    estimator.reportUsage(hash, 42);
    const before = estimator.estimateMessage({
      role: "user",
      content,
    });
    expect(before).toBe(42);

    estimator.clear();

    const after = estimator.estimateMessage({
      role: "user",
      content,
    });
    expect(after).not.toBe(42);
    expect(after).toBeGreaterThan(0);
  });

  it("tool calls add overhead to estimation", () => {
    const estimator = new TokenEstimator();

    const withoutTools = estimator.estimateMessage({
      role: "assistant",
      content: "Let me search for that.",
    });

    const withTools = estimator.estimateMessage({
      role: "assistant",
      content: "Let me search for that.",
      toolCalls: [
        {
          function: {
            arguments:
              '{"query":"test search query","filters":["recent","relevant"]}',
          },
        },
        {
          function: {
            arguments: '{"page":1,"limit":20}',
          },
        },
      ],
    });

    expect(withTools).toBeGreaterThan(withoutTools);
    // Additional overhead: 20 per tool call * 2 = 40 plus args estimation
    expect(withTools - withoutTools).toBeGreaterThan(30);
  });
});
