// =============================================================================
// src/lib/bundle-builder.ts
// =============================================================================
// Pack a prepared bundle working directory into a single tar.gz archive.
// Optionally split into multi-volume parts (cross-platform, no shell `split`).
//
// The tar.gz sha256 is written both as the function's return value AND as a
// sidecar `<output>.sha256` file. Task I2's verify command reads the sidecar
// to confirm integrity — the bundle-manifest.json inside the tar.gz cannot
// reference the tar.gz's own sha (chicken-and-egg).
// =============================================================================

import {
  createWriteStream, statSync, createReadStream, renameSync, writeFileSync,
  type WriteStream,
} from "node:fs";
import { join, basename } from "node:path";
import * as tar from "tar";
import { createHash } from "node:crypto";

export interface BuildBundleOptions {
  sourceDir: string;          // contains images/, models/, skills/, etc.
  outputFile: string;         // final tar.gz path
  bundleDirName: string;      // tar.gz internal top-level dir (e.g. da-bundle-v0.9.0)
  split?: string;             // "2GB" — see parseSplitSize
}

export interface BuildBundleResult {
  outputFile: string;
  totalSizeBytes: number;
  sha256: string;
  sidecarFile: string;        // <outputFile>.sha256
  files?: string[];           // present only when split
}

export async function buildBundle(opts: BuildBundleOptions): Promise<BuildBundleResult> {
  const tmpTar = `${opts.outputFile}.tmp`;

  console.log("[bundle-builder] creating tar.gz...");
  await tar.create(
    {
      gzip: true,
      file: tmpTar,
      cwd: join(opts.sourceDir, ".."),
    },
    [basename(opts.sourceDir)],
  );

  // Compute sha256 of the tar.gz
  const sha = await computeFileSha(tmpTar);
  const size = statSync(tmpTar).size;
  console.log(`[bundle-builder] sha256: ${sha}`);
  console.log(`[bundle-builder] size: ${formatBytes(size)}`);

  renameSync(tmpTar, opts.outputFile);

  // Write sidecar .sha256 file (read by Task I2's verify command)
  const sidecarFile = `${opts.outputFile}.sha256`;
  writeFileSync(sidecarFile, `${sha}  ${basename(opts.outputFile)}\n`);

  if (opts.split) {
    const chunkSize = parseSplitSize(opts.split);
    const baseName = opts.outputFile.replace(/\.tar\.gz$/, "");
    const partPrefix = `${baseName}.part.`;
    console.log(`[bundle-builder] splitting into ${formatBytes(chunkSize)} volumes...`);
    const parts = await splitFile(opts.outputFile, partPrefix, chunkSize);
    return {
      outputFile: opts.outputFile,
      totalSizeBytes: size,
      sha256: sha,
      sidecarFile,
      files: parts,
    };
  }

  return {
    outputFile: opts.outputFile,
    totalSizeBytes: size,
    sha256: sha,
    sidecarFile,
  };
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

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function parseSplitSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([KMG]?B?)$/i.exec(s.trim());
  if (!m) throw new Error(`Invalid --split size: ${s}`);
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = unit.startsWith("TB") ? 1024 ** 4
    : unit.startsWith("GB") ? 1024 ** 3
    : unit.startsWith("MB") ? 1024 ** 2
    : unit.startsWith("KB") ? 1024
    : 1;
  return Math.floor(num * mult);
}

async function splitFile(srcPath: string, partPrefix: string, chunkSizeBytes: number): Promise<string[]> {
  const parts: string[] = [];
  let partIdx = 0;
  let partPath = `${partPrefix}${partIdx}`;
  let bytesWritten = 0;
  let writeStream: WriteStream | null = null;
  for await (const chunk of createReadStream(srcPath)) {
    if (!writeStream) {
      writeStream = createWriteStream(partPath);
      parts.push(partPath);
    }
    writeStream.write(chunk as Buffer);
    bytesWritten += (chunk as Buffer).length;
    if (bytesWritten >= chunkSizeBytes) {
      writeStream.end();
      writeStream = null;
      partIdx++;
      partPath = `${partPrefix}${partIdx}`;
      bytesWritten = 0;
    }
  }
  if (writeStream) writeStream.end();
  return parts;
}
