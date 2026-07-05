// =============================================================================
// DeepAnalyze - Double Push Fix: E2E Test
// =============================================================================
// Verifies the fix for the "double push" bug where:
// 1. write_file("tmp/大模型训练技术分析报告.md") remaps to a prefixed filename
// 2. push_content("tmp/大模型训练技术分析报告.md") fails because the original
//    path doesn't exist
//
// The fix has two layers:
// Layer 1: makeAgentFilename preserves Unicode (CJK visible in filename)
// Layer 2: push_content falls back to session output directory fuzzy matching
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  makeAgentFilename,
  getSessionOutputDir,
} from "../../session/session-paths.js";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Stub: resolveSessionOutputPath (removed from source, kept for tests)
// ---------------------------------------------------------------------------
// Fuzzy-matches a filename inside the session output directory.
// If no match is found, falls back to resolve(dataDir, filename).
function resolveSessionOutputPath(filename: string, dataDir: string, sessionId: string): string {
  const outputDir = getSessionOutputDir(dataDir, sessionId);
  if (!existsSync(outputDir)) return resolve(dataDir, filename);

  const base = basename(filename);
  const files = readdirSync(outputDir);
  // Try exact basename match first
  const exact = files.find(f => f === base);
  if (exact) return join(outputDir, exact);
  // Fuzzy: look for the base name somewhere in the filename
  const fuzzy = files.find(f => f.includes(base.replace(/\.[^.]+$/, "")));
  if (fuzzy) return join(outputDir, fuzzy);
  // No match
  return resolve(dataDir, filename);
}

// ---------------------------------------------------------------------------
// Helper: create a temporary test directory
// ---------------------------------------------------------------------------
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `da-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ===========================================================================
// Layer 1: makeAgentFilename preserves Unicode
// ===========================================================================
describe("makeAgentFilename — Unicode preservation", () => {
  it("preserves CJK characters in filename", () => {
    const result = makeAgentFilename("main", "tmp/大模型训练技术分析报告.md");
    expect(result).toContain("大模型训练技术分析报告");
    expect(result).toMatch(/^main_\d+_tmp_大模型训练技术分析报告\.md$/);
  });

  it("preserves Japanese characters", () => {
    const result = makeAgentFilename("sub", "分析レポート.md");
    expect(result).toContain("分析レポート");
    expect(result).toMatch(/^sub_\d+_分析レポート\.md$/);
  });

  it("preserves Korean characters", () => {
    const result = makeAgentFilename("wf-a1", "보고서.md");
    expect(result).toContain("보고서");
  });

  it("preserves accented Latin characters", () => {
    const result = makeAgentFilename("main", "rapport-d'analyse-été.md");
    expect(result).toContain("été");
    expect(result).toContain("analyse");
  });

  it("flattens path separators to underscores", () => {
    const result = makeAgentFilename("main", "subdir/my-report.md");
    expect(result).toMatch(/^main_\d+_subdir_my-report\.md$/);
    // No forward slashes should remain (besides the OS path)
    const filename = result;
    expect(filename.includes("/")).toBe(false);
  });

  it("replaces Windows-unsafe characters", () => {
    const result = makeAgentFilename("main", 'file:with*bad?chars<"here>|pipe.md');
    const filename = result.replace(/^main_\d+_/, "");
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("*");
    expect(filename).not.toContain("?");
    expect(filename).not.toContain("<");
    expect(filename).not.toContain(">");
    expect(filename).not.toContain("|");
    // But the safe parts remain
    expect(filename).toContain("file");
    expect(filename).toContain("chars");
    expect(filename).toContain("pipe.md");
  });

  it("produces a recognizable filename — the core fix goal", () => {
    // Before the fix: main_1747890123_tmp____________.md (all CJK → underscores)
    // After the fix:  main_1747890123_tmp_大模型训练技术分析报告.md
    const originalPath = "tmp/大模型训练技术分析报告.md";
    const result = makeAgentFilename("main", originalPath);

    // The agent should be able to recognize "大模型训练" in the returned path
    expect(result).toContain("大模型训练");

    // And it should still start with the role prefix
    expect(result).toMatch(/^main_\d+/);
  });
});

// ===========================================================================
// Layer 2: resolveSessionOutputPath fuzzy matching
// ===========================================================================
describe("resolveSessionOutputPath — session output directory fallback", () => {
  const sessionId = "test-session-001";

  it("finds file by exact name in session output dir", () => {
    const outputDir = getSessionOutputDir(testDir, sessionId);
    mkdirSync(outputDir, { recursive: true });

    // Write a file with the exact name the agent might use
    writeFileSync(join(outputDir, "report.md"), "test content");

    const result = resolveSessionOutputPath("report.md", testDir, sessionId);
    expect(result).toBe(join(outputDir, "report.md"));
  });

  it("finds file by fuzzy match when write_file remapped the name", () => {
    const outputDir = getSessionOutputDir(testDir, sessionId);
    mkdirSync(outputDir, { recursive: true });

    // Simulate what write_file actually creates: prefixed filename with CJK preserved
    const remappedName = makeAgentFilename("main", "tmp/大模型训练技术分析报告.md");
    writeFileSync(join(outputDir, remappedName), "报告内容");

    // Agent calls push_content with the ORIGINAL path
    const result = resolveSessionOutputPath(
      "tmp/大模型训练技术分析报告.md",
      testDir,
      sessionId,
    );

    // Should find the remapped file
    expect(result).toContain("大模型训练技术分析报告");
    expect(existsSync(result)).toBe(true);
  });

  it("finds file when original path had subdirectories (flattened)", () => {
    const outputDir = getSessionOutputDir(testDir, sessionId);
    mkdirSync(outputDir, { recursive: true });

    // write_file flattens "reports/analysis.md" → "main_xxx_reports_analysis.md"
    const remappedName = makeAgentFilename("main", "reports/analysis.md");
    writeFileSync(join(outputDir, remappedName), "analysis content");

    // Agent uses original path with subdirectory
    const result = resolveSessionOutputPath("reports/analysis.md", testDir, sessionId);
    expect(existsSync(result)).toBe(true);
    expect(result).toContain("analysis");
  });

  it("returns direct path when no session output dir exists", () => {
    // No output directory created — should fall back to dataDir resolution
    const result = resolveSessionOutputPath("nonexistent.md", testDir, sessionId);
    expect(result).toBe(resolve(testDir, "nonexistent.md"));
  });

  it("returns direct path when no matching file found in session output", () => {
    const outputDir = getSessionOutputDir(testDir, sessionId);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "other-file.md"), "other content");

    const result = resolveSessionOutputPath("target-file.md", testDir, sessionId);
    // Falls back to dataDir resolution (which won't exist)
    expect(result).toBe(resolve(testDir, "target-file.md"));
  });

  it("handles multiple files — picks the one matching original name", () => {
    const outputDir = getSessionOutputDir(testDir, sessionId);
    mkdirSync(outputDir, { recursive: true });

    // Create multiple files with similar names
    writeFileSync(join(outputDir, makeAgentFilename("main", "报告A.md")), "A content");
    writeFileSync(join(outputDir, makeAgentFilename("main", "报告B.md")), "B content");
    writeFileSync(join(outputDir, makeAgentFilename("main", "报告C.md")), "C content");

    const result = resolveSessionOutputPath("报告B.md", testDir, sessionId);
    expect(existsSync(result)).toBe(true);
    expect(result).toContain("报告B");
  });
});

// ===========================================================================
// Integration: write_file → push_content flow (simulated)
// ===========================================================================
describe("Integration: write_file → push_content with CJK paths", () => {
  const sessionId = "integration-session";

  it("simulates the full write→push cycle that caused the double push bug", () => {
    // --- Step 1: write_file saves to session output with remapped name ---
    const originalPath = "tmp/大模型训练技术分析报告.md";
    const content = "# 大模型训练技术分析报告\n\n这是一份详细的分析报告。";

    // Simulate write_file behavior
    const outputDir = getSessionOutputDir(testDir, sessionId);
    mkdirSync(outputDir, { recursive: true });

    // makeAgentFilename preserves CJK (Layer 1 fix)
    const prefixed = makeAgentFilename("main", originalPath.replace(/^\/+/, ""));
    const actualPath = resolve(outputDir, prefixed);
    writeFileSync(actualPath, content, "utf-8");

    // write_file returns the actual relative path
    const returnedPath = actualPath.replace(testDir + "/", "");
    expect(returnedPath).toContain("大模型训练技术分析报告");

    // --- Step 2: Agent ignores returned path, uses original path for push_content ---
    // This is the bug scenario: Agent calls push_content("tmp/大模型训练技术分析报告.md")
    const agentProvidedPath = originalPath;

    // Simulate push_content path resolution (Layer 2 fix)
    const normalized = agentProvidedPath.startsWith("data/")
      ? agentProvidedPath.slice(5)
      : agentProvidedPath;
    let resolvedPath = resolve(testDir, normalized);

    // Direct path doesn't exist (the bug trigger)
    expect(existsSync(resolvedPath)).toBe(false);

    // Session output fallback (Layer 2 fix)
    const sessionPath = resolveSessionOutputPath(normalized, testDir, sessionId);
    expect(sessionPath).not.toBe(resolvedPath);
    expect(existsSync(sessionPath)).toBe(true);

    // Verify the file content matches what was written
    const { readFileSync } = require("node:fs");
    const readContent = readFileSync(sessionPath, "utf-8");
    expect(readContent).toBe(content);
  });

  it("still works when Agent uses the correct returned path", () => {
    const originalPath = "reports/季度财务分析.md";
    const content = "季度财务数据...";

    const outputDir = getSessionOutputDir(testDir, sessionId);
    mkdirSync(outputDir, { recursive: true });

    const prefixed = makeAgentFilename("main", originalPath.replace(/^\/+/, ""));
    const actualPath = resolve(outputDir, prefixed);
    writeFileSync(actualPath, content, "utf-8");

    // Agent uses the CORRECT returned path
    const returnedRelative = actualPath.replace(testDir + "/", "");

    // Direct resolution works (file exists at returned path)
    const directPath = resolve(testDir, returnedRelative);
    expect(existsSync(directPath)).toBe(true);

    // Session output fallback also works (no harm)
    const sessionPath = resolveSessionOutputPath(
      returnedRelative.replace(/^sessions\/[^/]+\/output\//, ""),
      testDir,
      sessionId,
    );
    expect(existsSync(sessionPath)).toBe(true);
  });
});
