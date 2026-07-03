// =============================================================================
// src/lib/manifest-fetcher.ts
// =============================================================================
// Locate the DA model manifest from one of:
//   1. cache:    local filesystem (DA_REPO_PATH env or opts.localPath)
//   2. enterprise: HTTP repo (opts.enterpriseUrl + /manifest.json)
//   3. GitHub raw: public main/master branches of leotangcw/DeepAnalyze
// All paths return the `models` field of the manifest JSON (a record keyed by
// model name). Throws when all sources fail.
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelManifestEntry } from "../types.js";

// Re-export so existing imports from this module keep working
export type { ModelManifestEntry };

const REMOTE_MANIFEST_URLS = [
  "https://raw.githubusercontent.com/leotangcw/DeepAnalyze/main/da-assets/manifest.json",
  "https://raw.githubusercontent.com/leotangcw/DeepAnalyze/master/da-assets/manifest.json",
];

export interface FetchModelManifestOpts {
  localPath?: string;
  enterpriseUrl?: string;
}

/**
 * Split a comma-separated model list into a trimmed array. Empty strings
 * produce an empty array (not `[""]`).
 */
export function parseModelList(s: string | undefined | null): string[] {
  if (!s || !s.trim()) return [];
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

/**
 * Resolve the DA model manifest from the configured source.
 *
 * - source="cache" OR opts.localPath set → try local file first
 * - source="enterprise" AND opts.enterpriseUrl set → try enterprise URL
 * - Otherwise (or as fallback) → try GitHub raw URLs in order
 *
 * Throws if every attempted source fails.
 */
export async function fetchModelManifest(
  source: "hf" | "hf_mirror" | "enterprise" | "cache",
  opts: FetchModelManifestOpts,
): Promise<Record<string, ModelManifestEntry>> {
  // 1. Local cache (highest priority when requested)
  if (source === "cache" || opts.localPath) {
    const localPath = opts.localPath || process.env.DA_REPO_PATH;
    if (localPath) {
      const manifestPath = resolve(localPath, "da-assets/manifest.json");
      if (existsSync(manifestPath)) {
        const raw = readFileSync(manifestPath, "utf-8");
        const data = JSON.parse(raw) as { models: Record<string, ModelManifestEntry> };
        return data.models;
      }
    }
  }

  // 2. Enterprise HTTP repo
  if (source === "enterprise" && opts.enterpriseUrl) {
    try {
      const resp = await fetch(`${opts.enterpriseUrl}/manifest.json`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { models: Record<string, ModelManifestEntry> };
        return data.models;
      }
    } catch {
      // fall through to GitHub
    }
  }

  // 3. GitHub raw (default fallback)
  for (const url of REMOTE_MANIFEST_URLS) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (resp.ok) {
        const data = (await resp.json()) as { models: Record<string, ModelManifestEntry> };
        return data.models;
      }
    } catch {
      // try next URL
    }
  }

  throw new Error("Failed to fetch manifest from any source");
}
