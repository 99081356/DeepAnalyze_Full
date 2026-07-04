// =============================================================================
// DeepAnalyze Hub - Bundle Repository
// =============================================================================
// 离线 bundle 元数据查询 + 镜像 tar 流式服务。
// 镜像 tar 由 da-packer 推送到 Hub（PUT /api/v1/bundle/images），
// 或直接放到 HUB_CONFIG.bundle.imagesDir 目录。
// =============================================================================

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { query } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";

const IMAGES_DIR = HUB_CONFIG.bundle.imagesDir;

export interface BundleManifestRow {
  id: string;
  version: string;
  da_image_tag: string;
  hub_image_tag: string;
  platform: string;
  models: Record<string, unknown>;
  skills: Record<string, unknown>;
  file_path: string | null;
  file_size: number | null;
  checksum_sha256: string | null;
  image_name: string;          // added by T05 migration 030
  uploaded_at: Date;           // added by T05 migration 030
  created_at: Date;
}

export async function getLatestBundleManifest(): Promise<BundleManifestRow | null> {
  const result = await query<BundleManifestRow>(
    `SELECT * FROM bundle_manifests ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

export async function listBundleManifests(): Promise<BundleManifestRow[]> {
  const result = await query<BundleManifestRow>(
    `SELECT id, version, da_image_tag, hub_image_tag, platform, models, skills,
            file_path, file_size, checksum_sha256, image_name, uploaded_at, created_at
     FROM bundle_manifests
     WHERE file_path IS NOT NULL
     ORDER BY uploaded_at DESC NULLS LAST`,
  );
  return result.rows;
}

export function resolveImageTar(imageName: string): {
  stream: Readable;
  size: number;
} | null {
  // imageName 形如 "da-base-v0.9.0-amd64.tar"
  const safe = imageName.replace(/[^a-zA-Z0-9._-]/g, "");
  const absPath = join(IMAGES_DIR, `${safe}`);
  if (!existsSync(absPath)) {
    // 也尝试不带 .tar 后缀
    const altPath = join(IMAGES_DIR, `${safe}.tar`);
    if (!existsSync(altPath)) return null;
    return {
      stream: createReadStream(altPath),
      size: statSync(altPath).size,
    };
  }
  return {
    stream: createReadStream(absPath),
    size: statSync(absPath).size,
  };
}

export function listAvailableImages(): string[] {
  if (!existsSync(IMAGES_DIR)) return [];
  return readdirSync(IMAGES_DIR)
    .filter((f) => f.endsWith(".tar"))
    .map((f) => f.replace(/\.tar$/, ""));
}
