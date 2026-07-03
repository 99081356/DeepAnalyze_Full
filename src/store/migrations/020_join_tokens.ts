/**
 * Migration 020: join_tokens 表
 *
 * Hub Admin 通过此表生成一次性 token，用于 Worker 加入了 Hub。
 * 一次性消费（consumed_at 标记），默认 24h 过期。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS join_tokens (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      assigned_user_id TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      consumed_worker_id TEXT,
      max_uses INT DEFAULT 1,
      use_count INT DEFAULT 0,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_join_tokens_org ON join_tokens(organization_id);
    CREATE INDEX IF NOT EXISTS idx_join_tokens_token ON join_tokens(token);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS join_tokens;`);
}
