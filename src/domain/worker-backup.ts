// deepanalyze-hub/src/domain/worker-backup.ts
//
// T19: Worker 备份记录 domain 层
//
// metadata-only 设计：T19 只记录 backup 元数据（from_tag/to_tag/path 占位符），
// 实际 pg_dump + tar 执行需要 SSH 编排，留给后续任务。
//
// 所有函数接受 `pool: () => Pool` 参数（T18 风格），便于测试注入。
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

export interface WorkerBackup {
  id: string;
  worker_id: string;
  backup_type: "pre_upgrade" | "manual" | "scheduled";
  from_tag: string | null;
  to_tag: string | null;
  pg_dump_path: string | null;
  data_archive_path: string | null;
  manifest_path: string | null;
  pg_version: string | null;
  size_bytes: number | null;
  status: "created" | "verified" | "restored" | "failed" | "expired" | "deletion_failed";
  deploy_job_id: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
}

export interface CreateBackupInput {
  workerId: string;
  backupType: WorkerBackup["backup_type"];
  fromTag?: string | null;
  toTag?: string | null;
  pgDumpPath?: string | null;
  dataArchivePath?: string | null;
  sizeBytes?: number | null;
  deployJobId?: string | null;
  createdBy: string;
  /**
   * Backup retention in days. Defaults to 30 if omitted (backward compat).
   * Production code should pass HUB_CONFIG.backup.retentionDays so the DB
   * expires_at column matches the manifest's retention field written by the
   * backup executor. Spec §7.3 / §13 acceptance checklist.
   */
  retentionDays?: number;
}

/**
 * Coerce raw pg row to WorkerBackup.
 *
 * pg returns BIGINT as string by default; we coerce size_bytes to number
 * since file sizes in our metadata-only system fit well within JS safe integer range.
 */
function mapRow(row: unknown): WorkerBackup {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    worker_id: r.worker_id as string,
    backup_type: r.backup_type as WorkerBackup["backup_type"],
    from_tag: (r.from_tag as string | null) ?? null,
    to_tag: (r.to_tag as string | null) ?? null,
    pg_dump_path: (r.pg_dump_path as string | null) ?? null,
    data_archive_path: (r.data_archive_path as string | null) ?? null,
    manifest_path: (r.manifest_path as string | null) ?? null,
    pg_version: (r.pg_version as string | null) ?? null,
    size_bytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    status: r.status as WorkerBackup["status"],
    deploy_job_id: (r.deploy_job_id as string | null) ?? null,
    created_by: r.created_by as string,
    created_at: r.created_at as string,
    expires_at: r.expires_at as string,
  };
}

/**
 * Create a backup record. Status defaults to 'created'. Expires after 30 days.
 *
 * ID 规范：`bkp_<uuid-no-hyphens>`（匹配现有 `dpl_` 约定）。
 */
export async function createBackupRecord(
  pool: () => Pool,
  input: CreateBackupInput,
): Promise<WorkerBackup> {
  const id = `bkp_${randomUUID().replace(/-/g, "")}`;
  const days = input.retentionDays ?? 30;
  const expires = new Date(Date.now() + days * 24 * 3600 * 1000);
  const { rows } = await pool().query(
    `INSERT INTO worker_backups
       (id, worker_id, backup_type, from_tag, to_tag, pg_dump_path,
        data_archive_path, size_bytes, deploy_job_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      id, input.workerId, input.backupType,
      input.fromTag ?? null, input.toTag ?? null,
      input.pgDumpPath ?? null, input.dataArchivePath ?? null,
      input.sizeBytes ?? null, input.deployJobId ?? null,
      input.createdBy, expires,
    ],
  );
  return mapRow(rows[0]);
}

/**
 * Update backup status (e.g., 'verified' after deploy success, 'failed' after error).
 *
 * Optional sizeBytes will COALESCE into the existing value (only set if provided non-null).
 */
export async function updateBackupStatus(
  pool: () => Pool,
  backupId: string,
  status: WorkerBackup["status"],
  sizeBytes?: number | null,
): Promise<WorkerBackup | null> {
  const { rows } = await pool().query(
    `UPDATE worker_backups
       SET status = $2, size_bytes = COALESCE($3, size_bytes)
     WHERE id = $1
     RETURNING *`,
    [backupId, status, sizeBytes ?? null],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * List backups for a worker, newest first.
 */
export async function listBackups(
  pool: () => Pool,
  workerId: string,
): Promise<WorkerBackup[]> {
  const { rows } = await pool().query(
    `SELECT * FROM worker_backups
     WHERE worker_id = $1
     ORDER BY created_at DESC`,
    [workerId],
  );
  return rows.map(mapRow);
}

/**
 * Get a single backup by ID. Returns null if not found.
 */
export async function getBackup(
  pool: () => Pool,
  backupId: string,
): Promise<WorkerBackup | null> {
  const { rows } = await pool().query(
    `SELECT * FROM worker_backups WHERE id = $1`,
    [backupId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Delete a backup record by ID.
 *
 * Note: actual file deletion (pg_dump_path / data_archive_path) is the caller's
 * responsibility — T19 is metadata-only. Caller should resolve paths via getBackup
 * first, perform SSH/file deletion if needed, then call deleteBackup.
 *
 * Returns true if a row was deleted, false if no row matched.
 */
export async function deleteBackup(pool: () => Pool, backupId: string): Promise<boolean> {
  const { rowCount } = await pool().query(
    `DELETE FROM worker_backups WHERE id = $1`,
    [backupId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Update backup record with real backup execution paths + size + pg_version.
 *
 * 由 upgradeWorker 在 backup executor 完成后调用 — 把 metadata-only 记录变成
 * 带真实路径的记录。
 */
export async function updateBackupPaths(
  pool: () => Pool,
  backupId: string,
  paths: {
    pgDumpPath: string | null;
    dataArchivePath: string | null;
    manifestPath: string | null;
    sizeBytes: number | null;
    pgVersion: string | null;
  },
): Promise<void> {
  await pool().query(
    `UPDATE worker_backups
       SET pg_dump_path = $2,
           data_archive_path = $3,
           manifest_path = $4,
           size_bytes = $5,
           pg_version = $6
     WHERE id = $1`,
    [
      backupId,
      paths.pgDumpPath, paths.dataArchivePath, paths.manifestPath,
      paths.sizeBytes, paths.pgVersion,
    ],
  );
}
