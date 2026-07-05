import { describe, it, expect } from "bun:test";
import {
  StreamingToolExecutor,
  consumeStreamWithToolExecution,
} from "../streaming-tool-executor.js";
import type { AgentTool } from "../types.js";
import type { ToolCall, ChatMessage, StreamChunk } from "../../../models/provider.js";

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

function makeToolResultMessage(content: string, toolCallId: string): ChatMessage {
  return { role: "tool", content, toolCallId };
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

async function* mockStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk;
}

// ---------------------------------------------------------------------------
// StreamingToolExecutor
// ---------------------------------------------------------------------------

describe("StreamingToolExecutor", () => {
  // -------------------------------------------------------------------------
  // 1. Two concurrency-safe tools execute in parallel (verify by timing)
  // -------------------------------------------------------------------------
  it("executes two concurrency-safe tools in parallel", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);
    const calls = [makeToolCall("read_tool"), makeToolCall("read_tool")];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      // Each tool takes 100ms; if serial total = 200ms. Parallel ~100ms.
      await new Promise((r) => setTimeout(r, 100));
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);

    const start = Date.now();
    for (const call of calls) executor.addTool(call);
    const results = await executor.getResults();
    const elapsed = Date.now() - start;

    // Should complete in roughly 100-200ms (parallel), not 200ms+ (serial)
    expect(elapsed).toBeLessThan(200);
    expect(results).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 2. Safe + unsafe tool: unsafe waits until safe completes
  // -------------------------------------------------------------------------
  it("makes unsafe tool wait until all safe tools complete", async () => {
    const tools = new Map<string, AgentTool>([
      ["read_tool", readOnlyTool],
      ["write_tool", writeTool],
    ]);

    const timestamps: { name: string; start: number }[] = [];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      timestamps.push({ name: tc.function.name, start: Date.now() });
      await new Promise((r) => setTimeout(r, 80));
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);

    // Add safe tool first, then unsafe
    executor.addTool(makeToolCall("read_tool"));
    executor.addTool(makeToolCall("write_tool"));

    const results = await executor.getResults();

    expect(results).toHaveLength(2);

    // The write_tool should start AFTER read_tool finishes (~80ms later)
    const readStart = timestamps.find((t) => t.name === "read_tool")!.start;
    const writeStart = timestamps.find((t) => t.name === "write_tool")!.start;
    const gap = writeStart - readStart;

    // write should start at least 60ms after read (allowing some timing slack)
    expect(gap).toBeGreaterThanOrEqual(60);
  });

  // -------------------------------------------------------------------------
  // 3. maxConcurrency is respected
  // -------------------------------------------------------------------------
  it("respects maxConcurrency limit", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);
    const calls = Array.from({ length: 8 }, () => makeToolCall("read_tool"));

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      await new Promise((r) => setTimeout(r, 30));
      currentConcurrent--;
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn, 3);

    for (const call of calls) executor.addTool(call);
    await executor.getResults();

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // 4. discard() cancels pending tools
  // -------------------------------------------------------------------------
  it("discard() prevents queued tools from executing", async () => {
    const tools = new Map<string, AgentTool>([["write_tool", writeTool]]);
    const executionLog: string[] = [];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      executionLog.push(tc.id);
      await new Promise((r) => setTimeout(r, 50));
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);

    // First write tool starts executing
    executor.addTool(makeToolCall("write_tool"));
    // Second write tool should be queued (unsafe, must wait)
    executor.addTool(makeToolCall("write_tool"));

    // Discard before the second one can start
    executor.discard();

    const results = await executor.getResults();

    // Only the first tool should have completed (second was discarded while queued)
    expect(executor.completedCount).toBeLessThanOrEqual(1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 5. getResults() returns results in original order
  // -------------------------------------------------------------------------
  it("returns results in original order even when executed concurrently", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);

    // Create tool calls with known IDs to track ordering
    const callA = makeToolCall("read_tool");
    const callB = makeToolCall("read_tool");
    const callC = makeToolCall("read_tool");

    // Make B take longer than A and C to test ordering
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      if (tc.id === callB.id) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);

    executor.addTool(callA);
    executor.addTool(callB);
    executor.addTool(callC);

    const results = await executor.getResults();

    expect(results).toHaveLength(3);
    // Order must match input order: A, B, C
    expect(results[0].toolCallId).toBe(callA.id);
    expect(results[1].toolCallId).toBe(callB.id);
    expect(results[2].toolCallId).toBe(callC.id);
  });

  // -------------------------------------------------------------------------
  // Additional: handles errors gracefully
  // -------------------------------------------------------------------------
  it("captures tool execution errors as error results", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);
    const callA = makeToolCall("read_tool");
    const callB = makeToolCall("read_tool");

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      if (tc.id === callA.id) {
        throw new Error("Tool A exploded");
      }
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);
    executor.addTool(callA);
    executor.addTool(callB);

    const results = await executor.getResults();

    expect(results).toHaveLength(2);
    // First result should be an error
    expect(results[0].content).toContain("Tool A exploded");
    // Second result should succeed
    expect(results[1].toolCallId).toBe(callB.id);
  });

  // -------------------------------------------------------------------------
  // Additional: conditional concurrency safety
  // -------------------------------------------------------------------------
  it("respects conditional isConcurrencySafe based on input", async () => {
    const tools = new Map<string, AgentTool>([["conditional_tool", conditionalTool]]);

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);

    // Both safe -- should be able to run concurrently
    const safeA = makeToolCall("conditional_tool", { safe: true });
    const safeB = makeToolCall("conditional_tool", { safe: true });

    executor.addTool(safeA);
    executor.addTool(safeB);

    // Both should be tracked
    expect(executor.totalCount).toBe(2);

    const results = await executor.getResults();
    expect(results).toHaveLength(2);
    // Both should have completed successfully
    expect(executor.completedCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Additional: completedCount and totalCount track correctly
  // -------------------------------------------------------------------------
  it("tracks completedCount and totalCount correctly", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      await new Promise((r) => setTimeout(r, 20));
      return makeToolResultMessage(`result_${tc.id}`, tc.id);
    };

    const executor = new StreamingToolExecutor(tools, executeFn);

    expect(executor.totalCount).toBe(0);
    expect(executor.completedCount).toBe(0);

    executor.addTool(makeToolCall("read_tool"));
    executor.addTool(makeToolCall("read_tool"));
    executor.addTool(makeToolCall("read_tool"));

    expect(executor.totalCount).toBe(3);

    await executor.getResults();

    expect(executor.completedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// consumeStreamWithToolExecution
// ---------------------------------------------------------------------------

describe("consumeStreamWithToolExecution", () => {
  it("processes a mock stream with text and tool calls", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);

    const deltas: string[] = [];

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage(`executed_${tc.function.name}`, tc.id);
    };

    const chunks: StreamChunk[] = [
      { type: "text", content: "Hello " },
      { type: "text", content: "world" },
      {
        type: "tool_call",
        toolCall: {
          id: "call_1",
          type: "function",
          function: { name: "read_tool", arguments: '{"query":"test"}' },
        },
      },
      {
        type: "tool_call_delta",
        toolCall: {
          function: { name: "read_tool", arguments: "" },
        },
      },
      {
        type: "done",
        finishReason: "tool_calls",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ];

    const result = await consumeStreamWithToolExecution(
      mockStream(chunks),
      tools,
      executeFn,
      (delta) => deltas.push(delta),
    );

    expect(result.content).toBe("Hello world");
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].content).toBe("executed_read_tool");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
  });

  it("handles stream with no tool calls", async () => {
    const tools = new Map<string, AgentTool>();
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage("ok", tc.id);
    };

    const chunks: StreamChunk[] = [
      { type: "text", content: "Just text, " },
      { type: "text", content: "no tools." },
      { type: "done", finishReason: "stop" },
    ];

    const result = await consumeStreamWithToolExecution(
      mockStream(chunks),
      tools,
      executeFn,
    );

    expect(result.content).toBe("Just text, no tools.");
    expect(result.toolResults).toHaveLength(0);
    expect(result.finishReason).toBe("stop");
  });

  it("handles tool_call_delta accumulating arguments", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      // Verify the arguments were accumulated correctly
      const parsed = JSON.parse(tc.function.arguments);
      return makeToolResultMessage(`q=${parsed.query}`, tc.id);
    };

    const chunks: StreamChunk[] = [
      {
        type: "tool_call",
        toolCall: {
          id: "call_abc",
          type: "function",
          function: { name: "read_tool", arguments: "" },
        },
      },
      {
        type: "tool_call_delta",
        toolCall: {
          function: { name: "read_tool", arguments: '{"qu' },
        },
      },
      {
        type: "tool_call_delta",
        toolCall: {
          function: { name: "read_tool", arguments: 'ery":' },
        },
      },
      {
        type: "tool_call_delta",
        toolCall: {
          function: { name: "read_tool", arguments: ' "hello"}' },
        },
      },
      { type: "done", finishReason: "tool_calls" },
    ];

    const result = await consumeStreamWithToolExecution(
      mockStream(chunks),
      tools,
      executeFn,
    );

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].content).toBe("q=hello");
  });

  it("throws on stream error chunk", async () => {
    const tools = new Map<string, AgentTool>();
    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      return makeToolResultMessage("ok", tc.id);
    };

    const chunks: StreamChunk[] = [
      { type: "text", content: "partial..." },
      { type: "error", error: "API rate limit exceeded" },
    ];

    expect(
      consumeStreamWithToolExecution(mockStream(chunks), tools, executeFn),
    ).rejects.toThrow("API rate limit exceeded");
  });

  it("executes multiple concurrent-safe tools in parallel from stream", async () => {
    const tools = new Map<string, AgentTool>([["read_tool", readOnlyTool]]);

    const executeFn = async (tc: ToolCall): Promise<ChatMessage> => {
      await new Promise((r) => setTimeout(r, 50));
      return makeToolResultMessage(`result_${tc.function.name}`, tc.id);
    };

    const chunks: StreamChunk[] = [
      { type: "text", content: "Searching..." },
      {
        type: "tool_call",
        toolCall: {
          id: "call_1",
          type: "function",
          function: { name: "read_tool", arguments: "{}" },
        },
      },
      {
        type: "tool_call",
        toolCall: {
          id: "call_2",
          type: "function",
          function: { name: "read_tool", arguments: "{}" },
        },
      },
      {
        type: "tool_call",
        toolCall: {
          id: "call_3",
          type: "function",
          function: { name: "read_tool", arguments: "{}" },
        },
      },
      { type: "done", finishReason: "tool_calls" },
    ];

    const start = Date.now();
    const result = await consumeStreamWithToolExecution(
      mockStream(chunks),
      tools,
      executeFn,
    );
    const elapsed = Date.now() - start;

    // 3 tools x 50ms each: serial would be 150ms+, parallel ~50ms
    expect(elapsed).toBeLessThan(150);
    expect(result.toolResults).toHaveLength(3);
    expect(result.content).toBe("Searching...");
  });
});
