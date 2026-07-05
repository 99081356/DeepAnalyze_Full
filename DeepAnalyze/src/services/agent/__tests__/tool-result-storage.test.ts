import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { maybePersistToolResult } from "../tool-result-storage.js";

describe("maybePersistToolResult", () => {
  const testSessionId = "test-session-" + Date.now();
  const baseDir = path.join(os.tmpdir(), "deepanalyze");
  const dataDir = baseDir;

  afterAll(async () => {
    try { await rm(baseDir, { recursive: true }); } catch {}
  });

  it("does not persist small results", async () => {
    const result = await maybePersistToolResult(dataDir, "tool", "small result", testSessionId, "call-1");
    expect(result.persisted).toBe(false);
    expect(result.content).toBe("small result");
    expect(result.filePath).toBeUndefined();
  });

  it("persists large results and returns preview", async () => {
    const largeContent = "x".repeat(60_000);
    const result = await maybePersistToolResult(dataDir, "tool", largeContent, testSessionId, "call-2", 50_000);
    expect(result.persisted).toBe(true);
    expect(result.content).toContain("<persisted-output>");
    expect(result.content).toContain("Preview");
    expect(result.filePath).toBeDefined();
    expect(existsSync(result.filePath!)).toBe(true);

    // Verify full content was written
    const written = await readFile(result.filePath!, "utf-8");
    expect(written).toBe(largeContent);
  });

  it("uses custom maxChars threshold", async () => {
    const content = "x".repeat(2000);
    const result = await maybePersistToolResult(dataDir, "tool", content, testSessionId, "call-3", 1000);
    expect(result.persisted).toBe(true);
  });

  it("does not persist at exact threshold", async () => {
    const content = "x".repeat(1000);
    const result = await maybePersistToolResult(dataDir, "tool", content, testSessionId, "call-4", 1000);
    expect(result.persisted).toBe(false);
  });
});
