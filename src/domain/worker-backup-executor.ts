// 备份执行 SSH 编排（Spec §6.3 单 SSH 会话）
//
// 流程：
//   1. 检测 da-pg-<id> 容器是否存在（B-mode）；不存在 → noop 返回
//   2. ssh.exec pg_dump → host /tmp/<backupId>.dump
//   3. ssh.exec docker run alpine tar czf → host /tmp/<backupId>-data.tar.gz
//   4. ssh.exec psql SHOW server_version → 捕获 pgVersion
//   5. ssh.pullFile × 2 → Hub 本地 backupDir
//   6. ssh.exec rm /tmp/<backupId>* → host 清理
//   7. buildManifest + writeManifest → Hub 本地 manifest.json
//
// 安全：PG 密码用 `docker exec -e PGPASSWORD=... ` 包装，绝不出现在命令行参数。
// 错误处理：任一关键步骤失败返回 {success:false, error}；已拉到 Hub 的文件保留。

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SshExecutor } from "./ssh-executor.js";
import type { Writable } from "node:stream";
import {
  pgContainerName, pgContainerExists as realPgContainerExists,
} from "./worker-pg-container.js";
import { loadPgCredentials as realLoadPgCredentials } from "./worker-pg-credentials.js";
import {
  buildManifest as realBuildManifest, writeManifest as realWriteManifest,
  type BackupManifest,
} from "./worker-backup-manifest.js";

export interface BackupExecutorResult {
  success: boolean;
  pgDumpPath: string | null;       // 相对 hubBackupDir
  dataArchivePath: string | null;
  manifestPath: string | null;
  sizeBytes: number | null;
  pgVersion: string | null;
  error?: string;
}

export interface BackupExecutorOpts {
  workerId: string;
  backupId: string;
  workerImageTag: string | null;
  hubBackupDir: string;            // absolute path on Hub side
  retentionDays: number;
}

export interface BackupExecutorDeps {
  pgContainerExists?: (ssh: SshExecutor, workerId: string) => Promise<boolean>;
  loadPgCredentials?: (workerId: string) => Promise<{
    database: string; username: string; password: string;
  }>;
  buildManifest?: typeof realBuildManifest;
  writeManifest?: typeof realWriteManifest;
  createWriteStream?: (path: string) => NodeJS.WriteStream;
}

// 失败时统一返回的"全空"结果（所有路径为 null）
function failureResult(pgVersion: string | null, error: string): BackupExecutorResult {
  return {
    success: false,
    pgDumpPath: null,
    dataArchivePath: null,
    manifestPath: null,
    sizeBytes: null,
    pgVersion,
    error,
  };
}

export async function executeWorkerBackup(
  ssh: SshExecutor,
  opts: BackupExecutorOpts,
  deps: BackupExecutorDeps = {},
): Promise<BackupExecutorResult> {
  // ─── 0a. 输入校验（与 ensurePgContainer:38 防御一致，M-3）─────────────
  // workerId 直接拼到容器名 / 路径 / docker 命令中，必须严格白名单
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.workerId)) {
    throw new Error(`invalid workerId: ${opts.workerId}`);
  }

  const pgExists = deps.pgContainerExists ?? realPgContainerExists;
  const loadCreds = deps.loadPgCredentials ?? realLoadPgCredentials;
  const build = deps.buildManifest ?? realBuildManifest;
  const write = deps.writeManifest ?? realWriteManifest;
  const makeStream = deps.createWriteStream
    ?? ((p: string) => createWriteStream(p) as unknown as NodeJS.WriteStream);

  // ─── 0. B-mode 检测 ───────────────────────────────────────────────────
  // A-mode worker 没有 da-pg-<id> 容器，备份为 noop（数据在 host PG，由客户运维管）
  const isBMode = await pgExists(ssh, opts.workerId);
  if (!isBMode) {
    return {
      success: true,
      pgDumpPath: null,
      dataArchivePath: null,
      manifestPath: null,
      sizeBytes: null,
      pgVersion: null,
    };
  }

  const creds = await loadCreds(opts.workerId);

  // ─── 0b. password 校验（与 ensurePgContainer:48 防御一致，M-2）─────────
  // 即使用 -e PGPASSWORD= 包装，单引号仍可能在某些 shell 解析路径下泄漏
  // （Hub 生成的 base64 密码不含 '，此 check 是 defense-in-depth）
  if (creds.password.includes("'")) {
    throw new Error("password contains single quote — refused for shell safety");
  }

  const pgContainer = pgContainerName(opts.workerId);
  const remoteDump = `/tmp/${opts.backupId}.dump`;
  const remoteTar = `/tmp/${opts.backupId}-data.tar.gz`;
  const volName = `da-app-data-${opts.workerId}`;

  // ─── 1. pg_dump（在 PG 容器内，输出重定向到 host /tmp）──────────────────
  // 安全：用 docker exec -e PGPASSWORD=... 包装，密码绝不进 pg_dump argv
  const dumpCmd = `docker exec -e PGPASSWORD=${creds.password} ${pgContainer} \
    pg_dump -U ${creds.username} -d ${creds.database} -Fc > ${remoteDump}`;
  const dumpR = await ssh.exec(dumpCmd);
  if (dumpR.exitCode !== 0) {
    return failureResult(
      null,
      `pg_dump failed (exit ${dumpR.exitCode}): ${dumpR.stderr.slice(0, 200)}`,
    );
  }

  // ─── 2. tar da-app-data volume（用临时 alpine 容器读 volume）──────────────
  const tarCmd = `docker run --rm -v ${volName}:/data:ro -v /tmp:/out alpine \
    tar czf ${remoteTar} -C /data .`;
  const tarR = await ssh.exec(tarCmd);
  if (tarR.exitCode !== 0) {
    // tar 失败 — 清理 host /tmp 里的 dump 文件后返回失败
    await ssh.exec(`rm -f ${remoteDump} ${remoteTar} 2>/dev/null || true`);
    return failureResult(
      null,
      `tar failed (exit ${tarR.exitCode}): ${tarR.stderr.slice(0, 200)}`,
    );
  }

  // ─── 3. pgVersion 提取（非致命，失败容错）──────────────────────────────
  let pgVersion: string | null = null;
  const verCmd = `docker exec -e PGPASSWORD=${creds.password} ${pgContainer} \
    psql -U ${creds.username} -d ${creds.database} -t -c "SHOW server_version;"`;
  const verR = await ssh.exec(verCmd);
  if (verR.exitCode === 0) {
    const trimmed = verR.stdout.trim().split("\n")[0]?.trim();
    pgVersion = trimmed || null;
  }

  // ─── 4. 拉文件到 Hub 本地 ─────────────────────────────────────────────
  const localSubDir = join(opts.hubBackupDir, opts.workerId, opts.backupId);
  await mkdir(localSubDir, { recursive: true });

  try {
    const dumpStream = makeStream(join(localSubDir, "pg.dump"));
    await ssh.pullFile(remoteDump, dumpStream as unknown as Writable);

    const tarStream = makeStream(join(localSubDir, "app-data.tar.gz"));
    await ssh.pullFile(remoteTar, tarStream as unknown as Writable);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // pullFile 失败 — 清理 host /tmp 文件；Hub 本地已拉的部分保留（forensic）
    await ssh.exec(`rm -f ${remoteDump} ${remoteTar} 2>/dev/null || true`);
    return failureResult(pgVersion, `pullFile failed: ${msg}`);
  }

  // ─── 5. host 清理 ───────────────────────────────────────────────────
  await ssh.exec(`rm -f ${remoteDump} ${remoteTar} 2>/dev/null || true`);

  // ─── 6. 本地 manifest 生成 ──────────────────────────────────────────
  const expiresAt = new Date(
    Date.now() + opts.retentionDays * 24 * 3600 * 1000,
  );

  let manifest: BackupManifest;
  try {
    manifest = await build({
      backupId: opts.backupId,
      workerId: opts.workerId,
      workerImageTag: opts.workerImageTag,
      pgVersion,
      backupDir: localSubDir,
      expiresAt,
    });
    await write(manifest, localSubDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failureResult(pgVersion, `manifest generation failed: ${msg}`);
  }

  // ─── 7. 算总 size + 组装相对路径 ──────────────────────────────────
  let sizeBytes = 0;
  for (const key of ["pg.dump", "app-data.tar.gz"] as const) {
    const f = manifest.files[key];
    if (f) sizeBytes += f.sizeBytes;
  }

  const relBase = `${opts.workerId}/${opts.backupId}`;
  return {
    success: true,
    pgDumpPath: `${relBase}/pg.dump`,
    dataArchivePath: `${relBase}/app-data.tar.gz`,
    manifestPath: `${relBase}/manifest.json`,
    sizeBytes,
    pgVersion,
  };
}
