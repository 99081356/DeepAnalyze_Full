/**
 * Migration 016: 元数据约束（seed 后强制）
 *
 * 在 015 加列 + seed 数据就位后，强制 NOT NULL + CHECK 约束。
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // skill_packages: description NOT NULL
  await query(`ALTER TABLE skill_packages ALTER COLUMN description SET NOT NULL`);

  // skill_packages: icon NOT NULL
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon SET NOT NULL`);

  // skill_packages: category CHECK 枚举
  await query(`ALTER TABLE skill_packages DROP CONSTRAINT IF EXISTS chk_category_values`);
  await query(`
    ALTER TABLE skill_packages
    ADD CONSTRAINT chk_category_values CHECK (category IN (
      'engineering', 'writing', 'operations', 'business',
      'security', 'productivity', 'general', 'custom'
    ))
  `);

  // skill_versions: change_summary NOT NULL
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary SET NOT NULL`);

  // skill_sharings: usage_intent NOT NULL
  await query(`UPDATE skill_sharings SET usage_intent = '' WHERE usage_intent IS NULL`);
  await query(`ALTER TABLE skill_sharings ALTER COLUMN usage_intent SET NOT NULL`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE skill_sharings ALTER COLUMN usage_intent DROP NOT NULL`);
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary DROP NOT NULL`);
  await query(`ALTER TABLE skill_packages DROP CONSTRAINT IF EXISTS chk_category_values`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon DROP NOT NULL`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN description DROP NOT NULL`);
}
