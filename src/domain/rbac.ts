// =============================================================================
// DeepAnalyze Hub - RBAC Domain
// =============================================================================
// 权限检查器 + 角色管理。
// 权限码格式 `{resource}:{action}`，支持通配符 skill:* 和 *。
// =============================================================================

import { query } from "../store/pg.js";
import { getUserPermissions, getUserRoleIds } from "./user.js";

/**
 * 检查用户是否拥有指定权限码。
 * super_admin（role_super_admin）直接通过。
 */
export async function hasPermission(
  userId: string,
  requiredCode: string,
): Promise<boolean> {
  const roleIds = await getUserRoleIds(userId);
  if (roleIds.includes("role_super_admin")) return true;

  const codes = await getUserPermissions(userId);
  return matchPermission(codes, requiredCode);
}

/** 通配符匹配 */
export function matchPermission(
  ownedCodes: string[],
  required: string,
): boolean {
  if (ownedCodes.includes("*")) return true;
  if (ownedCodes.includes(required)) return true;

  const [reqResource] = required.split(":");
  for (const code of ownedCodes) {
    if (code === `${reqResource}:*`) return true;
  }
  return false;
}

/** 为用户分配角色 */
export async function assignRole(
  userId: string,
  roleId: string,
): Promise<void> {
  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, roleId],
  );
}

/** 移除用户角色 */
export async function removeRole(
  userId: string,
  roleId: string,
): Promise<void> {
  await query(
    `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
    [userId, roleId],
  );
}

/** 列出所有角色 */
export async function listRoles(orgId?: string): Promise<
  Array<{
    id: string;
    name: string;
    org_id: string | null;
    description: string | null;
    is_system: boolean;
  }>
> {
  if (orgId) {
    const rows = await query<{
    id: string;
    name: string;
    org_id: string | null;
    description: string | null;
    is_system: boolean;
  }>(
      `SELECT * FROM roles WHERE org_id IS NULL OR org_id = $1 ORDER BY is_system DESC, name`,
      [orgId],
    );
    return rows.rows;
  }
  const rows = await query<{
    id: string;
    name: string;
    org_id: string | null;
    description: string | null;
    is_system: boolean;
  }>(
    `SELECT * FROM roles ORDER BY is_system DESC, name`,
  );
  return rows.rows;
}

/** 列出所有权限 */
export async function listPermissions(): Promise<
  Array<{
    id: string;
    code: string;
    resource: string;
    action: string;
    type: string;
    description: string | null;
  }>
> {
  const rows = await query<{
    id: string;
    code: string;
    resource: string;
    action: string;
    type: string;
    description: string | null;
  }>(
    `SELECT * FROM permissions ORDER BY resource, action`,
  );
  return rows.rows;
}

/** 获取角色的权限码列表 */
export async function getRolePermissions(
  roleId: string,
): Promise<string[]> {
  const rows = await query<{ code: string }>(
    `SELECT p.code FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1`,
    [roleId],
  );
  return rows.rows.map((r) => r.code);
}

/** 为角色设置权限（全量替换） */
export async function setRolePermissions(
  roleId: string,
  permCodes: string[],
): Promise<void> {
  const roleRows = await query<{ is_system: boolean }>(
    `SELECT is_system FROM roles WHERE id = $1`,
    [roleId],
  );
  if (roleRows.rows.length === 0) throw new Error("Role not found");
  if (roleRows.rows[0].is_system) {
    throw new Error("System role permissions cannot be modified");
  }

  await query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);

  if (permCodes.length === 0) return;

  const permRows = await query<{ id: string }>(
    `SELECT id FROM permissions WHERE code = ANY($1::text[])`,
    [permCodes],
  );
  for (const row of permRows.rows) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [roleId, row.id],
    );
  }
}
