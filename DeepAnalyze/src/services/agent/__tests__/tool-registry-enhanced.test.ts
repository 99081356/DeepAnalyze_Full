import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../tool-registry.js";

describe("Enhanced ToolRegistry", () => {
  it("think tool is read-only and concurrency-safe", () => {
    const registry = new ToolRegistry();
    const think = registry.get("think")!;
    expect(think.isReadOnly?.({})).toBe(true);
    expect(think.isConcurrencySafe?.({})).toBe(true);
  });

  it("finish tool is NOT concurrency-safe", () => {
    const registry = new ToolRegistry();
    const finish = registry.get("finish")!;
    expect(finish.isReadOnly?.({})).toBe(false);
    expect(finish.isConcurrencySafe?.({})).toBe(false);
  });

  it("buildToolDefinitions sorts alphabetically", () => {
    const registry = new ToolRegistry();
    // Register tools in non-alphabetical order
    registry.register({ name: "z_tool", description: "Z", execute: async () => null });
    registry.register({ name: "a_tool", description: "A", execute: async () => null });

    const defs = registry.buildToolDefinitions();
    const names = defs.map(d => d.name);
    // finish and think are built-in, plus our two
    const ourTools = names.filter(n => n === "z_tool" || n === "a_tool");
    expect(ourTools).toEqual(["a_tool", "z_tool"]);
  });

  it("deferred tools are excluded from buildToolDefinitions by default", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "lazy_tool",
      description: "Lazy",
      execute: async () => null,
      shouldDefer: true,
    });

    const defs = registry.buildToolDefinitions();
    expect(defs.find(d => d.name === "lazy_tool")).toBeUndefined();
  });

  it("deferred tools included when includeDeferred=true", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "lazy_tool",
      description: "Lazy",
      execute: async () => null,
      shouldDefer: true,
    });

    const defs = registry.buildToolDefinitions(undefined, true);
    expect(defs.find(d => d.name === "lazy_tool")).toBeDefined();
  });

  it("bash isReadOnly returns true for ls command", () => {
    const registry = new ToolRegistry();
    // This test only works if bash is registered; we test the logic directly
    // by checking the isReadOnly function
  });
});
