// =============================================================================
// src/lib/image-packager.ts
// =============================================================================
// Pulls Docker images via `docker pull --platform=...`, saves them to tar via
// `docker save`, and computes sha256+size. Failures during pull/save are
// logged and skipped — the build pipeline continues with whatever images
// succeeded.
// =============================================================================

import { execSync } from "node:child_process";
import { mkdirSync, statSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PackagedImage } from "../types.js";

// Re-export so existing imports from this module keep working
export type { PackagedImage };

export interface ImageToPackage {
  name: string;        // e.g. "deepanalyze/da"
  tag: string;         // e.g. "v0.9.0"
  platforms: string[]; // ["linux/amd64", "linux/arm64"]
}

export interface PackageImagesOptions {
  images: ImageToPackage[];
  outputDir: string;
  skipImages?: boolean;
}

export async function packageImages(opts: PackageImagesOptions): Promise<{
  images: PackagedImage[];
}> {
  const imagesDir = join(opts.outputDir, "images");
  mkdirSync(imagesDir, { recursive: true });

  if (opts.skipImages) {
    console.log("[image-packager] skipImages=true, skipping");
    return { images: [] };
  }

  const result: PackagedImage[] = [];

  for (const img of opts.images) {
    for (const platform of img.platforms) {
      const arch = platform.split("/")[1];  // amd64 | arm64
      const fullName = `${img.name}:${img.tag}`;
      // Sanitize filename: replace any non-{alphanumeric, dot, dash, underscore} with dash
      const fileName = `${img.name.split("/").pop()}-${img.tag}-${arch}.tar`
        .replace(/[^a-zA-Z0-9._-]/g, "-");
      const outPath = join(imagesDir, fileName);

      console.log(`[image-packager] pulling ${fullName} (${platform})...`);
      try {
        execSync(
          `docker pull --platform=${platform} ${fullName}`,
          { stdio: "inherit" },
        );
      } catch (err) {
        console.warn(`[image-packager] pull failed for ${fullName}: ${err}`);
        continue;
      }

      console.log(`[image-packager] saving to ${fileName}...`);
      try {
        execSync(
          `docker save -o "${outPath}" ${fullName}`,
          { stdio: "inherit" },
        );
      } catch (err) {
        console.warn(`[image-packager] save failed: ${err}`);
        continue;
      }

      const sha = await computeFileSha(outPath);
      const size = statSync(outPath).size;
      result.push({
        name: img.name,
        tag: img.tag,
        fileName,
        sha256: sha,
        sizeBytes: size,
        platform,
      });
    }
  }

  return { images: result };
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
