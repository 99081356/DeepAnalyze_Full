import { describe, it, expect, afterEach } from "bun:test";
import {
  resolveFeatureFlags,
  DEFAULT_FEATURE_FLAGS,
  type FeatureFlagConfig,
} from "../feature-flags.js";

describe("Feature Flags — Enhanced", () => {
  afterEach(() => {
    // Clean up all DA_ env vars
    delete process.env.DA_CONCURRENT_TOOLS;
    delete process.env.DA_PROMPT_CACHING;
    delete process.env.DA_STREAMING_TOOLS;
    delete process.env.DA_HIERARCHICAL_COMPACT;
    delete process.env.DA_CACHE_EDITING;
    delete process.env.DA_LONG_OUTPUT;
    delete process.env.DA_MAX_CONCURRENCY;
    delete process.env.DA_PLUGINS;
    delete process.env.DA_MARKDOWN_SKILLS;
    delete process.env.DA_CONTEXT_COLLAPSE;
  });

  // -----------------------------------------------------------------------
  // 1. contextCollapse defaults to true
  // -----------------------------------------------------------------------
  it("contextCollapse defaults to true", () => {
    const flags = resolveFeatureFlags();
    expect(flags.contextCollapse).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. env var overrides default
  // -----------------------------------------------------------------------
  it("env var DA_CONTEXT_COLLAPSE=false overrides default", () => {
    process.env.DA_CONTEXT_COLLAPSE = "false";
    const flags = resolveFeatureFlags();
    expect(flags.contextCollapse).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 3. dbConfig overrides default
  // -----------------------------------------------------------------------
  it("dbConfig overrides contextCollapse default", () => {
    const flags = resolveFeatureFlags({ contextCollapse: false });
    expect(flags.contextCollapse).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 4. env var has higher priority than dbConfig
  // -----------------------------------------------------------------------
  it("env var takes priority over dbConfig", () => {
    process.env.DA_CONTEXT_COLLAPSE = "true";
    const flags = resolveFeatureFlags({ contextCollapse: false });
    expect(flags.contextCollapse).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 5. All DEFAULT_FEATURE_FLAGS values are correct
  // -----------------------------------------------------------------------
  it("verifies all default flag values", () => {
    const expectedDefaults: FeatureFlagConfig = {
      concurrentToolExecution: true,
      promptCaching: true,
      streamingToolExecution: true,
      hierarchicalCompression: true,
      cacheEditing: true,
      longOutputContinuation: true,
      maxToolConcurrency: 10,
      pluginSystem: true,
      markdownSkills: true,
      contextCollapse: true,
      backgroundWorkflows: false,
    };

    for (const [key, value] of Object.entries(expectedDefaults)) {
      expect(DEFAULT_FEATURE_FLAGS[key as keyof FeatureFlagConfig]).toBe(value);
    }
  });
});
