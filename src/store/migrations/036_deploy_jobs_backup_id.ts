/**
 * Migration 036: deploy_jobs 加 backup_id FK
 *
 * T19: 在 deploy_jobs 表上加 backup_id 列，指向 worker_backups.id。
 * 这样每个 deploy_job 可以追溯其关联的 pre_upgrade backup 记录。
 *
 * 注意：deploy_jobs.action CHECK 已在 migration 026 包含 'upgrade'/'rollback'，
 * 无需修改枚举。
 *
 * 向后兼容：ADD COLUMN IF NOT EXISTS；ON DELETE SET NULL（删 backup 不删 job）。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE deploy_jobs
      ADD COLUMN IF NOT EXISTS backup_id TEXT REFERENCES worker_backups(id) ON DELETE SET NULL;
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE deploy_jobs DROP COLUMN IF EXISTS backup_id;`);
}
