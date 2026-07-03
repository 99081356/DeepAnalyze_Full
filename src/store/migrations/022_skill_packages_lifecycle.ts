/**
 * Migration 022: skill_packages 增加生命周期字段
 *
 * - status: published | deprecated | killed（默认 published，向后兼容）
 * - deprecated_at: 标记弃用时间
 * - kill_reason: kill switch 触发时记录原因
 *
 * Note: Brief originally said "migration 023" but the next free number after 021 is 022.
 * Note: Brief had TIMESTARLTZ typo — corrected to TIMESTAMPTZ.
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // 1. Add lifecycle columns
  await query(`
    ALTER TABLE skill_packages
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published',
      ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS kill_reason TEXT;
  `);

  // 2. Drop old status constraint if any, then add new one
  await query(`
    ALTER TABLE skill_packages
      DROP CONSTRAINT IF EXISTS skill_packages_status_check;
  `);
  await query(`
    ALTER TABLE skill_packages
      ADD CONSTRAINT skill_packages_status_check
        CHECK (status IN ('published','deprecated','killed'));
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE skill_packages
      DROP CONSTRAINT IF EXISTS skill_packages_status_check,
      DROP COLUMN IF EXISTS kill_reason,
      DROP COLUMN IF EXISTS deprecated_at,
      DROP COLUMN IF EXISTS status;
  `);
}
