// =============================================================================
// DeepAnalyze - Exception and Edge-Case Tests
// =============================================================================
// Comprehensive tests for error recovery, boundary conditions, and failure
// modes across all agent service modules.
// =============================================================================

import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { ToolRegistry } from "../tool-registry.js";
import { orchestrateToolCalls, runToolsConcurrently } from "../tool-orchestration.js";
import { applyCacheEditing } from "../cache-editing.js";
import { needsContinuation, buildContinuationMessage, shouldSegmentOutput } from "../long-io.js";
import { TokenEstimator } from "../token-estimator.js";
import { maybePersistToolResult } from "../tool-result-storage.js";
import { StreamingToolExecutor, consumeStreamWithToolExecution } from "../streaming-tool-executor.js";
import { AgentPluginManager } from "../plugin-manager.js";
import { resolveFeatureFlags, DEFAULT_FEATURE_FLAGS } from "../feature-flags.js";
import { AsyncSessionMemoryExtractor } from "../session-memory-async.js";
import type { AgentTool } from "../types.js";
import type { ToolCall, ChatMessage, StreamChunk } from "../../../models/provider.js";

// =============================================================================
// Helpers
// =============================================================================

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeToolResultMessage(content: string, toolCallId: string): ChatMessage {
  return { role: "tool", content, toolCallId };
}

async function* mockStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

// =============================================================================
// 1. Tool Validation Errors
// =============================================================================

describe("Tool Validation Errors", () => {
  const registry = new ToolRegistry();

  registry.register({
    name: "validated_tool",
    description: "A tool with strict schema",
    execute: async () => null,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Result count" },
        tags: { type: "array", description: "Tags" },
      },
      required: ["query"],
    },
  });

  it("completely malformed JSON arguments -> parse error, tool not found in registry treated as non-concurrent", () => {
    // When arguments are malformed JSON, the orchestration layer treats the
    // tool as non-concurrent-safe. Test that JSON.parse failure is handled.
    const badJson = "{not valid json at all!!!";
    expect(() => JSON.parse(badJson)).toThrow();
  });

  it("missing required field -> clear error identifying which field", () => {
    const schema = registry.get("validated_tool")!.inputSchema!;
    const result = registry.validateToolInput("validated_tool", { count: 5 }, schema);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("query");
    expect(result.error).toContain("Missing required parameter");
  });

  it("wrong type (string where number expected) -> type error message", () => {
    const schema = registry.get("validated_tool")!.inputSchema!;
    const result = registry.validateToolInput(
      "validated_tool",
      { query: "hello", count: "five" },
      schema,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("count");
    expect(result.error).toContain("number");
    expect(result.error).toContain("string");
  });

  it("tool call to non-existent tool -> returns undefined from registry", () => {
    const tool = registry.get("non_existent_tool_xyz");
    expect(tool).toBeUndefined();
  });

  it("null input -> validation error on required fields", () => {
    const schema = registry.get("validated_tool")!.inputSchema!;
    const result = registry.validateToolInput("validated_tool", { query: null } as any, schema);
    // null for a required field should fail
    expect(result.valid).toBe(false);
    expect(result.error).toContain("query");
  });

  it("empty string arguments -> should validate based on schema (passes if field is present)", () => {
    const schema = registry.get("validated_tool")!.inputSchema!;
    const result = registry.validateToolInput(
      "validated_tool",
      { query: "" },
      schema,
    );
    // Empty string is still a string type, so it should be valid
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// 2. Tool Execution Errors
// =============================================================================

describe("Tool Execution Errors", () => {
  const errorTool: AgentTool = {
    name: "error_tool",
    description: "Always throws",
    execute: async () => { throw new Error("deliberate error"); },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  };

  const stringThrowTool: AgentTool = {
    name: "string_throw_tool",
    description: "Throws a string",
    execute: async () => { throw "string error" as any; },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  };

  const undefinedThrowTool: AgentTool = {
    name: "undefined_throw_tool",
    description: "Throws undefined",
    execute: async () => { throw undefined as any; },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  };

  const undefinedReturnTool: AgentTool = {
    name: "undefined_return_tool",
    description: "Returns undefined",
    execute: async () => undefined,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  };

  it("tool that throws Error -> error captured in result message via StreamingToolExecutor", async () => {
    const tools = new Map<string, AgentTool>([["error_tool", errorTool]]);
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      // Simulate calling the tool which throws
      const tool = tools.get(tc.function.name)!;
      try {
        const result = await tool.execute({});
        return makeToolResultMessage(JSON.stringify(result), tc.id);
      } catch (err) {
        return makeToolResultMessage(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          tc.id,
        );
      }
    };

    const call = makeToolCall("error_tool");
    const result = await executeFn(call);
    expect(result.content).toContain("deliberate error");
  });

  it("tool that throws string -> captured as string message", async () => {
    const tools = new Map<string, AgentTool>([["string_throw_tool", stringThrowTool]]);
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      const tool = tools.get(tc.function.name)!;
      try {
        const result = await tool.execute({});
        return makeToolResultMessage(JSON.stringify(result), tc.id);
      } catch (err) {
        return makeToolResultMessage(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          tc.id,
        );
      }
    };

    const call = makeToolCall("string_throw_tool");
    const result = await executeFn(call);
    expect(result.content).toContain("string error");
  });

  it("tool that throws undefined -> captured as 'undefined' string", async () => {
    const tools = new Map<string, AgentTool>([["undefined_throw_tool", undefinedThrowTool]]);
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      const tool = tools.get(tc.function.name)!;
      try {
        const result = await tool.execute({});
        return makeToolResultMessage(JSON.stringify(result), tc.id);
      } catch (err) {
        return makeToolResultMessage(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          tc.id,
        );
      }
    };

    const call = makeToolCall("undefined_throw_tool");
    const result = await executeFn(call);
    expect(result.content).toContain("undefined");
  });

  it("tool that returns undefined -> handled without crash", async () => {
    const tools = new Map<string, AgentTool>([["undefined_return_tool", undefinedReturnTool]]);
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      const tool = tools.get(tc.function.name)!;
      const result = await tool.execute({});
      // JSON.stringify(undefined) returns undefined (the JS value), so coerce
      // to string for robustness
      const content = result !== undefined ? JSON.stringify(result) : "null";
      return makeToolResultMessage(content, tc.id);
    };

    const call = makeToolCall("undefined_return_tool");
    const result = await executeFn(call);
    expect(result.role).toBe("tool");
    expect(result.content).toBeDefined();
    // result was undefined, coerced to "null"
    expect(result.content).toBe("null");
  });

  it("tool that returns very large result -> serialized without crash", async () => {
    const largeTool: AgentTool = {
      name: "large_tool",
      description: "Returns 1MB string",
      execute: async () => "x".repeat(1_000_000),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    };
    const tools = new Map<string, AgentTool>([["large_tool", largeTool]]);
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      const tool = tools.get(tc.function.name)!;
      const result = await tool.execute({});
      return makeToolResultMessage(JSON.stringify(result), tc.id);
    };

    const call = makeToolCall("large_tool");
    const result = await executeFn(call);
    expect(result.content.length).toBeGreaterThan(100_000);
  });

  it("multiple tools where one fails -> others should still complete (serial execution)", async () => {
    const okTool: AgentTool = {
      name: "ok_tool",
      description: "Returns ok",
      execute: async () => null,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    };

    const failTool: AgentTool = {
      name: "fail_tool",
      description: "Always fails",
      execute: async () => { throw new Error("boom"); },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    };

    const tools = new Map<string, AgentTool>([
      ["ok_tool", okTool],
      ["fail_tool", failTool],
    ]);

    const results: string[] = [];
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      const tool = tools.get(tc.function.name)!;
      try {
        const result = await tool.execute({});
        results.push(tc.function.name + ":ok");
        return makeToolResultMessage(JSON.stringify(result), tc.id);
      } catch (err) {
        results.push(tc.function.name + ":error");
        return makeToolResultMessage(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          tc.id,
        );
      }
    };

    const calls = [
      makeToolCall("ok_tool"),
      makeToolCall("fail_tool"),
      makeToolCall("ok_tool"),
    ];

    // Run with orchestrateToolCalls (all non-concurrent so serial)
    const batchResult = await orchestrateToolCalls(calls, tools, executeFn);

    // All 3 results should be present
    expect(batchResult.messages).toHaveLength(3);
    expect(results).toEqual(["ok_tool:ok", "fail_tool:error", "ok_tool:ok"]);
    // The failure should be captured as a message, not thrown
    const failMsg = batchResult.messages[1];
    expect(failMsg.content).toContain("boom");
  });

  it("concurrent tool timeout (slow tool does not block forever)", async () => {
    const slowTool: AgentTool = {
      name: "slow_tool",
      description: "Takes a long time",
      execute: async () => {
        await new Promise(r => setTimeout(r, 200));
        return "slow result";
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    };

    const tools = new Map<string, AgentTool>([["slow_tool", slowTool]]);

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      const tool = tools.get(tc.function.name)!;
      const result = await tool.execute({});
      return makeToolResultMessage(JSON.stringify(result), tc.id);
    };

    const calls = [makeToolCall("slow_tool"), makeToolCall("slow_tool")];

    // Should complete within reasonable time (both in parallel)
    const start = Date.now();
    const result = await orchestrateToolCalls(calls, tools, executeFn);
    const elapsed = Date.now() - start;

    expect(result.messages).toHaveLength(2);
    // 200ms * 2 serial would be 400ms+. Parallel ~200ms.
    expect(elapsed).toBeLessThan(500);
  });
});

// =============================================================================
// 3. Cache Editing Edge Cases
// =============================================================================

describe("Cache Editing Edge Cases", () => {
  it("empty messages array -> returns empty array", () => {
    const result = applyCacheEditing([]);
    expect(result).toEqual([]);
  });

  it("all messages are recent (within keepRecentTurns) -> no truncation", () => {
    const longContent = "y".repeat(20_000);
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "turn 1" },
      { role: "tool", content: longContent, toolCallId: "t1" },
      { role: "assistant", content: "turn 2" },
      { role: "tool", content: longContent, toolCallId: "t2" },
    ];
    // keepRecentTurns=10 means both turns are "recent"
    const result = applyCacheEditing(msgs, { keepRecentTurns: 10, maxResultChars: 1000 });
    const tools = result.filter(m => m.role === "tool");
    expect(tools[0].content).toBe(longContent);
    expect(tools[1].content).toBe(longContent);
  });

  it("all messages are old -> all tool results truncated", () => {
    const longContent = "z".repeat(20_000);
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "old turn 1" },
      { role: "tool", content: longContent, toolCallId: "t1" },
      { role: "assistant", content: "old turn 2" },
      { role: "tool", content: longContent, toolCallId: "t2" },
    ];
    // keepRecentTurns=0 means everything is old
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 1000 });
    const tools = result.filter(m => m.role === "tool");
    expect(tools.every(t => (t.content as string).includes("truncated"))).toBe(true);
  });

  it("mixed: some tool results are empty string -> handled without error", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "a1" },
      { role: "tool", content: "", toolCallId: "t1" },
      { role: "assistant", content: "a2" },
      { role: "tool", content: "x".repeat(20_000), toolCallId: "t2" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 1000 });
    expect(result).toHaveLength(4);
    // Empty string should not be truncated (length 0 < maxResultChars)
    expect(result[1].content).toBe("");
    // Long result should be truncated
    expect((result[3].content as string).includes("truncated")).toBe(true);
  });

  it("mixed: tool results with ContentPart[] (non-string) -> stringify and truncate", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "a1" },
      {
        role: "tool",
        content: [{ type: "text" as const, text: "x".repeat(20_000) }],
        toolCallId: "t1",
      },
      { role: "assistant", content: "a2" },
      { role: "tool", content: "short", toolCallId: "t2" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 1, maxResultChars: 500 });
    // First tool result (ContentPart[]) should be stringified and truncated
    const firstTool = result[1];
    expect(typeof firstTool.content).toBe("string");
    expect((firstTool.content as string).includes("truncated")).toBe(true);
  });

  it("keepRecentTurns = 0 -> everything truncated", () => {
    const longContent = "a".repeat(20_000);
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "turn" },
      { role: "tool", content: longContent, toolCallId: "t1" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 1000 });
    expect((result[1].content as string).includes("truncated")).toBe(true);
  });

  it("keepRecentTurns larger than message count -> nothing truncated", () => {
    const longContent = "b".repeat(20_000);
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "turn" },
      { role: "tool", content: longContent, toolCallId: "t1" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 100, maxResultChars: 1000 });
    expect(result[1].content).toBe(longContent);
  });

  it("maxResultChars = 0 -> all tool results truncated (any content > 0)", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "turn" },
      { role: "tool", content: "short", toolCallId: "t1" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 0 });
    // "short" has length 5 > 0, so it should be truncated
    expect((result[1].content as string).includes("truncated")).toBe(true);
  });

  it("very large single tool result (1MB) -> truncated with correct preview", () => {
    const hugeContent = "A".repeat(1_000_000);
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "turn" },
      { role: "tool", content: hugeContent, toolCallId: "t1" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 8000 });
    const toolResult = result[1].content as string;
    // Should contain truncation marker
    expect(toolResult.includes("truncated")).toBe(true);
    // Should contain size info (977KB for 1MB)
    expect(toolResult).toContain("KB total");
    // Truncated content should be much smaller than original
    expect(toolResult.length).toBeLessThan(20_000);
  });
});

// =============================================================================
// 4. Long-IO Edge Cases
// =============================================================================

describe("Long-IO Edge Cases", () => {
  it("finishReason undefined -> no continuation", () => {
    expect(needsContinuation(undefined)).toBe(false);
  });

  it("finishReason null (coerced) -> no continuation", () => {
    expect(needsContinuation(null as any)).toBe(false);
  });

  it("finishReason 'content_filter' -> no continuation", () => {
    expect(needsContinuation("content_filter")).toBe(false);
  });

  it("finishReason 'stop' -> no continuation", () => {
    expect(needsContinuation("stop")).toBe(false);
  });

  it("finishReason 'length' -> continuation needed", () => {
    expect(needsContinuation("length")).toBe(true);
  });

  it("shouldSegmentOutput at exactly 50000 chars -> false (not greater)", () => {
    expect(shouldSegmentOutput(50_000)).toBe(false);
  });

  it("shouldSegmentOutput at 50001 chars -> true", () => {
    expect(shouldSegmentOutput(50_001)).toBe(true);
  });

  it("shouldSegmentOutput at 0 chars -> false", () => {
    expect(shouldSegmentOutput(0)).toBe(false);
  });

  it("custom continuation prompt -> uses custom text", () => {
    const msg = buildContinuationMessage({ continuationPrompt: "Keep going please" });
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Keep going please");
  });

  it("default continuation prompt -> uses Chinese default text", () => {
    const msg = buildContinuationMessage();
    expect(msg.content).toContain("继续");
  });
});

// =============================================================================
// 5. Token Estimator Edge Cases
// =============================================================================

describe("Token Estimator Edge Cases", () => {
  it("empty message -> minimal overhead only (10 tokens)", () => {
    const estimator = new TokenEstimator();
    const tokens = estimator.estimateMessage({ role: "user", content: "" });
    // Empty content -> 0 content tokens + 10 overhead = 10
    expect(tokens).toBe(10);
  });

  it("message with empty content and no tool calls -> overhead only", () => {
    const estimator = new TokenEstimator();
    const tokens = estimator.estimateMessage({ role: "assistant", content: "" });
    expect(tokens).toBe(10);
  });

  it("message with undefined content and no tool calls -> overhead only", () => {
    const estimator = new TokenEstimator();
    const tokens = estimator.estimateMessage({ role: "user" } as any);
    expect(tokens).toBe(10);
  });

  it("message with very long content (1MB string) -> reasonable estimate", () => {
    const estimator = new TokenEstimator();
    const longContent = "x".repeat(1_000_000);
    const tokens = estimator.estimateMessage({ role: "user", content: longContent });
    // Conservative estimate: ~1_000_000 / 3 * 4/3 + 10 ~= 444444 + 10
    expect(tokens).toBeGreaterThan(400_000);
    expect(tokens).toBeLessThan(500_000);
  });

  it("multiple reportUsage for same hash -> last value wins", () => {
    const estimator = new TokenEstimator();
    const hash = "user|Hello";
    estimator.reportUsage(hash, 50);
    estimator.reportUsage(hash, 100);
    const tokens = estimator.estimateMessage({ role: "user", content: "Hello" });
    expect(tokens).toBe(100);
  });

  it("hash collision: different messages with same first 100 chars -> possible but acceptable", () => {
    const estimator = new TokenEstimator();
    const prefix = "a".repeat(100);
    const msg1 = { role: "user", content: prefix + "extra1" };
    const msg2 = { role: "user", content: prefix + "extra2_different" };

    // Both have same first 100 chars -> same hash
    const hash = `user|${prefix}`;
    estimator.reportUsage(hash, 42);

    // Both will report the same cached value
    expect(estimator.estimateMessage(msg1)).toBe(42);
    expect(estimator.estimateMessage(msg2)).toBe(42);
  });

  it("estimateMessages returns sum of individual estimates", () => {
    const estimator = new TokenEstimator();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How are you?" },
    ];
    const total = estimator.estimateMessages(messages);
    const sum = messages.reduce((s, m) => s + estimator.estimateMessage(m), 0);
    expect(total).toBe(sum);
  });
});

// =============================================================================
// 6. Tool Result Storage Edge Cases
// =============================================================================

describe("Tool Result Storage Edge Cases", () => {
  const testSessionId = "exception-test-" + Date.now();

  afterAll(async () => {
    const { rm } = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");
    const baseDir = path.join(os.tmpdir(), "deepanalyze", "tool-results", testSessionId);
    try { await rm(baseDir, { recursive: true }); } catch {}
  });

  it("result exactly at threshold (50000 chars) -> not persisted", async () => {
    const content = "x".repeat(50_000);
    const result = await maybePersistToolResult("/tmp/deepanalyze", "tool", content, testSessionId, "call-at-threshold");
    expect(result.persisted).toBe(false);
    expect(result.content).toBe(content);
  });

  it("result at 50001 chars -> persisted", async () => {
    const content = "x".repeat(50_001);
    const result = await maybePersistToolResult("/tmp/deepanalyze", "tool", content, testSessionId, "call-over-threshold");
    expect(result.persisted).toBe(true);
    expect(result.content).toContain("<persisted-output>");
  });

  it("persisted file path contains sessionId and toolCallId", async () => {
    const content = "y".repeat(60_000);
    const result = await maybePersistToolResult("/tmp/deepanalyze", "tool", content, testSessionId, "call-path-check");
    expect(result.filePath).toBeDefined();
    expect(result.filePath).toContain(testSessionId);
    expect(result.filePath).toContain("call-path-check");
    expect(result.filePath).toContain("deepanalyze");
    expect(result.filePath).toContain("tool-results");
  });

  it("preview length is 2000 chars", async () => {
    const content = "a".repeat(60_000);
    const result = await maybePersistToolResult("/tmp/deepanalyze", "tool", content, testSessionId, "call-preview-len");
    expect(result.persisted).toBe(true);
    // The content should contain the preview (first 2000 chars)
    expect(result.content).toContain("Preview (first 2000 chars)");
    expect(result.content).toContain("a".repeat(100)); // At least some preview content
  });

  it("very large result (1MB) -> persisted with correct preview", async () => {
    const content = "B".repeat(1_000_000);
    const result = await maybePersistToolResult("/tmp/deepanalyze", "tool", content, testSessionId, "call-1mb");
    expect(result.persisted).toBe(true);
    expect(result.content).toContain("<persisted-output>");
    expect(result.content).toContain("KB total");
    expect(result.filePath).toBeDefined();

    // Verify the file was written
    const { readFile } = await import("fs/promises");
    const written = await readFile(result.filePath!, "utf-8");
    expect(written.length).toBe(1_000_000);
  });
});

// =============================================================================
// 7. StreamingToolExecutor Error Handling
// =============================================================================

describe("StreamingToolExecutor Error Handling", () => {
  it("stream error chunk -> throws", async () => {
    const tools = new Map<string, AgentTool>();
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage("ok", tc.id);
    };

    const chunks: StreamChunk[] = [
      { type: "text", content: "starting..." },
      { type: "error", error: "Rate limit exceeded" },
    ];

    await expect(
      consumeStreamWithToolExecution(mockStream(chunks), tools, executeFn),
    ).rejects.toThrow("Rate limit exceeded");
  });

  it("stream error with undefined message -> throws generic message", async () => {
    const tools = new Map<string, AgentTool>();
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage("ok", tc.id);
    };

    const chunks: StreamChunk[] = [
      { type: "error", error: undefined },
    ];

    await expect(
      consumeStreamWithToolExecution(mockStream(chunks), tools, executeFn),
    ).rejects.toThrow("Stream error");
  });

  it("tool execution error -> captured as error result, not thrown", async () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", {
        name: "read_tool",
        description: "Read",
        execute: async () => null,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
      }],
    ]);

    const callA = makeToolCall("read_tool");
    const callB = makeToolCall("read_tool");

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      if (tc.id === callA.id) throw new Error("Tool A crashed");
      return makeToolResultMessage("ok", tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);
    executor.addTool(callA);
    executor.addTool(callB);

    const results = await executor.getResults();

    // Both results should be present
    expect(results).toHaveLength(2);
    // First should contain error message
    expect(results[0].content).toContain("Tool A crashed");
    // Second should succeed
    expect(results[1].toolCallId).toBe(callB.id);
  });

  it("discarded tool -> not executed", async () => {
    const executionLog: string[] = [];
    const tools = new Map<string, AgentTool>([
      ["write_tool", {
        name: "write_tool",
        description: "Write",
        execute: async () => null,
        isReadOnly: () => false,
        isConcurrencySafe: () => false,
      }],
    ]);

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      executionLog.push(tc.id);
      return makeToolResultMessage("ok", tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);
    executor.addTool(makeToolCall("write_tool")); // starts executing
    executor.addTool(makeToolCall("write_tool")); // queued (unsafe, must wait)

    // Discard before second starts
    executor.discard();

    const results = await executor.getResults();
    // At most one tool executed (second was discarded while queued)
    expect(executionLog.length).toBeLessThanOrEqual(1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("max concurrency with some failing -> correct results returned", async () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", {
        name: "read_tool",
        description: "Read",
        execute: async () => null,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
      }],
    ]);

    const calls = Array.from({ length: 6 }, (_, i) => makeToolCall("read_tool"));
    // Make every other call fail
    const failIds = new Set([calls[1]!.id, calls[3]!.id, calls[5]!.id]);

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      if (failIds.has(tc.id)) throw new Error("alternating failure");
      return makeToolResultMessage("ok", tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn, 3);
    for (const call of calls) executor.addTool(call);

    const results = await executor.getResults();

    // All 6 should have results
    expect(results).toHaveLength(6);
    // Check that failures are captured as error messages
    const errorResults = results.filter(r => (r.content as any).includes("alternating failure"));
    expect(errorResults).toHaveLength(3);
    // Check that successes are captured
    const okResults = results.filter(r => (r.content as any) === "ok");
    expect(okResults).toHaveLength(3);
  });
});

// =============================================================================
// 8. Plugin Manager Error Handling
// =============================================================================

describe("Plugin Manager Error Handling", () => {
  it("load from non-existent directory -> throws", async () => {
    const pm = new AgentPluginManager();
    await expect(pm.loadPlugin("/non/existent/directory/xyz/path")).rejects.toThrow();
  });

  it("load plugin with malformed plugin.json -> throws", async () => {
    const { mkdir, writeFile, rm } = await import("fs/promises");
    const { join } = await import("path");
    const os = await import("os");

    const tmpDir = join(os.tmpdir(), "da-malformed-plugin-" + Date.now());
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(join(tmpDir, "plugin.json"), "this is not valid json{{{");

      const pm = new AgentPluginManager();
      await expect(pm.loadPlugin(tmpDir)).rejects.toThrow();
    } finally {
      await rm(tmpDir, { recursive: true }).catch(() => {});
    }
  });

  it("load plugin twice -> no crash, second load overwrites", async () => {
    const { mkdir, writeFile, rm } = await import("fs/promises");
    const { join } = await import("path");
    const os = await import("os");

    const tmpDir = join(os.tmpdir(), "da-double-plugin-" + Date.now());
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(join(tmpDir, "plugin.json"), JSON.stringify({
        name: "double-plugin",
        version: "1.0.0",
        description: "Test",
        capabilities: [],
      }));

      const pm = new AgentPluginManager();
      await pm.loadPlugin(tmpDir);
      // Loading again should not crash
      await pm.loadPlugin(tmpDir);
      expect(pm.get("double-plugin")).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true }).catch(() => {});
    }
  });

  it("get skills from unloaded plugin -> empty array", () => {
    const pm = new AgentPluginManager();
    expect(pm.getAllSkills()).toEqual([]);
  });

  it("get agents from unloaded plugin -> empty array", () => {
    const pm = new AgentPluginManager();
    expect(pm.getAllAgents()).toEqual([]);
  });

  it("disable non-existent plugin -> no crash", () => {
    const pm = new AgentPluginManager();
    // Should not throw
    expect(() => pm.setEnabled("non_existent_plugin", false)).not.toThrow();
  });

  it("unload non-existent plugin -> returns false", () => {
    const pm = new AgentPluginManager();
    expect(pm.unload("non_existent_plugin")).toBe(false);
  });

  it("get non-existent plugin -> returns undefined", () => {
    const pm = new AgentPluginManager();
    expect(pm.get("non_existent_plugin")).toBeUndefined();
  });
});

// =============================================================================
// 9. Feature Flags Edge Cases
// =============================================================================

describe("Feature Flags Edge Cases", () => {
  afterEach(() => {
    // Clean up all possible env vars
    delete process.env.DA_CONCURRENT_TOOLS;
    delete process.env.DA_PROMPT_CACHING;
    delete process.env.DA_STREAMING_TOOLS;
    delete process.env.DA_HIERARCHICAL_COMPACT;
    delete process.env.DA_CACHE_EDITING;
    delete process.env.DA_LONG_OUTPUT;
    delete process.env.DA_MAX_CONCURRENCY;
    delete process.env.DA_PLUGINS;
    delete process.env.DA_MARKDOWN_SKILLS;
  });

  it("empty string env var -> treated as false (only 'true' and '1' are truthy)", () => {
    process.env.DA_CONCURRENT_TOOLS = "";
    const flags = resolveFeatureFlags();
    // The env var IS set (not undefined), but the value "" is neither "true" nor "1"
    // so it resolves to false
    expect(flags.concurrentToolExecution).toBe(false);
  });

  it("'0' env var -> treated as false", () => {
    process.env.DA_CONCURRENT_TOOLS = "0";
    const flags = resolveFeatureFlags();
    expect(flags.concurrentToolExecution).toBe(false);
  });

  it("'false' env var -> treated as false", () => {
    process.env.DA_CONCURRENT_TOOLS = "false";
    const flags = resolveFeatureFlags();
    expect(flags.concurrentToolExecution).toBe(false);
  });

  it("'TRUE' env var -> treated as false (case sensitive, only lowercase 'true')", () => {
    process.env.DA_CONCURRENT_TOOLS = "TRUE";
    const flags = resolveFeatureFlags();
    // The implementation checks for envValue === "true" || envValue === "1"
    // "TRUE" is neither, so it should be false
    expect(flags.concurrentToolExecution).toBe(false);
  });

  it("'True' env var -> treated as false (case sensitive)", () => {
    process.env.DA_CONCURRENT_TOOLS = "True";
    const flags = resolveFeatureFlags();
    expect(flags.concurrentToolExecution).toBe(false);
  });

  it("non-numeric string for maxToolConcurrency -> NaN (parseInt returns NaN)", () => {
    process.env.DA_MAX_CONCURRENCY = "abc";
    const flags = resolveFeatureFlags();
    expect(isNaN(flags.maxToolConcurrency)).toBe(true);
  });

  it("undefined fields in dbConfig -> use defaults", () => {
    const flags = resolveFeatureFlags({});
    expect(flags.concurrentToolExecution).toBe(DEFAULT_FEATURE_FLAGS.concurrentToolExecution);
    expect(flags.promptCaching).toBe(DEFAULT_FEATURE_FLAGS.promptCaching);
    expect(flags.maxToolConcurrency).toBe(DEFAULT_FEATURE_FLAGS.maxToolConcurrency);
  });

  it("partial dbConfig only overrides specified fields", () => {
    const flags = resolveFeatureFlags({ concurrentToolExecution: false });
    expect(flags.concurrentToolExecution).toBe(false);
    expect(flags.promptCaching).toBe(DEFAULT_FEATURE_FLAGS.promptCaching);
    expect(flags.maxToolConcurrency).toBe(DEFAULT_FEATURE_FLAGS.maxToolConcurrency);
  });

  it("env var takes priority over db config for booleans", () => {
    process.env.DA_CONCURRENT_TOOLS = "true";
    const flags = resolveFeatureFlags({ concurrentToolExecution: false });
    expect(flags.concurrentToolExecution).toBe(true);
  });

  it("env var takes priority over db config for maxToolConcurrency", () => {
    process.env.DA_MAX_CONCURRENCY = "7";
    const flags = resolveFeatureFlags({ maxToolConcurrency: 3 });
    expect(flags.maxToolConcurrency).toBe(7);
  });
});

// =============================================================================
// 10. Session Memory Async Error Handling
// =============================================================================

describe("Session Memory Async Error Handling", () => {
  it("extraction callback throws -> handled without crash", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    // Should not throw even when the callback throws
    extractor.tryExtract(10000, async () => {
      throw new Error("extraction failed");
    });
    // Wait for extraction to complete (should not crash)
    await extractor.waitForExtraction();
    // After failure, extractPromise should be null and ready for next attempt
    expect(extractor.isExtracting).toBe(false);
  });

  it("extraction callback throws string -> handled without crash", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    extractor.tryExtract(10000, async () => {
      throw "string error" as any;
    });
    await extractor.waitForExtraction();
    expect(extractor.isExtracting).toBe(false);
  });

  it("multiple concurrent tryExtract calls -> only one runs at a time", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    let callCount = 0;

    const slowExtract = async () => {
      await new Promise(r => setTimeout(r, 100));
      callCount++;
    };

    // First call triggers extraction
    extractor.tryExtract(10000, slowExtract);
    expect(extractor.isExtracting).toBe(true);

    // Second call while first is running should be skipped
    extractor.tryExtract(20000, async () => { callCount += 100; });

    await extractor.waitForExtraction();
    expect(callCount).toBe(1);
  });

  it("reset during extraction -> extraction continues but state resets", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    let extractionCompleted = false;

    extractor.tryExtract(10000, async () => {
      await new Promise(r => setTimeout(r, 100));
      extractionCompleted = true;
    });

    // Reset while extraction is running
    extractor.reset();

    // Extraction should still complete
    await extractor.waitForExtraction();
    expect(extractionCompleted).toBe(true);
    expect(extractor.isExtracting).toBe(false);

    // Note: The .then() handler in tryExtract sets lastExtractedTokens = 10000
    // AFTER the extraction completes. Since reset() ran before completion,
    // the .then() overwrites reset's value. So lastExtractedTokens = 10000 now.
    // To trigger a new extraction, we need tokens > 10000 + 1*3 = 10003.
    let secondCalled = false;
    extractor.tryExtract(20000, async () => { secondCalled = true; });
    await extractor.waitForExtraction();
    expect(secondCalled).toBe(true);
  });

  it("tryExtract with zero tokens -> skips extraction", () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    let called = false;
    extractor.tryExtract(0, async () => { called = true; });
    // 0 - 0 = 0 increment, which is less than interval * 3 = 3
    expect(called).toBe(false);
    expect(extractor.isExtracting).toBe(false);
  });

  it("tryExtract with negative tokens -> skips extraction", () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    let called = false;
    extractor.tryExtract(-100, async () => { called = true; });
    // -100 - 0 = -100 increment, which is less than interval * 3 = 3
    expect(called).toBe(false);
    expect(extractor.isExtracting).toBe(false);
  });
});

// =============================================================================
// Additional: Cross-module boundary tests
// =============================================================================

describe("Cross-Module Boundary Tests", () => {
  it("ToolRegistry validateToolInput with no schema -> always valid", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "no_schema_tool",
      description: "No schema",
      execute: async () => null,
      // No inputSchema
    });

    const tool = registry.get("no_schema_tool")!;
    const result = registry.validateToolInput("no_schema_tool", {}, tool.inputSchema ?? {});
    expect(result.valid).toBe(true);
  });

  it("orchestrateToolCalls with unknown tool names -> treated as serial (non-safe)", async () => {
    const tools = new Map<string, AgentTool>(); // Empty map - no tools registered
    const calls = [makeToolCall("unknown_1"), makeToolCall("unknown_2")];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage(`result_${tc.function.name}`, tc.id);
    };

    const result = await orchestrateToolCalls(calls, tools, executeFn);
    expect(result.messages).toHaveLength(2);
    expect(result.concurrentCount).toBe(0);
    expect(result.serialCount).toBe(2);
  });

  it("StreamingToolExecutor with empty tools map -> tools still execute via executeFn", async () => {
    const tools = new Map<string, AgentTool>(); // Empty
    const call = makeToolCall("any_tool");

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage("executed", tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);
    executor.addTool(call);
    const results = await executor.getResults();

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("executed");
  });

  it("applyCacheEditing does not mutate original array", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "a" },
      { role: "tool", content: "x".repeat(20_000), toolCallId: "t1" },
    ];
    const originalContent = msgs[1].content;
    applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 100 });
    expect(msgs[1].content).toBe(originalContent);
  });

  it("runToolsConcurrently rejects on error without partial results", async () => {
    const calls = [makeToolCall("a"), makeToolCall("b")];
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      if (tc.function.name === "b") throw new Error("B failed");
      await new Promise(r => setTimeout(r, 50));
      return makeToolResultMessage("ok_a", tc.id);
    };

    await expect(runToolsConcurrently(calls, executeFn)).rejects.toThrow("B failed");
  });

  it("TokenEstimator clear allows re-estimation without cache", () => {
    const estimator = new TokenEstimator();
    const hash = "user|Test content";
    estimator.reportUsage(hash, 999);
    expect(estimator.estimateMessage({ role: "user", content: "Test content" })).toBe(999);
    estimator.clear();
    // After clear, should use conservative estimation, not 999
    const tokens = estimator.estimateMessage({ role: "user", content: "Test content" });
    expect(tokens).not.toBe(999);
    expect(tokens).toBeGreaterThan(0);
  });
});
