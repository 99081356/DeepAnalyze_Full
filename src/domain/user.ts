// =============================================================================
// DeepAnalyze Hub - User Domain
// =============================================================================
// 用户 CRUD + bcrypt 密码 + 权限展开。
// =============================================================================

import bcrypt from "bcrypt";
import { query } from "../store/pg.js";

export interface UserRecord {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  password_hash: string | null;
  role: string;
  auth_source: string;
  is_super_admin: boolean;
  is_org_admin: boolean;
  organization_id: string | null;
  assigned_worker_id: string | null;
  status: string;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * 用户记录 + 关联 Worker 信息（列表查询时 LEFT JOIN workers 得到）。
 * worker_* / da_url / host_port 在用户没有有效 Worker 时为 null。
 */
export interface UserWithWorker extends UserRecord {
  worker_id: string | null;
  worker_status: string | null;
  da_url: string | null;
  host_port: number | null;
}

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 创建用户 */
export async function createUser(params: {
  username: string;
  email?: string;
  display_name?: string;
  password: string;
  organization_id?: string;
  is_org_admin?: boolean;
}): Promise<UserRecord> {
  const {
    username,
    email,
    display_name,
    password,
    organization_id,
    is_org_admin = false,
  } = params;

  const existing = await query(`SELECT id FROM users WHERE username = $1`, [
    username,
  ]);
  if (existing.rows.length > 0) {
    throw new Error(`Username '${username}' already exists`);
  }

  const id = `usr_${crypto.randomUUID().replace(/-/g, "")}`;
  const passwordHash = await hashPassword(password);

  const result = await query<UserRecord>(
    `INSERT INTO users (id, username, email, display_name, password_hash, auth_source, organization_id, is_org_admin)
     VALUES ($1, $2, $3, $4, $5, 'local', $6, $7)
     RETURNING *`,
    [
      id,
      username,
      email ?? null,
      display_name ?? null,
      passwordHash,
      organization_id ?? null,
      is_org_admin,
    ],
  );

  // 默认赋予 user 角色（仅当角色存在时；seed 数据可能使用 UUID 而非 'role_user'）
  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE id = 'role_user' OR name = 'user'
     ON CONFLICT DO NOTHING`,
    [id],
  );

  if (is_org_admin) {
    await query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE id = 'role_org_admin' OR name = 'org_admin'
       ON CONFLICT DO NOTHING`,
      [id],
    );
  }

  return result.rows[0];
}

/** 按用户名查找（用于登录） */
export async function getUserByUsername(
  username: string,
): Promise<UserRecord | null> {
  const rows = await query<UserRecord>(
    `SELECT * FROM users WHERE username = $1 AND status = 'active'`,
    [username],
  );
  return rows.rows[0] ?? null;
}

/** 按 ID 查找 */
export async function getUserById(id: string): Promise<UserRecord | null> {
  const rows = await query<UserRecord>(`SELECT * FROM users WHERE id = $1`, [
    id,
  ]);
  return rows.rows[0] ?? null;
}

/** 获取用户的角色 ID 列表 */
export async function getUserRoleIds(userId: string): Promise<string[]> {
  const rows = await query<{ role_id: string }>(
    `SELECT role_id FROM user_roles WHERE user_id = $1`,
    [userId],
  );
  return rows.rows.map((r) => r.role_id);
}

/** 获取用户的权限码列表（展开角色 → 权限） */
export async function getUserPermissions(
  userId: string,
): Promise<string[]> {
  const rows = await query<{ code: string }>(
    `SELECT DISTINCT p.code
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return rows.rows.map((r) => r.code);
}

/** 列出组织内用户（含关联 Worker 状态） */
export async function listUsersByOrg(
  orgId: string,
): Promise<UserWithWorker[]> {
  const rows = await query<UserWithWorker>(
    `SELECT * FROM (
       SELECT DISTINCT ON (u.id)
              u.*,
              w.id          AS worker_id,
              w.status      AS worker_status,
              w.da_url      AS da_url,
              w.host_port   AS host_port
       FROM users u
       LEFT JOIN workers w
         ON w.assigned_user_id = u.id
        AND w.status != 'decommissioned'
       WHERE u.organization_id = $1
       ORDER BY u.id, w.registered_at DESC NULLS LAST
     ) t
     ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.rows;
}

/** 列出所有用户（含关联 Worker 状态） */
export async function listAllUsers(
  limit = 100,
  offset = 0,
): Promise<UserWithWorker[]> {
  const rows = await query<UserWithWorker>(
    `SELECT * FROM (
       SELECT DISTINCT ON (u.id)
              u.*,
              w.id          AS worker_id,
              w.status      AS worker_status,
              w.da_url      AS da_url,
              w.host_port   AS host_port
       FROM users u
       LEFT JOIN workers w
         ON w.assigned_user_id = u.id
        AND w.status != 'decommissioned'
       ORDER BY u.id, w.registered_at DESC NULLS LAST
     ) t
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.rows;
}

/** 更新用户 */
export async function updateUser(
  id: string,
  updates: {
    email?: string;
    display_name?: string;
    organization_id?: string | null;
    is_org_admin?: boolean;
    status?: string;
    password?: string;
  },
): Promise<UserRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.email !== undefined) {
    sets.push(`email = $${idx++}`);
    values.push(updates.email);
  }
  if (updates.display_name !== undefined) {
    sets.push(`display_name = $${idx++}`);
    values.push(updates.display_name);
  }
  if (updates.organization_id !== undefined) {
    sets.push(`organization_id = $${idx++}`);
    values.push(updates.organization_id);
  }
  if (updates.is_org_admin !== undefined) {
    sets.push(`is_org_admin = $${idx++}`);
    values.push(updates.is_org_admin);
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.password !== undefined) {
    const hash = await hashPassword(updates.password);
    sets.push(`password_hash = $${idx++}`);
    values.push(hash);
  }

  if (sets.length === 0) return getUserById(id);

  sets.push(`updated_at = NOW()`);
  values.push(id);
  const result = await query<UserRecord>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

/** 更新最后登录时间 */
export async function touchLogin(userId: string): Promise<void> {
  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [
    userId,
  ]);
}
