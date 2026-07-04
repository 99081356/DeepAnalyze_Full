/**
 * Migration 035: worker_backups 审计表
 *
 * T19: Worker 升级/回滚备份记录表。
 * 每次升级前插入一条 backup 记录（pre_upgrade 类型），记录 from_tag → to_tag
 * 以及占位的 pg_dump_path / data_archive_path（实际文件创建留给后续 SSH 编排任务）。
 *
 * 设计原则：
 * - metadata-only：T19 不执行实际 pg_dump/tar，路径字段为 nullable
 * - status 状态机：created → verified（部署成功）/ failed（部署失败）/ restored（用于回滚）/ expired
 * - 30 天过期由应用层写入 expires_at
 * - ON DELETE CASCADE：worker 被删除时自动清理 backup 记录
 *
 * 向后兼容：CREATE TABLE IF NOT EXISTS；不修改任何现有表结构。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS worker_backups (
      id                TEXT PRIMARY KEY,
      worker_id         TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      backup_type       TEXT NOT NULL CHECK (backup_type IN ('pre_upgrade','manual','scheduled')),
      from_tag          TEXT,
      to_tag            TEXT,
      pg_dump_path      TEXT,
      data_archive_path TEXT,
      size_bytes        BIGINT,
      status            TEXT NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','verified','restored','failed','expired')),
      deploy_job_id     TEXT REFERENCES deploy_jobs(id) ON DELETE SET NULL,
      created_by        TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at        TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backups_worker ON worker_backups(worker_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backups_status ON worker_backups(status);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP INDEX IF EXISTS idx_backups_status;`);
  await query(`DROP INDEX IF EXISTS idx_backups_worker;`);
  await query(`DROP TABLE IF EXISTS worker_backups;`);
}
