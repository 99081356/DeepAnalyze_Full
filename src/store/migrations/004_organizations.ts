/**
 * Migration 004: organizations 表（树形多租户）
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      description TEXT,
      parent_id TEXT NULL REFERENCES organizations(id),
      level INT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      manager_id TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      settings JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_org_parent ON organizations(parent_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_org_code ON organizations(code)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_org_path ON organizations(path)`);

  // 插入根组织（幂等）
  await query(`
    INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
    VALUES ('root', '系统根组织', 'ROOT', NULL, 0, 'root', 'company', '{}')
    ON CONFLICT (id) DO NOTHING
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS organizations CASCADE`);
}
