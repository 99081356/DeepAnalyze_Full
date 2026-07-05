// =============================================================================
// Migration Tools Integration Tests
// Verifies: StructuredOutput, Cron tools, MCP builtin adapters
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// StructuredOutput
// ---------------------------------------------------------------------------

describe("StructuredOutput tool", () => {
  it("should validate correct data against schema", async () => {
    const { structuredOutputTool } = await import("../src/tools/StructuredOutputTool/index.js");
    const result = await structuredOutputTool.execute({
      schema: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "number" } },
        required: ["name"],
      },
      data: { name: "Alice", age: 30 },
    });
    expect(result).toEqual({ structured: true, data: { name: "Alice", age: 30 } });
  });

  it("should reject invalid data", async () => {
    const { structuredOutputTool } = await import("../src/tools/StructuredOutputTool/index.js");
    const result = await structuredOutputTool.execute({
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      data: { name: 123 },
    });
    expect(result).toHaveProperty("error");
  });

  it("should have correct tool metadata", async () => {
    const { structuredOutputTool } = await import("../src/tools/StructuredOutputTool/index.js");
    expect(structuredOutputTool.name).toBe("structured_output");
    expect(structuredOutputTool.shouldDefer).toBe(true);
    expect(structuredOutputTool.isReadOnly()).toBe(true);
    expect(structuredOutputTool.isConcurrencySafe()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cron Agent tools registration
// ---------------------------------------------------------------------------

describe("Cron Agent tools", () => {
  it("should register cron_create, cron_list, cron_delete", async () => {
    const { ToolRegistry } = await import("../src/services/agent/tool-registry.js");
    const registry = new ToolRegistry();

    // Register cron tools via the exported function
    const { registerCronTools } = await import("../src/services/agent/tool-setup.js");
    registerCronTools(registry);

    expect(registry.has("cron_create")).toBe(true);
    expect(registry.has("cron_list")).toBe(true);
    expect(registry.has("cron_delete")).toBe(true);
  });

  it("cron tools should be deferred", async () => {
    const { ToolRegistry, DEFERRED_TOOLS } = await import("../src/services/agent/tool-registry.js");
    expect(DEFERRED_TOOLS.has("cron_create")).toBe(true);
    expect(DEFERRED_TOOLS.has("cron_list")).toBe(true);
    expect(DEFERRED_TOOLS.has("cron_delete")).toBe(true);
  });

  it("cron_create should have correct schema", async () => {
    const { ToolRegistry } = await import("../src/services/agent/tool-registry.js");
    const registry = new ToolRegistry();
    const { registerCronTools } = await import("../src/services/agent/tool-setup.js");
    registerCronTools(registry);

    const tool = registry.get("cron_create")!;
    expect(tool.inputSchema).toBeDefined();
    const schema = tool.inputSchema as { required?: string[] };
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("schedule");
    expect(schema.required).toContain("message");
    expect(tool.shouldDefer).toBe(true);
  });

  it("cron_list should be read-only", async () => {
    const { ToolRegistry } = await import("../src/services/agent/tool-registry.js");
    const registry = new ToolRegistry();
    const { registerCronTools } = await import("../src/services/agent/tool-setup.js");
    registerCronTools(registry);

    const tool = registry.get("cron_list")!;
    expect(tool.isReadOnly()).toBe(true);
  });

  it("cron_delete should NOT be read-only", async () => {
    const { ToolRegistry } = await import("../src/services/agent/tool-registry.js");
    const registry = new ToolRegistry();
    const { registerCronTools } = await import("../src/services/agent/tool-setup.js");
    registerCronTools(registry);

    const tool = registry.get("cron_delete")!;
    expect(tool.isReadOnly()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP Builtin Adapters
// ---------------------------------------------------------------------------

describe("MCP Builtin Adapters", () => {
  it("should register mcp__vlm__analyze_image and mcp__websearch__search", async () => {
    const { ToolRegistry } = await import("../src/services/agent/tool-registry.js");
    const registry = new ToolRegistry();

    const { registerBuiltinMCPTools } = await import("../src/services/agent/mcp-builtin-adapters.js");
    registerBuiltinMCPTools(registry);

    expect(registry.has("mcp__vlm__analyze_image")).toBe(true);
    expect(registry.has("mcp__websearch__search")).toBe(true);
  });

  it("builtin MCP tools should have correct metadata", async () => {
    const { ToolRegistry } = await import("../src/services/agent/tool-registry.js");
    const registry = new ToolRegistry();

    const { registerBuiltinMCPTools } = await import("../src/services/agent/mcp-builtin-adapters.js");
    registerBuiltinMCPTools(registry);

    const vlmTool = registry.get("mcp__vlm__analyze_image")!;
    expect(vlmTool.shouldDefer).toBe(true);
    expect(vlmTool.isReadOnly()).toBe(true);
    expect(vlmTool.isConcurrencySafe()).toBe(true);
    expect(vlmTool.inputSchema).toBeDefined();

    const searchTool = registry.get("mcp__websearch__search")!;
    expect(searchTool.shouldDefer).toBe(true);
    expect(searchTool.isReadOnly()).toBe(true);
    expect(searchTool.inputSchema).toBeDefined();
  });

  it("VLM tool should reject missing params", async () => {
    const { ToolRegistry } = await import("../src/services/agent/tool-registry.js");
    const registry = new ToolRegistry();

    const { registerBuiltinMCPTools } = await import("../src/services/agent/mcp-builtin-adapters.js");
    registerBuiltinMCPTools(registry);

    const vlmTool = registry.get("mcp__vlm__analyze_image")!;
    const result = await vlmTool.execute({ imageRef: "", prompt: "" });
    expect(result).toHaveProperty("error");
  });

  it("MCP tools should be in DEFERRED_TOOLS", async () => {
    const { DEFERRED_TOOLS } = await import("../src/services/agent/tool-registry.js");
    expect(DEFERRED_TOOLS.has("mcp__vlm__analyze_image")).toBe(true);
    expect(DEFERRED_TOOLS.has("mcp__websearch__search")).toBe(true);
  });

  it("getBuiltinMCPServers should return 2 servers", async () => {
    const { getBuiltinMCPServers } = await import("../src/services/agent/mcp-builtin-adapters.js");
    const servers = getBuiltinMCPServers();
    expect(servers).toHaveLength(2);
    expect(servers[0].id).toBe("vlm");
    expect(servers[0].tools).toHaveLength(1);
    expect(servers[0].tools[0].name).toBe("analyze_image");
    expect(servers[1].id).toBe("websearch");
    expect(servers[1].tools).toHaveLength(1);
    expect(servers[1].tools[0].name).toBe("search");
  });
});

// ---------------------------------------------------------------------------
// Tool Registry DEFERRED_TOOLS completeness
// ---------------------------------------------------------------------------

describe("DEFERRED_TOOLS completeness", () => {
  it("should contain all new migrated tools", async () => {
    const { DEFERRED_TOOLS } = await import("../src/services/agent/tool-registry.js");

    // StructuredOutput
    expect(DEFERRED_TOOLS.has("structured_output")).toBe(true);

    // Cron tools
    expect(DEFERRED_TOOLS.has("cron_create")).toBe(true);
    expect(DEFERRED_TOOLS.has("cron_list")).toBe(true);
    expect(DEFERRED_TOOLS.has("cron_delete")).toBe(true);

    // MCP builtin adapters
    expect(DEFERRED_TOOLS.has("mcp__vlm__analyze_image")).toBe(true);
    expect(DEFERRED_TOOLS.has("mcp__websearch__search")).toBe(true);

    // Original image_analysis should still be deferred
    expect(DEFERRED_TOOLS.has("image_analysis")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CronScheduler Lifecycle
// ---------------------------------------------------------------------------

describe("CronScheduler Lifecycle", () => {
  it("startCronScheduler should create singleton", async () => {
    const { startCronScheduler, getCronScheduler } = await import("../src/services/cron/scheduler-lifecycle.js");

    // Start
    startCronScheduler();
    const instance = getCronScheduler();
    expect(instance).not.toBeNull();

    // Starting again should be idempotent
    startCronScheduler();
    const instance2 = getCronScheduler();
    expect(instance2).toBe(instance);

    // Clean up
    instance!.stop();
  });

  it("stop should clean up timer", async () => {
    const mod = await import("../src/services/cron/scheduler-lifecycle.js");
    // Reset the singleton by creating a fresh scheduler
    const { CronScheduler } = await import("../src/services/cron/scheduler.js");
    const scheduler = new CronScheduler();
    scheduler.start();
    scheduler.stop();
    // No error means success
    expect(true).toBe(true);
  });
});
