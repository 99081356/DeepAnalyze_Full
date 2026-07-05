// 过期备份清理 cron（Spec §7）
//
// 选择条件：expires_at < NOW() AND status IN ('verified', 'failed', 'deletion_failed')
// 对每行：
//   1. 从 manifest_path 或 pg_dump_path 推导 backup 目录（<worker>/<backup>/）
//   2. rm 整个目录（recursive force）
//   3. 成功 → UPDATE status='expired'
//   4. 失败 → status='deletion_failed'，下次 cron 重试（WHERE 包含 deletion_failed）
//
// path=null 的 metadata-only 记录（旧 T19 数据）：跳过 rm，仍标记 expired。

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { query as realQuery } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";

export interface CleanupResult {
  processed: number;
  deleted: number;
  failed: number;
  errors: Array<{ backupId: string; error: string }>;
}

interface ExpiredRow {
  id: string;
  worker_id: string;
  pg_dump_path: string | null;
  data_archive_path: string | null;
  manifest_path: string | null;
}

export interface CleanupDeps {
  query?: typeof realQuery;
  rm?: typeof rm;
}

/**
 * 推导 backup 目录的相对路径（<worker>/<backup>）。
 *
 * 优先用 manifest_path（包含 3 个 / 分段），其次 pg_dump_path。
 * 都为 null 时返回 null（metadata-only 记录）。
 */
function deriveBackupSubDir(row: ExpiredRow): string | null {
  // manifest_path 形如 "<worker>/<backup>/manifest.json"
  const candidates = [row.manifest_path, row.pg_dump_path, row.data_archive_path];
  for (const p of candidates) {
    if (!p) continue;
    const parts = p.split("/");
    if (parts.length >= 3) {
      // <worker>/<backup>/<file>
      return `${parts[0]}/${parts[1]}`;
    }
  }
  // 兜底：用 row.worker_id + row.id 拼
  return `${row.worker_id}/${row.id}`;
}

export async function cleanupExpiredBackups(
  opts: { storageDir?: string } = {},
  deps: CleanupDeps = {},
): Promise<CleanupResult> {
  const q = deps.query ?? realQuery;
  const rmFn = deps.rm ?? rm;
  const storageDir = opts.storageDir ?? HUB_CONFIG.backup.storageDir;

  const { rows } = await q<ExpiredRow>(
    `SELECT id, worker_id, pg_dump_path, data_archive_path, manifest_path
     FROM worker_backups
     WHERE expires_at < NOW()
       AND status IN ('verified', 'failed', 'deletion_failed')`,
  );

  const result: CleanupResult = {
    processed: rows.length, deleted: 0, failed: 0, errors: [],
  };

  for (const row of rows) {
    // path=null 跳过 rm 但仍标记 expired
    const hasFiles = row.pg_dump_path || row.data_archive_path || row.manifest_path;
    if (hasFiles) {
      const subDir = deriveBackupSubDir(row) ?? `${row.worker_id}/${row.id}`;
      const absPath = join(storageDir, subDir);
      try {
        await rmFn(absPath, { recursive: true, force: true });
        result.deleted++;
        await q(
          `UPDATE worker_backups SET status = $1 WHERE id = $2`,
          ["expired", row.id],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failed++;
        result.errors.push({ backupId: row.id, error: msg });
        await q(
          `UPDATE worker_backups SET status = $1 WHERE id = $2`,
          ["deletion_failed", row.id],
        );
      }
    } else {
      // metadata-only — 直接标记 expired
      result.deleted++;
      await q(
        `UPDATE worker_backups SET status = $1 WHERE id = $2`,
        ["expired", row.id],
      );
    }
  }

  return result;
}
