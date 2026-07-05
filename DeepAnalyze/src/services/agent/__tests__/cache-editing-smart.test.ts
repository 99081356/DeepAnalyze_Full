import { describe, it, expect } from "bun:test";
import { applySmartCacheEditing } from "../cache-editing.js";
import type { ChatMessage } from "../../../models/provider.js";

/** Generate a string of the given KB size. */
function makeContent(kb: number): string {
  return "x".repeat(kb * 1024);
}

describe("applySmartCacheEditing", () => {
  // -----------------------------------------------------------------------
  // 1. Empty messages array returns empty array
  // -----------------------------------------------------------------------
  it("returns empty array for empty input", () => {
    const result = applySmartCacheEditing([]);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 2. Citation tool result preserved longer
  // -----------------------------------------------------------------------
  it("citation tool (kb_search) preserves more content than generic", () => {
    const longContent = makeContent(20); // 20KB

    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [{ id: "tc-1", type: "function", function: { name: "kb_search", arguments: "{}" } }],
      },
      { role: "tool", content: longContent, toolCallId: "tc-1" },
      // Need a recent turn so old one gets truncated
      { role: "assistant", content: "recent" },
      { role: "tool", content: "short", toolCallId: "tc-recent" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 1,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    // Old kb_search result should be truncated but retain ~16KB + tail
    const oldTool = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "tc-1")!;
    const content = oldTool.content as string;
    expect(content.length).toBeGreaterThan(15000);
    expect(content).toContain("citation data truncated");
  });

  // -----------------------------------------------------------------------
  // 3. Generic tool generates structured summary
  // -----------------------------------------------------------------------
  it("generic tool (read_file) gets structured summary", () => {
    const longContent = makeContent(20); // 20KB

    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [{ id: "tc-2", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: longContent, toolCallId: "tc-2" },
      { role: "assistant", content: "recent" },
      { role: "tool", content: "short", toolCallId: "tc-recent" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 1,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    const oldTool = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "tc-2")!;
    const content = oldTool.content as string;
    expect(content).toContain("[Tool result condensed from 20KB]");
    expect(content).toContain("[Original:");
    expect(content).toContain("lines");
    expect(content.length).toBeLessThan(longContent.length);
  });

  // -----------------------------------------------------------------------
  // 4. Short results are not truncated
  // -----------------------------------------------------------------------
  it("short results below threshold are not truncated", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [{ id: "tc-3", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: "small result", toolCallId: "tc-3" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 0,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    const tool = result.find((m) => m.role === "tool")!;
    expect(tool.content).toBe("small result");
  });

  // -----------------------------------------------------------------------
  // 5. Citation tool vs generic tool differentiation
  // -----------------------------------------------------------------------
  it("citation tool retains more content than generic tool of same size", () => {
    const content20k = makeContent(20);

    // Citation tool message set
    const citationMsgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "a",
        toolCalls: [{ id: "cit", type: "function", function: { name: "kb_search", arguments: "{}" } }],
      },
      { role: "tool", content: content20k, toolCallId: "cit" },
      { role: "assistant", content: "recent" },
    ];

    // Generic tool message set
    const genericMsgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "a",
        toolCalls: [{ id: "gen", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: content20k, toolCallId: "gen" },
      { role: "assistant", content: "recent" },
    ];

    const citationResult = applySmartCacheEditing(citationMsgs, {
      keepRecentTurns: 0,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });
    const genericResult = applySmartCacheEditing(genericMsgs, {
      keepRecentTurns: 0,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    const citLen = (citationResult.find((m) => m.role === "tool")!.content as string).length;
    const genLen = (genericResult.find((m) => m.role === "tool")!.content as string).length;
    expect(citLen).toBeGreaterThan(genLen);
  });

  // -----------------------------------------------------------------------
  // 6. toolCallId correctly maps to tool name
  // -----------------------------------------------------------------------
  it("maps toolCallId to tool name from preceding assistant message", () => {
    const longContent = makeContent(20);

    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "working",
        toolCalls: [
          { id: "tc-kb", type: "function", function: { name: "kb_search", arguments: "{}" } },
          { id: "tc-rf", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", content: longContent, toolCallId: "tc-kb" },
      { role: "tool", content: longContent, toolCallId: "tc-rf" },
      { role: "assistant", content: "recent" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 1,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    const kbTool = result.find((m) => "toolCallId" in m && m.toolCallId === "tc-kb")!;
    const rfTool = result.find((m) => "toolCallId" in m && m.toolCallId === "tc-rf")!;

    // kb_search is citation tool → keeps more content
    expect((kbTool.content as string).length).toBeGreaterThan((rfTool.content as string).length);
    // read_file is generic → gets structured summary
    expect(rfTool.content as string).toContain("[Tool result condensed from");
  });

  // -----------------------------------------------------------------------
  // 7. Unknown toolCallId treated as generic
  // -----------------------------------------------------------------------
  it("unknown toolCallId is treated as generic tool", () => {
    const longContent = makeContent(20);

    const msgs: ChatMessage[] = [
      { role: "assistant", content: "a" },
      // No toolCalls on this assistant, so toolNameMap won't have "tc-unknown"
      { role: "tool", content: longContent, toolCallId: "tc-unknown" },
      { role: "assistant", content: "recent" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 1,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    const tool = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "tc-unknown")!;
    // Should be condensed as generic tool
    expect((tool.content as string).length).toBeLessThan(longContent.length);
  });

  // -----------------------------------------------------------------------
  // 8. keepRecentTurns preserves the last N assistant turns
  // -----------------------------------------------------------------------
  it("keepRecentTurns preserves recent turns without truncation", () => {
    const longContent = makeContent(20);

    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "a",
        toolCalls: [{ id: "old-tc", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: longContent, toolCallId: "old-tc" },
      {
        role: "assistant",
        content: "recent",
        toolCalls: [{ id: "new-tc", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: longContent, toolCallId: "new-tc" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 1,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    // The last tool result (associated with the recent assistant turn) should be unchanged
    const recentTool = result.find((m) => "toolCallId" in m && m.toolCallId === "new-tc")!;
    expect(recentTool.content).toBe(longContent);
  });

  // -----------------------------------------------------------------------
  // 9. Original array is not modified
  // -----------------------------------------------------------------------
  it("does not modify the original messages array", () => {
    const longContent = makeContent(20);
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "a" },
      { role: "tool", content: longContent, toolCallId: "t1" },
    ];
    const originalRef = msgs;
    const originalContent = msgs[1].content;

    applySmartCacheEditing(msgs, {
      keepRecentTurns: 0,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    // Same reference and same content — not mutated
    expect(msgs).toBe(originalRef);
    expect(msgs[1].content).toBe(originalContent);
  });

  // -----------------------------------------------------------------------
  // 10. ContentPart[] content is handled
  // -----------------------------------------------------------------------
  it("handles ContentPart[] in tool messages", () => {
    const longText = makeContent(20);

    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "a",
        toolCalls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      {
        role: "tool",
        content: [{ type: "text" as const, text: longText }],
        toolCallId: "t1",
      },
      // Recent turn to make the above "old"
      { role: "assistant", content: "recent" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 1,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    const tool = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "t1")!;
    // ContentPart[] gets JSON.stringify'd in the function, so the result should be a string summary
    const content = typeof tool.content === "string" ? tool.content : "";
    expect(content.length).toBeLessThan(longText.length);
  });

  // -----------------------------------------------------------------------
  // 11. generateSmartSummary format verification
  // -----------------------------------------------------------------------
  it("structured summary contains expected format markers", () => {
    // Create content with multiple lines to test line count
    const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: some content here`);
    const longContent = lines.join("\n");

    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "a",
        toolCalls: [{ id: "tc-sum", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: longContent, toolCallId: "tc-sum" },
      // Recent turn to make the above "old"
      { role: "assistant", content: "recent" },
    ];

    const result = applySmartCacheEditing(msgs, {
      keepRecentTurns: 1,
      maxCitationResultChars: 16000,
      maxGenericResultChars: 4000,
    });

    const tool = result.find((m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "tc-sum")!;
    const content = tool.content as string;

    expect(content).toContain("[Tool result condensed from");
    expect(content).toContain("[Original:");
    expect(content).toContain("lines");
    expect(content).toContain("KB]");
  });
});
