import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../tool-registry.js";

describe("ToolRegistry.validateToolInput", () => {
  const registry = new ToolRegistry();

  // Register a test tool with schema
  registry.register({
    name: "test_tool",
    description: "Test",
    execute: async () => null,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Result count" },
        tags: { type: "array", description: "Tags" },
        enabled: { type: "boolean", description: "Enabled flag" },
      },
      required: ["query"],
    },
  });

  it("passes valid input with required field", () => {
    const result = registry.validateToolInput("test_tool", { query: "hello" }, registry.get("test_tool")!.inputSchema!);
    expect(result.valid).toBe(true);
  });

  it("fails when required field is missing", () => {
    const result = registry.validateToolInput("test_tool", { count: 5 }, registry.get("test_tool")!.inputSchema!);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("query");
  });

  it("fails when field type is wrong (string vs number)", () => {
    const result = registry.validateToolInput("test_tool", { query: "hello", count: "five" }, registry.get("test_tool")!.inputSchema!);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("count");
    expect(result.error).toContain("number");
  });

  it("fails when field type is wrong (string vs boolean)", () => {
    const result = registry.validateToolInput("test_tool", { query: "hello", enabled: "yes" }, registry.get("test_tool")!.inputSchema!);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("enabled");
  });

  it("passes when optional fields are omitted", () => {
    const result = registry.validateToolInput("test_tool", { query: "hello" }, registry.get("test_tool")!.inputSchema!);
    expect(result.valid).toBe(true);
  });

  it("passes when all fields are correct types", () => {
    const result = registry.validateToolInput("test_tool", { query: "hello", count: 5, tags: ["a"], enabled: true }, registry.get("test_tool")!.inputSchema!);
    expect(result.valid).toBe(true);
  });

  it("passes when schema has no properties", () => {
    const result = registry.validateToolInput("test_tool", {}, { type: "object" });
    expect(result.valid).toBe(true);
  });
});
