/**
 * Migration 008: seed admin 用户（admin/admin123）
 */

import type { QueryResultRow } from "pg";
import bcrypt from "bcrypt";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  const existing = await query(`SELECT id FROM users WHERE username = 'admin'`);
  if (existing.rows.length > 0) {
    // 确保 admin 已标记为 super_admin + 有角色
    await query(`UPDATE users SET is_super_admin = TRUE WHERE username = 'admin'`);
    await query(`
      INSERT INTO user_roles (user_id, role_id)
      SELECT 'admin', 'role_super_admin'
      WHERE EXISTS (SELECT 1 FROM users WHERE username = 'admin')
      ON CONFLICT DO NOTHING
    `);
    return;
  }

  const passwordHash = await bcrypt.hash('admin123', 10);
  await query(
    `INSERT INTO users (id, username, display_name, password_hash, auth_source, is_super_admin, role)
     VALUES ('admin', 'admin', 'Super Admin', $1, 'local', TRUE, 'admin')`,
    [passwordHash],
  );

  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ('admin', 'role_super_admin') ON CONFLICT DO NOTHING`,
  );
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DELETE FROM user_roles WHERE user_id = 'admin'`);
  await query(`DELETE FROM users WHERE username = 'admin'`);
}
