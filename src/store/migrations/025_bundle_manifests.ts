/**
 * Migration 025: bundle_manifests 表
 *
 * da-packer 构建的离线包元数据。每条记录对应一个 tar.gz。
 *
 * Note: Brief referenced "migration 022" but 022 is already used
 * (022_skill_packages_lifecycle.ts); next free number is 025.
 * Also fixes TIMESTARLTZ -> TIMESTAMPTZ typo from the brief.
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS bundle_manifests (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      da_image_tag TEXT NOT NULL,
      hub_image_tag TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'linux/amd64',
      models JSONB NOT NULL,
      skills JSONB NOT NULL,
      file_path TEXT,
      file_size BIGINT,
      checksum_sha256 TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(version, platform)
    );
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS bundle_manifests;`);
}
