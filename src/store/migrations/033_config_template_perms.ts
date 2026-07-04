/**
 * Migration 033: config_template 权限 + 角色授权
 *
 * Adds two new permissions (config_template:read, config_template:manage)
 * and grants them to role_super_admin + role_org_admin.
 *
 * Follows migration 028 (host_server_perm) pattern.
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // Add config_template:read + config_template:manage permissions
  await query(`
    INSERT INTO permissions (id, code, resource, action, type, description) VALUES
      ('perm_config_template_read',   'config_template:read',  'config_template', 'read',  'system', 'Read config templates'),
      ('perm_config_template_manage', 'config_template:manage', 'config_template', 'manage', 'system', 'Manage config templates')
    ON CONFLICT (id) DO NOTHING
  `);
  // Grant both to super_admin + org_admin
  await query(`
    INSERT INTO role_permissions (role_id, permission_id) VALUES
      ('role_super_admin', 'perm_config_template_read'),
      ('role_super_admin', 'perm_config_template_manage'),
      ('role_org_admin',   'perm_config_template_read'),
      ('role_org_admin',   'perm_config_template_manage')
    ON CONFLICT DO NOTHING
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(
    `DELETE FROM role_permissions WHERE permission_id IN ('perm_config_template_read', 'perm_config_template_manage')`,
  );
  await query(
    `DELETE FROM permissions WHERE id IN ('perm_config_template_read', 'perm_config_template_manage')`,
  );
}
