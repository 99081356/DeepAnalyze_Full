import { describe, it, expect } from "bun:test";
import {
  partitionToolCalls,
  runToolsConcurrently,
  runToolsSerially,
  orchestrateToolCalls,
} from "../tool-orchestration.js";
import type { AgentTool } from "../types.js";
import type { ToolCall, ChatMessage } from "../../../models/provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function makeMessage(content: string): ChatMessage {
  return { role: "tool", content };
}

const readOnlyTool: AgentTool = {
  name: "read_tool",
  description: "Read",
  execute: async () => null,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
};

const writeTool: AgentTool = {
  name: "write_tool",
  description: "Write",
  execute: async () => null,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
};

const conditionalTool: AgentTool = {
  name: "conditional_tool",
  description: "Conditional",
  execute: async () => null,
  isReadOnly: () => false,
  isConcurrencySafe: (input) => input.safe === true,
};

// ---------------------------------------------------------------------------
// partitionToolCalls
// ---------------------------------------------------------------------------

describe("partitionToolCalls", () => {
  it("merges two read-only tools into one concurrent batch", () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
    ]);
    const calls = [makeToolCall("read_tool"), makeToolCall("read_tool")];

    const batches = partitionToolCalls(calls, tools);

    expect(batches).toHaveLength(1);
    expect(batches[0].isConcurrent).toBe(true);
    expect(batches[0].toolCalls).toHaveLength(2);
  });

  it("splits read-only + write tool into two batches", () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
      ["write_tool", writeTool],
    ]);
    const calls = [makeToolCall("read_tool"), makeToolCall("write_tool")];

    const batches = partitionToolCalls(calls, tools);

    expect(batches).toHaveLength(2);
    expect(batches[0].isConcurrent).toBe(true);
    expect(batches[0].toolCalls).toHaveLength(1);
    expect(batches[1].isConcurrent).toBe(false);
    expect(batches[1].toolCalls).toHaveLength(1);
  });

  it("splits write + read-only + write into three batches", () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
      ["write_tool", writeTool],
    ]);
    const calls = [
      makeToolCall("write_tool"),
      makeToolCall("read_tool"),
      makeToolCall("write_tool"),
    ];

    const batches = partitionToolCalls(calls, tools);

    expect(batches).toHaveLength(3);
    // batch 0: write (serial)
    expect(batches[0].isConcurrent).toBe(false);
    expect(batches[0].toolCalls[0].function.name).toBe("write_tool");
    // batch 1: read (concurrent)
    expect(batches[1].isConcurrent).toBe(true);
    expect(batches[1].toolCalls[0].function.name).toBe("read_tool");
    // batch 2: write (serial)
    expect(batches[2].isConcurrent).toBe(false);
    expect(batches[2].toolCalls[0].function.name).toBe("write_tool");
  });

  it("returns empty array for empty input", () => {
    const tools = new Map<string, AgentTool>();
    const batches = partitionToolCalls([], tools);
    expect(batches).toEqual([]);
  });

  it("treats unknown tools as non-concurrent", () => {
    const tools = new Map<string, AgentTool>();
    const calls = [makeToolCall("unknown_tool")];

    const batches = partitionToolCalls(calls, tools);

    expect(batches).toHaveLength(1);
    expect(batches[0].isConcurrent).toBe(false);
  });

  it("handles invalid JSON arguments gracefully", () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
    ]);
    const badCall: ToolCall = {
      id: "call_bad",
      type: "function",
      function: { name: "read_tool", arguments: "not-valid-json" },
    };

    const batches = partitionToolCalls([badCall], tools);

    expect(batches).toHaveLength(1);
    expect(batches[0].isConcurrent).toBe(false);
  });

  it("respects isConcurrencySafe input-based decision", () => {
    const tools = new Map<string, AgentTool>([
      ["conditional_tool", conditionalTool],
    ]);

    // safe=true -> concurrent
    const safeBatches = partitionToolCalls(
      [makeToolCall("conditional_tool", { safe: true })],
      tools,
    );
    expect(safeBatches).toHaveLength(1);
    expect(safeBatches[0].isConcurrent).toBe(true);

    // safe=false -> serial
    const unsafeBatches = partitionToolCalls(
      [makeToolCall("conditional_tool", { safe: false })],
      tools,
    );
    expect(unsafeBatches).toHaveLength(1);
    expect(unsafeBatches[0].isConcurrent).toBe(false);
  });

  it("merges consecutive safe tools, separates at non-safe boundary", () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
      ["write_tool", writeTool],
    ]);
    // read, read, write, read, read, read
    const calls = [
      makeToolCall("read_tool"),
      makeToolCall("read_tool"),
      makeToolCall("write_tool"),
      makeToolCall("read_tool"),
      makeToolCall("read_tool"),
      makeToolCall("read_tool"),
    ];

    const batches = partitionToolCalls(calls, tools);

    expect(batches).toHaveLength(3);
    // batch 0: 2 reads (concurrent)
    expect(batches[0].isConcurrent).toBe(true);
    expect(batches[0].toolCalls).toHaveLength(2);
    // batch 1: 1 write (serial)
    expect(batches[1].isConcurrent).toBe(false);
    expect(batches[1].toolCalls).toHaveLength(1);
    // batch 2: 3 reads (concurrent)
    expect(batches[2].isConcurrent).toBe(true);
    expect(batches[2].toolCalls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// runToolsSerially
// ---------------------------------------------------------------------------

describe("runToolsSerially", () => {
  it("executes tool calls one at a time in order", async () => {
    const order: string[] = [];
    const calls = [makeToolCall("a"), makeToolCall("b"), makeToolCall("c")];

    const executeFn = async (tc: ToolCall) => {
      order.push(tc.function.name);
      return makeMessage(`result_${tc.function.name}`);
    };

    const results = await runToolsSerially(calls, executeFn);

    expect(order).toEqual(["a", "b", "c"]);
    expect(results).toHaveLength(3);
    expect(results[0].content).toBe("result_a");
    expect(results[1].content).toBe("result_b");
    expect(results[2].content).toBe("result_c");
  });

  it("returns empty array for empty input", async () => {
    const results = await runToolsSerially([], async () => makeMessage("x"));
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runToolsConcurrently
// ---------------------------------------------------------------------------

describe("runToolsConcurrently", () => {
  it("actually runs tools in parallel (use timing to verify)", async () => {
    const calls = [
      makeToolCall("a"),
      makeToolCall("b"),
      makeToolCall("c"),
    ];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      // Each tool takes 100ms; if serial, total = 300ms. If parallel, ~100ms.
      await new Promise((r) => setTimeout(r, 100));
      return makeMessage(`result_${tc.function.name}`);
    };

    const start = Date.now();
    const results = await runToolsConcurrently(calls, executeFn, 10);
    const elapsed = Date.now() - start;

    // Should complete in roughly 100-200ms (parallel), not 300ms+ (serial)
    // Use 250ms as threshold to avoid flakiness on slow CI
    expect(elapsed).toBeLessThan(250);

    // Results must be in input order
    expect(results).toHaveLength(3);
    expect(results[0].content).toBe("result_a");
    expect(results[1].content).toBe("result_b");
    expect(results[2].content).toBe("result_c");
  });

  it("respects maxConcurrency", async () => {
    const timestamps: { name: string; start: number }[] = [];
    const calls = [
      makeToolCall("a"),
      makeToolCall("b"),
      makeToolCall("c"),
      makeToolCall("d"),
    ];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      timestamps.push({ name: tc.function.name, start: Date.now() });
      await new Promise((r) => setTimeout(r, 100));
      return makeMessage(`result_${tc.function.name}`);
    };

    // maxConcurrency = 2, so first two start together, next two after
    await runToolsConcurrently(calls, executeFn, 2);

    // Sort by start time to analyze concurrency
    const sorted = timestamps.sort((a, b) => a.start - b.start);

    // First two should start within ~20ms of each other (concurrent)
    const gap1 = Math.abs(sorted[0].start - sorted[1].start);
    expect(gap1).toBeLessThan(50);

    // Third should start after first batch finishes (~100ms later)
    const gap2 = sorted[2].start - sorted[0].start;
    expect(gap2).toBeGreaterThanOrEqual(80);
  });

  it("returns empty array for empty input", async () => {
    const results = await runToolsConcurrently([], async () => makeMessage("x"));
    expect(results).toEqual([]);
  });

  it("rejects with the first error when a tool throws", async () => {
    const calls = [makeToolCall("ok"), makeToolCall("fail"), makeToolCall("ok")];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      if (tc.function.name === "fail") {
        throw new Error("tool exploded");
      }
      return makeMessage("ok");
    };

    expect(runToolsConcurrently(calls, executeFn)).rejects.toThrow("tool exploded");
  });
});

// ---------------------------------------------------------------------------
// orchestrateToolCalls
// ---------------------------------------------------------------------------

describe("orchestrateToolCalls", () => {
  it("handles mixed concurrent/serial scenario", async () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
      ["write_tool", writeTool],
    ]);

    // read, read, write, read -> batches: [read,read concurrent], [write serial], [read concurrent]
    const calls = [
      makeToolCall("read_tool"),
      makeToolCall("read_tool"),
      makeToolCall("write_tool"),
      makeToolCall("read_tool"),
    ];

    const executionOrder: string[] = [];
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      executionOrder.push(tc.function.name);
      return makeMessage(`result_${tc.function.name}`);
    };

    const result = await orchestrateToolCalls(calls, tools, executeFn);

    expect(result.messages).toHaveLength(4);
    expect(result.concurrentCount).toBe(3); // 2 reads + 1 read
    expect(result.serialCount).toBe(1); // 1 write
    // All results present
    expect(result.messages.map((m) => m.content)).toEqual([
      "result_read_tool",
      "result_read_tool",
      "result_write_tool",
      "result_read_tool",
    ]);
  });

  it("returns empty result for empty input", async () => {
    const tools = new Map<string, AgentTool>();
    const result = await orchestrateToolCalls([], tools, async () => makeMessage("x"));

    expect(result.messages).toEqual([]);
    expect(result.concurrentCount).toBe(0);
    expect(result.serialCount).toBe(0);
  });

  it("runs all serial when all tools are non-concurrent", async () => {
    const tools = new Map<string, AgentTool>([
      ["write_tool", writeTool],
    ]);
    const calls = [
      makeToolCall("write_tool"),
      makeToolCall("write_tool"),
    ];

    const result = await orchestrateToolCalls(
      calls,
      tools,
      async (tc) => makeMessage(`result_${tc.function.name}`),
    );

    expect(result.concurrentCount).toBe(0);
    expect(result.serialCount).toBe(2);
    expect(result.messages).toHaveLength(2);
  });

  it("runs all concurrent when all tools are concurrency-safe", async () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
    ]);
    const calls = [
      makeToolCall("read_tool"),
      makeToolCall("read_tool"),
      makeToolCall("read_tool"),
    ];

    const result = await orchestrateToolCalls(
      calls,
      tools,
      async (tc) => makeMessage(`result_${tc.function.name}`),
    );

    expect(result.concurrentCount).toBe(3);
    expect(result.serialCount).toBe(0);
    expect(result.messages).toHaveLength(3);
  });

  it("respects maxConcurrency parameter", async () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
    ]);
    const calls = Array.from({ length: 20 }, () => makeToolCall("read_tool"));

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const executeFn = async (): Promise<ChatMessage> => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      await new Promise((r) => setTimeout(r, 10));
      currentConcurrent--;
      return makeMessage("ok");
    };

    await orchestrateToolCalls(calls, tools, executeFn, 5);

    // With maxConcurrency=5, we should never exceed 5 concurrent executions
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });
});
