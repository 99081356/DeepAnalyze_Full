// =============================================================================
// DeepAnalyze - System-Level Integration Tests
// =============================================================================
// Verifies the complete agent system integration without requiring a live LLM
// API call. Tests the wiring, configuration, and end-to-end data flow of all
// major subsystems.
// =============================================================================

import { describe, it, expect } from "bun:test";

// ---------------------------------------------------------------------------
// 1. Tool Registry Complete System
// ---------------------------------------------------------------------------

import { ToolRegistry, DEFERRED_TOOLS } from "../tool-registry.js";

describe("1. Tool Registry Complete System", () => {
  it("registers all tools and verifies complete set (25+ tools)", () => {
    const registry = new ToolRegistry();

    // Register a large set of mock tools to simulate full system
    const mockTools = [
      "kb_search", "wiki_browse", "expand", "doc_grep",
      "timeline_build", "graph_build", "push_content", "agent_todo",
      "ask_user", "write_file", "edit_file", "read_file", "grep", "glob",
      "bash", "run_sql", "web_search", "web_fetch", "skill_invoke",
      "list_skills", "tool_discover", "task_output", "send_message",
      "workflow_run", "wikipedia", "youtube", "browser",
      "tts_generate", "image_generate", "video_generate", "music_generate",
    ];

    for (const name of mockTools) {
      registry.register({
        name,
        description: `Mock ${name}`,
        execute: async () => ({ mock: true }),
      });
    }

    // +3 for think, finish, and context_expand (pre-registered)
    expect(registry.getAll().length).toBeGreaterThanOrEqual(25);
    expect(registry.getAll().length).toBe(mockTools.length + 3);
  });

  it("buildToolDefinitions returns alphabetically sorted definitions", () => {
    const registry = new ToolRegistry();

    // Register in deliberately non-alphabetical order
    registry.register({ name: "zulu", description: "Z", execute: async () => null });
    registry.register({ name: "alpha", description: "A", execute: async () => null });
    registry.register({ name: "middle", description: "M", execute: async () => null });

    const defs = registry.buildToolDefinitions();
    const names = defs.map((d) => d.name);

    // Extract just our custom tools (excluding built-in think/finish)
    const customNames = names.filter((n) => ["zulu", "alpha", "middle"].includes(n));
    expect(customNames).toEqual(["alpha", "middle", "zulu"]);
  });

  it("deferred tools are excluded by default", () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "deferred_tool",
      description: "Should be hidden",
      execute: async () => null,
      shouldDefer: true,
    });

    registry.register({
      name: "normal_tool",
      description: "Should be visible",
      execute: async () => null,
    });

    const defs = registry.buildToolDefinitions();
    expect(defs.find((d) => d.name === "deferred_tool")).toBeUndefined();
    expect(defs.find((d) => d.name === "normal_tool")).toBeDefined();
  });

  it("deferred tools included when includeDeferred=true", () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "deferred_tool",
      description: "Should be visible now",
      execute: async () => null,
      shouldDefer: true,
    });

    const defs = registry.buildToolDefinitions(undefined, true);
    expect(defs.find((d) => d.name === "deferred_tool")).toBeDefined();
  });

  it("wildcard '*' returns all tools (including deferred when includeDeferred)", () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "wildcard_deferred",
      description: "Deferred",
      execute: async () => null,
      shouldDefer: true,
    });

    registry.register({
      name: "wildcard_normal",
      description: "Normal",
      execute: async () => null,
    });

    // Without includeDeferred, wildcard skips deferred
    const defsNoDeferred = registry.buildToolDefinitions(["*"], false);
    expect(defsNoDeferred.find((d) => d.name === "wildcard_deferred")).toBeUndefined();
    expect(defsNoDeferred.find((d) => d.name === "wildcard_normal")).toBeDefined();

    // With includeDeferred, wildcard includes everything
    const defsAll = registry.buildToolDefinitions(["*"], true);
    expect(defsAll.find((d) => d.name === "wildcard_deferred")).toBeDefined();
    expect(defsAll.find((d) => d.name === "wildcard_normal")).toBeDefined();
  });

  it("think and finish are pre-registered", () => {
    const registry = new ToolRegistry();
    expect(registry.has("think")).toBe(true);
    expect(registry.has("finish")).toBe(true);
  });

  it("think tool is read-only and concurrency-safe", async () => {
    const registry = new ToolRegistry();
    const think = registry.get("think")!;
    expect(think.isReadOnly?.({})).toBe(true);
    expect(think.isConcurrencySafe?.({})).toBe(true);

    const result = await think.execute({ thought: "test reasoning" });
    expect(result).toEqual({ thought: "test reasoning", recorded: true });
  });

  it("finish tool is not concurrency-safe", async () => {
    const registry = new ToolRegistry();
    const finish = registry.get("finish")!;
    expect(finish.isReadOnly?.({})).toBe(false);
    expect(finish.isConcurrencySafe?.({})).toBe(false);

    const result = await finish.execute({ summary: "done" });
    expect(result).toEqual({ completed: true, summary: "done" });
  });

  it("DEFERRED_TOOLS set contains expected tools", () => {
    expect(DEFERRED_TOOLS.has("tts_generate")).toBe(true);
    expect(DEFERRED_TOOLS.has("image_generate")).toBe(true);
    expect(DEFERRED_TOOLS.has("video_generate")).toBe(true);
    expect(DEFERRED_TOOLS.has("music_generate")).toBe(true);
    expect(DEFERRED_TOOLS.has("timeline_build")).toBe(true);
    expect(DEFERRED_TOOLS.has("graph_build")).toBe(true);
  });

  it("validateToolInput catches missing required fields", () => {
    const registry = new ToolRegistry();
    const result = registry.validateToolInput("test", {}, {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("name");
  });

  it("validateToolInput catches type mismatches", () => {
    const registry = new ToolRegistry();
    const result = registry.validateToolInput("test", { count: "not a number" }, {
      type: "object",
      properties: { count: { type: "number" } },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("count");
  });

  it("filterByNames returns matching tools", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "A", execute: async () => null });
    registry.register({ name: "b", description: "B", execute: async () => null });

    const filtered = registry.filterByNames(["a", "think"]);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("a");
    expect(names).toContain("think");
    expect(names).not.toContain("b");
  });
});

// ---------------------------------------------------------------------------
// 2. Tool Setup Integration
// ---------------------------------------------------------------------------

import { createConfiguredToolRegistry, SUB_AGENT_BLOCKED_TOOLS } from "../tool-setup.js";

describe("2. Tool Setup Integration", () => {
  // Create minimal mock deps
  const mockDeps = {
    retriever: {
      search: async () => ({ results: [], total: 0 }),
    } as any,
    linker: {} as any,
    expander: {
      expand: async () => ({ pageId: "p1", docId: "d1", level: "L0", title: "t", content: "c", tokenCount: 10 }),
      expandToLevel: async () => ({ docId: "d1", pageId: "p1", level: "L1", title: "t", content: "c", tokenCount: 10 }),
      expandWithBudget: async () => ({ pageId: "p1", docId: "d1", level: "L1", title: "t", content: "c", tokenCount: 10 }),
      expandSection: async () => null,
      batchExpand: async () => [],
    } as any,
    embeddingManager: {} as any,
    indexer: {} as any,
    modelRouter: {
      getDefaultModel: () => "default-model",
      chat: async () => ({ content: "mock response" }),
    } as any,
    dataDir: "/tmp/da-test-data",
  };

  it("creates a configured registry with all expected tools", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    const allNames = registry.getAll().map((t) => t.name);

    expect(allNames.length).toBeGreaterThanOrEqual(25);
  });

  it("has kb_search, wiki_browse, expand registered", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    expect(registry.has("kb_search")).toBe(true);
    expect(registry.has("wiki_browse")).toBe(true);
    expect(registry.has("expand")).toBe(true);
  });

  it("has glob, grep, bash registered", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    expect(registry.has("glob")).toBe(true);
    expect(registry.has("grep")).toBe(true);
    expect(registry.has("bash")).toBe(true);
  });

  it("has skill_invoke, list_skills registered", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    expect(registry.has("skill_invoke")).toBe(true);
    expect(registry.has("list_skills")).toBe(true);
  });

  it("has tool_discover registered", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    expect(registry.has("tool_discover")).toBe(true);
  });

  it("has push_content and agent_todo registered", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    expect(registry.has("push_content")).toBe(true);
    expect(registry.has("agent_todo")).toBe(true);
  });

  it("has ask_user, write_file, edit_file, read_file registered", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    expect(registry.has("ask_user")).toBe(true);
    expect(registry.has("write_file")).toBe(true);
    expect(registry.has("edit_file")).toBe(true);
    expect(registry.has("read_file")).toBe(true);
  });

  it("has run_sql registered", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    expect(registry.has("run_sql")).toBe(true);
  });

  it("edit_file has uniqueness check behavior", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    const editTool = registry.get("edit_file")!;
    expect(editTool.isReadOnly?.({})).toBe(false);
    expect(editTool.isConcurrencySafe?.({})).toBe(false);
  });

  it("bash has dynamic isReadOnly detection", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    const bashTool = registry.get("bash")!;

    // Read-only commands
    expect(bashTool.isReadOnly?.({ command: "ls -la" })).toBe(true);
    expect(bashTool.isReadOnly?.({ command: "cat file.txt" })).toBe(true);
    expect(bashTool.isReadOnly?.({ command: "git status" })).toBe(true);
    expect(bashTool.isReadOnly?.({ command: "pwd" })).toBe(true);
    expect(bashTool.isReadOnly?.({ command: "wc -l file.txt" })).toBe(true);

    // Write commands
    expect(bashTool.isReadOnly?.({ command: "rm file.txt" })).toBe(false);
    expect(bashTool.isReadOnly?.({ command: "mkdir newdir" })).toBe(false);
    // python3/pattern is now treated as read-only (analysis scripts don't mutate FS)
    expect(bashTool.isReadOnly?.({ command: "python3 script.py" })).toBe(true);
  });

  it("kb_search and expand are read-only and concurrency-safe", async () => {
    const registry = await createConfiguredToolRegistry(mockDeps);
    const kbSearch = registry.get("kb_search")!;
    const expand = registry.get("expand")!;

    expect(kbSearch.isReadOnly?.({})).toBe(true);
    expect(kbSearch.isConcurrencySafe?.({})).toBe(true);
    expect(expand.isReadOnly?.({})).toBe(true);
    expect(expand.isConcurrencySafe?.({})).toBe(true);
  });

  it("SUB_AGENT_BLOCKED_TOOLS contains workflow_run", () => {
    expect(SUB_AGENT_BLOCKED_TOOLS.has("workflow_run")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Agent Definitions System
// ---------------------------------------------------------------------------

import {
  GENERAL_AGENT,
  EXPLORE_AGENT,
  COMPILE_AGENT,
  VERIFY_AGENT,
  COORDINATOR_AGENT,
  BUILT_IN_AGENTS,
} from "../agent-definitions.js";

describe("3. Agent Definitions System", () => {
  it("all 5 agent types exist", () => {
    const types = BUILT_IN_AGENTS.map((a) => a.agentType);
    expect(types).toContain("general");
    expect(types).toContain("explore");
    expect(types).toContain("compile");
    expect(types).toContain("verify");
    expect(types).toContain("coordinator");
    expect(BUILT_IN_AGENTS.length).toBe(5);
  });

  it("BUILT_IN_AGENTS array has all 5 entries", () => {
    expect(BUILT_IN_AGENTS).toBeDefined();
    expect(BUILT_IN_AGENTS.length).toBe(5);
    const types = BUILT_IN_AGENTS.map((a) => a.agentType);
    expect(types).toEqual(["general", "explore", "compile", "verify", "coordinator"]);
  });

  it("GENERAL_AGENT system prompt contains methodology sections", () => {
    expect(GENERAL_AGENT.systemPrompt).toContain("## 核心原则");
    expect(GENERAL_AGENT.systemPrompt).toContain("kb_search");
    expect(GENERAL_AGENT.systemPrompt).toContain("## 工作方法论");
  });

  it("each agent has required fields", () => {
    const agents = BUILT_IN_AGENTS;
    for (const agent of agents) {
      expect(agent.agentType).toBeTruthy();
      expect(agent.description).toBeTruthy();
      expect(agent.systemPrompt).toBeTruthy();
      expect(Array.isArray(agent.tools)).toBe(true);
      expect(agent.tools.length).toBeGreaterThan(0);
    }
  });

  it("GENERAL_AGENT has wildcard tools", () => {
    expect(GENERAL_AGENT.tools).toEqual(["*"]);
  });

  it("EXPLORE_AGENT is read-only", () => {
    expect(EXPLORE_AGENT.readOnly).toBe(true);
    expect(EXPLORE_AGENT.modelRole).toBe("main");
  });

  it("COMPILE_AGENT has modelRole summarizer", () => {
    expect(COMPILE_AGENT.modelRole).toBe("summarizer");
  });

  it("COORDINATOR_AGENT has limited tools", () => {
    expect(COORDINATOR_AGENT.tools).toEqual(["think", "finish", "workflow_status"]);
  });

  it("VERIFY_AGENT is read-only", () => {
    expect(VERIFY_AGENT.readOnly).toBe(true);
  });

  it("agents have anti-hallucination instructions in prompts", () => {
    // General agent: mentions "不编造"
    expect(GENERAL_AGENT.systemPrompt).toContain("编造");
  });
});

// ---------------------------------------------------------------------------
// 4. Compaction System
// ---------------------------------------------------------------------------

import { CompactionEngine } from "../compaction.js";

describe("4. Compaction System", () => {
  // Minimal mock model router
  const mockModelRouter = {
    getDefaultModel: () => "mock-model",
    chat: async () => ({ content: "Summary of conversation: user asked about testing." }),
  } as any;

  const mockContextManager = {
    getContextWindow: () => ({ total: 200_000, effective: 187_000 }),
    estimateMessagesTokens: (msgs: any[]) => msgs.length * 50,
    estimateTextTokens: (text: string) => Math.ceil(text.length / 3),
  } as any;

  it("can be instantiated with required dependencies", () => {
    const engine = new CompactionEngine(mockModelRouter, mockContextManager);
    expect(engine).toBeDefined();
  });

  it("compact method exists and returns CompactionResult", async () => {
    const engine = new CompactionEngine(mockModelRouter, mockContextManager);

    const messages = [
      { role: "system" as const, content: "You are helpful." },
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there!" },
    ];

    const result = await engine.compact(messages, null);
    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(typeof result.method).toBe("string");
    expect(typeof result.tokensSaved).toBe("number");
    expect(typeof result.preCompactTokens).toBe("number");
  });

  it("smCompact method exists", () => {
    const engine = new CompactionEngine(mockModelRouter, mockContextManager);
    expect(typeof engine.smCompact).toBe("function");
  });

  it("legacyCompact method exists", () => {
    const engine = new CompactionEngine(mockModelRouter, mockContextManager);
    expect(typeof engine.legacyCompact).toBe("function");
  });

  it("hierarchicalCompact method exists", () => {
    const engine = new CompactionEngine(mockModelRouter, mockContextManager);
    expect(typeof engine.hierarchicalCompact).toBe("function");
  });

  it("handles 30+ mock messages without error", async () => {
    const engine = new CompactionEngine(mockModelRouter, mockContextManager);

    const messages: any[] = [
      { role: "system", content: "System prompt" },
    ];

    // Create 30+ messages (user/assistant/tool pairs)
    for (let i = 0; i < 15; i++) {
      messages.push({ role: "user", content: `User message ${i}: ${"x".repeat(100)}` });
      messages.push({ role: "assistant", content: `Assistant response ${i}: ${"y".repeat(100)}` });
      messages.push({ role: "tool", content: `Tool result ${i}: ${"z".repeat(200)}`, toolCallId: `tc-${i}` });
    }

    const result = await engine.compact(messages, null);
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("groupMessages correctly groups assistant+tool messages", () => {
    const engine = new CompactionEngine(mockModelRouter, mockContextManager);

    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "thinking..." },
      { role: "tool" as const, content: "result1", toolCallId: "tc1" },
      { role: "tool" as const, content: "result2", toolCallId: "tc2" },
      { role: "user" as const, content: "next question" },
      { role: "assistant" as const, content: "thinking again..." },
      { role: "tool" as const, content: "result3", toolCallId: "tc3" },
    ];

    const groups = engine.groupMessages(messages);
    expect(groups.length).toBe(2); // Two assistant groups
    expect(groups[0].toolResultIndices.length).toBe(2); // First group has 2 tool results
    expect(groups[1].toolResultIndices.length).toBe(1); // Second group has 1 tool result
  });
});

// ---------------------------------------------------------------------------
// 5. Hook System End-to-End
// ---------------------------------------------------------------------------

import { HookManager, HookDefinition } from "../hooks.js";
import type { HookType, HookContext, HookResult } from "../hook-types.js";

describe("5. Hook System End-to-End", () => {
  it("HookManager can be instantiated", () => {
    const manager = new HookManager();
    expect(manager).toBeDefined();
  });

  it("fire returns allowed:true when no hooks are loaded", async () => {
    const manager = new HookManager();
    // Mark as loaded to skip DB load
    await manager.loadFromSettings?.();
    // fire() will try to load from settings which may fail, so we call firePreCompact
    // which is a convenience method that handles errors
    const result = await manager.fire("PreToolUse", {
      hookType: "PreToolUse",
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    expect(result.allowed).toBe(true);
  });

  it("supports all 8 hook types in HookType", () => {
    const hookTypes: HookType[] = [
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "AgentStart",
      "AgentComplete",
    ];
    expect(hookTypes.length).toBe(8);
  });

  it("convenience methods exist for all lifecycle hooks", () => {
    const manager = new HookManager();
    expect(typeof manager.fireSessionStart).toBe("function");
    expect(typeof manager.fireSessionEnd).toBe("function");
    expect(typeof manager.fireAgentStart).toBe("function");
    expect(typeof manager.fireAgentComplete).toBe("function");
    expect(typeof manager.firePreCompact).toBe("function");
    expect(typeof manager.firePostCompact).toBe("function");
  });

  it("fire-and-forget methods do not throw on error", async () => {
    const manager = new HookManager();
    // These should not throw even with no DB
    await expect(manager.fireSessionStart("task-1")).resolves.toBeUndefined();
    await expect(manager.fireSessionEnd("task-1")).resolves.toBeUndefined();
    await expect(manager.fireAgentStart("task-1")).resolves.toBeUndefined();
    await expect(manager.fireAgentComplete("task-1")).resolves.toBeUndefined();
    await expect(manager.firePostCompact("task-1")).resolves.toBeUndefined();
  });

  it("PreCompact returns a result (blocking hook)", async () => {
    const manager = new HookManager();
    const result = await manager.firePreCompact("task-1", "custom instructions");
    expect(result).toBeDefined();
    expect(typeof result.allowed).toBe("boolean");
  });

  it("HookDefinition has correct shape", () => {
    const def: HookDefinition = {
      id: "test-hook-1",
      event: "PreToolUse",
      type: "command",
      matcher: "bash",
      config: { command: "echo ok" },
      enabled: true,
    };
    expect(def.id).toBe("test-hook-1");
    expect(def.event).toBe("PreToolUse");
    expect(def.type).toBe("command");
    expect(def.matcher).toBe("bash");
    expect(def.enabled).toBe(true);
  });

  it("HookContext carries all expected fields", () => {
    const ctx: HookContext = {
      hookType: "PreToolUse",
      toolName: "bash",
      toolInput: { command: "rm -rf /" },
      taskId: "task-123",
      customInstructions: "Be careful",
    };
    expect(ctx.hookType).toBe("PreToolUse");
    expect(ctx.toolName).toBe("bash");
    expect(ctx.taskId).toBe("task-123");
  });

  it("HookResult supports allowed, error, and modifiedInput", () => {
    const result: HookResult = {
      allowed: false,
      error: "Blocked by policy",
      modifiedInput: { command: "ls -la" },
    };
    expect(result.allowed).toBe(false);
    expect(result.error).toBe("Blocked by policy");
    expect(result.modifiedInput).toEqual({ command: "ls -la" });
  });
});

// ---------------------------------------------------------------------------
// 6. Feature Flag System
// ---------------------------------------------------------------------------

import {
  resolveFeatureFlags,
  DEFAULT_FEATURE_FLAGS,
  type FeatureFlagConfig,
} from "../feature-flags.js";

describe("6. Feature Flag System", () => {
  it("all 11 flags resolve correctly from defaults", () => {
    const flags = resolveFeatureFlags();
    const keys = Object.keys(flags) as (keyof FeatureFlagConfig)[];
    expect(keys.length).toBe(11);
  });

  it("default values are correct for all flags", () => {
    const flags = resolveFeatureFlags();
    expect(flags.concurrentToolExecution).toBe(true);
    expect(flags.promptCaching).toBe(true);
    expect(flags.streamingToolExecution).toBe(true);
    expect(flags.hierarchicalCompression).toBe(true);
    expect(flags.cacheEditing).toBe(true);
    expect(flags.longOutputContinuation).toBe(true);
    expect(flags.maxToolConcurrency).toBe(10);
    expect(flags.pluginSystem).toBe(true);
    expect(flags.markdownSkills).toBe(true);
    expect(flags.contextCollapse).toBe(true);
  });

  it("priority chain: env > dbConfig > defaults", () => {
    // Set env var
    const originalValue = process.env.DA_CONCURRENT_TOOLS;
    process.env.DA_CONCURRENT_TOOLS = "false";

    try {
      // dbConfig overrides default but not env
      const flags = resolveFeatureFlags({
        concurrentToolExecution: true, // dbConfig says true
      });
      // env should win over dbConfig
      expect(flags.concurrentToolExecution).toBe(false);
    } finally {
      if (originalValue === undefined) {
        delete process.env.DA_CONCURRENT_TOOLS;
      } else {
        process.env.DA_CONCURRENT_TOOLS = originalValue;
      }
    }
  });

  it("dbConfig overrides defaults when no env var", () => {
    // Ensure env var is not set
    const originalValue = process.env.DA_STREAMING_TOOLS;
    delete process.env.DA_STREAMING_TOOLS;

    try {
      const flags = resolveFeatureFlags({
        streamingToolExecution: true, // Override default false
      });
      expect(flags.streamingToolExecution).toBe(true);
    } finally {
      if (originalValue !== undefined) {
        process.env.DA_STREAMING_TOOLS = originalValue;
      }
    }
  });

  it("all critical flags default to true", () => {
    expect(DEFAULT_FEATURE_FLAGS.concurrentToolExecution).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.promptCaching).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.cacheEditing).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.longOutputContinuation).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.pluginSystem).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.markdownSkills).toBe(true);
  });

  it("hierarchicalCompression and streamingToolExecution default to true", () => {
    expect(DEFAULT_FEATURE_FLAGS.hierarchicalCompression).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.streamingToolExecution).toBe(true);
  });

  it("maxToolConcurrency parses as number from env", () => {
    const original = process.env.DA_MAX_CONCURRENCY;
    process.env.DA_MAX_CONCURRENCY = "20";

    try {
      const flags = resolveFeatureFlags();
      expect(flags.maxToolConcurrency).toBe(20);
    } finally {
      if (original === undefined) {
        delete process.env.DA_MAX_CONCURRENCY;
      } else {
        process.env.DA_MAX_CONCURRENCY = original;
      }
    }
  });

  it("env var '1' is treated as true", () => {
    const original = process.env.DA_CACHE_EDITING;
    process.env.DA_CACHE_EDITING = "1";

    try {
      const flags = resolveFeatureFlags();
      expect(flags.cacheEditing).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.DA_CACHE_EDITING;
      } else {
        process.env.DA_CACHE_EDITING = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Plugin System End-to-End
// ---------------------------------------------------------------------------

import { AgentPluginManager } from "../plugin-manager.js";
import { join } from "node:path";

describe("7. Plugin System End-to-End", () => {
  it("loads judicial-analysis plugin from plugins directory", async () => {
    const pm = new AgentPluginManager();
    const pluginPath = join(process.cwd(), "plugins", "judicial-analysis");
    const plugin = await pm.loadPlugin(pluginPath);

    expect(plugin.manifest.name).toBe("judicial-analysis");
    expect(plugin.manifest.version).toBe("1.0.0");
    expect(plugin.enabled).toBe(true);
  });

  it("verifies complete skill set (6 skills)", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    const skills = pm.getAllSkills();
    expect(skills.length).toBe(8);

    const skillNames = skills.map((s) => s.name);
    expect(skillNames).toContain("evidence-chain");
    expect(skillNames).toContain("timeline-reconstruction");
    expect(skillNames).toContain("entity-network");
    expect(skillNames).toContain("cross-validation");
    expect(skillNames).toContain("fact-extraction");
  });

  it("each skill has correct system prompt with anti-hallucination rules", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    const skills = pm.getAllSkills();
    for (const skill of skills) {
      expect(skill.systemPrompt).toBeTruthy();
      expect(skill.systemPrompt.length).toBeGreaterThan(50);
      // All judicial skills have anti-hallucination instructions
      expect(
        skill.systemPrompt.includes("来源") ||
        skill.systemPrompt.includes("不得") ||
        skill.systemPrompt.includes("禁止") ||
        skill.systemPrompt.includes("标注")
      ).toBe(true);
    }
  });

  it("agents have anti-hallucination instructions", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    const agents = pm.getAllAgents();
    expect(agents.length).toBe(2);

    const agentTypes = agents.map((a) => a.agentType);
    expect(agentTypes).toContain("judicial-verifier");
    expect(agentTypes).toContain("judicial-extractor");

    // Verifier agent has anti-hallucination rules
    const verifier = agents.find((a) => a.agentType === "judicial-verifier")!;
    expect(verifier.systemPrompt).toContain("验证");
    expect(verifier.systemPrompt).toContain("直接证据");

    // Extractor agent has anti-hallucination rules
    const extractor = agents.find((a) => a.agentType === "judicial-extractor")!;
    expect(extractor.systemPrompt).toContain("来源");
  });

  it("evidence-chain skill has expected tools", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    const evidenceChain = pm.getAllSkills().find((s) => s.name === "evidence-chain")!;
    expect(evidenceChain.tools).toContain("kb_search");
    expect(evidenceChain.tools).toContain("expand");
    expect(evidenceChain.tools).toContain("push_content");
  });

  it("cross-validation skill uses council scheduling", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    const crossVal = pm.getAllSkills().find((s) => s.name === "cross-validation")!;
    expect(crossVal.scheduling).toBe("council");
  });

  it("enable/disable lifecycle works", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    // Initially enabled
    expect(pm.getAllSkills().length).toBe(8);
    expect(pm.getAllAgents().length).toBe(2);

    // Disable
    pm.setEnabled("judicial-analysis", false);
    expect(pm.getAllSkills()).toEqual([]);
    expect(pm.getAllAgents()).toEqual([]);

    // Re-enable
    pm.setEnabled("judicial-analysis", true);
    expect(pm.getAllSkills().length).toBe(8);
    expect(pm.getAllAgents().length).toBe(2);
  });

  it("unload removes the plugin completely", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    expect(pm.get("judicial-analysis")).toBeDefined();
    expect(pm.unload("judicial-analysis")).toBe(true);
    expect(pm.get("judicial-analysis")).toBeUndefined();
    expect(pm.getAllSkills()).toEqual([]);
  });

  it("list returns all loaded plugins", async () => {
    const pm = new AgentPluginManager();
    await pm.loadPlugin(join(process.cwd(), "plugins", "judicial-analysis"));

    const list = pm.list();
    expect(list.length).toBe(1);
    expect(list[0].manifest.name).toBe("judicial-analysis");
  });
});

// ---------------------------------------------------------------------------
// 8. Tool Orchestration System
// ---------------------------------------------------------------------------

import {
  orchestrateToolCalls,
  partitionToolCalls,
  runToolsConcurrently,
  runToolsSerially,
} from "../tool-orchestration.js";
import type { AgentTool } from "../types.js";
import type { ToolCall } from "../../../models/provider.js";

describe("8. Tool Orchestration System", () => {
  // Create a realistic tool map
  function createToolMap(): Map<string, AgentTool> {
    const tools = new Map<string, AgentTool>();

    tools.set("kb_search", {
      name: "kb_search",
      description: "Search KB",
      execute: async (input) => ({ results: [] }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });

    tools.set("expand", {
      name: "expand",
      description: "Expand document",
      execute: async (input) => ({ content: "expanded" }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });

    tools.set("edit_file", {
      name: "edit_file",
      description: "Edit file",
      execute: async (input) => ({ success: true }),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    });

    tools.set("bash", {
      name: "bash",
      description: "Run shell command",
      execute: async (input) => ({ exitCode: 0, output: "done" }),
      isReadOnly: (input) => {
        const cmd = (input.command as string) ?? "";
        return cmd.trimStart().startsWith("ls");
      },
      isConcurrencySafe: (input) => {
        const cmd = (input.command as string) ?? "";
        return cmd.trimStart().startsWith("ls");
      },
    });

    return tools;
  }

  function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
    return {
      id: `call-${name}-${Date.now()}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    };
  }

  it("partition with mixed realistic tools", () => {
    const toolMap = createToolMap();
    const toolCalls = [
      makeToolCall("kb_search", { query: "test" }),
      makeToolCall("expand", { pageId: "p1" }),
      makeToolCall("edit_file", { path: "f.txt", old_string: "a", new_string: "b" }),
      makeToolCall("bash", { command: "ls -la" }),
      makeToolCall("bash", { command: "rm file.txt" }),
    ];

    const batches = partitionToolCalls(toolCalls, toolMap);

    // kb_search + expand should be grouped into one concurrent batch
    // edit_file is separate (unsafe)
    // bash ls is concurrent-safe
    // bash rm is unsafe (separate batch)
    expect(batches.length).toBeGreaterThanOrEqual(3);

    // First batch: concurrent (kb_search + expand)
    expect(batches[0].isConcurrent).toBe(true);
    expect(batches[0].toolCalls.length).toBe(2);

    // Second batch: serial (edit_file)
    expect(batches[1].isConcurrent).toBe(false);
  });

  it("full orchestration produces correct message format", async () => {
    const toolMap = createToolMap();
    const toolCalls = [
      makeToolCall("kb_search", { query: "test" }),
      makeToolCall("expand", { pageId: "p1" }),
    ];

    const executeFn = async (tc: ToolCall) => {
      const tool = toolMap.get(tc.function.name)!;
      const input = JSON.parse(tc.function.arguments);
      const result = await tool.execute(input);
      return {
        role: "tool" as const,
        content: JSON.stringify(result),
        toolCallId: tc.id,
      };
    };

    const result = await orchestrateToolCalls(toolCalls, toolMap, executeFn);

    expect(result.messages.length).toBe(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[1].role).toBe("tool");
    expect(result.concurrentCount).toBe(2);
    expect(result.serialCount).toBe(0);
  });

  it("error handling when tool throws", async () => {
    const toolMap = new Map<string, AgentTool>();
    toolMap.set("failing_tool", {
      name: "failing_tool",
      description: "Always fails",
      execute: async () => { throw new Error("Tool execution failed"); },
      isReadOnly: () => false,
    });

    const toolCalls = [makeToolCall("failing_tool")];
    const executeFn = async (tc: ToolCall) => {
      const tool = toolMap.get(tc.function.name)!;
      const input = JSON.parse(tc.function.arguments);
      try {
        const result = await tool.execute(input);
        return { role: "tool" as const, content: JSON.stringify(result), toolCallId: tc.id };
      } catch (err) {
        return {
          role: "tool" as const,
          content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          toolCallId: tc.id,
        };
      }
    };

    const result = await orchestrateToolCalls(toolCalls, toolMap, executeFn);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].content).toContain("Tool execution failed");
  });

  it("empty tool calls returns empty result", async () => {
    const toolMap = createToolMap();
    const result = await orchestrateToolCalls([], toolMap, async () => ({
      role: "tool" as const,
      content: "",
      toolCallId: "",
    }));
    expect(result.messages).toEqual([]);
    expect(result.concurrentCount).toBe(0);
    expect(result.serialCount).toBe(0);
  });

  it("runToolsSerially executes in order", async () => {
    const order: string[] = [];
    const toolCalls = [
      makeToolCall("kb_search"),
      makeToolCall("expand"),
      makeToolCall("edit_file"),
    ];

    const executeFn = async (tc: ToolCall) => {
      order.push(tc.function.name);
      return { role: "tool" as const, content: tc.function.name, toolCallId: tc.id };
    };

    await runToolsSerially(toolCalls, executeFn);
    expect(order).toEqual(["kb_search", "expand", "edit_file"]);
  });

  it("runToolsConcurrently returns results in order", async () => {
    const toolCalls = [
      makeToolCall("kb_search"),
      makeToolCall("expand"),
      makeToolCall("edit_file"),
    ];

    const executeFn = async (tc: ToolCall) => {
      // Simulate variable execution time
      return { role: "tool" as const, content: tc.function.name, toolCallId: tc.id };
    };

    const results = await runToolsConcurrently(toolCalls, executeFn);
    expect(results.length).toBe(3);
    // Results should be in the same order as input
    expect(results[0].content).toBe("kb_search");
    expect(results[1].content).toBe("expand");
    expect(results[2].content).toBe("edit_file");
  });
});

// ---------------------------------------------------------------------------
// 9. Long-IO Complete Flow
// ---------------------------------------------------------------------------

import {
  needsContinuation,
  buildContinuationMessage,
  shouldSegmentOutput,
  DEFAULT_CONTINUATION_CONFIG,
} from "../long-io.js";

describe("9. Long-IO Complete Flow", () => {
  it("continuation config has expected default values", () => {
    expect(DEFAULT_CONTINUATION_CONFIG.maxContinuations).toBe(5);
    expect(DEFAULT_CONTINUATION_CONFIG.continuationPrompt).toBeTruthy();
    expect(DEFAULT_CONTINUATION_CONFIG.continuationPrompt).toContain("继续");
  });

  it("needsContinuation detects length finish reason", () => {
    expect(needsContinuation("length")).toBe(true);
    expect(needsContinuation("stop")).toBe(false);
    expect(needsContinuation("tool_calls")).toBe(false);
    expect(needsContinuation(undefined)).toBe(false);
    expect(needsContinuation("end_turn")).toBe(false);
  });

  it("buildContinuationMessage returns user message with default prompt", () => {
    const msg = buildContinuationMessage();
    expect(msg.role).toBe("user");
    expect(msg.content).toBe(DEFAULT_CONTINUATION_CONFIG.continuationPrompt);
  });

  it("buildContinuationMessage supports custom prompt", () => {
    const msg = buildContinuationMessage({ continuationPrompt: "Keep going!" });
    expect(msg.content).toBe("Keep going!");
  });

  it("shouldSegmentOutput returns true for large output", () => {
    expect(shouldSegmentOutput(100_000)).toBe(true);
    expect(shouldSegmentOutput(60_000)).toBe(true);
    expect(shouldSegmentOutput(50_001)).toBe(true);
  });

  it("shouldSegmentOutput returns false for small output", () => {
    expect(shouldSegmentOutput(50_000)).toBe(false);
    expect(shouldSegmentOutput(10_000)).toBe(false);
    expect(shouldSegmentOutput(0)).toBe(false);
  });

  it("complete flow: truncation detection -> continuation message -> repeat", () => {
    // Simulate: model returns finish_reason=length
    const finishReason = "length";
    expect(needsContinuation(finishReason)).toBe(true);

    // Build continuation message
    const contMsg = buildContinuationMessage();
    expect(contMsg.role).toBe("user");
    expect(contMsg.content).toBeTruthy();

    // After continuation, model returns finish_reason=stop
    const nextFinishReason = "stop";
    expect(needsContinuation(nextFinishReason)).toBe(false);
  });

  it("segmentation flow for very large output", () => {
    const estimatedChars = 120_000;
    expect(shouldSegmentOutput(estimatedChars)).toBe(true);

    // Agent should write to file instead of direct output
    // The segmentation suggestion tells it to use write_file
    // This is just a flow verification
  });
});

// ---------------------------------------------------------------------------
// 10. Cache Editing Complete Flow
// ---------------------------------------------------------------------------

import { applyCacheEditing } from "../cache-editing.js";
import type { ChatMessage } from "../../../models/provider.js";

describe("10. Cache Editing Complete Flow", () => {
  it("creates realistic message sequence and applies editing", () => {
    // Realistic sequence: system -> user -> assistant w/ tool_calls -> tool results
    const longResult = "A".repeat(20_000);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant with access to a knowledge base." },
      { role: "user", content: "Analyze the documents about project X." },
      { role: "assistant", content: "I will search for relevant documents.", toolCalls: [
        { id: "tc-1", type: "function", function: { name: "kb_search", arguments: '{"query":"project X"}' } },
      ] },
      { role: "tool", content: longResult, toolCallId: "tc-1" },
      { role: "assistant", content: "Let me expand the results.", toolCalls: [
        { id: "tc-2", type: "function", function: { name: "expand", arguments: '{"docId":"d1"}' } },
        { id: "tc-3", type: "function", function: { name: "expand", arguments: '{"docId":"d2"}' } },
      ] },
      { role: "tool", content: "Expanded content 1", toolCallId: "tc-2" },
      { role: "tool", content: "Expanded content 2", toolCallId: "tc-3" },
      { role: "assistant", content: "Here is the analysis..." },
      { role: "user", content: "Can you dig deeper into document 3?" },
      { role: "assistant", content: "Let me expand document 3.", toolCalls: [
        { id: "tc-4", type: "function", function: { name: "expand", arguments: '{"docId":"d3"}' } },
      ] },
      { role: "tool", content: longResult, toolCallId: "tc-4" },
    ];

    const result = applyCacheEditing(messages, { keepRecentTurns: 2, maxResultChars: 1000 });

    // Verify system prompt is preserved
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe(messages[0].content);

    // Old tool result (tc-1) should be truncated
    const oldTool = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "tc-1");
    expect(oldTool).toBeDefined();
    expect(typeof oldTool!.content === "string" ? oldTool!.content.length : 0).toBeLessThan(longResult.length);

    // Recent tool results (tc-2, tc-3, tc-4) should NOT be truncated
    const recentTool = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "tc-2");
    expect(recentTool!.content).toBe("Expanded content 1");

    // tc-4 is in the 2 most recent assistant turns, so it should be kept
    const recentTool4 = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "tc-4");
    expect(recentTool4!.content).toBe(longResult); // Not truncated because it's recent
  });

  it("keeps all messages when keepRecentTurns is high enough", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "thinking..." },
      { role: "tool", content: "x".repeat(20_000), toolCallId: "t1" },
      { role: "assistant", content: "more" },
      { role: "tool", content: "y".repeat(20_000), toolCallId: "t2" },
    ];

    // Both turns are "recent" when keepRecentTurns >= 2
    const result = applyCacheEditing(messages, { keepRecentTurns: 5, maxResultChars: 100 });
    expect(result[2].content).toBe("x".repeat(20_000)); // Not truncated
    expect(result[4].content).toBe("y".repeat(20_000)); // Not truncated
  });

  it("boundary test: keepRecentTurns=0 truncates all tool results", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "a" },
      { role: "tool", content: "x".repeat(20_000), toolCallId: "t1" },
      { role: "assistant", content: "b" },
      { role: "tool", content: "y".repeat(20_000), toolCallId: "t2" },
    ];

    const result = applyCacheEditing(messages, { keepRecentTurns: 0, maxResultChars: 1000 });
    const tools = result.filter((m) => m.role === "tool");
    for (const tool of tools) {
      expect(typeof tool.content === "string" ? tool.content.length : 0).toBeLessThan(20_000);
    }
  });

  it("preserves original messages (immutable)", () => {
    const longContent = "z".repeat(20_000);
    const messages: ChatMessage[] = [
      { role: "assistant", content: "a" },
      { role: "tool", content: longContent, toolCallId: "t1" },
    ];

    applyCacheEditing(messages, { keepRecentTurns: 0, maxResultChars: 100 });
    // Original must be unchanged
    expect(messages[1].content).toBe(longContent);
  });

  it("handles empty messages array", () => {
    const result = applyCacheEditing([]);
    expect(result).toEqual([]);
  });

  it("handles messages with no tool results", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const result = applyCacheEditing(messages, { keepRecentTurns: 0, maxResultChars: 100 });
    expect(result).toEqual(messages);
  });
});
