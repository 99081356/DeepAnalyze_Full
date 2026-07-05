/**
 * Migration 037: worker:deploy 权限 seed
 *
 * 9 个 worker 部署/升级/回滚路由调用 requirePermission("worker:deploy")，
 * 但该权限从未被任何 migration seed 进 permissions 表，导致只有 super_admin
 * 的 * 通配绕过能通过。本 migration 补全权限行 + 授予 super_admin 和 org_admin。
 *
 * org_admin 在 migration 005 已经有 worker:read/approve/reject，部署是 worker
 * 生命周期的自然延伸；审计日志 (audit_logs) 记录每次部署的 initiated_by。
 *
 * Pattern: 跟随 migration 028 (host_server:manage) + 033 (config_template:*) 的格式。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // 1. 插入 worker:deploy 权限定义
  await query(
    `INSERT INTO permissions (id, code, resource, action, type, description)
     VALUES ('perm_worker_deploy', 'worker:deploy', 'worker', 'deploy', 'system',
             '部署、升级、回滚 worker 节点')
     ON CONFLICT (id) DO NOTHING`,
  );

  // 2. 授予 super_admin + org_admin
  await query(
    `INSERT INTO role_permissions (role_id, permission_id) VALUES
       ('role_super_admin', 'perm_worker_deploy'),
       ('role_org_admin',   'perm_worker_deploy')
     ON CONFLICT DO NOTHING`,
  );
}

export async function down(query: QueryFn): Promise<void> {
  await query(
    `DELETE FROM role_permissions WHERE permission_id = 'perm_worker_deploy'`,
  );
  await query(
    `DELETE FROM permissions WHERE id = 'perm_worker_deploy'`,
  );
}
