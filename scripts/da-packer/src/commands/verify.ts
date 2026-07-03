// =============================================================================
// src/commands/verify.ts
// =============================================================================
// Verify a bundle's integrity:
//   1. Compute the actual sha256 of the tar.gz
//   2. Read the sidecar .sha256 (written by buildBundle)
//   3. Match → ✓; mismatch → ✗ exit 1
//   4. If no sidecar: warn but don't fail (older bundles)
// Then extract bundle-manifest.json (display-only) to enumerate contents.
// =============================================================================

import { existsSync, readFileSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import * as tar from "tar";

export async function verifyCommand(bundlePath: string): Promise<void> {
  if (!existsSync(bundlePath)) {
    console.error(`Bundle not found: ${bundlePath}`);
    process.exit(1);
  }

  console.log(`Verifying: ${bundlePath}`);

  // Step 1: actual sha
  const actualSha = await computeFileSha(bundlePath);
  console.log(`  Bundle sha256: ${actualSha}`);

  // Step 2: read sidecar
  const sidecarSha = readSidecarSha(bundlePath);
  if (sidecarSha) {
    console.log(`  Sidecar sha256: ${sidecarSha}`);
    if (sidecarSha === actualSha) {
      console.log("  ✓ Checksum OK (matches sidecar)");
    } else {
      console.error("  ✗ Checksum mismatch!");
      console.error(`    Sidecar says: ${sidecarSha}`);
      console.error(`    Actual is:    ${actualSha}`);
      process.exit(1);
    }
  } else {
    console.warn("  ⚠ No sidecar .sha256 file. Cannot verify integrity automatically.");
    console.warn("    Use `sha256sum <bundle>` manually and compare against trusted source.");
  }

  // Step 3: extract manifest (display-only)
  let manifest: any = null;
  try {
    manifest = await extractManifest(bundlePath);
  } catch (err) {
    console.warn(`  ⚠ Could not extract bundle-manifest.json: ${err instanceof Error ? err.message : err}`);
  }

  if (manifest) {
    console.log(`\nContents (from bundle-manifest.json):`);
    console.log(`  Version:    ${manifest.version || "unknown"}`);
    console.log(`  Generated:  ${manifest.generatedAt || "unknown"}`);
    console.log(`  Images:     ${(manifest.images || []).length}`);
    console.log(`  Models:     ${(manifest.models || []).length}`);
    console.log(`  Skills:     ${(manifest.skills || []).length}`);
    if (manifest.checksumSha256 && manifest.checksumSha256 !== "") {
      console.log(`  Manifest checksumSha256: ${manifest.checksumSha256}`);
      console.log(`    (this field is "pending"/legacy — sidecar is the source of truth)`);
    }
  }
}

function readSidecarSha(bundlePath: string): string | null {
  try {
    const sidecar = `${bundlePath}.sha256`;
    const content = readFileSync(sidecar, "utf-8").trim();
    // sha256sum format: "<sha>  <filename>" or "<sha>  *<filename>"
    const m = /^([0-9a-fA-F]{64})\s+\*?/.exec(content);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
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

function computeFileSha(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", d => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
