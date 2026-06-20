/**
 * Migration 006: users 表升级（多租户字段）
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'local'`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOL NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_org_admin BOOL NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id TEXT NULL REFERENCES organizations(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_subject TEXT NULL`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ldap_dn TEXT NULL`);

  // 将现有 system 用户标记为 super_admin
  await query(`UPDATE users SET is_super_admin = TRUE WHERE id = 'system'`);

  // 给 system 用户赋予 super_admin 角色
  await query(`
    INSERT INTO user_roles (user_id, role_id) VALUES ('system', 'role_super_admin')
    ON CONFLICT DO NOTHING
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_user_org ON users(organization_id)`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP INDEX IF EXISTS idx_user_org`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS ldap_dn`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS oidc_subject`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS organization_id`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS is_org_admin`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS is_super_admin`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS auth_source`);
}
