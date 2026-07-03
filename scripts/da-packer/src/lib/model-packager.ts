// =============================================================================
// src/lib/model-packager.ts
// =============================================================================
// Concurrent multi-threaded model weight downloader with sha256 verification.
// Failed models are recorded with status="failed" but don't abort the run —
// the build pipeline continues with whatever models succeeded.
//
// Cache mode (source="cache" + cachePath): copies an existing local model
// directory verbatim (no sha verification — assumes the cache is trustworthy).
// =============================================================================

import { createHash } from "node:crypto";
import {
  createWriteStream, existsSync, mkdirSync, statSync, renameSync,
  cpSync, readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import pMap from "p-map";
import type { PackagedModel, ModelManifestEntry } from "../types.js";

// Re-export so existing imports from this module keep working
export type { PackagedModel, ModelManifestEntry };

export interface PackageModelsOptions {
  models: Map<string, ModelManifestEntry>;  // name → manifest entry
  outputDir: string;
  source: "hf" | "hf_mirror" | "enterprise" | "cache";
  enterpriseUrl?: string;
  cachePath?: string;          // DA_REPO_PATH/data/models
  skipModels?: boolean;
  concurrency?: number;
}

export async function packageModels(opts: PackageModelsOptions): Promise<{
  models: PackagedModel[];
}> {
  const modelsDir = join(opts.outputDir, "models");
  mkdirSync(modelsDir, { recursive: true });

  if (opts.skipModels) {
    return { models: [] };
  }

  const concurrency = opts.concurrency ?? 4;
  const entries = Array.from(opts.models.entries());

  const results = await pMap(
    entries,
    ([name, manifest]) => packageOneModel(name, manifest, modelsDir, opts),
    { concurrency },
  );

  return { models: results };
}

async function packageOneModel(
  name: string,
  manifest: ModelManifestEntry,
  modelsDir: string,
  opts: PackageModelsOptions,
): Promise<PackagedModel> {
  // cache mode: copy from local DA repo's data/models/<name>/
  if (opts.source === "cache" && opts.cachePath) {
    const srcDir = join(opts.cachePath, name);
    if (existsSync(srcDir)) {
      const destDir = join(modelsDir, name);
      mkdirSync(destDir, { recursive: true });
      cpSync(srcDir, destDir, { recursive: true });
      const sizeBytes = dirSize(destDir);
      return {
        name,
        version: manifest.version,
        sha256: "",
        sizeBytes,
        files: [],
        status: "ok",
      };
    }
  }

  // download mode
  const modelDir = join(modelsDir, name);
  mkdirSync(modelDir, { recursive: true });

  const sourceBaseUrl = resolveSourceUrl(manifest, opts);
  if (!sourceBaseUrl) {
    return {
      name, version: manifest.version, sha256: "", sizeBytes: 0, files: [],
      status: "failed", error: "no source URL",
    };
  }

  const fileResults: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
  let totalSize = 0;
  let combinedSha = "";

  for (const file of manifest.files) {
    const targetPath = join(modelDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });

    try {
      const url = `${sourceBaseUrl}/${file.path}`;
      const actualSha = await downloadWithRetry(url, targetPath);

      if (actualSha !== file.sha256) {
        return {
          name, version: manifest.version,
          sha256: actualSha, sizeBytes: totalSize, files: fileResults,
          status: "failed", error: `sha mismatch on ${file.path}`,
        };
      }

      fileResults.push({ path: file.path, sha256: actualSha, sizeBytes: file.size_bytes });
      totalSize += file.size_bytes;
      combinedSha += actualSha;
    } catch (err) {
      return {
        name, version: manifest.version, sha256: "", sizeBytes: totalSize, files: fileResults,
        status: "failed", error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const finalSha = createHash("sha256").update(combinedSha).digest("hex");
  return {
    name, version: manifest.version, sha256: finalSha, sizeBytes: totalSize,
    files: fileResults, status: "ok",
  };
}

function resolveSourceUrl(
  manifest: ModelManifestEntry,
  opts: PackageModelsOptions,
): string | null {
  if (opts.source === "hf" && manifest.sources.huggingface) return manifest.sources.huggingface;
  if (opts.source === "hf_mirror" && manifest.sources.hf_mirror) return manifest.sources.hf_mirror;
  if (opts.source === "enterprise" && opts.enterpriseUrl) {
    return `${opts.enterpriseUrl}/${manifest.version}`;
  }
  // fallback: prefer hf_mirror, then huggingface
  return manifest.sources.hf_mirror || manifest.sources.huggingface || null;
}

const MAX_RETRIES = 3;

async function downloadWithRetry(url: string, targetPath: string): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await downloadFile(url, targetPath);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[model-packager] attempt ${attempt + 1} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error("download failed");
}

async function downloadFile(url: string, targetPath: string): Promise<string> {
  const partPath = `${targetPath}.part`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!resp.body) throw new Error("no body");

  const hasher = createHash("sha256");
  const out = createWriteStream(partPath);

  // Wrap the web ReadableStream into a Node Readable so pipeline() can consume it.
  const { Readable } = await import("node:stream");
  const nodeStream = Readable.fromWeb(resp.body as any);
  nodeStream.on("data", chunk => hasher.update(chunk));

  await pipeline(nodeStream, out);
  renameSync(partPath, targetPath);
  return hasher.digest("hex");
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(dir);
  return total;
}
