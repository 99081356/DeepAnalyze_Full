// =============================================================================
// DeepAnalyze Hub - Organization Domain
// =============================================================================
// 树形多租户组织管理。path 字段格式 "root/uuid2/uuid3" 用于高效子树查询。
// =============================================================================

import { query } from "../store/pg.js";

export interface OrgRecord {
  id: string;
  name: string;
  code: string;
  description: string | null;
  parent_id: string | null;
  level: number;
  path: string;
  type: string;
  manager_id: string | null;
  status: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/** 计算 org 的 level 和 path */
function computePathLevel(
  parentPath: string | null,
  orgId: string,
): { level: number; path: string } {
  if (!parentPath) {
    return { level: 1, path: orgId };
  }
  const parentLevel = parentPath.split("/").length - 1; // root=0, root/a=1...
  return { level: parentLevel + 1, path: `${parentPath}/${orgId}` };
}

/** 创建组织 */
export async function createOrg(params: {
  name: string;
  code: string;
  description?: string;
  parent_id?: string;
  type: string;
  settings?: Record<string, unknown>;
}): Promise<OrgRecord> {
  const { name, code, description, parent_id, type, settings = {} } = params;

  let parentPath: string | null = null;
  if (parent_id) {
    const parentRows = await query<{ path: string }>(
      `SELECT path FROM organizations WHERE id = $1`,
      [parent_id],
    );
    if (parentRows.rows.length === 0) {
      throw new Error(`Parent organization ${parent_id} not found`);
    }
    parentPath = parentRows.rows[0].path;
  }

  const id = `org_${crypto.randomUUID().replace(/-/g, "")}`;
  const { level, path } = computePathLevel(parentPath, id);

  const result = await query<OrgRecord>(
    `INSERT INTO organizations (id, name, code, description, parent_id, level, path, type, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id,
      name,
      code,
      description ?? null,
      parent_id ?? null,
      level,
      path,
      type,
      JSON.stringify(settings),
    ],
  );
  return result.rows[0];
}

/** 按 ID 获取组织 */
export async function getOrgById(id: string): Promise<OrgRecord | null> {
  const rows = await query<OrgRecord>(
    `SELECT * FROM organizations WHERE id = $1`,
    [id],
  );
  return rows.rows[0] ?? null;
}

/** 获取子树（通过 path 前缀匹配） */
export async function getSubtree(rootId: string): Promise<OrgRecord[]> {
  const rows = await query<OrgRecord>(
    `WITH root AS (SELECT path FROM organizations WHERE id = $1)
     SELECT o.* FROM organizations o, root
     WHERE o.path = root.path OR o.path LIKE root.path || '/%'
     ORDER BY o.level, o.name`,
    [rootId],
  );
  return rows.rows;
}

export interface OrgTreeNode extends OrgRecord {
  children: OrgTreeNode[];
  user_count: number;
}

/** 构建树形结构（含 user_count） */
export async function buildOrgTree(
  rootId: string,
): Promise<OrgTreeNode | null> {
  const orgs = await getSubtree(rootId);
  if (orgs.length === 0) return null;

  // 批量查 user_count
  const orgIds = orgs.map((o) => o.id);
  const countRows = await query<{ organization_id: string; count: string }>(
    `SELECT organization_id, COUNT(*) as count FROM users
     WHERE organization_id = ANY($1::text[])
     GROUP BY organization_id`,
    [orgIds],
  );
  const countMap = new Map(
    countRows.rows.map((r) => [r.organization_id, parseInt(r.count, 10)]),
  );

  const nodeMap = new Map<string, OrgTreeNode>();
  for (const org of orgs) {
    nodeMap.set(org.id, {
      ...org,
      children: [],
      user_count: countMap.get(org.id) ?? 0,
    });
  }

  let root: OrgTreeNode | null = null;
  for (const org of orgs) {
    const node = nodeMap.get(org.id)!;
    if (org.id === rootId) {
      root = node;
    } else if (org.parent_id && nodeMap.has(org.parent_id)) {
      nodeMap.get(org.parent_id)!.children.push(node);
    }
  }
  return root;
}

/** 更新组织 */
export async function updateOrg(
  id: string,
  updates: Partial<
    Pick<OrgRecord, "name" | "description" | "status" | "settings" | "manager_id">
  >,
): Promise<OrgRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${idx++}`);
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.manager_id !== undefined) {
    sets.push(`manager_id = $${idx++}`);
    values.push(updates.manager_id);
  }
  if (updates.settings !== undefined) {
    sets.push(`settings = $${idx++}`);
    values.push(JSON.stringify(updates.settings));
  }

  if (sets.length === 0) return getOrgById(id);

  sets.push(`updated_at = NOW()`);
  values.push(id);
  const result = await query<OrgRecord>(
    `UPDATE organizations SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

/** 删除组织（需无子节点、无关联用户、无关联 worker） */
export async function deleteOrg(
  id: string,
): Promise<{ deleted: boolean; reason?: string }> {
  if (id === "root") {
    return { deleted: false, reason: "Cannot delete root organization" };
  }

  const children = await query(
    `SELECT id FROM organizations WHERE parent_id = $1 LIMIT 1`,
    [id],
  );
  if (children.rows.length > 0) {
    return { deleted: false, reason: "Has child organizations" };
  }

  const users = await query(
    `SELECT id FROM users WHERE organization_id = $1 LIMIT 1`,
    [id],
  );
  if (users.rows.length > 0) {
    return { deleted: false, reason: "Has associated users" };
  }

  const workers = await query(
    `SELECT id FROM workers WHERE organization_id = $1 LIMIT 1`,
    [id],
  );
  if (workers.rows.length > 0) {
    return { deleted: false, reason: "Has associated workers" };
  }

  await query(`DELETE FROM organizations WHERE id = $1`, [id]);
  return { deleted: true };
}

/** 列出所有组织（扁平） */
export async function listOrgs(): Promise<OrgRecord[]> {
  const rows = await query<OrgRecord>(
    `SELECT * FROM organizations ORDER BY level, name`,
  );
  return rows.rows;
}
