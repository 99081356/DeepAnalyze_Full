import { describe, it, expect } from "bun:test";
import { needsContinuation, buildContinuationMessage, shouldSegmentOutput, DEFAULT_CONTINUATION_CONFIG } from "../long-io.js";

describe("long-io", () => {
  it("needsContinuation returns true for 'length'", () => {
    expect(needsContinuation("length")).toBe(true);
  });

  it("needsContinuation returns false for 'stop'", () => {
    expect(needsContinuation("stop")).toBe(false);
  });

  it("needsContinuation detects mid-sentence truncation with 'stop' + content", () => {
    const longContent = "这是一段很长的文本，用于测试MiniMax模型在输出截断时返回stop的情况。".repeat(10);
    // Ends mid-sentence (no punctuation)
    const truncated = longContent + "针对未来AI芯片特";
    expect(needsContinuation("stop", truncated)).toBe(true);
  });

  it("needsContinuation returns false for 'stop' with sentence-ending content", () => {
    const content = "这是一段正常结束的文本。".repeat(20);
    expect(needsContinuation("stop", content)).toBe(false);
  });

  it("needsContinuation returns false for 'stop' with short content", () => {
    expect(needsContinuation("stop", "短文本")).toBe(false);
  });

  it("needsContinuation returns false for undefined", () => {
    expect(needsContinuation(undefined)).toBe(false);
  });

  it("buildContinuationMessage returns user message", () => {
    const msg = buildContinuationMessage();
    expect(msg.role).toBe("user");
    expect(msg.content).toBeTruthy();
  });

  it("buildContinuationMessage uses custom prompt", () => {
    const msg = buildContinuationMessage({ continuationPrompt: "Custom prompt" });
    expect(msg.content).toBe("Custom prompt");
  });

  it("shouldSegmentOutput returns true for large output", () => {
    expect(shouldSegmentOutput(60_000)).toBe(true);
  });

  it("shouldSegmentOutput returns false for small output", () => {
    expect(shouldSegmentOutput(10_000)).toBe(false);
  });

  it("DEFAULT_CONTINUATION_CONFIG has maxContinuations", () => {
    expect(DEFAULT_CONTINUATION_CONFIG.maxContinuations).toBe(5);
  });
});
