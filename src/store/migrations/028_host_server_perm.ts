// deepanalyze-hub/src/store/migrations/028_host_server_perm.ts
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // Add new permission using actual schema (id, code, resource, action, type)
  await query(
    `INSERT INTO permissions (id, code, resource, action, type, description)
     VALUES ('perm_host_server_manage', 'host_server:manage', 'host_server', 'manage', 'system', 'CRUD host_servers')
     ON CONFLICT (id) DO NOTHING`,
  );

  // Grant ONLY to super_admin — host_servers 是基础设施管理，仅系统管理员可操作
  await query(
    `INSERT INTO role_permissions (role_id, permission_id)
     VALUES ('role_super_admin', 'perm_host_server_manage')
     ON CONFLICT DO NOTHING`,
  );
}

export async function down(query: QueryFn): Promise<void> {
  await query(
    `DELETE FROM role_permissions WHERE permission_id = 'perm_host_server_manage'`,
  );
  await query(
    `DELETE FROM permissions WHERE id = 'perm_host_server_manage'`,
  );
}
