// =============================================================================
// src/lib/install-script-gen.ts
// =============================================================================
// Generate install scripts + bundle metadata into a working directory.
// Reads templates/install-hub.sh.tmpl, docker-compose.yml.tmpl, README.md.tmpl
// and emits:
//   - install-hub.sh (executable)
//   - docker-compose.yml (with HUB_IMAGE_TAG substituted)
//   - config/hub-default.yaml
//   - scripts/health-check.sh
//   - README.md (with placeholders substituted)
//   - bundle-manifest.json (checksumSha256 field may be "pending"; rewritten
//     by bundle-builder / build command after the tar.gz is finalized)
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BundleManifest, PackagedImage, PackagedModel, PackagedSkill } from "../types.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../templates", import.meta.url));

export interface InstallScriptGenOptions {
  outputDir: string;
  daVersion: string;
  hubVersion: string;
  platforms: string[];
  models: PackagedModel[];
  skills: PackagedSkill[];
  images: PackagedImage[];
  bundleSha256: string;
  totalSizeBytes: number;
}

export function generateInstallScripts(opts: InstallScriptGenOptions): void {
  // install-hub.sh (verbatim from template, executable)
  const installTpl = readFileSync(join(TEMPLATES_DIR, "install-hub.sh.tmpl"), "utf-8");
  writeFileSync(join(opts.outputDir, "install-hub.sh"), installTpl, { mode: 0o755 });

  // docker-compose.yml (substitute HUB_IMAGE_TAG)
  const composeTpl = readFileSync(join(TEMPLATES_DIR, "docker-compose.yml.tmpl"), "utf-8")
    .replace(/\$\{HUB_IMAGE_TAG\}/g, opts.hubVersion);
  writeFileSync(join(opts.outputDir, "docker-compose.yml"), composeTpl);

  // config/hub-default.yaml
  mkdirSync(join(opts.outputDir, "config"), { recursive: true });
  writeFileSync(join(opts.outputDir, "config/hub-default.yaml"), generateHubDefaultYaml());

  // scripts/health-check.sh
  mkdirSync(join(opts.outputDir, "scripts"), { recursive: true });
  writeFileSync(join(opts.outputDir, "scripts/health-check.sh"), generateHealthCheckScript(), { mode: 0o755 });

  // README.md (substitute {{VARIABLE}} placeholders)
  const readmeTpl = readFileSync(join(TEMPLATES_DIR, "README.md.tmpl"), "utf-8");
  const readme = readmeTpl
    .replace(/\{\{VERSION\}\}/g, opts.daVersion)
    .replace(/\{\{DA_IMAGE_TAG\}\}/g, opts.daVersion)
    .replace(/\{\{HUB_IMAGE_TAG\}\}/g, opts.hubVersion)
    .replace(/\{\{MODEL_COUNT\}\}/g, String(opts.models.length))
    .replace(/\{\{MODELS_LIST\}\}/g, opts.models.map(m => m.name).join(", "))
    .replace(/\{\{SKILL_COUNT\}\}/g, String(opts.skills.length))
    .replace(/\{\{TOTAL_SIZE\}\}/g, formatBytes(opts.totalSizeBytes))
    .replace(/\{\{IMAGES_SIZE\}\}/g, formatBytes(opts.images.reduce((s, i) => s + i.sizeBytes, 0)))
    .replace(/\{\{MODELS_SIZE\}\}/g, formatBytes(opts.models.reduce((s, m) => s + m.sizeBytes, 0)))
    .replace(/\{\{BUNDLE_SHA256\}\}/g, opts.bundleSha256)
    .replace(/\{\{GENERATED_AT\}\}/g, new Date().toISOString());
  writeFileSync(join(opts.outputDir, "README.md"), readme);

  // bundle-manifest.json
  const manifest: BundleManifest = {
    version: opts.daVersion,
    generatedAt: new Date().toISOString(),
    daImageTag: opts.daVersion,
    hubImageTag: opts.hubVersion,
    platforms: opts.platforms,
    models: opts.models.map(m => ({
      name: m.name, version: m.version, sha256: m.sha256,
      sizeBytes: m.sizeBytes, files: m.files,
    })),
    skills: opts.skills.map(s => ({
      name: s.name, version: s.version, source: s.source,
    })),
    images: groupImagesByTag(opts.images),
    checksumSha256: opts.bundleSha256,
    totalSizeBytes: opts.totalSizeBytes,
  };
  writeFileSync(join(opts.outputDir, "bundle-manifest.json"), JSON.stringify(manifest, null, 2));
}

function groupImagesByTag(images: PackagedImage[]): BundleManifest["images"] {
  const grouped = new Map<string, BundleManifest["images"][number]>();
  for (const img of images) {
    const key = `${img.name}:${img.tag}`;
    if (!grouped.has(key)) {
      grouped.set(key, { name: img.name, tag: img.tag, platforms: [] });
    }
    grouped.get(key)!.platforms.push({
      arch: img.platform.split("/")[1] || img.platform,
      sha256: img.sha256,
      sizeBytes: img.sizeBytes,
    });
  }
  return Array.from(grouped.values());
}

function generateHubDefaultYaml(): string {
  return `# Hub 默认配置（install-hub.sh 会注入实际值）
port: ${process.env.PORT || 22000}
database:
  host: postgres
  port: 5432
  user: deepanalyze_hub
  password: \${HUB_DB_PASSWORD}
  database: deepanalyze_hub
auth:
  jwtSecret: \${JWT_SECRET}
  jwtRefreshSecret: \${JWT_REFRESH_SECRET}
  jwtExpiry: 7d
  workerTokenExpiry: 30d
modelRepo:
  storageDir: \${HUB_DATA_DIR}/models
bundle:
  imagesDir: \${HUB_DATA_DIR}/bundle/images
`;
}

function generateHealthCheckScript(): string {
  return `#!/bin/bash
set -e
curl -sf http://localhost:\${HUB_PORT:-22000}/api/health
`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}
