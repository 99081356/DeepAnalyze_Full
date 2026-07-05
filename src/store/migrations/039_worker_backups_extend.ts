/**
 * Migration 039: worker_backups schema 扩展
 *
 * Spec 2.2 — 备份生命周期：
 *   - 加 manifest_path：manifest.json 相对路径（相对 HUB_BACKUP_DIR）
 *   - 加 pg_version：备份时 PG server_version，未来跨版本兼容检查用
 *   - status CHECK 加 'deletion_failed'：清理 cron 删文件失败时标记，下次重试
 *
 * 向后兼容：ADD COLUMN IF NOT EXISTS；ALTER CONSTRAINT 用 DROP + ADD 模式。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // 1. 加列（idempotent）
  await query(`
    ALTER TABLE worker_backups
      ADD COLUMN IF NOT EXISTS manifest_path TEXT,
      ADD COLUMN IF NOT EXISTS pg_version TEXT;
  `);

  // 2. 扩展 status CHECK 约束
  // PostgreSQL 不支持 ALTER CONSTRAINT 直接改 CHECK，必须 DROP + ADD。
  // 约束名按 migration 035 的命名约定：worker_backups_status_check（PG 自动生成）
  await query(`
    ALTER TABLE worker_backups
      DROP CONSTRAINT IF EXISTS worker_backups_status_check;
    ALTER TABLE worker_backups
      ADD CONSTRAINT worker_backups_status_check
        CHECK (status IN ('created','verified','restored','failed','expired','deletion_failed'));
  `);
}

export async function down(query: QueryFn): Promise<void> {
  // 加列和扩展 CHECK 都是向后兼容扩展，down 不写（按设计原则：跨版本回滚靠备份）
}
