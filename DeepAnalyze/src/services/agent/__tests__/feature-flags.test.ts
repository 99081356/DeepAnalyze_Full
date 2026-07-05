import { describe, it, expect, afterEach } from "bun:test";
import { resolveFeatureFlags, DEFAULT_FEATURE_FLAGS } from "../feature-flags.js";

describe("Feature Flags", () => {
  afterEach(() => {
    // Clean up env vars
    delete process.env.DA_CONCURRENT_TOOLS;
    delete process.env.DA_MAX_CONCURRENCY;
  });

  it("returns defaults when no config", () => {
    const flags = resolveFeatureFlags();
    expect(flags.concurrentToolExecution).toBe(DEFAULT_FEATURE_FLAGS.concurrentToolExecution);
  });

  it("overrides with db config", () => {
    const flags = resolveFeatureFlags({ concurrentToolExecution: false });
    expect(flags.concurrentToolExecution).toBe(false);
  });

  it("overrides with env var", () => {
    process.env.DA_CONCURRENT_TOOLS = "false";
    const flags = resolveFeatureFlags({ concurrentToolExecution: true });
    expect(flags.concurrentToolExecution).toBe(false);
  });

  it("parses numeric env var", () => {
    process.env.DA_MAX_CONCURRENCY = "5";
    const flags = resolveFeatureFlags();
    expect(flags.maxToolConcurrency).toBe(5);
  });

  it("env var takes priority over db config", () => {
    process.env.DA_CONCURRENT_TOOLS = "true";
    const flags = resolveFeatureFlags({ concurrentToolExecution: false });
    expect(flags.concurrentToolExecution).toBe(true);
  });
});
