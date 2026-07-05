// =============================================================================
// DeepAnalyze - Message Sequence Repair & Range Alignment Tests
// =============================================================================
// Tests for repairMessageSequence() and the range boundary alignment logic
// used in proactive compaction (generateMiddleSummary).
//
// These tests verify that sliced message ranges with orphaned tool_use/tool_result
// pairs are correctly repaired before being sent to any LLM provider.
// The repair is provider-agnostic — it works on the internal ChatMessage[] format.
// =============================================================================

import { describe, it, expect } from "bun:test";
import {
  repairMessageSequence,
  validateMessageSequence,
} from "../message-utils.js";
import { adjustIndexToPreserveInvariants } from "../compaction.js";
import type { ChatMessage } from "../../../models/provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sys(content: string): ChatMessage {
  return { role: "system", content };
}

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistant(
  content: string | null,
  toolCalls?: Array<{ id: string; name: string; args?: string }>,
): ChatMessage {
  if (toolCalls?.length) {
    return {
      role: "assistant",
      content,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args ?? "{}" },
      })),
    };
  }
  return { role: "assistant", content };
}

function tool(content: string, toolCallId: string): ChatMessage {
  return { role: "tool", content, toolCallId };
}

// ===========================================================================
// repairMessageSequence — Basic scenarios
// ===========================================================================

describe("repairMessageSequence: basic scenarios", () => {
  it("returns empty or single-element arrays unchanged", () => {
    expect(repairMessageSequence([])).toEqual([]);
    const single = [user("hello")];
    expect(repairMessageSequence(single)).toEqual(single);
  });

  it("leaves a clean sequence unchanged", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      user("search X"),
      assistant(null, [{ id: "tc_1", name: "kb_search" }]),
      tool("results", "tc_1"),
      assistant("here is the answer"),
    ];
    const repaired = repairMessageSequence(messages);
    expect(repaired).toEqual(messages);
  });

  it("handles multi-tool-call sequences correctly", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      user("analyze"),
      assistant(null, [
        { id: "tc_1", name: "kb_search" },
        { id: "tc_2", name: "expand" },
      ]),
      tool("search results", "tc_1"),
      tool("expand results", "tc_2"),
      assistant("done"),
    ];
    const repaired = repairMessageSequence(messages);
    expect(repaired).toEqual(messages);
  });
});

// ===========================================================================
// repairMessageSequence — Orphaned tool messages (sliced range)
// ===========================================================================

describe("repairMessageSequence: orphaned tool messages", () => {
  it("drops tool message at the start of a sliced range (no preceding assistant)", () => {
    // This simulates slicing that starts mid-group:
    // Original: [assistant(tc_1), tool("results", tc_1), user("next"), ...]
    // Slice from index 1: [tool("results", tc_1), user("next"), ...]
    const sliced: ChatMessage[] = [
      user("prompt"), // repairMessageSequence keeps the first message
      tool("results", "tc_1"), // orphaned — no assistant before it
      user("next question"),
      assistant("answer"),
    ];
    const repaired = repairMessageSequence(sliced);
    // The orphaned tool message should be dropped
    expect(repaired.some((m) => m.role === "tool")).toBe(false);
    expect(repaired).toEqual([
      user("prompt"),
      user("next question"),
      assistant("answer"),
    ]);
  });

  it("drops multiple consecutive orphaned tool messages", () => {
    // Slice that starts after assistant with multiple tool calls:
    // Original: [assistant(tc_1, tc_2), tool(r1, tc_1), tool(r2, tc_2), user("...")]
    // Slice from index 1: [tool(r1, tc_1), tool(r2, tc_2), user("...")]
    const sliced: ChatMessage[] = [
      user("prompt"),
      tool("r1", "tc_1"),
      tool("r2", "tc_2"),
      user("next"),
    ];
    const repaired = repairMessageSequence(sliced);
    expect(repaired.some((m) => m.role === "tool")).toBe(false);
  });

  it("preserves tool messages that have a valid preceding assistant", () => {
    const messages: ChatMessage[] = [
      user("prompt"),
      assistant(null, [{ id: "tc_1", name: "kb_search" }]),
      tool("results", "tc_1"),
      user("thanks"),
    ];
    const repaired = repairMessageSequence(messages);
    expect(repaired.some((m) => m.role === "tool")).toBe(true);
  });
});

// ===========================================================================
// repairMessageSequence — Missing tool results (truncated range)
// ===========================================================================

describe("repairMessageSequence: missing tool results", () => {
  it("synthesizes missing tool results for truncated assistant tool calls", () => {
    // Slice that includes assistant with 2 tool calls but only 1 tool result:
    // Original: [assistant(tc_1, tc_2), tool(r1, tc_1), tool(r2, tc_2), ...]
    // Slice to index 2: [assistant(tc_1, tc_2), tool(r1, tc_1)]
    const sliced: ChatMessage[] = [
      user("prompt"),
      assistant(null, [
        { id: "tc_1", name: "kb_search" },
        { id: "tc_2", name: "expand" },
      ]),
      tool("search results", "tc_1"),
      // tc_2 result is missing because the range was truncated
    ];
    const repaired = repairMessageSequence(sliced);
    // Should have synthesized a placeholder for tc_2
    const toolMessages = repaired.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(2);
    expect(toolMessages[1]!.toolCallId).toBe("tc_2");
    expect(toolMessages[1]!.content).toContain("省略");
  });

  it("synthesizes all missing tool results when none are present", () => {
    // Slice that has assistant with tool calls but no results at all
    const sliced: ChatMessage[] = [
      user("prompt"),
      assistant(null, [
        { id: "tc_a", name: "tool_a" },
        { id: "tc_b", name: "tool_b" },
        { id: "tc_c", name: "tool_c" },
      ]),
    ];
    const repaired = repairMessageSequence(sliced);
    const toolMessages = repaired.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(3);
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(["tc_a", "tc_b", "tc_c"]);
  });

  it("handles partial match — some results present, some missing", () => {
    const sliced: ChatMessage[] = [
      user("prompt"),
      assistant(null, [
        { id: "tc_1", name: "kb_search" },
        { id: "tc_2", name: "expand" },
        { id: "tc_3", name: "doc_grep" },
      ]),
      tool("search results", "tc_1"),
      tool("expand results", "tc_3"), // tc_2 result missing
    ];
    const repaired = repairMessageSequence(sliced);
    const toolMessages = repaired.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(3);
    // tc_1 and tc_3 have real results, tc_2 has synthesized
    const tc2Result = toolMessages.find((m) => m.toolCallId === "tc_2");
    expect(tc2Result).toBeDefined();
    expect(tc2Result!.content).toContain("省略");
  });
});

// ===========================================================================
// repairMessageSequence — Combined orphaned + missing
// ===========================================================================

describe("repairMessageSequence: combined orphaned and missing results", () => {
  it("handles a realistic sliced range from proactive compaction", () => {
    // Full conversation:
    // [0] system
    // [1] user "analyze"
    // [2] assistant(tc_1)
    // [3] tool("results", tc_1)     ← fromIndex=3 starts HERE (arbitrary)
    // [4] user "next"
    // [5] assistant(tc_2, tc_3)
    // [6] tool("r2", tc_2)
    // [7] tool("r3", tc_3)
    // [8] user "more"               ← toIndex=8 ends HERE
    // [9] assistant(tc_4)
    // [10] tool("r4", tc_4)

    // Sliced as [3, 8):
    // [0] tool("results", tc_1)   ← orphaned! No assistant before it in range
    // [1] user "next"
    // [2] assistant(tc_2, tc_3)
    // [3] tool("r2", tc_2)
    // [4] tool("r3", tc_3)
    // [5] user "more")

    const slicedRange: ChatMessage[] = [
      tool("results", "tc_1"), // orphaned — assistant is outside range
      user("next"),
      assistant(null, [
        { id: "tc_2", name: "kb_search" },
        { id: "tc_3", name: "expand" },
      ]),
      tool("r2", "tc_2"),
      tool("r3", "tc_3"),
      user("more"),
    ];

    const repaired = repairMessageSequence(slicedRange);
    // First message (tool) is orphaned and should be dropped
    expect(repaired[0]!.role).not.toBe("tool");
    // The valid tool group should be preserved
    const validTools = repaired.filter((m) => m.role === "tool");
    expect(validTools.length).toBe(2);
    expect(validTools.map((m) => m.toolCallId)).toEqual(["tc_2", "tc_3"]);
  });

  it("handles trailing assistant with tool calls but no results (sliced at end)", () => {
    // Range ends right after an assistant with tool calls
    const slicedRange: ChatMessage[] = [
      user("prompt"),
      assistant(null, [{ id: "tc_1", name: "kb_search" }]),
      // No tool result — range was sliced before the result arrived
    ];

    const repaired = repairMessageSequence(slicedRange);
    const toolMessages = repaired.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(1);
    expect(toolMessages[0]!.toolCallId).toBe("tc_1");
  });
});

// ===========================================================================
// validateMessageSequence — Verify repair produces valid sequences
// ===========================================================================

describe("validateMessageSequence: post-repair validation", () => {
  it("repaired sequences pass validation", () => {
    const cases: ChatMessage[][] = [
      // Case 1: Clean sequence
      [
        sys("system"),
        user("hello"),
        assistant(null, [{ id: "tc_1", name: "kb_search" }]),
        tool("results", "tc_1"),
        assistant("done"),
      ],
      // Case 2: After repair of orphaned tool
      repairMessageSequence([
        tool("orphaned", "tc_x"),
        user("prompt"),
        assistant(null, [{ id: "tc_1", name: "tool" }]),
        tool("result", "tc_1"),
      ]),
      // Case 3: After repair of missing results
      repairMessageSequence([
        user("prompt"),
        assistant(null, [
          { id: "tc_1", name: "a" },
          { id: "tc_2", name: "b" },
        ]),
        tool("r1", "tc_1"),
      ]),
    ];

    for (const msgs of cases) {
      const result = validateMessageSequence(msgs);
      expect(result.valid).toBe(true);
    }
  });
});

// ===========================================================================
// Range boundary alignment simulation
// ===========================================================================
// These tests simulate the alignment logic added to generateMiddleSummary.
// They don't call generateMiddleSummary directly (that needs a full
// CompactionEngine), but test the same algorithm in isolation.

describe("Range boundary alignment for proactive compaction", () => {
  /**
   * Simulates the alignment logic from generateMiddleSummary.
   * Walks start forward past leading tool messages, walks end backward past
   * trailing assistant messages with toolCalls.
   */
  function alignRange(
    messages: ChatMessage[],
    fromIndex: number,
    toIndex: number,
  ): { start: number; end: number } {
    let start = Math.max(1, fromIndex);
    if (start >= messages.length - 1) return { start, end: toIndex };
    if (toIndex <= start) return { start, end: toIndex };

    // Walk start forward past any leading tool messages
    while (start < toIndex && messages[start]?.role === "tool") {
      start++;
    }
    // Walk end backward past any trailing assistant messages with toolCalls
    while (
      toIndex > start &&
      messages[toIndex - 1]?.role === "assistant" &&
      (messages[toIndex - 1]?.toolCalls?.length ?? 0) > 0
    ) {
      toIndex--;
    }

    return { start, end: toIndex };
  }

  it("does not shift clean boundaries", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      user("hello"),
      assistant("hi"),
      user("search"),
      assistant(null, [{ id: "tc_1", name: "kb_search" }]),
      tool("results", "tc_1"),
      user("next"),
    ];
    const { start, end } = alignRange(messages, 2, 6);
    // Index 2 is assistant("hi") — not a tool, no shift needed
    // Index 6 is user("next") — not an assistant with toolCalls, no shift needed
    expect(start).toBe(2);
    expect(end).toBe(6);
  });

  it("shifts start forward past leading tool messages", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      user("hello"),
      assistant(null, [{ id: "tc_1", name: "kb_search" }]), // index 2
      tool("results", "tc_1"), // index 3 — start would land here
      tool("results2", "tc_1"), // index 4 (hypothetical duplicate)
      user("next"), // index 5
    ];
    const { start, end } = alignRange(messages, 3, 5);
    // Should skip index 3 (tool) and index 4 (tool), land on 5 (user)
    expect(start).toBe(5);
  });

  it("shifts end backward past trailing assistant with toolCalls", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      user("hello"),
      assistant("hi"),
      user("search"),
      assistant(null, [{ id: "tc_1", name: "kb_search" }]), // index 4 — end would land here
      tool("results", "tc_1"), // index 5
    ];
    // toIndex=5 means slice [..., 5), so last included is index 4
    // Index 4 is assistant with toolCalls → shift backward
    const { start, end } = alignRange(messages, 2, 5);
    expect(end).toBe(4); // shifted back to exclude the orphaned assistant
  });

  it("handles both start and end needing adjustment", () => {
    const messages: ChatMessage[] = [
      sys("system"), // 0
      user("q1"), // 1
      assistant(null, [{ id: "tc_1", name: "kb_search" }]), // 2
      tool("r1", "tc_1"), // 3 ← fromIndex=3 lands here (orphaned tool)
      user("q2"), // 4
      assistant(null, [{ id: "tc_2", name: "expand" }]), // 5 ← toIndex=6 means last included=5 (orphaned assistant)
      tool("r2", "tc_2"), // 6
    ];
    const { start, end } = alignRange(messages, 3, 6);
    // start should skip past index 3 (tool) to index 4 (user)
    expect(start).toBe(4);
    // end should skip past index 5 (assistant with toolCalls) to index 4
    expect(end).toBe(5); // 5→4? Wait, let me trace: toIndex=6, messages[5] is assistant with toolCalls → toIndex becomes 5
    // Now messages[4] is user, not assistant with toolCalls → stop
    expect(end).toBe(5);
    // So range [4, 5) = just index 4 (user "q2") — very narrow but valid
  });

  it("returns empty range when all messages are tool/assistant-with-tools", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      assistant(null, [{ id: "tc_1", name: "a" }]),
      tool("r1", "tc_1"),
      assistant(null, [{ id: "tc_2", name: "b" }]),
      tool("r2", "tc_2"),
    ];
    const { start, end } = alignRange(messages, 2, 4);
    // start=2 is tool → skip → start=3
    // messages[3] is assistant with toolCalls, toIndex=4 means last=3 → end shifts to 3
    // start=3, end=3 → empty range
    // Actually let's re-check: toIndex=4, messages[3] is assistant with toolCalls → end=3
    // start=3, end=3 → start >= end... but this is handled by caller
    expect(start >= end).toBe(true);
  });
});

// ===========================================================================
// adjustIndexToPreserveInvariants — already tested but let's add edge cases
// ===========================================================================

describe("adjustIndexToPreserveInvariants: additional edge cases", () => {
  it("handles deeply nested tool call chains", () => {
    // Multiple rounds of tool calls
    const messages: ChatMessage[] = [
      sys("system"),
      user("start"),
      assistant(null, [{ id: "tc_1", name: "a" }]),
      tool("r1", "tc_1"),
      assistant(null, [{ id: "tc_2", name: "b" }]),
      tool("r2", "tc_2"),
      assistant(null, [{ id: "tc_3", name: "c" }]),
      tool("r3", "tc_3"),
      user("done"),
    ];

    // If we try to cut at index 5 (keeping tool r2 onward), tc_2's assistant is at 4
    // but the tool_result for tc_2 is at 5. Cutting at 5 keeps tc_2 result but loses tc_2 assistant.
    const result = adjustIndexToPreserveInvariants(messages, 5);
    // Should pull back to include assistant with tc_2
    expect(result).toBeLessThanOrEqual(4);
  });

  it("returns unchanged index when no tool calls exist", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      user("hello"),
      assistant("hi"),
      user("bye"),
      assistant("bye"),
    ];
    expect(adjustIndexToPreserveInvariants(messages, 2)).toBe(2);
    expect(adjustIndexToPreserveInvariants(messages, 3)).toBe(3);
  });
});

// ===========================================================================
// Integration: slice → align → repair → validate
// ===========================================================================

describe("Integration: full proactive compaction message preparation pipeline", () => {
  /**
   * Simulates the full pipeline:
   * 1. Slice messages at arbitrary indices
   * 2. Align boundaries
   * 3. Repair the sliced range
   * 4. Validate the result
   */
  function prepareRangeForSummarizer(
    messages: ChatMessage[],
    fromIndex: number,
    toIndex: number,
  ): { range: ChatMessage[]; valid: boolean; issues: string[] } {
    // Step 1: Align boundaries
    let start = Math.max(1, fromIndex);
    if (start >= messages.length - 1 || toIndex <= start) {
      return { range: [], valid: true, issues: [] };
    }
    while (start < toIndex && messages[start]?.role === "tool") {
      start++;
    }
    while (
      toIndex > start &&
      messages[toIndex - 1]?.role === "assistant" &&
      (messages[toIndex - 1]?.toolCalls?.length ?? 0) > 0
    ) {
      toIndex--;
    }
    if (toIndex <= start) {
      return { range: [], valid: true, issues: [] };
    }

    // Step 2: Slice
    const sliced = messages.slice(start, toIndex);

    // Step 3: Repair
    const repaired = repairMessageSequence(sliced);

    // Step 4: Validate
    const validation = validateMessageSequence(repaired);

    return { range: repaired, valid: validation.valid, issues: validation.issues };
  }

  it("handles realistic multi-turn conversation sliced in the middle", () => {
    const messages: ChatMessage[] = [
      sys("system"), // 0
      user("analyze the data"), // 1
      assistant(null, [{ id: "tc_1", name: "kb_search" }]), // 2
      tool("found 50 docs", "tc_1"), // 3
      assistant(null, [{ id: "tc_2", name: "expand" }]), // 4
      tool("expanded content", "tc_2"), // 5
      assistant("let me check more"), // 6
      user("check file X"), // 7
      assistant(null, [{ id: "tc_3", name: "read_file" }]), // 8
      tool("file content here", "tc_3"), // 9
      assistant(null, [{ id: "tc_4", name: "grep", args: '{"pattern":"error"}' }]), // 10
      tool("grep results", "tc_4"), // 11
      user("now summarize"), // 12
      assistant("here is the summary"), // 13
    ];

    // Slice at arbitrary points: fromIndex=3 (tool!), toIndex=11 (tool)
    const result = prepareRangeForSummarizer(messages, 3, 11);
    expect(result.valid).toBe(true);
    expect(result.range.length).toBeGreaterThan(0);
    // No orphaned tool messages
    for (let i = 0; i < result.range.length; i++) {
      if (result.range[i]!.role === "tool") {
        expect(result.range[i - 1]!.role).toBe("assistant");
      }
    }
  });

  it("handles slice that starts and ends in the middle of tool groups", () => {
    const messages: ChatMessage[] = [
      sys("system"), // 0
      user("query"), // 1
      assistant(null, [{ id: "tc_1", name: "a" }, { id: "tc_2", name: "b" }]), // 2
      tool("r1", "tc_1"), // 3 ← fromIndex lands here
      tool("r2", "tc_2"), // 4
      assistant("processing"), // 5
      assistant(null, [{ id: "tc_3", name: "c" }]), // 6
      tool("r3", "tc_3"), // 7
      assistant(null, [{ id: "tc_4", name: "d" }]), // 8 ← toIndex lands after here
      tool("r4", "tc_4"), // 9
      user("final"), // 10
    ];

    // fromIndex=3 (tool result for tc_1), toIndex=9 (between tool and user)
    // After alignment: start skips tool at 3 and 4, lands on 5
    // end: messages[8] is assistant with toolCalls → end becomes 8
    // messages[7] is tool, not assistant with toolCalls → stop
    const result = prepareRangeForSummarizer(messages, 3, 9);
    expect(result.valid).toBe(true);
  });

  it("handles empty conversation gracefully", () => {
    const messages: ChatMessage[] = [
      sys("system"),
    ];
    const result = prepareRangeForSummarizer(messages, 1, 1);
    expect(result.range).toEqual([]);
  });

  it("handles conversation with no tool calls at all", () => {
    const messages: ChatMessage[] = [
      sys("system"),
      user("hello"),
      assistant("hi there"),
      user("how are you"),
      assistant("doing well"),
      user("great"),
    ];
    const result = prepareRangeForSummarizer(messages, 1, 5);
    expect(result.valid).toBe(true);
    expect(result.range.length).toBeGreaterThan(0);
  });

  it("handles alternating tool groups — realistic proactive compaction scenario", () => {
    // Build a realistic long conversation with many tool calls
    const messages: ChatMessage[] = [
      sys("system"),
      user("complex analysis task"),
    ];

    // Add 10 rounds of tool usage
    for (let i = 0; i < 10; i++) {
      messages.push(
        assistant(null, [
          { id: `tc_${i}_a`, name: "kb_search" },
          { id: `tc_${i}_b`, name: "expand" },
        ]),
      );
      messages.push(tool(`search results ${i}`, `tc_${i}_a`));
      messages.push(tool(`expand results ${i}`, `tc_${i}_b`));
      messages.push(assistant(`analysis round ${i}`));
    }

    messages.push(user("final summary request"));

    // Simulate proactive compaction: compact middle third
    const fromIndex = 2;
    const toIndex = messages.length - 5;

    const result = prepareRangeForSummarizer(messages, fromIndex, toIndex);
    expect(result.valid).toBe(true);
    expect(result.range.length).toBeGreaterThan(0);

    // Verify no orphaned tool messages
    for (let i = 1; i < result.range.length; i++) {
      if (result.range[i]!.role === "tool") {
        // Find the nearest preceding assistant
        let foundAssistant = false;
        for (let j = i - 1; j >= 0; j--) {
          if (result.range[j]!.role === "assistant") {
            foundAssistant = true;
            break;
          }
        }
        expect(foundAssistant).toBe(true);
      }
    }
  });
});

// ===========================================================================
// Provider format compatibility — structural guarantees
// ===========================================================================

describe("Provider format compatibility: structural guarantees after repair", () => {
  it("produces sequences valid for OpenAI-compatible format (MiniMax, GLM, etc.)", () => {
    // OpenAI-compatible format requires:
    // - tool messages must have tool_call_id matching a preceding assistant's tool_calls[].id
    // - assistant with tool_calls must have all results before next user message
    const cases = [
      // Case 1: Sliced at start of tool group
      repairMessageSequence([
        tool("orphan", "tc_x"),
        user("prompt"),
        assistant(null, [{ id: "tc_1", name: "search" }]),
        tool("results", "tc_1"),
      ]),
      // Case 2: Sliced at end of tool group
      repairMessageSequence([
        user("prompt"),
        assistant(null, [{ id: "tc_1", name: "search" }]),
      ]),
      // Case 3: Sliced in middle of multi-tool group
      repairMessageSequence([
        user("prompt"),
        assistant(null, [
          { id: "tc_1", name: "a" },
          { id: "tc_2", name: "b" },
          { id: "tc_3", name: "c" },
        ]),
        tool("r1", "tc_1"),
      ]),
    ];

    for (const repaired of cases) {
      // Every tool message must have a toolCallId
      const toolMsgs = repaired.filter((m) => m.role === "tool");
      for (const tm of toolMsgs) {
        expect(tm.toolCallId).toBeDefined();
        expect(tm.toolCallId!.length).toBeGreaterThan(0);
      }

      // Every tool message must follow an assistant message
      for (let i = 0; i < repaired.length; i++) {
        if (repaired[i]!.role === "tool" && i > 0) {
          expect(repaired[i - 1]!.role).toMatch(/^(assistant|tool)$/);
        }
      }

      // Every assistant with toolCalls must have matching tool results
      for (let i = 0; i < repaired.length; i++) {
        const msg = repaired[i]!;
        if (msg.role === "assistant" && msg.toolCalls?.length) {
          const callIds = msg.toolCalls.map((tc) => tc.id);
          const resultIds: string[] = [];
          for (let j = i + 1; j < repaired.length && repaired[j]!.role === "tool"; j++) {
            if (repaired[j]!.toolCallId) {
              resultIds.push(repaired[j]!.toolCallId!);
            }
          }
          // All call IDs should have results
          for (const callId of callIds) {
            expect(resultIds).toContain(callId);
          }
        }
      }
    }
  });

  it("produces sequences valid for Anthropic-compatible format", () => {
    // Anthropic format requires:
    // - tool_use blocks in assistant content must have matching tool_result blocks
    // - The adapter converts our internal format, but the invariants are the same
    const repaired = repairMessageSequence([
      user("prompt"),
      assistant(null, [
        { id: "tc_1", name: "search" },
        { id: "tc_2", name: "expand" },
      ]),
      tool("search results", "tc_1"),
      // tc_2 missing → synthesized
    ]);

    // Verify the structural invariants that Anthropic adapter relies on
    const assistantIdx = repaired.findIndex(
      (m) => m.role === "assistant" && m.toolCalls?.length,
    );
    expect(assistantIdx).toBe(1);

    // Count tool results following the assistant
    let toolResultCount = 0;
    for (let i = assistantIdx + 1; i < repaired.length; i++) {
      if (repaired[i]!.role === "tool") toolResultCount++;
      else break;
    }
    expect(toolResultCount).toBe(
      repaired[assistantIdx]!.toolCalls!.length,
    );
  });
});
