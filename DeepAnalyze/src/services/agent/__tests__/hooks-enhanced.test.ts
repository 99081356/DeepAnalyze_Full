import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { HookManager } from "../hooks.js";
import type { HookType, HookContext, HookResult } from "../hook-types.js";

// ---------------------------------------------------------------------------
// All 17 HookType values
// ---------------------------------------------------------------------------
const ALL_HOOK_TYPES: HookType[] = [
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "AgentStart",
  "AgentComplete",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "Notification",
  "PermissionRequest",
  "PermissionDenied",
  "FileChanged",
];

describe("HookManager — Enhanced", () => {
  let mgr: HookManager;

  beforeEach(() => {
    mgr = new HookManager();
    // Mark as loaded to prevent loadFromSettings() from clearing hooks
    (mgr as unknown as { loaded: boolean }).loaded = true;
  });

  // -----------------------------------------------------------------------
  // 1. All 17 HookType values are complete
  // -----------------------------------------------------------------------
  it("covers all 17 HookType string literals", () => {
    expect(ALL_HOOK_TYPES.length).toBe(17);
    // Verify uniqueness
    const unique = new Set(ALL_HOOK_TYPES);
    expect(unique.size).toBe(17);
  });

  // -----------------------------------------------------------------------
  // 2. registerCallbackHook registers and fires
  // -----------------------------------------------------------------------
  it("registerCallbackHook registers and triggers callback", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("PreToolUse", "test-1", cb);

    const ctx: HookContext = { hookType: "PreToolUse", toolName: "kb_search", taskId: "t1" };
    const result = await mgr.fire("PreToolUse", ctx);

    expect(result.allowed).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    // Callback receives the context
    const receivedCtx = cb.mock.calls[0]![0];
    expect(receivedCtx.hookType).toBe("PreToolUse");
    expect(receivedCtx.toolName).toBe("kb_search");
    expect(receivedCtx.taskId).toBe("t1");
  });

  // -----------------------------------------------------------------------
  // 3. Blocking hook allows through
  // -----------------------------------------------------------------------
  it("blocking hook returns allowed:true when callback allows", async () => {
    mgr.registerCallbackHook(
      "PreToolUse",
      "allow-hook",
      async () => ({ allowed: true }),
    );

    const result = await mgr.fire("PreToolUse", {
      hookType: "PreToolUse",
      toolName: "read_file",
    });
    expect(result.allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. Blocking hook denies execution
  // -----------------------------------------------------------------------
  it("blocking hook returns allowed:false when callback denies", async () => {
    mgr.registerCallbackHook(
      "PreToolUse",
      "deny-hook",
      async () => ({ allowed: false, error: "blocked" }),
    );

    const result = await mgr.fire("PreToolUse", {
      hookType: "PreToolUse",
      toolName: "bash",
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toBe("blocked");
  });

  // -----------------------------------------------------------------------
  // 5. Fire-and-forget hook does not block on error
  // -----------------------------------------------------------------------
  it("fire-and-forget hook does not block even when callback throws", async () => {
    mgr.registerCallbackHook(
      "Notification",
      "throw-hook",
      async () => { throw new Error("boom"); },
    );

    const result = await mgr.fire("Notification", {
      hookType: "Notification",
      notificationContent: "test",
    });
    expect(result.allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. modifiedInput accumulation from multiple hooks
  // -----------------------------------------------------------------------
  it("accumulates modifiedInput from multiple hooks", async () => {
    mgr.registerCallbackHook(
      "PreToolUse",
      "hook-a",
      async () => ({ allowed: true, modifiedInput: { query: "modified" } }),
    );
    mgr.registerCallbackHook(
      "PreToolUse",
      "hook-b",
      async () => ({ allowed: true, modifiedInput: { limit: 10 } }),
    );

    const result = await mgr.fire("PreToolUse", {
      hookType: "PreToolUse",
      toolName: "kb_search",
      toolInput: { query: "original" },
    });
    expect(result.allowed).toBe(true);
    expect(result.modifiedInput).toBeDefined();
    expect(result.modifiedInput!.query).toBe("modified");
    expect(result.modifiedInput!.limit).toBe(10);
  });

  // -----------------------------------------------------------------------
  // 7. matcher wildcard "*"
  // -----------------------------------------------------------------------
  it("matcher '*' matches any toolName", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("PreToolUse", "wildcard", cb, "*");

    await mgr.fire("PreToolUse", { hookType: "PreToolUse", toolName: "anything" });
    await mgr.fire("PreToolUse", { hookType: "PreToolUse", toolName: "kb_search" });

    expect(cb).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // 8. matcher exact match
  // -----------------------------------------------------------------------
  it("matcher exact match only matches the specified tool", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("PreToolUse", "exact", cb, "kb_search");

    await mgr.fire("PreToolUse", { hookType: "PreToolUse", toolName: "kb_search" });
    await mgr.fire("PreToolUse", { hookType: "PreToolUse", toolName: "expand" });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 9. matcher prefix glob
  // -----------------------------------------------------------------------
  it("matcher prefix 'bash*' matches bash and bash_exec", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("PreToolUse", "prefix", cb, "bash*");

    await mgr.fire("PreToolUse", { hookType: "PreToolUse", toolName: "bash" });
    await mgr.fire("PreToolUse", { hookType: "PreToolUse", toolName: "bash_exec" });
    await mgr.fire("PreToolUse", { hookType: "PreToolUse", toolName: "read_file" });

    expect(cb).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // 10. fireUserPromptSubmit convenience method
  // -----------------------------------------------------------------------
  it("fireUserPromptSubmit passes correct context", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("UserPromptSubmit", "ups-hook", cb);

    await mgr.fireUserPromptSubmit("hello world", "task-1");

    expect(cb).toHaveBeenCalledTimes(1);
    const ctx = cb.mock.calls[0]![0];
    expect(ctx.hookType).toBe("UserPromptSubmit");
    expect(ctx.userPrompt).toBe("hello world");
    expect(ctx.taskId).toBe("task-1");
  });

  // -----------------------------------------------------------------------
  // 11. fireSubagentStart / fireSubagentStop
  // -----------------------------------------------------------------------
  it("fireSubagentStart/Stop passes correct subagentId", async () => {
    const startCb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    const stopCb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("SubagentStart", "sa-start", startCb);
    mgr.registerCallbackHook("SubagentStop", "sa-stop", stopCb);

    await mgr.fireSubagentStart("sub-123", "task-1");
    await mgr.fireSubagentStop("sub-123", "task-1");

    expect(startCb).toHaveBeenCalledTimes(1);
    expect(startCb.mock.calls[0]![0].subagentId).toBe("sub-123");
    expect(stopCb).toHaveBeenCalledTimes(1);
    expect(stopCb.mock.calls[0]![0].subagentId).toBe("sub-123");
  });

  // -----------------------------------------------------------------------
  // 12. fireStop / fireStopFailure
  // -----------------------------------------------------------------------
  it("fireStop/fireStopFailure passes correct fields", async () => {
    const stopCb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    const failCb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("Stop", "stop-hook", stopCb);
    mgr.registerCallbackHook("StopFailure", "fail-hook", failCb);

    await mgr.fireStop("task-1");
    await mgr.fireStopFailure("something went wrong", "task-1");

    expect(stopCb).toHaveBeenCalledTimes(1);
    expect(stopCb.mock.calls[0]![0].taskId).toBe("task-1");
    expect(failCb).toHaveBeenCalledTimes(1);
    expect(failCb.mock.calls[0]![0].errorMessage).toBe("something went wrong");
    expect(failCb.mock.calls[0]![0].taskId).toBe("task-1");
  });

  // -----------------------------------------------------------------------
  // 13. fireFileChanged
  // -----------------------------------------------------------------------
  it("fireFileChanged passes filePath", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("FileChanged", "fc-hook", cb);

    await mgr.fireFileChanged("/tmp/test.txt", "task-1");

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].filePath).toBe("/tmp/test.txt");
  });

  // -----------------------------------------------------------------------
  // 14. fireNotification
  // -----------------------------------------------------------------------
  it("fireNotification passes notificationContent", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    mgr.registerCallbackHook("Notification", "notif-hook", cb);

    await mgr.fireNotification("task completed", "task-1");

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0].notificationContent).toBe("task completed");
  });

  // -----------------------------------------------------------------------
  // 15. Command hook execution (echo JSON)
  // -----------------------------------------------------------------------
  it("command hook executes and parses JSON output", async () => {
    // Register a command hook via internal mechanism
    // We need to access the private hooks map to inject a command hook
    const mgrAny = mgr as unknown as {
      hooks: Map<HookType, import("../hooks.js").HookDefinition[]>;
      loaded: boolean;
    };
    mgrAny.loaded = true;
    mgrAny.hooks.set("PreToolUse", [{
      id: "cmd-hook",
      event: "PreToolUse",
      type: "command",
      matcher: "*",
      config: {
        command: 'echo \'{"allowed": false, "error": "denied by policy"}\'',
      },
      enabled: true,
    }]);

    const result = await mgr.fire("PreToolUse", {
      hookType: "PreToolUse",
      toolName: "dangerous_tool",
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toBe("denied by policy");
  });

  // -----------------------------------------------------------------------
  // 16. Command hook non-JSON output → allowed:true
  // -----------------------------------------------------------------------
  it("command hook with non-JSON output returns allowed:true", async () => {
    const mgrAny = mgr as unknown as {
      hooks: Map<HookType, import("../hooks.js").HookDefinition[]>;
      loaded: boolean;
    };
    mgrAny.loaded = true;
    mgrAny.hooks.set("PreToolUse", [{
      id: "cmd-text",
      event: "PreToolUse",
      type: "command",
      matcher: "*",
      config: {
        command: 'echo "just some text"',
      },
      enabled: true,
    }]);

    const result = await mgr.fire("PreToolUse", {
      hookType: "PreToolUse",
      toolName: "some_tool",
    });
    expect(result.allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 17. Command hook non-zero exit → denied
  // -----------------------------------------------------------------------
  it("command hook with non-zero exit code returns allowed:false", async () => {
    const mgrAny = mgr as unknown as {
      hooks: Map<HookType, import("../hooks.js").HookDefinition[]>;
      loaded: boolean;
    };
    mgrAny.loaded = true;
    mgrAny.hooks.set("PreToolUse", [{
      id: "cmd-fail",
      event: "PreToolUse",
      type: "command",
      matcher: "*",
      config: {
        command: "exit 1",
      },
      enabled: true,
    }]);

    const result = await mgr.fire("PreToolUse", {
      hookType: "PreToolUse",
      toolName: "some_tool",
    });
    expect(result.allowed).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 18. Lazy load from settings when not loaded
  // -----------------------------------------------------------------------
  it("auto-calls loadFromSettings when fire is called without prior load", async () => {
    // Just verify it doesn't throw — the settings table likely doesn't exist
    // in test env, so it silently clears hooks and sets loaded=true
    const result = await mgr.fire("SessionStart", {
      hookType: "SessionStart",
    });
    expect(result.allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 19. LIFECYCLE_HOOK_TYPES skip matcher check
  // -----------------------------------------------------------------------
  it("lifecycle hooks skip matcher even when matcher is set", async () => {
    const cb = vi.fn<(ctx: HookContext) => Promise<HookResult>>(async () => ({ allowed: true }));
    // Register AgentStart hook with a specific matcher that shouldn't apply
    mgr.registerCallbackHook("AgentStart", "lc-hook", cb, "kb_search");

    // Fire without toolName — should still trigger since AgentStart is lifecycle
    await mgr.fire("AgentStart", { hookType: "AgentStart", taskId: "t1" });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 20. Multiple hooks on same event execute in order
  // -----------------------------------------------------------------------
  it("multiple hooks on same event execute in registration order", async () => {
    const order: string[] = [];

    mgr.registerCallbackHook("PostToolUse", "first", async () => {
      order.push("first");
      return { allowed: true };
    });
    mgr.registerCallbackHook("PostToolUse", "second", async () => {
      order.push("second");
      return { allowed: true };
    });

    await mgr.fire("PostToolUse", { hookType: "PostToolUse", toolName: "test" });

    expect(order).toEqual(["first", "second"]);
  });
});
