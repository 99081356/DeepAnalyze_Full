/**
 * Migration 018: marketplace_skills 加溯源列
 *
 * 给 Phase 1 marketplace_skills 表加 source_package_id / source_version_id，
 * 用于记录"该 skill 是从 Phase 2 哪个 package 的哪个 version 推广而来"。
 * 旧数据保持 NULL（表示非推广来源）。
 *
 * 配套：marketplace.ts 的 /admin/promote 端点写入这两列。
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE marketplace_skills
      ADD COLUMN IF NOT EXISTS source_package_id TEXT,
      ADD COLUMN IF NOT EXISTS source_version_id TEXT;
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE marketplace_skills
      DROP COLUMN IF EXISTS source_version_id,
      DROP COLUMN IF EXISTS source_package_id;
  `);
}
