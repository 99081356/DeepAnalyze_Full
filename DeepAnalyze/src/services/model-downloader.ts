// =============================================================================
// src/services/model-downloader.ts
// =============================================================================

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { getLocalManifest, getModelDir, getModelsDir, type ModelManifestEntry } from "./model-manifest.js";

export type ModelSource = "huggingface" | "hf_mirror" | "enterprise" | "hub" | "manual";

export interface DownloadProgress {
  fileName: string;
  bytesDownloaded: number;
  bytesTotal: number;
  percent: number;
}

export interface DownloadResult {
  ok: boolean;
  modelName: string;
  bytesDownloaded: number;
  duration: number;
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  missingFiles?: string[];
  mismatchedSha?: string[];
}

const MAX_RETRIES = 3;
const FALLBACK_SOURCES: ModelSource[] = ["enterprise", "hf_mirror", "huggingface"];

export async function downloadModel(
  name: string,
  source: ModelSource,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  const start = Date.now();
  const manifest = getLocalManifest();
  const entry: ModelManifestEntry | undefined = manifest.models[name];
  if (!entry) {
    return { ok: false, modelName: name, bytesDownloaded: 0, duration: 0, error: "model not in manifest" };
  }

  const modelDir = getModelDir(name);
  mkdirSync(modelDir, { recursive: true });

  const sources = resolveSourceUrls(entry, source);
  if (sources.length === 0) {
    return { ok: false, modelName: name, bytesDownloaded: 0, duration: 0, error: "no source available" };
  }

  let totalDownloaded = 0;

  for (const file of entry.files) {
    const targetPath = join(modelDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });

    let success = false;
    let lastErr: Error | null = null;

    for (const baseUrl of sources) {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const url = `${baseUrl}/${file.path}`;
          const bytes = await downloadFile(url, targetPath, file.size_bytes, file.path, onProgress);
          totalDownloaded += bytes;

          // Verify sha256
          const actualSha = await computeFileSha(targetPath);
          if (actualSha !== file.sha256) {
            throw new Error(`sha256 mismatch for ${file.path}: expected ${file.sha256}, got ${actualSha}`);
          }

          success = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          console.warn(`[downloader] ${file.path} attempt ${attempt + 1} failed: ${lastErr.message}`);
        }
      }
      if (success) break;
    }

    if (!success) {
      return {
        ok: false, modelName: name, bytesDownloaded: totalDownloaded, duration: Date.now() - start,
        error: `failed to download ${file.path}: ${lastErr?.message}`,
      };
    }
  }

  return { ok: true, modelName: name, bytesDownloaded: totalDownloaded, duration: Date.now() - start };
}

function resolveSourceUrls(entry: ModelManifestEntry, source: ModelSource): string[] {
  if (source === "manual") return [];
  if (source === "enterprise" && process.env.DA_ENTERPRISE_MODELS_URL) {
    return [`${process.env.DA_ENTERPRISE_MODELS_URL}/${entry.version}`];
  }
  if (source === "hub" && process.env.DA_HUB_URL) {
    return [`${process.env.DA_HUB_URL}/api/v1/models/blobs`];
  }
  if (source === "huggingface" && entry.sources.huggingface) {
    return [entry.sources.huggingface];
  }
  if (source === "hf_mirror" && entry.sources.hf_mirror) {
    return [entry.sources.hf_mirror];
  }
  // auto fallback
  return FALLBACK_SOURCES
    .map(s => resolveSourceUrls(entry, s)[0])
    .filter(Boolean) as string[];
}

async function downloadFile(
  url: string,
  targetPath: string,
  totalBytes: number,
  fileName: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<number> {
  const partPath = `${targetPath}.part`;
  const existingBytes = existsSync(partPath) ? statSync(partPath).size : 0;

  const headers: Record<string, string> = {};
  if (existingBytes > 0) {
    headers["Range"] = `bytes=${existingBytes}-`;
  }

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(300000) });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  const isResuming = resp.status === 206;
  const body = resp.body;
  if (!body) throw new Error("no body");

  let received = existingBytes;
  let lastReport = Date.now();

  // Append mode when resuming, write mode for fresh download
  const out = createWriteStream(partPath, { flags: isResuming ? "a" : "w" });

  const countingStream = new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        controller.enqueue(value);
        if (onProgress && Date.now() - lastReport > 500) {
          lastReport = Date.now();
          onProgress({
            fileName,
            bytesDownloaded: received,
            bytesTotal: totalBytes,
            percent: totalBytes > 0 ? (received / totalBytes) * 100 : 0,
          });
        }
      }
      controller.close();
    },
  });

  await pipeline(countingStream, out);
  renameSync(partPath, targetPath);
  return received;
}

async function computeFileSha(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", d => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function verifyModel(name: string): Promise<VerifyResult> {
  const manifest = getLocalManifest();
  const entry = manifest.models[name];
  if (!entry) return { ok: false, reason: "model not in manifest" };

  const modelDir = getModelDir(name);
  if (!existsSync(modelDir)) return { ok: false, reason: "model dir missing" };

  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const f of entry.files) {
    const fp = join(modelDir, f.path);
    if (!existsSync(fp)) {
      missing.push(f.path);
      continue;
    }
    const actualSha = await computeFileSha(fp);
    if (actualSha !== f.sha256) {
      mismatched.push(f.path);
    }
  }

  if (missing.length > 0) {
    return { ok: false, reason: `missing ${missing.length} file(s)`, missingFiles: missing };
  }
  if (mismatched.length > 0) {
    return { ok: false, reason: `sha256 mismatch on ${mismatched.length} file(s)`, mismatchedSha: mismatched };
  }

  return { ok: true };
}

export function listLocalModels(): Array<{ name: string; sizeBytes: number }> {
  const dir = getModelsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const path = join(dir, d.name);
      let sizeBytes = 0;
      try {
        const entries = readdirSync(path, { recursive: true });
        for (const f of entries) {
          const fp = join(path, f as string);
          if (existsSync(fp) && statSync(fp).isFile()) sizeBytes += statSync(fp).size;
        }
      } catch {}
      return { name: d.name, sizeBytes };
    });
}

export async function removeModel(name: string): Promise<void> {
  const dir = getModelDir(name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
