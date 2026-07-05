// =============================================================================
// DeepAnalyze - AgentRunner Tests
// =============================================================================
// Tests the TAOR (Think-Act-Observe-Reflect) loop with a mock ModelRouter.

import { describe, test, expect } from "bun:test";
import { ToolRegistry } from "../src/services/agent/tool-registry.js";
import { AgentRunner } from "../src/services/agent/agent-runner.js";
import type { ChatResponse, StreamChunk } from "../src/models/provider.js";

// ---------------------------------------------------------------------------
// Mock ModelRouter
// ---------------------------------------------------------------------------

/**
 * Creates a mock ModelRouter that returns pre-configured responses in sequence
 * via the chatStream() interface. Each ChatResponse is converted into a series
 * of StreamChunk yields (text, tool_call, done).
 * When all responses are consumed, it repeats the last one indefinitely.
 */
function createMockRouter(responses: ChatResponse[]) {
  let callIndex = 0;

  function* responseToChunks(response: ChatResponse): Generator<StreamChunk> {
    // Yield text content
    if (response.content) {
      yield { type: "text", content: response.content };
    }
    // Yield tool calls
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield { type: "tool_call", toolCall: tc };
      }
    }
    // Yield done
    yield { type: "done", finishReason: response.finishReason, usage: response.usage };
  }

  return {
    chat: async (_messages: any, _options?: any): Promise<ChatResponse> => {
      const response =
        callIndex < responses.length
          ? responses[callIndex]
          : responses[responses.length - 1];
      callIndex++;
      return response;
    },
    chatStream: async function* (_messages: any, _options?: any): AsyncGenerator<StreamChunk> {
      const response =
        callIndex < responses.length
          ? responses[callIndex]
          : responses[responses.length - 1];
      callIndex++;
      yield* responseToChunks(response);
    },
    getDefaultModel: (_role?: string) => "mock-model",
    estimateTokens: (_text: string) => 100,
    initialize: async () => {},
    ensureCurrent: async () => {},
    listProviderNames: () => ["mock"],
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunner", () => {
  test("runs a simple agent task with text response (finishReason: stop)", async () => {
    const registry = new ToolRegistry();
    const mockRouter = createMockRouter([
      {
        content: "Hello, I analyzed your request.",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 50, outputTokens: 20 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    const result = await runner.run({
      input: "Analyze this document",
    });

    // The output may contain the response repeated due to continuation prompts
    // for short content, so use toContain instead of toBe
    expect(result.output).toContain("Hello, I analyzed your request.");
    expect(result.toolCallsCount).toBe(0);
    // Token usage accumulates across continuation turns (4 turns in total)
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(50);
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(20);
  });

  test("runs an agent that calls the finish tool", async () => {
    const registry = new ToolRegistry();
    const mockRouter = createMockRouter([
      {
        content: "Let me finish this task.",
        toolCalls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "finish",
              arguments: '{"summary": "Task completed successfully"}',
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    const result = await runner.run({
      input: "Complete this task",
    });

    expect(result.toolCallsCount).toBe(1);
    expect(result.output).toBeDefined();
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("executes think tool and continues loop", async () => {
    const registry = new ToolRegistry();

    // First response: call think tool
    // Second response: text completion
    const mockRouter = createMockRouter([
      {
        content: "Let me think about this...",
        toolCalls: [
          {
            id: "call_think",
            type: "function" as const,
            function: {
              name: "think",
              arguments: '{"thought": "I need to analyze the document"}',
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 50, outputTokens: 30 },
      },
      {
        content: "After thinking, here is my analysis: the document is about testing.",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 60, outputTokens: 40 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    const result = await runner.run({
      input: "Analyze this",
    });

    expect(result.toolCallsCount).toBe(1);
    expect(result.output).toContain("After thinking, here is my analysis");
    expect(result.usage.inputTokens).toBe(110); // 50 + 60
    expect(result.usage.outputTokens).toBe(70); // 30 + 40
  });

  test("respects maxTurns limit when agent keeps looping", async () => {
    const registry = new ToolRegistry();

    // Router that always returns a think tool call (never stops on its own)
    const mockRouter = createMockRouter([
      {
        content: "Thinking...",
        toolCalls: [
          {
            id: "call_think",
            type: "function" as const,
            function: {
              name: "think",
              arguments: '{"thought": "Still thinking..."}',
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    const maxTurns = 3;
    const result = await runner.run({
      input: "Loop forever",
      maxTurns,
    });

    // Should eventually stop — hard limit is Math.max(Math.ceil(advisoryLimit * 2), 200)
    // The agent keeps calling the think tool, so it runs until hard limit is reached
    expect(result.turnsUsed).toBeGreaterThan(0);
    // Hard limit = Math.max(Math.ceil(3 * 2), 200) = 200, plus possible wrap-up turn
    expect(result.turnsUsed).toBeLessThanOrEqual(202);
    // Each turn calls the think tool once
    expect(result.toolCallsCount).toBeGreaterThan(0);
  });

  test("emits start and complete events", async () => {
    const registry = new ToolRegistry();
    const events: any[] = [];

    const mockRouter = createMockRouter([
      {
        content: "Done",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    await runner.run({
      input: "Test events",
      onEvent: (event) => events.push(event),
    });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("complete");
    expect(eventTypes).toContain("turn");
  });

  test("emits tool_call and tool_result events when tools are used", async () => {
    const registry = new ToolRegistry();
    const events: any[] = [];

    const mockRouter = createMockRouter([
      {
        content: "Calling think",
        toolCalls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "think",
              arguments: '{"thought": "Planning"}',
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: "Final answer",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    await runner.run({
      input: "Test tool events",
      onEvent: (event) => events.push(event),
    });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("tool_call");
    expect(eventTypes).toContain("tool_result");

    const toolCallEvent = events.find((e) => e.type === "tool_call");
    expect(toolCallEvent.toolName).toBe("think");
  });

  test("handles error from model router gracefully", async () => {
    const registry = new ToolRegistry();
    const events: any[] = [];

    const mockRouter = {
      chat: async () => {
        throw new Error("Model unavailable");
      },
      chatStream: async function* () {
        throw new Error("Model unavailable");
      },
      getDefaultModel: () => "mock-model",
      ensureCurrent: async () => {},
      listProviderNames: () => ["mock"],
    } as any;

    const runner = new AgentRunner(mockRouter, registry);
    const result = await runner.run({
      input: "This should fail",
      onEvent: (event) => events.push(event),
    });

    expect(result.output).toContain("Model unavailable");
    expect(result.toolCallsCount).toBe(0);

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("error");
  });

  test("handles tool call with invalid JSON arguments", async () => {
    const registry = new ToolRegistry();
    const events: any[] = [];

    const mockRouter = createMockRouter([
      {
        content: "Calling tool with bad args",
        toolCalls: [
          {
            id: "call_bad",
            type: "function" as const,
            function: {
              name: "think",
              arguments: "not valid json{{{",
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: "Recovered after bad tool call",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    const result = await runner.run({
      input: "Test bad args",
      onEvent: (event) => events.push(event),
    });

    // Should still complete
    expect(result.output).toContain("Recovered after bad tool call");
    expect(result.toolCallsCount).toBe(1);
  });

  test("handles call to unknown tool", async () => {
    const registry = new ToolRegistry();
    const events: any[] = [];

    const mockRouter = createMockRouter([
      {
        content: "Calling unknown tool",
        toolCalls: [
          {
            id: "call_unknown",
            type: "function" as const,
            function: {
              name: "nonexistent_tool",
              arguments: "{}",
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: "OK, tool was not found. Here is my answer.",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    const result = await runner.run({
      input: "Test unknown tool",
      onEvent: (event) => events.push(event),
    });

    expect(result.output).toContain("OK, tool was not found");
    // The tool result event should contain the error
    const toolResultEvent = events.find(
      (e) => e.type === "tool_result" && e.toolName === "nonexistent_tool",
    );
    expect(toolResultEvent).toBeDefined();
    expect((toolResultEvent.result as any).error).toContain("not found");
  });

  test("registers and uses custom agent definitions", async () => {
    const registry = new ToolRegistry();
    const mockRouter = createMockRouter([
      {
        content: "Custom agent response",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);

    // Register a custom agent
    runner.registerAgent({
      agentType: "custom_analyzer",
      description: "A custom analyzer agent",
      systemPrompt: "You are a custom analyzer.",
      tools: ["think"],
      maxTurns: 5,
    });

    expect(runner.getAgentTypes()).toContain("custom_analyzer");
    expect(runner.getAgentDefinition("custom_analyzer")?.systemPrompt).toBe(
      "You are a custom analyzer.",
    );

    // Run the custom agent
    const result = await runner.run({
      input: "Analyze this with custom agent",
      agentType: "custom_analyzer",
    });

    expect(result.output).toBe("Custom agent response");
  });

  // ---------------------------------------------------------------------------
  // Runtime KB scope enforcement (defense-in-depth for requiresKbScope tools)
  // ---------------------------------------------------------------------------

  test("runtime guard blocks KB-scoped tool when no KB in session scope", async () => {
    const registry = new ToolRegistry();
    const events: any[] = [];
    let executeCallCount = 0;

    // Register a KB-scoped tool that should be blocked at runtime
    registry.register({
      name: "fake_kb_search",
      description: "Fake KB search tool for testing",
      execute: async () => {
        executeCallCount++;
        return "should never reach here";
      },
      requiresKbScope: true,
    });

    // Execution context with NO scopeKbIds (empty KB scope)
    registry.setExecutionContext({ scopeKbIds: [] });

    // Mock router "hallucinates" a call to the KB tool (simulating a sub-agent
    // that somehow attempts a KB tool despite it being hidden from tool defs)
    const mockRouter = createMockRouter([
      {
        content: "Let me search the KB",
        toolCalls: [
          {
            id: "call_kb_1",
            type: "function" as const,
            function: {
              name: "fake_kb_search",
              arguments: '{"query": "test"}',
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: "Done",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    await runner.run({
      input: "Test KB scope guard",
      onEvent: (event) => events.push(event),
    });

    // The tool's execute() should NEVER be called — runtime guard must block it
    expect(executeCallCount).toBe(0);

    // The tool_result event should contain an error about KB scope
    const toolResultEvent = events.find(
      (e) => e.type === "tool_result" && e.toolName === "fake_kb_search",
    );
    expect(toolResultEvent).toBeDefined();
    const resultStr = JSON.stringify(toolResultEvent!.result);
    expect(resultStr).toContain("requires a knowledge base");
    expect(resultStr).toContain("no KB");
  });

  test("runtime guard allows KB-scoped tool when KB scope is set", async () => {
    const registry = new ToolRegistry();
    const events: any[] = [];
    let executeCallCount = 0;

    registry.register({
      name: "fake_kb_search",
      description: "Fake KB search tool for testing",
      execute: async () => {
        executeCallCount++;
        return "search results";
      },
      requiresKbScope: true,
    });

    // Execution context WITH scopeKbIds — tool should be allowed
    registry.setExecutionContext({ scopeKbIds: ["kb-123"] });

    const mockRouter = createMockRouter([
      {
        content: "Let me search the KB",
        toolCalls: [
          {
            id: "call_kb_1",
            type: "function" as const,
            function: {
              name: "fake_kb_search",
              arguments: '{"query": "test"}',
            },
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: "Done",
        toolCalls: undefined,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const runner = new AgentRunner(mockRouter, registry);
    await runner.run({
      input: "Test KB scope guard (with KB)",
      onEvent: (event) => events.push(event),
    });

    // The tool's execute() SHOULD be called — scope is set
    expect(executeCallCount).toBe(1);

    const toolResultEvent = events.find(
      (e) => e.type === "tool_result" && e.toolName === "fake_kb_search",
    );
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent!.result).toBe("search results");
  });
});
