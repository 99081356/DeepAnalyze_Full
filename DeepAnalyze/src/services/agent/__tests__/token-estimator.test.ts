import { describe, it, expect } from "bun:test";
import { TokenEstimator } from "../token-estimator.js";

describe("TokenEstimator", () => {
  it("uses conservative estimation by default", () => {
    const estimator = new TokenEstimator();
    const tokens = estimator.estimateMessage({
      role: "user",
      content: "Hello, this is a test message with some content.",
    });
    // Conservative: ~46 chars / 3 * 4/3 + 10 overhead ≈ 30
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it("uses API-reported value when available", () => {
    const estimator = new TokenEstimator();
    // Hash is role + first 100 chars of content joined by "|"
    const content = "Hello, this is a test message with some content.";
    const expectedHash = `user|${content.slice(0, 100)}`;
    estimator.reportUsage(expectedHash, 42);
    const tokens = estimator.estimateMessage({
      role: "user",
      content,
    });
    expect(tokens).toBe(42);
  });

  it("accounts for tool call overhead", () => {
    const estimator = new TokenEstimator();
    const withoutTools = estimator.estimateMessage({ role: "assistant", content: "test" });
    const withTools = estimator.estimateMessage({
      role: "assistant",
      content: "test",
      toolCalls: [
        { function: { arguments: '{"query":"test"}' } },
      ],
    });
    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("estimates total for message array", () => {
    const estimator = new TokenEstimator();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const total = estimator.estimateMessages(messages);
    expect(total).toBeGreaterThan(0);
  });

  it("clear resets reported values", () => {
    const estimator = new TokenEstimator();
    estimator.reportUsage("user|Hello", 10);
    expect(estimator.estimateMessage({ role: "user", content: "Hello" })).toBe(10);
    estimator.clear();
    expect(estimator.estimateMessage({ role: "user", content: "Hello" })).not.toBe(10);
  });
});
