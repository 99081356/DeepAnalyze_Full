/**
 * Migration 007: workers 表升级（申请-审批流程 + 连接事件）
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS name TEXT`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS display_name TEXT`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS approved_by TEXT NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS user_id TEXT NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS organization_id TEXT NULL REFERENCES organizations(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS protocol_version INT NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // 扩展 status CHECK 约束
  await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check`);
  await query(`
    ALTER TABLE workers ADD CONSTRAINT workers_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'online', 'offline', 'draining'))
  `);

  // 用 hostname/name 填充 name 字段
  await query(`UPDATE workers SET name = hostname WHERE name IS NULL AND hostname IS NOT NULL`);
  await query(`UPDATE workers SET name = id WHERE name IS NULL`);

  // 已注册的 worker 自动升级为 approved
  await query(`UPDATE workers SET status = 'approved', approved_at = NOW() WHERE status IN ('online', 'offline')`);

  await query(`CREATE INDEX IF NOT EXISTS idx_worker_user ON workers(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_worker_org ON workers(organization_id)`);

  // worker 连接事件表
  await query(`
    CREATE TABLE IF NOT EXISTS worker_connection_events (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_wce_worker ON worker_connection_events(worker_id, created_at DESC)`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS worker_connection_events CASCADE`);
  await query(`DROP INDEX IF EXISTS idx_worker_org`);
  await query(`DROP INDEX IF EXISTS idx_worker_user`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS applied_at`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS protocol_version`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS organization_id`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS user_id`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS approved_by`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS approved_at`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS display_name`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS name`);
}
