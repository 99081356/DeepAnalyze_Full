/**
 * Migration 011: 添加 skill 生命周期权限（kill/publish/approve/subscribe）
 *
 * Phase 2 引入 Kill Switch 和 SkillSync，需要扩展权限矩阵：
 *   - skill:kill: 紧急禁用 skill 包
 *   - skill:publish: 发布版本到 published 状态
 *   - skill:approve: 审批 skill 提交（Phase 3 完整工作流）
 *   - skill:subscribe: 订阅/取消订阅
 *   - skill:sync: 强制同步指令
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  const newPerms: Array<[string, string, string, string]> = [
    ["skill:kill", "skill", "kill", "system"],
    ["skill:publish", "skill", "publish", "system"],
    ["skill:approve", "skill", "approve", "system"],
    ["skill:subscribe", "skill", "subscribe", "system"],
    ["skill:sync", "skill", "sync", "system"],
  ];

  for (const [code, resource, action, type] of newPerms) {
    const id = `perm_${code.replace(/[:]/g, "_")}`;
    await query(
      `INSERT INTO permissions (id, code, resource, action, type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id, code, resource, action, type],
    );
  }

  // Grant skill:kill, skill:publish, skill:approve, skill:subscribe to super_admin
  const superAdminPerms = ["perm_skill_kill", "perm_skill_publish", "perm_skill_approve", "perm_skill_subscribe", "perm_skill_sync"];
  for (const permId of superAdminPerms) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_super_admin', $1) ON CONFLICT DO NOTHING`,
      [permId],
    );
  }

  // Grant skill:subscribe, skill:read, skill:create to org_admin
  const orgAdminPerms = ["perm_skill_subscribe", "perm_skill_kill"]; // org admin can kill within own org
  for (const permId of orgAdminPerms) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_org_admin', $1) ON CONFLICT DO NOTHING`,
      [permId],
    );
  }

  // Grant skill:subscribe and skill:read to regular user
  const userPerms = ["perm_skill_subscribe"];
  for (const permId of userPerms) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_user', $1) ON CONFLICT DO NOTHING`,
      [permId],
    );
  }
}

export async function down(query: QueryFn): Promise<void> {
  const permIds = ["perm_skill_kill", "perm_skill_publish", "perm_skill_approve", "perm_skill_subscribe", "perm_skill_sync"];
  for (const id of permIds) {
    await query(`DELETE FROM role_permissions WHERE permission_id = $1`, [id]);
  }
  await query(`DELETE FROM permissions WHERE id = ANY($1::text[])`, [permIds]);
}
