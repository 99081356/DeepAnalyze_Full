/**
 * Migration 026: deploy_jobs 表
 *
 * 记录 Hub 通过 SSH 部署/升级 Worker 的任务日志。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS deploy_jobs (
      id TEXT PRIMARY KEY,
      worker_id TEXT REFERENCES workers(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('deploy','upgrade','stop','restart','rollback')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','success','failed','cancelled')),
      image_tag TEXT,
      previous_image_tag TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      initiated_by TEXT NOT NULL,
      logs JSONB DEFAULT '[]'::jsonb,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_jobs_worker ON deploy_jobs(worker_id);
    CREATE INDEX IF NOT EXISTS idx_deploy_jobs_status ON deploy_jobs(status);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS deploy_jobs;`);
}
