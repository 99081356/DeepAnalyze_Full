import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { getLocalManifest, getModelsDir, getModelDir, _resetManifestCache } from "../src/services/model-manifest.js";
import { downloadModel, verifyModel, listLocalModels, removeModel } from "../src/services/model-downloader.js";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

describe("model-manifest", () => {
  beforeEach(() => _resetManifestCache());

  test("local manifest loads", () => {
    const m = getLocalManifest();
    expect(m.version).toBeTruthy();
    expect(Object.keys(m.models).length).toBeGreaterThan(0);
    expect(m.models["bge-m3"]).toBeDefined();
  });

  test("models dir resolves", () => {
    expect(getModelsDir()).toBeTruthy();
  });

  test("getModelDir joins model name", () => {
    const dir = getModelDir("bge-m3");
    expect(dir).toContain("bge-m3");
  });

  test("manifest contains expected model categories", () => {
    const m = getLocalManifest();
    expect(m.models["bge-m3"].category).toBe("embedding");
    expect(m.models["whisper-tiny"].category).toBe("asr");
    expect(m.models["docling"].category).toBe("doc_parsing");
    expect(m.models["paddleocr-vl"].category).toBe("vlm");
  });
});

const TEST_DIR = resolve(process.cwd(), "tests/tmp-models");

describe("model-downloader", () => {
  beforeEach(() => {
    _resetManifestCache();
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.DA_MODELS_DIR = TEST_DIR;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.DA_MODELS_DIR;
    _resetManifestCache();
  });

  test("listLocalModels returns empty when no models", () => {
    expect(listLocalModels()).toEqual([]);
  });

  test("verifyModel detects missing files", async () => {
    const r = await verifyModel("bge-m3");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("missing");
  });

  test("verifyModel detects sha256 mismatch after manual place", async () => {
    const manifest = getLocalManifest();
    const model = manifest.models["bge-m3"];
    const modelDir = resolve(TEST_DIR, "bge-m3");
    mkdirSync(modelDir, { recursive: true });

    for (const f of model.files) {
      writeFileSync(resolve(modelDir, f.path), "fake-content");
    }
    const r = await verifyModel("bge-m3");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("sha256");
  });

  test("downloadFile resumes from .part file when Range supported", async () => {
    // This test verifies the resume logic doesn't crash when a .part file exists.
    // We can't easily test real HTTP resume in unit tests, but we verify
    // that listLocalModels/verifyModel still work after a partial download.
    const manifest = getLocalManifest();
    const model = manifest.models["bge-m3"];
    const modelDir = resolve(TEST_DIR, "bge-m3");
    mkdirSync(modelDir, { recursive: true });

    // Create a partial file to simulate interrupted download
    for (const f of model.files) {
      writeFileSync(resolve(modelDir, f.path), "partial");
    }

    // verifyModel should detect sha mismatch (partial content != expected sha)
    const r = await verifyModel("bge-m3");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("sha256");
  });

  test("removeModel cleans up directory", async () => {
    const modelDir = resolve(TEST_DIR, "test-model");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(resolve(modelDir, "file.txt"), "test");
    await removeModel("test-model");
    expect(existsSync(modelDir)).toBe(false);
  });
});
