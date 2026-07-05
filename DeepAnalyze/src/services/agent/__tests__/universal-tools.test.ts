import { describe, it, expect } from "bun:test";
import { UNIVERSAL_TOOLS } from "../tools/universal-tools.js";

describe("Universal Tools", () => {
  it("exports correct number of tools", () => {
    expect(UNIVERSAL_TOOLS.length).toBe(2);
  });

  it("list_files is read-only and concurrency-safe", () => {
    const tool = UNIVERSAL_TOOLS.find(t => t.name === "list_files")!;
    expect(tool).toBeDefined();
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  it("notebook_read is read-only and deferred", () => {
    const tool = UNIVERSAL_TOOLS.find(t => t.name === "notebook_read")!;
    expect(tool).toBeDefined();
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.shouldDefer).toBe(true);
  });

  it("all tools have required fields", () => {
    for (const tool of UNIVERSAL_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
