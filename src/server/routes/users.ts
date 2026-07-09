// =============================================================================
// User Routes — CRUD + 角色分配 + 权限隔离
// =============================================================================

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import {
  createUser,
  getUserById,
  listAllUsers,
  listUsersByOrg,
  updateUser,
  getUserRoleIds,
  getUserPermissions,
} from "../../domain/user.js";
import { listRoles, assignRole, removeRole } from "../../domain/rbac.js";
import { getPool } from "../../store/pg.js";
import {
  deployLocalWorker,
  deleteLocalWorker,
  allocateLocalPort,
  readOldPgCreds,
} from "../../domain/local-deployment.js";

export function createUserRoutes() {
  const router = new Hono();
  router.use("*", jwtAuth);

  // GET /api/v1/users
  router.get("/", requirePermission("user:read"), async (c) => {
    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;
    const page = parseInt(c.req.query("page") ?? "1", 10);
    const pageSize = parseInt(c.req.query("pageSize") ?? "50", 10);

    if (isSuperAdmin) {
      const users = await listAllUsers(pageSize, (page - 1) * pageSize);
      return c.json({ users, page, pageSize });
    }

    if (!userOrgId) return c.json({ users: [] });
    const users = await listUsersByOrg(userOrgId);
    return c.json({ users });
  });

  // GET /api/v1/users/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id")!;
    const user = await getUserById(id);
    if (!user) return c.json({ error: "User not found" }, 404);

    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;
    const requesterId = c.get("userId");
    if (id !== requesterId && !isSuperAdmin && user.organization_id !== userOrgId) {
      return c.json({ error: "Access denied" }, 403);
    }

    const roleIds = await getUserRoleIds(id);
    return c.json({
      user: { ...user, password_hash: undefined, roles: roleIds },
    });
  });

  // POST /api/v1/users
  router.post("/", requirePermission("user:create"), async (c) => {
    const body = await c.req.json<{
      username: string;
      email?: string;
      display_name?: string;
      password: string;
      organization_id?: string;
      is_org_admin?: boolean;
    }>();

    if (!body.username || !body.password) {
      return c.json({ error: "username and password required" }, 400);
    }

    const isSuperAdmin = c.get("isSuperAdmin");
    const userOrgId = c.get("userOrgId") as string | null;
    if (!isSuperAdmin) {
      if (!userOrgId) return c.json({ error: "No organization context" }, 400);
      body.organization_id = userOrgId;
    }

    try {
      const user = await createUser({
        username: body.username,
        email: body.email,
        display_name: body.display_name,
        password: body.password,
        organization_id: body.organization_id,
        is_org_admin: body.is_org_admin,
      });
      return c.json(
        { user: { ...user, password_hash: undefined } },
        201,
      );
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Create failed" },
        400,
      );
    }
  });

  // PATCH /api/v1/users/:id
  router.patch("/:id", requirePermission("user:update"), async (c) => {
    const id = c.req.param("id")!;
    const body = await c.req.json();

    const isSuperAdmin = c.get("isSuperAdmin");
    if (!isSuperAdmin && body.is_super_admin !== undefined) {
      delete body.is_super_admin;
    }

    const user = await updateUser(id, body);
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ user: { ...user, password_hash: undefined } });
  });

  // PATCH /api/v1/users/:id/disable — 禁用用户（status -> 'suspended'，软操作可恢复）
  // 注意：必须在 /:id/roles/:roleId、/:id/worker 等更具体的子路径之前注册，
  // 否则 Hono 会把 /:id/roles/... 错误匹配到 /:id 上。
  // 禁用不动 Worker 容器；getUserByUsername 已过滤 status='active'，
  // 被禁用用户无法登录，但行保留、可由 PATCH 再次激活。
  router.patch("/:id/disable", requirePermission("user:update"), async (c) => {
    const id = c.req.param("id")!;
    const requesterId = c.get("userId") as string;

    // 防御：禁止自禁（避免管理员把自己锁死在系统外）
    if (id === requesterId) {
      return c.json({ error: "Cannot disable yourself" }, 400);
    }

    const target = await getUserById(id);
    if (!target) return c.json({ error: "User not found" }, 404);

    // 超管不可被禁用（避免误操作把唯一治理账号锁死）
    if (target.is_super_admin) {
      return c.json({ error: "Cannot disable super admin" }, 403);
    }

    const user = await updateUser(id, { status: "suspended" });
    return c.json({ user: { ...user, password_hash: undefined } });
  });

  // DELETE /api/v1/users/:id — 物理删除用户（不可恢复）
  // 注意：必须在 /:id/roles/:roleId、/:id/worker 等更具体的子路径之前注册，
  // 否则 Hono 会把 /:id/roles/... 错误匹配到 /:id 上。
  // 物理删除 = DELETE FROM users，连带清理：
  //   1. 该用户名下所有 Worker 容器（避免悬挂）
  //   2. 4 张 ON DELETE NO ACTION 外键表的引用（其余子表为 SET NULL/CASCADE 自动处理）
  //   3. users 行本身（user_roles/sso_sessions/user_api_keys 等 CASCADE 子表连带删除）
  router.delete("/:id", requirePermission("user:delete"), async (c) => {
    const id = c.req.param("id")!;
    const requesterId = c.get("userId") as string;
    const isSuperAdmin = c.get("isSuperAdmin");

    // 防御：禁止自删（避免管理员把自己锁死在系统外）
    if (id === requesterId) {
      return c.json({ error: "Cannot delete yourself" }, 400);
    }

    const target = await getUserById(id);
    if (!target) return c.json({ error: "User not found" }, 404);

    // 仅超管可删除超管；非超管尝试删超管 → 403
    if (target.is_super_admin && !isSuperAdmin) {
      return c.json({ error: "Cannot delete super admin" }, 403);
    }

    const pool = getPool();

    // 1. decommission + 物理删除该用户名下所有未下线的 Worker 容器
    //    workers.assigned_user_id 无外键约束，DB 行删除不受影响；
    //    此处仅清理 Docker 容器/网络/卷，避免悬挂。
    const workers = await pool.query(
      `SELECT id FROM workers WHERE assigned_user_id = $1 AND status != 'decommissioned'`,
      [id],
    );
    for (const row of workers.rows) {
      try {
        await deleteLocalWorker(row.id);
      } catch {
        // 忽略容器删除失败（容器可能已不存在）
      }
      await pool.query(
        `UPDATE workers SET status = 'decommissioned' WHERE id = $1`,
        [row.id],
      );
    }

    // 2. 手动清理 ON DELETE NO ACTION 外键引用，避免 DELETE FROM users 被阻挡：
    //    - sso_tickets:        一次性 SSO 票据，用户已删则票据无意义 → 直接 DELETE
    //    - bundle_manifests:   保留 bundle 历史记录，仅断开上传者关联 → SET NULL
    //    - config_templates:   保留模板历史记录，仅断开更新者关联 → SET NULL
    //    （config_versions.created_by、skill_*.author/reviewer 等已是 SET NULL/CASCADE，
    //     由数据库自动处理，无需在此显式清理。）
    await pool.query(`DELETE FROM sso_tickets WHERE user_id = $1`, [id]);
    await pool.query(
      `UPDATE bundle_manifests SET uploaded_by = NULL WHERE uploaded_by = $1`,
      [id],
    );
    await pool.query(
      `UPDATE config_templates SET updated_by = NULL WHERE updated_by = $1`,
      [id],
    );

    // 3. 物理删除 users 行
    //    user_roles / user_api_keys / sso_sessions / skill_reviews / skill_approvals(requested_by)
    //    / skill_sharings(initiated_by) 等均为 ON DELETE CASCADE，连带自动删除。
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);

    return c.json({ ok: true, id });
  });

  // POST /api/v1/users/:id/roles
  router.post("/:id/roles", requirePermission("role:assign"), async (c) => {
    const id = c.req.param("id")!;
    const body = await c.req.json<{ role_id: string }>();
    if (!body.role_id) return c.json({ error: "role_id required" }, 400);

    await assignRole(id, body.role_id);
    const roleIds = await getUserRoleIds(id);
    return c.json({ roles: roleIds });
  });

  // DELETE /api/v1/users/:id/roles/:roleId
  router.delete(
    "/:id/roles/:roleId",
    requirePermission("role:assign"),
    async (c) => {
      const id = c.req.param("id")!;
      const roleId = c.req.param("roleId")!;

      if (roleId === "role_super_admin") {
        return c.json({ error: "Cannot remove super_admin role" }, 400);
      }

      await removeRole(id, roleId);
      const roleIds = await getUserRoleIds(id);
      return c.json({ roles: roleIds });
    },
  );

  // GET /api/v1/users/:id/permissions
  router.get("/:id/permissions", async (c) => {
    const id = c.req.param("id")!;
    const requesterId = c.get("userId");
    const isSuperAdmin = c.get("isSuperAdmin");
    if (id !== requesterId && !isSuperAdmin) {
      return c.json({ error: "Access denied" }, 403);
    }
    const permissions = await getUserPermissions(id);
    return c.json({ permissions });
  });

  // POST /api/v1/users/:id/deploy-worker — 为用户部署一对一 DA Worker 容器
  router.post("/:id/deploy-worker", requirePermission("worker:deploy"), async (c) => {
    const userId = c.req.param("id")!;
    const adminId = c.get("userId") as string;

    // 1. 获取用户信息
    const user = await getUserById(userId);
    if (!user) return c.json({ error: "User not found" }, 404);

    // 2. 查询用户是否已有 Worker
    const pool = getPool();
    const existing = await pool.query(
      `SELECT id, worker_token, host_port FROM workers
       WHERE assigned_user_id = $1 AND status != 'decommissioned'
       ORDER BY registered_at DESC LIMIT 1`,
      [userId],
    );
    const oldWorker = existing.rows[0] ?? null;

    // 3. 如果已有 Worker，deployLocalWorker 内部会 docker rm -f 旧容器（不删卷），
    //    所以这里不需要预先清理。关键是绝不能调 deleteLocalWorker（它会删卷！）。
    //    旧容器如果占用端口，deployLocalWorker 的 rm -f 会先释放。

    // 4. 生成 Worker ID 和 token
    const workerId = `wkr_${randomUUID().replace(/-/g, "")}`;
    const workerToken = `wkt_${randomUUID().replace(/-/g, "")}`;
    // 重新部署时复用旧端口，避免每次换端口
    const port = oldWorker?.host_port ?? allocateLocalPort();

    // 5. 如果已有 Worker 记录则更新，否则创建新记录
    if (oldWorker) {
      await pool.query(
        `UPDATE workers SET
           worker_token = $1, host_port = $2, status = 'deploying',
           current_image_tag = $3, da_url = $4
         WHERE id = $5`,
        [workerToken, port, "deepanalyze/da:latest", `http://localhost:${port}`, oldWorker.id],
      );
    } else {
      await pool.query(
        `INSERT INTO workers (id, worker_token, hostname, endpoint, status,
          assigned_user_id, organization_id, da_url, host_port, current_image_tag,
          approved_at, approved_by, protocol_version, registered_at)
         VALUES ($1, $2, $3, $4, 'deploying', $5, $6, $7, $8, $9, now(), $10, 2, now())`,
        [
          workerId, workerToken, "localhost",
          `http://localhost:${port}`,
          userId, user.organization_id,
          `http://localhost:${port}`, port,
          "deepanalyze/da:latest", adminId,
        ],
      );
    }

    const finalWorkerId = oldWorker?.id ?? workerId;

    // 6. 构建 DA 容器环境变量
    const hubExternalUrl = process.env.HUB_EXTERNAL_URL ?? "http://localhost:22000";
    const envVars: Record<string, string> = {
      DA_AUTH_MODE: "hub",
      DA_HUB_URL: "http://host.docker.internal:22000",
      DA_HUB_EXTERNAL_URL: hubExternalUrl,
      DA_HUB_WORKER_TOKEN: workerToken,
      DA_SSO_ALLOW_HTTP: "1",
      DA_WORKER_ID: finalWorkerId,
      HF_ENDPOINT: "https://hf-mirror.com",
      NODE_ENV: "production",
    };
    if (user.organization_id) {
      envVars.DA_ORG_ID = user.organization_id;
    }

    // 7. 部署容器栈
    //    重新部署时复用旧 PG 密码（卷里已有数据用的是旧密码，
    //    新密码会导致 DA app 连不上 PG）
    let pgPassword = `da_pg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (oldWorker) {
      try {
        const oldCreds = readOldPgCreds(oldWorker.id);
        if (oldCreds) pgPassword = oldCreds.password;
      } catch {
        // 读不到旧密码（容器已删），用新密码（首次初始化场景）
      }
    }
    try {
      const result = await deployLocalWorker({
        workerId: finalWorkerId,
        port,
        envVars,
        pgCreds: {
          database: "deepanalyze",
          username: "deepanalyze",
          password: pgPassword,
        },
      });

      // 8. 更新 Worker 状态为 approved
      await pool.query(
        `UPDATE workers SET status = 'approved', da_url = $1
         WHERE id = $2`,
        [result.daUrl, finalWorkerId],
      );

      return c.json({
        worker_id: finalWorkerId,
        da_url: result.daUrl,
        port: result.port,
        container_name: result.containerName,
        status: "approved",
      });
    } catch (err) {
      // 部署失败，更新状态
      await pool.query(
        `UPDATE workers SET status = 'error' WHERE id = $1`,
        [finalWorkerId],
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Deploy failed" },
        500,
      );
    }
  });

  // DELETE /api/v1/users/:id/worker — 删除用户的 Worker 容器
  router.delete("/:id/worker", requirePermission("worker:deploy"), async (c) => {
    const userId = c.req.param("id")!;
    const pool = getPool();

    const existing = await pool.query(
      `SELECT id FROM workers WHERE assigned_user_id = $1 AND status != 'decommissioned'`,
      [userId],
    );
    if (existing.rows.length === 0) {
      return c.json({ error: "No worker found for this user" }, 404);
    }

    for (const row of existing.rows) {
      try {
        await deleteLocalWorker(row.id);
      } catch {
        // 忽略
      }
      await pool.query(
        `UPDATE workers SET status = 'decommissioned' WHERE id = $1`,
        [row.id],
      );
    }

    return c.json({ ok: true });
  });

  return router;
}
