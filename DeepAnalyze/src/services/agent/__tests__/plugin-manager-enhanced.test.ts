import { describe, it, expect, beforeAll, afterAll, vi } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import os from "os";
import { AgentPluginManager } from "../plugin-manager.js";
import type { HookManager } from "../hooks.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { HookType, HookContext, HookResult } from "../hook-types.js";

const TMP = join(os.tmpdir(), "da-plugin-enhanced-test-" + Date.now());

// ---------------------------------------------------------------------------
// Mock HookManager
// ---------------------------------------------------------------------------

function createMockHookManager() {
  const registeredHooks: Array<{ event: HookType; id: string; callback: (ctx: HookContext) => Promise<HookResult>; matcher: string }> = [];

  return {
    registeredHooks,
    registerCallbackHook: vi.fn((event: HookType, id: string, callback: (ctx: HookContext) => Promise<HookResult>, matcher = "*") => {
      registeredHooks.push({ event, id, callback, matcher });
    }),
  } as unknown as HookManager;
}

// ---------------------------------------------------------------------------
// Mock ToolRegistry
// ---------------------------------------------------------------------------

function createMockToolRegistry() {
  const registeredTools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];

  return {
    registeredTools,
    register: vi.fn((tool: { name: string; execute: (...args: unknown[]) => unknown }) => {
      registeredTools.push(tool);
    }),
  } as unknown as ToolRegistry;
}

beforeAll(async () => {
  // Plugin with hooks and tools
  await mkdir(join(TMP, "hook-plugin", "hooks"), { recursive: true });
  await mkdir(join(TMP, "hook-plugin", "tools"), { recursive: true });
  await mkdir(join(TMP, "hook-plugin", "skills", "test-skill"), { recursive: true });

  await writeFile(join(TMP, "hook-plugin", "plugin.json"), JSON.stringify({
    name: "hook-plugin",
    version: "1.0.0",
    description: "Plugin with hooks and tools",
    capabilities: ["hooks", "tools", "skills"],
    skills: [{ dir: "skills/test-skill" }],
    hooks: {
      PreToolUse: "hooks/pre-tool-use.js",
      PostToolUse: "hooks/post-tool-use.js",
    },
    tools: [
      { file: "tools/good-tool.js" },
      { file: "tools/bad-tool.js" },
    ],
  }));

  // Skill file
  await writeFile(join(TMP, "hook-plugin", "skills", "test-skill", "SKILL.md"),
    `---
description: Test skill
tools: [kb_search]
---

# Test Skill

Do the test.`);

  // Hook modules (ESM-style)
  await writeFile(join(TMP, "hook-plugin", "hooks", "pre-tool-use.js"), `
export default async function(ctx) {
  return { allowed: true };
};
`);
  await writeFile(join(TMP, "hook-plugin", "hooks", "post-tool-use.js"), `
export default async function(ctx) {
  return { allowed: true };
};
`);

  // Good tool module
  await writeFile(join(TMP, "hook-plugin", "tools", "good-tool.js"), `
export default {
  name: "good_tool",
  description: "A good test tool",
  async execute(input) { return { result: "ok" }; }
};
`);

  // Bad tool module (no name/execute)
  await writeFile(join(TMP, "hook-plugin", "tools", "bad-tool.js"), `
export default {
  notName: "bad_tool",
  notExecute: true
};
`);

  // Plugin with no manifest (for discover test)
  await mkdir(join(TMP, "no-plugin-dir"), { recursive: true });
  await writeFile(join(TMP, "no-plugin-dir", "readme.txt"), "Not a plugin");

  // Second plugin for discover test
  await mkdir(join(TMP, "second-plugin"), { recursive: true });
  await writeFile(join(TMP, "second-plugin", "plugin.json"), JSON.stringify({
    name: "second-plugin",
    version: "1.0.0",
    description: "Second test plugin",
    capabilities: [],
  }));

  // Hook module with no default/handler export
  await mkdir(join(TMP, "bad-hook-plugin"), { recursive: true });
  await mkdir(join(TMP, "bad-hook-plugin", "hooks"), { recursive: true });
  await writeFile(join(TMP, "bad-hook-plugin", "plugin.json"), JSON.stringify({
    name: "bad-hook-plugin",
    version: "1.0.0",
    description: "Plugin with bad hooks",
    capabilities: ["hooks"],
    hooks: {
      PreToolUse: "hooks/no-handler.js",
    },
  }));
  await writeFile(join(TMP, "bad-hook-plugin", "hooks", "no-handler.js"), `
export const something = "not a function";
`);

  // Hook module that throws on import
  await mkdir(join(TMP, "fail-hook-plugin"), { recursive: true });
  await mkdir(join(TMP, "fail-hook-plugin", "hooks"), { recursive: true });
  await writeFile(join(TMP, "fail-hook-plugin", "plugin.json"), JSON.stringify({
    name: "fail-hook-plugin",
    version: "1.0.0",
    description: "Plugin with failing hooks",
    capabilities: ["hooks"],
    hooks: {
      PreToolUse: "hooks/fail-hook.js",
      PostToolUse: "hooks/post-tool-use.js",
    },
  }));
  await writeFile(join(TMP, "fail-hook-plugin", "hooks", "fail-hook.js"), `
throw new Error("Import failed");
`);
  await writeFile(join(TMP, "fail-hook-plugin", "hooks", "post-tool-use.js"), `
export default async function(ctx) {
  return { allowed: true };
};
`);
});

afterAll(async () => {
  await rm(TMP, { recursive: true });
});

describe("AgentPluginManager — Enhanced", () => {
  // -----------------------------------------------------------------------
  // 1. Load plugin with hooks
  // -----------------------------------------------------------------------
  it("registers hooks when hookManager is set", async () => {
    const pm = new AgentPluginManager();
    const mockHM = createMockHookManager();
    pm.setHookManager(mockHM);

    await pm.loadPlugin(join(TMP, "hook-plugin"));

    expect(mockHM.registerCallbackHook).toHaveBeenCalled();
    // Should have registered at least PreToolUse and PostToolUse hooks
    expect((mockHM as any).registeredHooks.length).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // 2. Load plugin with tools
  // -----------------------------------------------------------------------
  it("registers tools when toolRegistry is set", async () => {
    const pm = new AgentPluginManager();
    const mockTR = createMockToolRegistry();
    pm.setToolRegistry(mockTR);

    await pm.loadPlugin(join(TMP, "hook-plugin"));

    expect(mockTR.register).toHaveBeenCalled();
    // Good tool should be registered
    expect((mockTR as any).registeredTools.some((t) => t.name === "good_tool")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. Hook module without default/handler export → warning, no crash
  // -----------------------------------------------------------------------
  it("handles hook module without default/handler export gracefully", async () => {
    const pm = new AgentPluginManager();
    const mockHM = createMockHookManager();
    pm.setHookManager(mockHM);

    // Should not throw
    const plugin = await pm.loadPlugin(join(TMP, "bad-hook-plugin"));
    expect(plugin).toBeDefined();
    // No hooks registered for the bad module
    expect(plugin.loadedHookIds.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 4. Tool module without name/execute → warning, no crash
  // -----------------------------------------------------------------------
  it("handles tool module without name/execute gracefully", async () => {
    const pm = new AgentPluginManager();
    const mockTR = createMockToolRegistry();
    pm.setToolRegistry(mockTR);

    const plugin = await pm.loadPlugin(join(TMP, "hook-plugin"));
    // Bad tool should not be registered, only the good one
    expect(plugin.loadedToolNames).not.toContain("bad_tool");
    expect(plugin.loadedToolNames).toContain("good_tool");
  });

  // -----------------------------------------------------------------------
  // 5. Hook loading failure does not affect other hooks
  // -----------------------------------------------------------------------
  it("continues loading other hooks after one fails", async () => {
    const pm = new AgentPluginManager();
    const mockHM = createMockHookManager();
    pm.setHookManager(mockHM);

    const plugin = await pm.loadPlugin(join(TMP, "fail-hook-plugin"));
    // PreToolUse hook import fails, but PostToolUse should still be loaded
    // Note: the failing hook throws on import, so it won't be registered
    const registeredEvents = (mockHM as any).registeredHooks.map((h) => h.event);
    // PostToolUse should be registered since it's listed after PreToolUse in manifest
    expect(registeredEvents).toContain("PostToolUse");
  });

  // -----------------------------------------------------------------------
  // 6. Tool loading failure does not affect other tools
  // -----------------------------------------------------------------------
  it("continues loading other tools after one fails", async () => {
    const pm = new AgentPluginManager();
    const mockTR = createMockToolRegistry();
    pm.setToolRegistry(mockTR);

    const plugin = await pm.loadPlugin(join(TMP, "hook-plugin"));
    // bad-tool.js fails validation, but good-tool.js should still be registered
    expect(plugin.loadedToolNames).toContain("good_tool");
  });

  // -----------------------------------------------------------------------
  // 7. discoverPlugins scans multiple directories
  // -----------------------------------------------------------------------
  it("discovers plugins from multiple search paths", async () => {
    const pm = new AgentPluginManager();

    const loaded = await pm.discoverPlugins([TMP]);

    // Should find hook-plugin and second-plugin (but skip no-plugin-dir)
    const names = loaded.map((p) => p.manifest.name);
    expect(names).toContain("hook-plugin");
    expect(names).toContain("second-plugin");
    expect(names).not.toContain("no-plugin-dir");
  });

  // -----------------------------------------------------------------------
  // 8. discoverPlugins skips directories without plugin.json
  // -----------------------------------------------------------------------
  it("skips directories without plugin.json without error", async () => {
    const pm = new AgentPluginManager();

    // Should not throw
    const loaded = await pm.discoverPlugins([join(TMP, "no-plugin-dir")]);
    expect(loaded).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 9. loadedHookIds records registered hooks
  // -----------------------------------------------------------------------
  it("records loadedHookIds for registered hooks", async () => {
    const pm = new AgentPluginManager();
    const mockHM = createMockHookManager();
    pm.setHookManager(mockHM);

    const plugin = await pm.loadPlugin(join(TMP, "hook-plugin"));

    expect(plugin.loadedHookIds.length).toBeGreaterThanOrEqual(2);
    // Hook IDs follow pattern: plugin-{name}-{event}
    expect(plugin.loadedHookIds[0]).toContain("plugin-hook-plugin-");
  });

  // -----------------------------------------------------------------------
  // 10. loadedToolNames records registered tools
  // -----------------------------------------------------------------------
  it("records loadedToolNames for registered tools", async () => {
    const pm = new AgentPluginManager();
    const mockTR = createMockToolRegistry();
    pm.setToolRegistry(mockTR);

    const plugin = await pm.loadPlugin(join(TMP, "hook-plugin"));

    expect(plugin.loadedToolNames).toContain("good_tool");
    expect(plugin.loadedToolNames).not.toContain("bad_tool");
  });

  // -----------------------------------------------------------------------
  // 11. No hookManager → hooks are skipped
  // -----------------------------------------------------------------------
  it("skips hook loading when hookManager is not set", async () => {
    const pm = new AgentPluginManager();
    // Don't set hookManager

    const plugin = await pm.loadPlugin(join(TMP, "hook-plugin"));
    // Should not crash, but hooks should not be loaded
    expect(plugin.loadedHookIds).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 12. No toolRegistry → tools are skipped
  // -----------------------------------------------------------------------
  it("skips tool loading when toolRegistry is not set", async () => {
    const pm = new AgentPluginManager();
    // Don't set toolRegistry

    const plugin = await pm.loadPlugin(join(TMP, "hook-plugin"));
    // Should not crash, but tools should not be loaded
    expect(plugin.loadedToolNames).toEqual([]);
  });
});
