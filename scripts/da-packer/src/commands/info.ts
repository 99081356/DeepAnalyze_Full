// =============================================================================
// src/commands/info.ts
// =============================================================================
// Display bundle contents. Extracts bundle-manifest.json and prints structured
// info. If no manifest in archive, falls back to listing archive contents.
// =============================================================================

import { existsSync, createReadStream } from "node:fs";
import * as tar from "tar";
import { formatBytes } from "../lib/install-script-gen.js";

export async function infoCommand(bundlePath: string): Promise<void> {
  if (!existsSync(bundlePath)) {
    console.error(`Bundle not found: ${bundlePath}`);
    process.exit(1);
  }

  console.log(`=== Bundle: ${bundlePath} ===\n`);

  let manifest: any = null;
  try {
    manifest = await extractManifest(bundlePath);
  } catch (err) {
    console.warn(`  Could not extract manifest: ${err instanceof Error ? err.message : err}`);
  }

  if (!manifest) {
    console.log("No bundle-manifest.json in archive. Showing raw file list:");
    await listArchiveContents(bundlePath);
    return;
  }

  console.log(`Version:        ${manifest.version || "unknown"}`);
  console.log(`Generated at:   ${manifest.generatedAt || "unknown"}`);
  console.log(`Total size:     ${formatBytes(manifest.totalSizeBytes || 0)}`);
  console.log(`SHA256 (sidecar): see ${bundlePath}.sha256`);
  console.log(`\nDA image:       ${manifest.daImageTag || "unknown"}`);
  console.log(`Hub image:      ${manifest.hubImageTag || "unknown"}`);
  console.log(`Platforms:      ${(manifest.platforms || []).join(", ") || "unknown"}`);

  console.log(`\nModels (${manifest.models?.length || 0}):`);
  for (const m of manifest.models || []) {
    console.log(`  - ${m.name} v${m.version}  ${formatBytes(m.sizeBytes || 0)}`);
  }

  console.log(`\nSkills (${manifest.skills?.length || 0}):`);
  for (const s of manifest.skills || []) {
    console.log(`  - ${s.name} v${s.version}  (${s.source})`);
  }

  console.log(`\nImages (${manifest.images?.length || 0}):`);
  for (const i of manifest.images || []) {
    console.log(`  - ${i.name}:${i.tag}`);
    for (const p of i.platforms || []) {
      console.log(`    ${p.arch}: ${formatBytes(p.sizeBytes || 0)}`);
    }
  }
}

async function extractManifest(bundlePath: string): Promise<any> {
  let manifest: any = null;
  await new Promise<void>((resolve, reject) => {
    const tarStream = tar.list({
      filter: (path: string) => path.endsWith("bundle-manifest.json"),
      onentry: (entry: any) => {
        const chunks: Buffer[] = [];
        entry.on("data", (d: Buffer) => chunks.push(d));
        entry.on("end", () => {
          try {
            manifest = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        entry.on("error", reject);
      },
    });
    tarStream.on("error", reject);
    createReadStream(bundlePath).pipe(tarStream);
  });
  return manifest;
}

async function listArchiveContents(path: string): Promise<void> {
  const files: string[] = [];
  await new Promise<void>(resolve => {
    const tarStream = tar.list({
      onentry: (entry: any) => files.push(entry.path),
    } as any);
    createReadStream(path).pipe(tarStream);
    tarStream.on("end", resolve);
    tarStream.on("error", resolve);
  });
  console.log(`Files (${files.length}):`);
  for (const f of files.slice(0, 50)) console.log(`  ${f}`);
  if (files.length > 50) console.log(`  ... and ${files.length - 50} more`);
}
