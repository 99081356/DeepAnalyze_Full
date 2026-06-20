/**
 * Migration 005: RBAC 表 + 预置角色和权限
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      description TEXT,
      is_system BOOL NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(name, org_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_id TEXT NULL REFERENCES permissions(id),
      description TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, role_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'read',
      last_used_at TIMESTAMPTZ NULL,
      expires_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_apikey_user ON user_api_keys(user_id)`);

  // 预置权限码（幂等插入）
  const perms: Array<[string, string, string, string]> = [
    ['org:create', 'org', 'create', 'system'],
    ['org:read', 'org', 'read', 'system'],
    ['org:update', 'org', 'update', 'system'],
    ['org:delete', 'org', 'delete', 'system'],
    ['user:create', 'user', 'create', 'system'],
    ['user:read', 'user', 'read', 'system'],
    ['user:update', 'user', 'update', 'system'],
    ['user:delete', 'user', 'delete', 'system'],
    ['role:read', 'role', 'read', 'system'],
    ['role:assign', 'role', 'assign', 'system'],
    ['worker:apply', 'worker', 'apply', 'system'],
    ['worker:read', 'worker', 'read', 'system'],
    ['worker:approve', 'worker', 'approve', 'system'],
    ['worker:reject', 'worker', 'reject', 'system'],
    ['skill:read', 'skill', 'read', 'system'],
    ['skill:create', 'skill', 'create', 'system'],
    ['config:read', 'config', 'read', 'system'],
    ['config:create', 'config', 'create', 'system'],
  ];
  for (const [code, resource, action, type] of perms) {
    const id = `perm_${code.replace(/[:]/g, '_')}`;
    await query(
      `INSERT INTO permissions (id, code, resource, action, type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id, code, resource, action, type],
    );
  }

  // 预置系统角色（幂等）
  await query(`
    INSERT INTO roles (id, name, org_id, description, is_system) VALUES
      ('role_super_admin', '超级管理员', NULL, '系统全权限', TRUE),
      ('role_org_admin', '组织管理员', NULL, '本组织管理权限', TRUE),
      ('role_user', '普通用户', NULL, '基本使用权限', TRUE)
    ON CONFLICT (id) DO NOTHING
  `);

  // super_admin 拥有所有权限
  const allPerms = await query<{ id: string }>(`SELECT id FROM permissions`);
  for (const row of allPerms.rows) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_super_admin', $1) ON CONFLICT DO NOTHING`,
      [row.id],
    );
  }

  // org_admin 权限
  const orgAdminPerms = [
    'perm_org_read', 'perm_user_create', 'perm_user_read', 'perm_user_update',
    'perm_role_read', 'perm_role_assign', 'perm_worker_read', 'perm_worker_approve',
    'perm_worker_reject', 'perm_skill_read', 'perm_config_read',
  ];
  for (const pid of orgAdminPerms) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_org_admin', $1) ON CONFLICT DO NOTHING`,
      [pid],
    );
  }

  // user 角色
  const userPerms = ['perm_worker_read', 'perm_skill_read', 'perm_config_read'];
  for (const pid of userPerms) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_user', $1) ON CONFLICT DO NOTHING`,
      [pid],
    );
  }
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS user_api_keys CASCADE`);
  await query(`DROP TABLE IF EXISTS role_permissions CASCADE`);
  await query(`DROP TABLE IF EXISTS user_roles CASCADE`);
  await query(`DROP TABLE IF EXISTS permissions CASCADE`);
  await query(`DROP TABLE IF EXISTS roles CASCADE`);
}
