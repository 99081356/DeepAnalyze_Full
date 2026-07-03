// =============================================================================
// DeepAnalyze Hub - Model Artifact Repository
// =============================================================================
// Enterprise internal model repository. Admins upload via multipart, DA
// workers fetch manifests and stream blobs. Files are stored on local disk
// (or a mounted volume) at HUB_CONFIG.modelRepo.storageDir.
// =============================================================================

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  createReadStream,
  statSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { query } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";

const STORAGE_DIR =
  HUB_CONFIG.modelRepo.storageDir ||
  process.env.HUB_MODEL_REPO_DIR ||
  "./data/model-repo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadedFile {
  originalName: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
}

export interface ModelManifest {
  version: string;
  category: string;
  sha256: string;
  size_bytes: number;
  files: Array<{ path: string; sha256: string; size_bytes: number }>;
  runtime_deps?: Record<string, unknown>;
  uploaded_at: string;
}

// ---------------------------------------------------------------------------
// uploadModelArtifact — write files to disk, compute hashes, insert into PG
// ---------------------------------------------------------------------------

export async function uploadModelArtifact(
  name: string,
  version: string,
  category: string,
  files: Array<{ originalName: string; stream: Readable }>,
  uploadedBy: string,
): Promise<{ id: string; files: UploadedFile[] }> {
  const uploaded: UploadedFile[] = [];

  for (const f of files) {
    const relPath = `${name}/${version}/${f.originalName}`;
    const absPath = join(STORAGE_DIR, relPath);
    mkdirSync(dirname(absPath), { recursive: true });

    const hash = createHash("sha256");
    const out = createWriteStream(absPath);

    // Iterate the stream, writing chunks and hashing them
    for await (const chunk of f.stream) {
      hash.update(chunk as Buffer);
      if (!out.write(chunk)) {
        // backpressure: wait for drain before continuing
        await new Promise<void>((res) => out.once("drain", () => res()));
      }
    }

    // Flush and close — register error handler BEFORE end(), then await finish
    await new Promise<void>((resolve, reject) => {
      out.on("error", reject);
      out.end(() => resolve());
    });

    const sha = hash.digest("hex");
    const size = statSync(absPath).size;
    uploaded.push({
      originalName: f.originalName,
      sha256: sha,
      sizeBytes: size,
      storagePath: relPath,
    });
  }

  // Pack-level sha256 (concatenation of per-file digests)
  const packSha = createHash("sha256")
    .update(uploaded.map((f) => f.sha256).join(""))
    .digest("hex");

  const id = `mdl_${randomUUID().replace(/-/g, "")}`;
  const manifest: ModelManifest = {
    version,
    category,
    sha256: packSha,
    size_bytes: uploaded.reduce((s, f) => s + f.sizeBytes, 0),
    files: uploaded.map((f) => ({
      path: f.originalName,
      sha256: f.sha256,
      size_bytes: f.sizeBytes,
    })),
    uploaded_at: new Date().toISOString(),
  };

  await query(
    `INSERT INTO model_artifacts (id, name, version, category, sha256, size_bytes, storage_path, manifest, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      name,
      version,
      category,
      packSha,
      manifest.size_bytes,
      `${STORAGE_DIR}/${name}/${version}`,
      JSON.stringify(manifest),
      uploadedBy,
    ],
  );

  return { id, files: uploaded };
}

// ---------------------------------------------------------------------------
// getLatestManifest — return the most recent manifest for a model name
// ---------------------------------------------------------------------------

export async function getLatestManifest(
  name: string,
): Promise<ModelManifest | null> {
  const result = await query<{ manifest: ModelManifest }>(
    `SELECT manifest FROM model_artifacts WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
    [name],
  );
  return result.rows.length > 0 ? result.rows[0].manifest : null;
}

// ---------------------------------------------------------------------------
// resolveBlobStream — find a blob by sha256 across all model versions
// ---------------------------------------------------------------------------

export async function resolveBlobStream(
  sha256: string,
): Promise<{ stream: Readable; size: number; contentType: string } | null> {
  // manifest->'files' @> [{"sha256": "..."}] finds any version containing this blob
  const result = await query<{ storage_path: string; manifest: ModelManifest }>(
    `SELECT storage_path, manifest FROM model_artifacts
     WHERE manifest->'files' @> $1::jsonb LIMIT 1`,
    [JSON.stringify([{ sha256 }])],
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const fileMeta = row.manifest.files.find((f) => f.sha256 === sha256);
  if (!fileMeta) return null;

  const absPath = join(row.storage_path, fileMeta.path);
  if (!existsSync(absPath)) return null;

  return {
    stream: createReadStream(absPath),
    size: fileMeta.size_bytes,
    contentType: "application/octet-stream",
  };
}

// ---------------------------------------------------------------------------
// deleteModelVersion — remove a version from PG and clean up its directory
// ---------------------------------------------------------------------------

export async function deleteModelVersion(
  name: string,
  version: string,
): Promise<boolean> {
  const result = await query<{ storage_path: string }>(
    `DELETE FROM model_artifacts WHERE name = $1 AND version = $2 RETURNING storage_path`,
    [name, version],
  );
  if (result.rows.length === 0) return false;

  // Best-effort cleanup: storage_path is a directory (${STORAGE_DIR}/${name}/${version})
  try {
    rmSync(result.rows[0].storage_path, { recursive: true, force: true });
  } catch {
    // best-effort — log if needed but don't fail the API call
  }
  return true;
}
