/**
 * Migration 008: seed admin 用户
 *
 * 初始密码来源（按优先级）：
 *   1. ADMIN_INIT_PASSWORD 环境变量（生产部署必须设置强密码）
 *   2. 未设置时回退到默认 dev 密码（仅本地开发用）
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

  const initPassword = process.env.ADMIN_INIT_PASSWORD;
  if (!initPassword) {
    console.warn(
      '[migration 008] ADMIN_INIT_PASSWORD 未设置，使用默认 dev 密码。' +
      ' 生产环境务必通过环境变量注入强密码。',
    );
  }
  const passwordHash = await bcrypt.hash(initPassword || 'admin123', 10);
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
