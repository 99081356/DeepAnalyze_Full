/**
 * Migration 032: config_templates + config_template_history 表
 *
 * Hub-managed configuration templates (design doc §5):
 * - config_templates: 当前生效的全局/组织模板（scope CHECK + UNIQUE(org_id, scope)）
 * - config_template_history: 所有历史版本（每次 upsert 写入一条）
 *
 * 合并模型：merged = deepMerge(global, org)
 * - 对象递归；数组替换；null 删除；fieldLocks.lockedPaths 取并集
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS config_templates (
      id           TEXT PRIMARY KEY,
      org_id       TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      scope        TEXT NOT NULL CHECK (scope IN ('global','org')),
      content      JSONB NOT NULL,
      version      INT NOT NULL DEFAULT 1,
      updated_by   TEXT REFERENCES users(id),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, scope)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_config_templates_org
    ON config_templates(org_id, scope)
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS config_template_history (
      id           BIGSERIAL PRIMARY KEY,
      template_id  TEXT NOT NULL,
      org_id       TEXT,
      scope        TEXT NOT NULL,
      content      JSONB NOT NULL,
      version      INT NOT NULL,
      updated_by   TEXT,
      updated_at   TIMESTAMPTZ NOT NULL
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_config_template_history_lookup
    ON config_template_history(scope, org_id, version DESC)
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS config_template_history`);
  await query(`DROP TABLE IF EXISTS config_templates`);
}
