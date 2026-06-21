// deepanalyze-hub/src/store/migrations/015_metadata_enrichment.ts
/**
 * Migration 015: 元数据补全
 *
 * skill_packages: 已有 category/tags/icon/display_name/trust_level
 *   → 新增 use_cases JSONB
 *   → 给 icon 设默认值 '📦'
 *
 * skill_versions: 已有 change_summary (可空)
 *   → 设默认值 ''
 *
 * skill_sharings: 缺 usage_intent / business_justification
 *   → 新增两列
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // skill_packages: 加 use_cases + icon 默认值
  await query(`ALTER TABLE skill_packages ADD COLUMN IF NOT EXISTS use_cases JSONB NOT NULL DEFAULT '[]'`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon SET DEFAULT '📦'`);
  await query(`UPDATE skill_packages SET icon = '📦' WHERE icon IS NULL`);

  // skill_versions: change_summary 设默认值
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary SET DEFAULT ''`);

  // skill_sharings: 加 usage_intent + business_justification
  await query(`ALTER TABLE skill_sharings ADD COLUMN IF NOT EXISTS usage_intent TEXT`);
  await query(`ALTER TABLE skill_sharings ADD COLUMN IF NOT EXISTS business_justification TEXT`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE skill_sharings DROP COLUMN IF EXISTS business_justification`);
  await query(`ALTER TABLE skill_sharings DROP COLUMN IF EXISTS usage_intent`);
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary DROP DEFAULT`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon DROP DEFAULT`);
  await query(`ALTER TABLE skill_packages DROP COLUMN IF EXISTS use_cases`);
}
