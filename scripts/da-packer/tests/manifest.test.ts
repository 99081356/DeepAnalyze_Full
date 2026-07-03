// =============================================================================
// tests/manifest.test.ts
// =============================================================================
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fetchModelManifest, parseModelList } from "../src/lib/manifest-fetcher.js";

const daRepo = process.env.DA_REPO_PATH;
const manifestPath = daRepo ? resolve(daRepo, "da-assets/manifest.json") : null;
const haveLiveManifest = !!manifestPath && existsSync(manifestPath);

describe("parseModelList", () => {
  test("splits comma-separated list", () => {
    expect(parseModelList("bge-m3,whisper-tiny")).toEqual(["bge-m3", "whisper-tiny"]);
  });

  test("returns empty array for empty string", () => {
    expect(parseModelList("")).toEqual([]);
  });

  test("returns single-element array for lone name", () => {
    expect(parseModelList("single")).toEqual(["single"]);
  });

  test("trims whitespace around entries", () => {
    expect(parseModelList(" a , b , c ")).toEqual(["a", "b", "c"]);
  });
});

describe("fetchModelManifest", () => {
  test.skipIf(!haveLiveManifest)("returns models from local DA repo", async () => {
    const manifest = await fetchModelManifest("cache", { localPath: daRepo });
    expect(manifest["bge-m3"]).toBeDefined();
    expect(manifest["bge-m3"].category).toBe("embedding");
    expect(manifest["bge-m3"].files.length).toBeGreaterThan(0);
    // Wire format uses snake_case for size_bytes
    expect(manifest["bge-m3"].files[0].size_bytes).toBeGreaterThan(0);
  });

  test("throws when all sources fail", async () => {
    // Stub fetch to always fail
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    try {
      await expect(fetchModelManifest("hf", {})).rejects.toThrow(
        /Failed to fetch manifest/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
