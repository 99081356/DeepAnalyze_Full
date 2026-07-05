// src/services/model-manifest.ts
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export interface ModelManifestFile {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface ModelManifestEntry {
  version: string;
  category: string;
  size_bytes: number;
  files: ModelManifestFile[];
  sources: { huggingface?: string; hf_mirror?: string };
  runtime_deps?: { python_packages?: string[] };
  min_disk_mb?: number;
  min_ram_mb?: number;
  recommended_for?: string[];
}

export interface ModelManifest {
  version: string;
  models: Record<string, ModelManifestEntry>;
}

let cached: ModelManifest | null = null;

export function getLocalManifest(): ModelManifest {
  if (cached) return cached;
  const manifestPath = process.env.DA_MANIFEST_PATH
    || resolve(process.cwd(), "da-assets/manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  cached = JSON.parse(readFileSync(manifestPath, "utf-8"));
  return cached;
}

export async function fetchRemoteManifest(): Promise<ModelManifest | null> {
  const url = process.env.DA_MANIFEST_URL;
  if (!url) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    return await resp.json() as ModelManifest;
  } catch {
    return null;
  }
}

export function getModelsDir(): string {
  return process.env.DA_MODELS_DIR || resolve(process.cwd(), "data/models");
}

export function getModelDir(modelName: string): string {
  return join(getModelsDir(), modelName);
}

/** Reset the manifest cache — for test isolation only */
export function _resetManifestCache(): void {
  cached = null;
}
