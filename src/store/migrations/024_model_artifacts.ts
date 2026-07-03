/**
 * Migration 024: model_artifacts 表
 *
 * 企业内部模型仓库（章节 6.3 Source C2）。
 * DA Worker 通过 GET /api/v1/models/manifests/:name 拉清单，
 * GET /api/v1/models/blobs/:sha256 拉 blob。
 *
 * Note: Brief referenced "migration 021" but 019-023 are already used; next
 * free number is 024. Also fixes the TIMESTARLTZ -> TIMESTAMPTZ typo from
 * the plan (M before E, not R before L).
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS model_artifacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      category TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes BIGINT,
      storage_path TEXT NOT NULL,
      manifest JSONB NOT NULL,
      uploaded_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(name, version)
    );
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_model_artifacts_name ON model_artifacts(name);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_model_artifacts_sha ON model_artifacts(sha256);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS model_artifacts;`);
}
