/**
 * Migration 030: bundle_manifests 表扩展
 *
 * T05: 为 bundle_manifests 添加上传者信息与构建备注，支持流式下载端点。
 *
 * 向后兼容：所有新列要么 NULLABLE，要么有 DEFAULT。
 * - image_name NOT NULL DEFAULT 'da-personal-full'（回填现有数据）
 * - uploaded_by NULLABLE（现有数据无此信息）
 * - uploaded_at NOT NULL DEFAULT now()
 * - build_note NULLABLE
 *
 * 索引：idx_bundle_name_tag(image_name, da_image_tag) — 支持按 image + tag 查找。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // image_name：区分 da-personal-core / da-personal-full（默认 full，兼容现有数据）
  await query(`
    ALTER TABLE bundle_manifests
    ADD COLUMN IF NOT EXISTS image_name TEXT NOT NULL DEFAULT 'da-personal-full'
  `);
  // uploaded_by：上传者（可空，因为现有数据无此信息）
  await query(`
    ALTER TABLE bundle_manifests
    ADD COLUMN IF NOT EXISTS uploaded_by TEXT REFERENCES users(id)
  `);
  // uploaded_at：上传时间（默认 now()，回填现有数据用 created_at 时刻）
  await query(`
    ALTER TABLE bundle_manifests
    ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `);
  // build_note：构建备注（可空）
  await query(`
    ALTER TABLE bundle_manifests
    ADD COLUMN IF NOT EXISTS build_note TEXT
  `);
  // 复合索引：按 image_name + da_image_tag 查找
  await query(`
    CREATE INDEX IF NOT EXISTS idx_bundle_name_tag
    ON bundle_manifests(image_name, da_image_tag)
  `);
}

export async function down(_query: QueryFn): Promise<void> {
  // 不写 down（向后兼容的扩展，无须回滚）
}
