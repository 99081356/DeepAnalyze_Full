# Hub 加固实施计划（A1/A2/A3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理企业多租户验收（T01-T21）的 3 个 P2 遗留项：补 `worker:deploy` 权限 seed、修 `HostServerRepo.update()` SQL 注入、清掉本计划引入的 typing cast。

**Architecture:** 3 个独立任务、3 个独立 commit、互不依赖。每个任务自带测试覆盖（T3 除外，纯类型清理无 runtime 行为变化）。所有改动都在 Hub repo (`/mnt/d/code/deepanalyze/deepanalyze-hub`) 内。

**Tech Stack:** TypeScript + Bun + Hono + pg + zod。Migration runner 自动发现 `migrations/*.ts`，按文件名排序顺序执行。

**Spec:** `docs/superpowers/specs/2026-07-05-hub-hardening-design.md`

## Global Constraints

- **数据库 schema 约束**：`permissions` 表的实际列是 `(id, code, resource, action, type, description)`；`role_permissions` 表的实际列是 `(role_id, permission_id)`。**Spec 文档里写的 SQL 是简化的，本计划用实际 schema**。
- **权限命名约定**：`id` 形如 `perm_<resource>_<action>`（如 `perm_worker_deploy`），`code` 形如 `<resource>:<action>`（如 `worker:deploy`）。
- **角色 ID 约定**：`role_super_admin` / `role_org_admin` / `role_user`（不是 `super_admin` / `org_admin`）。
- **Migration 文件命名**：`NNN_<snake_case_name>.ts`，三位数字前缀，从 037 开始（036 已存在）。
- **测试运行**：`cd /mnt/d/code/deepanalyze/deepanalyze-hub && NODE_ENV=development bun test`。**必须带 `NODE_ENV=development`**（生产模式会要求 RSA env vars，导致 `getKeyPair()` 抛错）。
- **Migration 幂等性**：所有 INSERT 必须 `ON CONFLICT DO NOTHING`，重跑安全。
- **不引入新依赖**：zod 已经在 `package.json`（被 `skill-schemas.ts` 使用），直接复用。
- **commit 风格**：参考既有 commit，`feat(hub):` / `fix(hub):` 前缀，简短描述 + 可选详细说明。

---

## File Structure

| 文件 | 操作 | 任务 | 责任 |
|------|------|------|------|
| `src/store/migrations/037_seed_worker_deploy_perm.ts` | Create | T1 | 把 `worker:deploy` 权限插入 + 授予两个角色 |
| `tests/migrations/seed-worker-deploy-perm.test.ts` | Create | T1 | 验证 migration 037 应用后的 DB 状态 |
| `src/domain/host-server.ts` | Modify | T2 | 在 `HostServerRepo.update()` 加列白名单 Set 过滤 |
| `src/server/routes/host-servers.ts` | Modify | T2 | 在 PATCH handler 加 zod `.strict()` schema |
| `tests/routes/host-servers.test.ts` | Modify | T2 | 新增 3 个 case：未知列、空对象、正常更新 |
| `src/server/routes/workers.ts` | Modify | T3 | 修 3 处 `{} as any` fallback（line 560, 601, 621） |
| `src/domain/worker-backup.ts` | Modify | T3 | 修 `(r as unknown as WorkerBackup)` 双重 cast（line 49） |
| `src/domain/config-template.ts` | Modify | T3 | 修 `[...(base as unknown[])] as unknown as ...` cast（line 37） |

---

## Task 1: Migration 037 — `worker:deploy` 权限 seed

**Files:**
- Create: `deepanalyze-hub/src/store/migrations/037_seed_worker_deploy_perm.ts`
- Test: `deepanalyze-hub/tests/migrations/seed-worker-deploy-perm.test.ts`

**Interfaces:**
- Consumes: `query` 函数 from `src/store/pg.ts`（migration 签名约定）
- Produces: `worker:deploy` 权限行 + 两行 `role_permissions`，供 `requirePermission("worker:deploy")` 在 9 个 worker 路由中正常工作

**Background context (for implementer):**
- 9 个路由调用 `requirePermission("worker:deploy")` 但 `permissions` 表里**没有这个 code**，导致 `requirePermission` 永远 reject（除非 super_admin 的 `*` 通配绕过）
- 实际 schema 是 `permissions (id, code, resource, action, type, description)` + `role_permissions (role_id, permission_id)`
- 参考 migration 028（`host_server:manage` 只给 super_admin）和 migration 033（`config_template:*` 给 super_admin + org_admin）的模式

- [ ] **Step 1: 写 migration 文件**

Create `deepanalyze-hub/src/store/migrations/037_seed_worker_deploy_perm.ts`:

```typescript
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
```

- [ ] **Step 2: 应用 migration**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun run src/store/migrate.ts
```

Expected output: 包含 `[DB] Running migration: 037_seed_worker_deploy_perm.ts` 和 `[DB] Migration applied: 037_seed_worker_deploy_perm.ts`。如果看到 "All migrations applied successfully" 但没有 037 那两行，说明 037 之前已经被记录过 — 需要 `psql` 检查 `_migrations` 表（不应该出现这种情况因为这是新文件）。

- [ ] **Step 3: 写 migration 测试**

Create `deepanalyze-hub/tests/migrations/seed-worker-deploy-perm.test.ts`:

```typescript
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
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/migrations/seed-worker-deploy-perm.test.ts
```

Expected: `4 pass | 0 fail`。如果失败，最可能原因是 Step 2 没成功跑 migration。

- [ ] **Step 5: 跑全套测试确认无回归**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
```

Expected: 至少 86 pass（基线 82 + 本 task 新增 4）。8 fail（预先存在的 da-packer 相关）保持不变。任何**新**失败都是回归 — 调查后才能 commit。

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/store/migrations/037_seed_worker_deploy_perm.ts tests/migrations/seed-worker-deploy-perm.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): migration 037 seed worker:deploy 权限给 super_admin + org_admin

9 个 worker 路由调用 requirePermission("worker:deploy") 但 permissions 表
从未 seed 该 code，只有 super_admin 的 * 通配绕过能通过。补一行 permission
+ 两行 role_permissions 解决。org_admin 在 005 已有 worker:read/approve/reject，
部署是生命周期延伸，审计日志记录 initiated_by。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: HostServerRepo 列白名单 + 路由层 zod 校验

**Files:**
- Modify: `deepanalyze-hub/src/domain/host-server.ts:5-114`（加 Set 常量 + 改 `update()` 方法）
- Modify: `deepanalyze-hub/src/server/routes/host-servers.ts:1-49`（import zod + 加 schema + 改 PATCH handler）
- Test: `deepanalyze-hub/tests/routes/host-servers.test.ts`（追加 3 个新 case）

**Interfaces:**
- Consumes: `HostServerRepo.update(id, patch)` 当前签名不变，行为变：未知 key 被静默忽略
- Produces: PATCH `/api/v1/host-servers/:id` 在未知 key 时返回 400（zod `.strict()`）+ 列白名单在 domain 层兜底

**Background context (for implementer):**
- 当前 `host-server.ts:101` 直接字符串插值 `${k}` 进 SQL SET 子句，攻击者可以 PATCH `{"id = '...'; --": "x"}` 篡改任意列
- TypeScript 类型 `Partial<CreateHostServerInput>` 在运行时被擦除，`c.req.json<...>()` 不做任何校验
- 必须双重防御：zod `.strict()` 在路由入口拒绝未知 key（用户友好错误）+ Set 白名单在 domain 层兜底（防御纵深）
- 当前 PATCH handler 在 `host-servers.ts:44-49`，update 方法在 `host-server.ts:93-109`
- 测试辅助 `tests/helpers/test-app.ts` 已经支持 super_admin + 正确签发 JWT

- [ ] **Step 1: 加列白名单 Set 到 host-server.ts**

打开 `deepanalyze-hub/src/domain/host-server.ts`，在 import 之后、`HostServer` interface 之前插入：

```typescript
/**
 * 允许通过 PATCH 更新的 host_servers 列白名单。
 * 防御 SQL 注入：列名虽然走字符串插值进 SET 子句，但只接受这个 Set 里的编译期常量。
 * 与 routes/host-servers.ts 的 zod schema 配合（路由层先过滤未知 key）。
 */
const UPDATEABLE_HOST_SERVER_FIELDS = Object.freeze(new Set<keyof HostServer | keyof CreateHostServerInput>([
  "hostname",
  "ssh_target_host",
  "ssh_target_port",
  "ssh_user",
  "ssh_key_encrypted",
  "ssh_key_salt",
  "port_range_start",
  "port_range_end",
  "port_block_size",
  "cpu_cores",
  "memory_gb",
  "gpu_count",
  "gpu_vram_mb",
  "gpu_model",
  "labels",
  "notes",
  "status",
]));
```

注意：`status` 不在 `CreateHostServerInput` 里（创建时不可指定，由系统管理），但**必须**在 update 白名单里，因为要把 host 标记为 `maintenance` / `retired` 是合法的 PATCH 操作。

- [ ] **Step 2: 改 update() 方法**

替换 `host-server.ts:93-109` 整个 `update` 方法为：

```typescript
  async update(id: string, patch: Partial<CreateHostServerInput> & { status?: HostServer["status"] }): Promise<HostServer | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      // 列名白名单：拒绝任何不在白名单内的 key（防 SQL 注入）
      if (!UPDATEABLE_HOST_SERVER_FIELDS.has(k as keyof typeof UPDATEABLE_HOST_SERVER_FIELDS)) continue;
      if (k === "labels") {
        fields.push(`labels = $${i++}`); values.push(JSON.stringify(v));
      } else {
        fields.push(`${k} = $${i++}`); values.push(v);
      }
    }
    // 没有可更新字段：返回当前行（PATCH 空对象 = 不变）
    if (fields.length === 0) {
      const { rows } = await this.pool().query<HostServer>(
        `SELECT * FROM host_servers WHERE id = $1`, [id]);
      return rows[0] ?? null;
    }
    fields.push(`updated_at = now()`);
    values.push(id);
    const { rows } = await this.pool().query<HostServer>(
      `UPDATE host_servers SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    return rows[0] ?? null;
  }
```

变化点：
1. 入参类型加 `& { status?: HostServer["status"] }` — 让 status 字段在 TS 层也合法
2. 循环开头加白名单 `if (!UPDATEABLE_HOST_SERVER_FIELDS.has(...)) continue;`
3. 处理 `fields.length === 0` 边界（PATCH 空对象或全部 key 被过滤后）

- [ ] **Step 3: 加 zod schema 到 host-servers.ts**

打开 `deepanalyze-hub/src/server/routes/host-servers.ts`，把 import 区改为：

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { HostServerRepo, CreateHostServerInput } from "../../domain/host-server";
import type { HostServer } from "../../domain/host-server";
import { getPortUsage } from "../../domain/port-allocation";
import { getPool } from "../../store/pg";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission";
```

在 `const repo = new HostServerRepo(...)` 之后、`router.use("*", ...)` 之前插入 schema 定义：

```typescript
  /**
   * PATCH 输入校验：列白名单 + 类型检查 + 严格拒绝未知 key。
   * 配合 domain 层的 UPDATEABLE_HOST_SERVER_FIELDS 形成防御纵深。
   * 注意：ssh_key_encrypted 字段客户端应传明文 PEM，加密由后续 task 处理（本 task 范围外）。
   */
  const patchHostServerSchema = z.object({
    hostname: z.string().min(1).optional(),
    ssh_target_host: z.string().min(1).optional(),
    ssh_target_port: z.number().int().min(1).max(65535).optional(),
    ssh_user: z.string().min(1).optional(),
    ssh_key_encrypted: z.string().optional(),
    ssh_key_salt: z.string().optional(),
    port_range_start: z.number().int().min(1).max(65535).optional(),
    port_range_end: z.number().int().min(1).max(65535).optional(),
    port_block_size: z.number().int().min(1).max(100).optional(),
    cpu_cores: z.number().int().positive().optional(),
    memory_gb: z.number().int().positive().optional(),
    gpu_count: z.number().int().nonnegative().optional(),
    gpu_vram_mb: z.number().int().nonnegative().optional(),
    gpu_model: z.string().optional(),
    labels: z.record(z.unknown()).optional(),
    notes: z.string().nullable().optional(),
    status: z.enum(["active", "maintenance", "retired"]).optional(),
  }).strict();
```

- [ ] **Step 4: 改 PATCH handler 用 zod**

替换 `host-servers.ts:44-49` 整个 PATCH handler 为：

```typescript
  router.patch("/:id", async (c) => {
    const parseResult = patchHostServerSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parseResult.success) {
      return c.json(
        { error: "validation failed", issues: parseResult.error.issues },
        400,
      );
    }
    const hs = await repo.update(c.req.param("id"), parseResult.data);
    if (!hs) return c.json({ error: "not found" }, 404);
    return c.json(hs);
  });
```

变化点：
1. 用 `patchHostServerSchema.safeParse()` 替代 `c.req.json<...>()`
2. 解析失败返回 400 + zod issues（用户可见原因）
3. 成功时把 `parseResult.data`（已校验、未知 key 已被 `.strict()` 过滤）传给 `repo.update`

- [ ] **Step 5: 追加 3 个测试到 host-servers.test.ts**

在 `deepanalyze-hub/tests/routes/host-servers.test.ts` 末尾追加：

```typescript
describe("PATCH /api/v1/host-servers/:id", () => {
  test("未知列名返回 400（zod .strict()）", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    // 先创建一个 host
    const createRes = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-strict",
        ssh_target_host: "10.0.0.99",
      }),
    });
    const created = await createRes.json();

    // 尝试 PATCH 未知列
    const res = await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        "id = 'hst_evil'; DROP TABLE workers--": "x",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");

    // Cleanup
    await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test("空对象返回 200 + 当前行（无字段更新）", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    const createRes = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-empty",
        ssh_target_host: "10.0.0.98",
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.hostname).toBe("patch-test-empty");

    // Cleanup
    await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test("正常字段更新返回 200", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    const createRes = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-normal",
        ssh_target_host: "10.0.0.97",
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-renamed",
        status: "maintenance",
        notes: "testing PATCH",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostname).toBe("patch-test-renamed");
    expect(body.status).toBe("maintenance");
    expect(body.notes).toBe("testing PATCH");

    // Cleanup
    await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });
});
```

- [ ] **Step 6: 运行 host-servers 测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/routes/host-servers.test.ts
```

Expected: `6 pass | 0 fail`（原 3 个 + 新 3 个）。任何失败先调查原因再修改，不要硬改测试断言。

- [ ] **Step 7: 跑全套测试确认无回归**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
```

Expected: 至少 89 pass（基线 82 + T1 新增 4 + 本 task 新增 3）。如果出现**新**失败（特别是 worker-deployment.test.ts / sso.test.ts），说明 zod schema 太严或 update 行为变化影响了别的调用方 — 调查后再决定是改 schema 还是改调用方。

- [ ] **Step 8: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/domain/host-server.ts src/server/routes/host-servers.ts tests/routes/host-servers.test.ts
git commit -m "$(cat <<'EOF'
fix(hub): HostServerRepo.update 列白名单 + PATCH zod 校验

之前 update 把用户传入 JSON 的 key 直接字符串插值进 SQL SET 子句，
构成 SQL 注入（PATCH {"id='x';--": "y"} 可改任意列）。本 commit：

1. domain 层加 UPDATEABLE_HOST_SERVER_FIELDS frozen Set 列白名单
2. 路由层加 zod .strict() schema 拒绝未知 key
3. PATCH 空对象语义改为返回 200 + 当前行（之前会 SQL syntax error）
4. status 字段加入 update 类型签名（用于标记 maintenance/retired）
5. 新增 3 个测试覆盖：注入尝试、空对象、正常更新

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 清理本计划引入的 typing cast

**Files:**
- Modify: `deepanalyze-hub/src/server/routes/workers.ts:560, 601, 621`（3 处 `{} as any`）
- Modify: `deepanalyze-hub/src/domain/worker-backup.ts:49`（`(r as unknown as WorkerBackup)` 双重 cast）
- Modify: `deepanalyze-hub/src/domain/config-template.ts:37`（`[...(base as unknown[])] as unknown as Record<string, unknown>`）

**Interfaces:** 不变 — 纯类型层面清理，runtime 行为零变化。

**Background context (for implementer):**
- 这是 T01-T21 验收时积累的 5 处明显类型逃逸，**不是**预先存在的（da-packer 等预存在 cast 不在范围）
- 清理原则：保留 runtime 行为，只让类型签名更精确；如果 cast 是为了绕开真正的类型错误，**修根本问题**而不是删 cast
- 不引入新依赖、不动业务逻辑

- [ ] **Step 1: 修 routes/workers.ts 的 3 处 `{} as any` fallback**

打开 `deepanalyze-hub/src/server/routes/workers.ts`，找到 line 560 附近（在 `POST /:id/upgrade` handler 内）：

**Before** (line 560):
```typescript
    const body = await c.req.json<{ to_tag?: string; image_tag?: string; dry_run?: boolean }>().catch(() => ({} as any));
```

**After**:
```typescript
    const body: { to_tag?: string; image_tag?: string; dry_run?: boolean } =
      await c.req.json().catch(() => ({}));
```

**Before** (line 601, in `POST /:id/rollback`):
```typescript
    const body = await c.req.json<{ backup_id?: string }>().catch(() => ({} as any));
```

**After**:
```typescript
    const body: { backup_id?: string } = await c.req.json().catch(() => ({}));
```

**Before** (line 621, in `POST /:id/backups`):
```typescript
    const body = await c.req.json<{ backup_type?: "manual" | "scheduled" }>().catch(() => ({} as any));
```

**After**:
```typescript
    const body: { backup_type?: "manual" | "scheduled" } =
      await c.req.json().catch(() => ({}));
```

变化点：
1. 类型参数从 `c.req.json<T>()` 移到显式 const 注解 — 行为完全相同
2. fallback 从 `{} as any` 改成 `{}` — 空 object literal 类型兼容所有 optional 字段接口

- [ ] **Step 2: 修 worker-backup.ts 的 row mapper cast**

打开 `deepanalyze-hub/src/domain/worker-backup.ts`，找到 line 49 附近。当前实现类似：

```typescript
function rowToBackup(r: QueryResultRow): WorkerBackup {
  return {
    ...(r as unknown as WorkerBackup),
  };
}
```

改成显式字段映射：

```typescript
function rowToBackup(r: QueryResultRow): WorkerBackup {
  return {
    id: r.id,
    workerId: r.worker_id,
    backupType: r.backup_type,
    fromTag: r.from_tag,
    toTag: r.to_tag,
    pgDumpPath: r.pg_dump_path,
    dataArchivePath: r.data_archive_path,
    sizeBytes: r.size_bytes,
    status: r.status,
    deployJobId: r.deploy_job_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}
```

注意：`WorkerBackup` interface 的字段名以本仓库实际定义为准 — 实施 Step 1 之前先 `grep "interface WorkerBackup" deepanalyze-hub/src/domain/worker-backup.ts` 看实际字段，按那个为准。如果 interface 已经是 snake_case，那 cast 本来就不该存在 — 直接 `return r as WorkerBackup` 也行。**实施前确认 interface 定义**。

- [ ] **Step 3: 修 config-template.ts 的 deepMerge cast**

打开 `deepanalyze-hub/src/domain/config-template.ts`，找到 line 37 附近。当前实现类似：

```typescript
} else if (Array.isArray(base)) {
  return [...(base as unknown[]), ...mergedValue] as unknown as Record<string, unknown>;
}
```

修法取决于 `deepMerge` 的实际签名 — 如果函数返回类型应该是 `unknown` 或 `unknown[]`，那 cast 是错的（应该改返回类型）。如果调用方期望 `Record<string, unknown>`，那这个分支根本不应该返回 array（应该 throw 或返回 base 不变）。

实施前的检查：
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
grep -n "function deepMerge\|export.*deepMerge" src/domain/config-template.ts
```

读完整函数定义后再决定改法。**优先选简单方案**：
- 如果 deepMerge 返回类型已是 `unknown`，把双重 cast 改成 `as unknown`
- 如果是 `Record<string, unknown>`，那 array 分支是 bug — 但修 bug 超出本 task 范围，保留 cast 但加注释 `// FIXME: deepMerge return type shouldn't be Record when branch returns array — T13 latent bug`

不要为了删 cast 而引入新的 runtime 行为变化。

- [ ] **Step 4: 跑相关测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/routes/worker-backups.test.ts tests/routes/config-templates.test.ts 2>&1 | tail -5
```

Expected: 全部通过（这些测试在 T19/T13 已经写过，本 task 不应破坏任何 case）。

- [ ] **Step 5: 跑全套测试 + tsc 类型检查**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
```

Expected: 至少 89 pass（与 T2 完成后基线持平），8 fail（预先存在的）不变。

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bunx tsc --noEmit 2>&1 | tail -20
```

Expected: 不应出现**新的**类型错误。如果 tsc 之前能过（应该是），现在也必须能过。如果出现新错误，说明 cast 删除暴露了真正的类型问题 — 必须修根本原因而不是恢复 cast。

- [ ] **Step 6: 验证 grep 结果**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
grep -n "as any" src/server/routes/workers.ts src/domain/worker-backup.ts src/domain/config-template.ts
grep -n "as unknown as" src/server/routes/workers.ts src/domain/worker-backup.ts src/domain/config-template.ts
```

Expected: 这三个文件中 `as any` 应该返回 0 行；`as unknown as` 应该至多剩 1 行（config-template.ts 如果选了"保留 cast 加注释"方案）。

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/server/routes/workers.ts src/domain/worker-backup.ts src/domain/config-template.ts
git commit -m "$(cat <<'EOF'
refactor(hub): 清理 T01-T21 引入的 typing cast

5 处类型逃逸，纯类型层面清理，runtime 行为不变：
- routes/workers.ts: 3 处 c.req.json<T>().catch(() => ({} as any)) → 显式 const 注解
- domain/worker-backup.ts: row mapper (r as unknown as WorkerBackup) → 显式字段映射
- domain/config-template.ts: deepMerge 双重 cast → 简化或注释标注 T13 latent bug

预存在的 cast（da-packer / images / models 模块）不在本 commit 范围。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## 验收 checklist（全部 task 完成后）

- [ ] Migration 037 应用成功：`SELECT code FROM permissions WHERE code='worker:deploy'` 返回 1 行
- [ ] super_admin + org_admin 都有 worker:deploy：`SELECT role_id FROM role_permissions WHERE permission_id='perm_worker_deploy'` 返回 2 行
- [ ] role_user **没有** worker:deploy（验证上面同 query 不含 role_user）
- [ ] PATCH 含 SQL 注入尝试返回 400：`curl -X PATCH ... -d '{"id=evil;--":"x"}'`
- [ ] PATCH 空对象返回 200：`curl -X PATCH ... -d '{}'`
- [ ] PATCH 正常字段返回 200：`curl -X PATCH ... -d '{"hostname":"new"}'`
- [ ] 全套测试通过：`NODE_ENV=development bun test` → ≥89 pass / 8 预存在 fail
- [ ] `bunx tsc --noEmit` 无新错误
- [ ] 3 个 commit（T1 / T2 / T3）独立可 cherry-pick
