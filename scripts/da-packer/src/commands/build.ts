// =============================================================================
// src/commands/build.ts
// =============================================================================
// build command main flow:
//   1. parse args → BuildOptions
//   2. fetch model manifest (fetchModelManifest)
//   3. assemble work dir: images/ models/ skills/ config/ scripts/
//   4. call image-packager / model-packager / skill-packager
//   5. generate install-hub.sh + docker-compose.yml + README + bundle-manifest.json
//   6. tar.gz it (buildBundle writes sidecar .sha256)
//   7. report final sha256 (from buildBundle return value)
// =============================================================================

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { parseModelList, fetchModelManifest } from "../lib/manifest-fetcher.js";
import { packageImages, type ImageToPackage } from "../lib/image-packager.js";
import { packageModels } from "../lib/model-packager.js";
import { packageSkills } from "../lib/skill-packager.js";
import { generateInstallScripts, formatBytes } from "../lib/install-script-gen.js";
import { buildBundle } from "../lib/bundle-builder.js";
import type { BuildOptions } from "../types.js";

export async function buildCommand(opts: any): Promise<void> {
  console.log("=== da-packer build ===");
  const options = parseBuildOptions(opts);
  console.log("Options:", JSON.stringify(options, null, 2));

  // Step 1: fetch manifest
  console.log("\n[1/7] Fetching model manifest...");
  const allModels = await fetchModelManifest(options.source, {
    localPath: process.env.DA_REPO_PATH,
    enterpriseUrl: options.enterpriseUrl,
  });
  const selectedModels = new Map<string, (typeof allModels)[string]>();
  for (const name of options.models) {
    if (allModels[name]) {
      selectedModels.set(name, allModels[name]);
    } else {
      console.warn(`[build] model not in manifest: ${name}, skipping`);
    }
  }
  console.log(`  Selected ${selectedModels.size} model(s)`);

  // Step 2: create temp work dir
  const workDir = mkdtempSync(join(tmpdir(), "da-bundle-"));
  const bundleDirName = `da-bundle-${options.daVersion}`;
  const outputDir = join(workDir, bundleDirName);
  mkdirSync(outputDir, { recursive: true });
  console.log(`\n[2/7] Work dir: ${outputDir}`);

  try {
    // Step 3: package images
    console.log("\n[3/7] Packaging Docker images...");
    const imagesToPackage: ImageToPackage[] = [
      { name: "deepanalyze/da", tag: options.daVersion, platforms: options.platform },
    ];
    if (options.includeHub) {
      imagesToPackage.push(
        { name: "deepanalyze/hub", tag: options.hubVersion, platforms: options.platform },
        { name: "pgvector/pgvector", tag: "pg17", platforms: ["linux/amd64"] },
      );
    }
    const imageResult = await packageImages({
      images: imagesToPackage,
      outputDir,
      skipImages: options.skipImages,
    });
    console.log(`  Packaged ${imageResult.images.length} image(s)`);

    // Step 4: package models
    console.log("\n[4/7] Packaging models...");
    const modelResult = await packageModels({
      models: selectedModels,
      outputDir,
      source: options.source,
      enterpriseUrl: options.enterpriseUrl,
      cachePath: process.env.DA_REPO_PATH
        ? join(process.env.DA_REPO_PATH, "data/models")
        : undefined,
      skipModels: options.skipModels,
    });
    const okModels = modelResult.models.filter(m => m.status === "ok");
    const failedModels = modelResult.models.filter(m => m.status === "failed");
    console.log(`  OK: ${okModels.length}, Failed: ${failedModels.length}`);
    for (const m of failedModels) {
      console.warn(`    - ${m.name}: ${m.error}`);
    }

    // Step 5: package skills
    console.log("\n[5/7] Packaging skills...");
    const skillResult = await packageSkills({
      skills: options.skills.map(s => ({
        name: s,
        source: "local" as const,
        localPath: process.env.DA_REPO_PATH
          ? join(process.env.DA_REPO_PATH, "agent_skills", s)
          : undefined,
      })),
      outputDir,
      skipSkills: options.skipSkills,
    });
    console.log(`  Packaged ${skillResult.skills.length} skill(s)`);

    // Step 6: generate install scripts
    console.log("\n[6/7] Generating install scripts...");
    const totalSize =
      imageResult.images.reduce((s, i) => s + i.sizeBytes, 0) +
      okModels.reduce((s, m) => s + m.sizeBytes, 0) +
      skillResult.skills.reduce((s, sk) => s + sk.sizeBytes, 0);
    generateInstallScripts({
      outputDir,
      daVersion: options.daVersion,
      hubVersion: options.hubVersion,
      platforms: options.platform,
      models: okModels,
      skills: skillResult.skills,
      images: imageResult.images,
      bundleSha256: "",  // sidecar .sha256 file written by buildBundle is the source of truth
      totalSizeBytes: totalSize,
    });

    // Step 7: pack tar.gz
    console.log("\n[7/7] Building tar.gz...");
    const buildResult = await buildBundle({
      sourceDir: outputDir,
      outputFile: resolve(options.output),
      bundleDirName,
      split: options.split,
    });

    console.log("\n=== Build complete ===");
    console.log(`Output:    ${buildResult.outputFile}`);
    console.log(`Sidecar:   ${buildResult.sidecarFile}`);
    console.log(`Size:      ${formatBytes(buildResult.totalSizeBytes)}`);
    console.log(`SHA256:    ${buildResult.sha256}`);
    if (buildResult.files) {
      console.log(`Parts:     ${buildResult.files.join(", ")}`);
    }
    console.log(`\nNext steps:`);
    console.log(`  1. Copy ${basename(buildResult.outputFile)} (+ .sha256 sidecar) to target machine`);
    console.log(`  2. tar xzf ${basename(buildResult.outputFile)}`);
    console.log(`  3. cd ${bundleDirName}/ && sudo ./install-hub.sh`);

  } finally {
    if (!process.env.DA_PACKER_KEEP_WORK) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`[build] DA_PACKER_KEEP_WORK set; work dir retained at ${workDir}`);
    }
  }
}

function parseBuildOptions(opts: any): BuildOptions {
  return {
    daVersion: opts.daVersion,
    hubVersion: opts.hubVersion,
    models: parseModelList(opts.models),
    skills: parseModelList(opts.skills),
    output: opts.output,
    source: opts.source,
    enterpriseUrl: opts.enterpriseUrl,
    platform: opts.platform.split(",").map((s: string) => s.trim()),
    split: opts.split,
    includeHub: opts.hub !== false,
    skipImages: opts.skipImages,
    skipModels: opts.skipModels,
    skipSkills: opts.skipSkills,
  };
}
