// =============================================================================
// DeepAnalyze - ToolRegistry Tests
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { ToolRegistry } from "../src/services/agent/tool-registry.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ---------------------------------------------------------------------------
  // Built-in tools
  // ---------------------------------------------------------------------------

  test("has built-in think, finish, and context_expand tools", () => {
    expect(registry.has("think")).toBe(true);
    expect(registry.has("finish")).toBe(true);
    expect(registry.has("context_expand")).toBe(true);
  });

  test("getAll returns at least the three built-in tools", () => {
    const all = registry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const names = all.map((t) => t.name);
    expect(names).toContain("think");
    expect(names).toContain("finish");
    expect(names).toContain("context_expand");
  });

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  test("registers a custom tool and retrieves it", () => {
    registry.register({
      name: "test_tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ result: "ok" }),
    });

    expect(registry.has("test_tool")).toBe(true);
    const tool = registry.get("test_tool");
    expect(tool?.name).toBe("test_tool");
    expect(tool?.description).toBe("A test tool");
  });

  test("register overwrites an existing tool with the same name", () => {
    registry.register({
      name: "test_tool",
      description: "First version",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "v1",
    });

    registry.register({
      name: "test_tool",
      description: "Second version",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "v2",
    });

    const tool = registry.get("test_tool");
    expect(tool?.description).toBe("Second version");
  });

  test("registerMany registers multiple tools at once", () => {
    registry.registerMany([
      {
        name: "multi1",
        description: "Multi 1",
        inputSchema: { type: "object", properties: {} },
        execute: async () => null,
      },
      {
        name: "multi2",
        description: "Multi 2",
        inputSchema: { type: "object", properties: {} },
        execute: async () => null,
      },
    ]);

    expect(registry.has("multi1")).toBe(true);
    expect(registry.has("multi2")).toBe(true);
    // + the three built-in tools (think, finish, context_expand)
    expect(registry.getAll().length).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Unregistration
  // ---------------------------------------------------------------------------

  test("unregister removes a tool and returns true", () => {
    registry.register({
      name: "temp_tool",
      description: "Temporary",
      inputSchema: { type: "object", properties: {} },
      execute: async () => null,
    });

    expect(registry.has("temp_tool")).toBe(true);
    expect(registry.unregister("temp_tool")).toBe(true);
    expect(registry.has("temp_tool")).toBe(false);
  });

  test("unregister returns false for non-existent tool", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  test("get returns undefined for non-existent tool", () => {
    expect(registry.get("no_such_tool")).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  test("filterByNames with wildcard returns all tools", () => {
    registry.register({
      name: "custom1",
      description: "Custom 1",
      inputSchema: { type: "object", properties: {} },
      execute: async () => null,
    });

    const tools = registry.filterByNames(["*"]);
    // Should include think, finish, context_expand, custom1
    expect(tools.length).toBeGreaterThanOrEqual(4);
  });

  test("filterByNames returns only named tools", () => {
    registry.register({
      name: "custom2",
      description: "Custom 2",
      inputSchema: { type: "object", properties: {} },
      execute: async () => null,
    });

    const tools = registry.filterByNames(["think", "custom2"]);
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name)).toContain("think");
    expect(tools.map((t) => t.name)).toContain("custom2");
  });

  test("filterByNames skips unknown names silently", () => {
    const tools = registry.filterByNames(["think", "nonexistent"]);
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("think");
  });

  test("filterByNames with empty array returns empty array", () => {
    const tools = registry.filterByNames([]);
    expect(tools.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Tool definition building
  // ---------------------------------------------------------------------------

  test("buildToolDefinitions returns ToolDefinition format for named tools", () => {
    const defs = registry.buildToolDefinitions(["think", "finish"]);
    expect(defs.length).toBe(2);

    for (const def of defs) {
      expect(def.name).toBeDefined();
      expect(def.description).toBeDefined();
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe("object");
    }
  });

  test("buildToolDefinitions without args returns all tools", () => {
    const defs = registry.buildToolDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(2); // think + finish (context_expand is deferred, excluded by default)
  });

  test("built-in tools have correct schemas", () => {
    const defs = registry.buildToolDefinitions(["think"]);
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe("think");
    const schema = defs[0].inputSchema;
    expect((schema as any).properties.thought).toBeDefined();
    expect((schema as any).required).toContain("thought");
  });
});
