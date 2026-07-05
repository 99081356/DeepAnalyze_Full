// 备份 manifest.json 生成 + IO
//
// Spec §6.5 manifest.json 字段：
//   backupId / workerId / workerImageTag / pgVersion / pgDumpFormat /
//   files.{pg.dump, app-data.tar.gz}.{sizeBytes, sha256} /
//   createdAt / expiresAt
//
// 设计：
// - buildManifest 是 pure function（除读文件 hash），输入文件路径输出对象
// - sha256 流式计算，避免大文件加载到内存
// - 文件可选：worker 未迁移到 B-mode 时只有 pg.dump

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BackupManifest {
  backupId: string;
  workerId: string;
  workerImageTag: string | null;
  pgVersion: string | null;
  pgDumpFormat: "custom";
  files: {
    "pg.dump"?: { sizeBytes: number; sha256: string };
    "app-data.tar.gz"?: { sizeBytes: number; sha256: string };
  };
  createdAt: string;
  expiresAt: string;
}

const FILE_KEYS = ["pg.dump", "app-data.tar.gz"] as const;
type FileKey = (typeof FILE_KEYS)[number];

async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function buildManifest(opts: {
  backupId: string;
  workerId: string;
  workerImageTag: string | null;
  pgVersion: string | null;
  backupDir: string;
  expiresAt: Date;
}): Promise<BackupManifest> {
  const files: BackupManifest["files"] = {};

  for (const key of FILE_KEYS) {
    const path = join(opts.backupDir, key);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(path);
    } catch {
      continue;  // 文件不存在，跳过
    }
    if (!s.isFile()) continue;
    const sha = await sha256OfFile(path);
    files[key] = { sizeBytes: s.size, sha256: sha };
  }

  if (Object.keys(files).length === 0) {
    throw new Error(
      `buildManifest: no backup files found in ${opts.backupDir} (empty backup)`,
    );
  }

  return {
    backupId: opts.backupId,
    workerId: opts.workerId,
    workerImageTag: opts.workerImageTag,
    pgVersion: opts.pgVersion,
    pgDumpFormat: "custom",
    files,
    createdAt: new Date().toISOString(),
    expiresAt: opts.expiresAt.toISOString(),
  };
}

export async function writeManifest(
  manifest: BackupManifest, dir: string,
): Promise<void> {
  const json = JSON.stringify(manifest, null, 2);
  await writeFile(join(dir, "manifest.json"), json, "utf8");
}

export async function readManifest(dir: string): Promise<BackupManifest> {
  let buf: Buffer;
  try {
    buf = await readFile(join(dir, "manifest.json"));
  } catch (err) {
    throw new Error(
      `readManifest: manifest.json not found in ${dir}: ${(err as Error).message}`,
    );
  }
  return JSON.parse(buf.toString("utf8")) as BackupManifest;
}
