// deepanalyze-hub/tests/migrations/seed-worker-deploy-perm.test.ts
// 验证 migration 037 已应用：permissions 表有 worker:deploy 行 + 两个角色都有授权
import { describe, test, expect } from "bun:test";
import { query } from "../../src/store/pg";

describe("migration 037: worker:deploy permission seed", () => {
  test("permissions 表存在 worker:deploy 行", async () => {
    const { rows } = await query<{
      id: string; code: string; resource: string; action: string;
    }>(`SELECT id, code, resource, action FROM permissions WHERE code = 'worker:deploy'`);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("perm_worker_deploy");
    expect(rows[0].resource).toBe("worker");
    expect(rows[0].action).toBe("deploy");
  });

  test("role_super_admin 有 worker:deploy 权限", async () => {
    const { rows } = await query<{ role_id: string }>(
      `SELECT role_id FROM role_permissions
       WHERE permission_id = 'perm_worker_deploy' AND role_id = 'role_super_admin'`,
    );
    expect(rows.length).toBe(1);
  });

  test("role_org_admin 有 worker:deploy 权限", async () => {
    const { rows } = await query<{ role_id: string }>(
      `SELECT role_id FROM role_permissions
       WHERE permission_id = 'perm_worker_deploy' AND role_id = 'role_org_admin'`,
    );
    expect(rows.length).toBe(1);
  });

  test("role_user 没有 worker:deploy 权限（普通用户不应能部署）", async () => {
    const { rows } = await query<{ role_id: string }>(
      `SELECT role_id FROM role_permissions
       WHERE permission_id = 'perm_worker_deploy' AND role_id = 'role_user'`,
    );
    expect(rows.length).toBe(0);
  });
});
