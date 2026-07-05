import { describe, it, expect } from "bun:test";
import { applyCacheEditing } from "../cache-editing.js";
import type { ChatMessage } from "../../../models/provider.js";

describe("applyCacheEditing", () => {
  it("returns empty array for empty input", () => {
    const result = applyCacheEditing([]);
    expect(result).toEqual([]);
  });

  it("does not modify messages without tool results", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ];
    const result = applyCacheEditing(msgs);
    expect(result).toEqual(msgs);
  });

  it("truncates old tool results exceeding maxResultChars", () => {
    const longResult = "x".repeat(20000);
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "thinking..." },
      { role: "tool", content: longResult, toolCallId: "old-1" },
      // Recent turn (kept)
      { role: "assistant", content: "more" },
      { role: "tool", content: "short", toolCallId: "new-1" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 1, maxResultChars: 1000 });
    // Old tool result should be truncated
    const oldTool = result.find(
      (m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "old-1",
    );
    expect((oldTool!.content as string).length).toBeLessThan(longResult.length);
    expect(oldTool!.content).toContain("truncated");
    // Recent tool result should be unchanged
    const newTool = result.find(
      (m) => m.role === "tool" && "toolCallId" in m && m.toolCallId === "new-1",
    );
    expect(newTool!.content).toBe("short");
  });

  it("does not modify small tool results", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "old" },
      { role: "tool", content: "small result", toolCallId: "t1" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 1000 });
    const tool = result.find((m) => m.role === "tool");
    expect(tool!.content).toBe("small result");
  });

  it("returns new array without modifying original", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "a" },
      { role: "tool", content: "x".repeat(20000), toolCallId: "t1" },
    ];
    const originalContent = msgs[1].content;
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 1000 });
    expect(result).not.toBe(msgs);
    expect(msgs[1].content).toBe(originalContent); // original unchanged
  });

  it("preserves all non-tool messages", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "x".repeat(20000), toolCallId: "t1" },
      { role: "assistant", content: "final" },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 500 });
    // All non-tool messages preserved
    expect(result[0]).toEqual(msgs[0]); // system
    expect(result[1]).toEqual(msgs[1]); // user
    expect(result[2]).toEqual(msgs[2]); // assistant
    expect(result[4]).toEqual(msgs[4]); // assistant (recent)
    // Tool result truncated
    expect((result[3].content as string).length).toBeLessThan(20000);
  });

  it("handles ContentPart[] in tool messages by stringifying", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "old" },
      {
        role: "tool",
        content: [{ type: "text" as const, text: "x".repeat(20000) }],
        toolCallId: "t1",
      },
    ];
    const result = applyCacheEditing(msgs, { keepRecentTurns: 0, maxResultChars: 500 });
    const tool = result.find((m) => m.role === "tool");
    expect(typeof tool!.content === "string" ? tool!.content : "").toContain("truncated");
  });

  it("does not truncate when all turns are within keepRecentTurns", () => {
    const longResult = "y".repeat(20000);
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "a1" },
      { role: "tool", content: longResult, toolCallId: "t1" },
      { role: "assistant", content: "a2" },
      { role: "tool", content: longResult, toolCallId: "t2" },
    ];
    // keepRecentTurns=10 means both assistant turns are "recent"
    const result = applyCacheEditing(msgs, { keepRecentTurns: 10, maxResultChars: 1000 });
    // Neither should be truncated
    const tools = result.filter((m) => m.role === "tool");
    expect(tools[0].content).toBe(longResult);
    expect(tools[1].content).toBe(longResult);
  });
});
