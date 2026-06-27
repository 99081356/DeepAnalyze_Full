/**
 * Migration 017: 确保 system 用户存在（idempotent）
 *
 * Background:
 *   marketplace_skills 表有外键 submitter_id REFERENCES users(id)，
 *   marketplace.ts 的 submit/approve/reject 路径硬编码 submitter_id='system'。
 *   Migration 001 本应 seed system 用户（INSERT ... ON CONFLICT DO NOTHING），
 *   但对于从更早版本升级、或 migration 001 部分失败的现有库，system 用户可能缺失，
 *   导致 worker 提交 skill 时报外键约束错误：
 *     "insert ... violates foreign key constraint marketplace_skills_submitter_id_fkey
 *      Key (submitter_id)=(system) is not present in table users"
 *
 * Fix:
 *   幂等地确保 system 用户存在。已存在则升级为 super_admin。
 *   与 migration 008 (admin seed) 模式一致。
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // 已存在则升级
  const existing = await query(`SELECT id FROM users WHERE id = 'system'`);
  if (existing.rows.length > 0) {
    await query(`UPDATE users SET is_super_admin = TRUE, role = 'admin' WHERE id = 'system'`);
    return;
  }

  // 不存在则创建
  await query(
    `INSERT INTO users (id, username, display_name, role, status, auth_source, is_super_admin)
     VALUES ('system', 'system', 'System', 'admin', 'active', 'system', TRUE)
     ON CONFLICT (id) DO NOTHING`,
  );
}

export async function down(query: QueryFn): Promise<void> {
  // 不删除 system 用户（会导致 marketplace_skills 外键悬空）
  // 仅回滚 is_super_admin 标记
  await query(`UPDATE users SET is_super_admin = FALSE WHERE id = 'system'`);
}
