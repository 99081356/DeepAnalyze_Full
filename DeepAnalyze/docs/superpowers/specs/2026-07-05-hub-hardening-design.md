# Hub 加固设计（A：worker:deploy 权限 seed + host-servers 列白名单 + typing 清理）

**Spec date:** 2026-07-05
**Scope:** Category A of the post-acceptance P2 follow-up batch
**Out of scope:** Categories B（备份保留 cron）和 C（真实 SSH 备份执行）— 单独立 spec

## 背景与动机

企业多租户验收（T01-T21）完成后，最终审查发现 3 个独立的 P2 级问题。它们彼此无关、修复方式简单、无架构争议，但都代表着**真实的安全或运维风险**，应当在投入生产前清掉：

1. **`worker:deploy` 权限未被任何 migration seed** — 9 个 worker 部署/升级/回滚相关路由都调用 `requirePermission("worker:deploy")`，但 `permissions` 表里压根没有这个 code，更没分配给任何角色。结果**只有 super_admin 的 `*` 通配绕过能通过**，org_admin 实际上点不动部署按钮。
2. **`HostServerRepo.update()` 列名 SQL 注入** — `src/domain/host-server.ts:101` 把用户传入的 JSON key 直接字符串插值进 `UPDATE ... SET ${k} = $${i}`。TypeScript 类型 `Partial<CreateHostServerInput>` 在运行时被擦除，攻击者可以 PATCH `{"id = '...'; --": "x"}` 篡改任意列（包括 `id`、`created_at`、`ssh_user`、`ssh_target_host` 等）。
3. **散落的 typing 逃逸** — 验收过程中积累的若干 `as any` / `as unknown as WorkerBackup` 双重 cast，影响类型安全与代码可读性。

## 设计

### A1: `worker:deploy` 权限 seed migration 037

**新增文件**: `deepanalyze-hub/src/store/migrations/037_seed_worker_deploy_perm.ts`

**SQL 内容**:

```sql
INSERT INTO permissions (code, description)
VALUES ('worker:deploy', '部署、升级、回滚 worker 节点')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code)
SELECT 'role_super_admin', 'worker:deploy'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions
  WHERE role = 'role_super_admin' AND permission_code = 'worker:deploy'
);

INSERT INTO role_permissions (role, permission_code)
SELECT 'role_org_admin', 'worker:deploy'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions
  WHERE role = 'role_org_admin' AND permission_code = 'worker:deploy'
);
```

**理由**:
- super_admin 是必然要给的
- org_admin 在 migration 005 已经有 `worker:read/approve/reject`，部署是 worker 生命周期的自然延伸
- 审计日志（`audit_logs` 表）会记录每次部署/升级/回滚的 `initiated_by`，可追溯
- 普通用户（`role_user`）**不给** — 部署是组织级运维动作，普通用户不应有此权限

**幂等性**: 全部用 `ON CONFLICT DO NOTHING` 或 `WHERE NOT EXISTS`，重跑安全。

**测试**: 在 `tests/store/migrations/037_seed_worker_deploy_perm.test.ts` 验证：
- 跑 migration 后 `permissions` 表有 `worker:deploy` 行
- `role_super_admin` 和 `role_org_admin` 都有该权限
- 重跑 migration 不报错、不重复插入

### A2: `HostServerRepo.update()` 列白名单 + zod 输入校验

**修改文件**:
- `deepanalyze-hub/src/domain/host-server.ts`
- `deepanalyze-hub/src/server/routes/host-servers.ts`
- `deepanalyze-hub/tests/routes/host-servers.test.ts`

**修改 1: 列白名单（domain 层）**

在 `HostServerRepo` 类内引入 frozen Set：

```ts
const UPDATEABLE_HOST_SERVER_FIELDS = Object.freeze(new Set([
  "hostname",
  "ssh_target_host",
  "ssh_port",
  "ssh_user",
  "ssh_key_encrypted",
  "status",
  "labels",
  "port_range_start",
  "port_range_end",
  "port_block_size",
] as const));
```

`update()` 方法改成：

```ts
async update(id: string, patch: Partial<CreateHostServerInput>): Promise<HostServer | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATEABLE_HOST_SERVER_FIELDS.has(k as any)) continue;  // 关键：拒绝未知列
    if (k === "labels") {
      fields.push(`labels = $${i++}`); values.push(JSON.stringify(v));
    } else {
      fields.push(`${k} = $${i++}`); values.push(v);
    }
  }
  if (fields.length === 0) {
    // 没有可更新的字段，直接返回当前行（语义上 PATCH 空对象 = 不变）
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

注意：白名单内的列名仍然走字符串插值，但因为是**编译期常量集合**，不再构成 SQL 注入向量。

**修改 2: zod 输入校验（路由层，防御纵深）**

在 `host-servers.ts` 的 PATCH handler 内加 zod schema：

```ts
const patchSchema = z.object({
  hostname: z.string().min(1).optional(),
  ssh_target_host: z.string().optional(),
  ssh_port: z.number().int().min(1).max(65535).optional(),
  ssh_user: z.string().optional(),
  ssh_key_encrypted: z.string().optional(),  // 注意：客户端应传明文，由服务端加密
  status: z.enum(["active", "inactive"]).optional(),
  labels: z.record(z.unknown()).optional(),
  port_range_start: z.number().int().min(1).max(65535).optional(),
  port_range_end: z.number().int().min(1).max(65535).optional(),
  port_block_size: z.number().int().min(1).max(100).optional(),
}).strict();  // strict: 拒绝未知 key

router.patch("/:id", async (c) => {
  const parseResult = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parseResult.success) {
    return c.json({ error: "validation failed", issues: parseResult.error.issues }, 400);
  }
  const hs = await repo.update(c.req.param("id"), parseResult.data);
  if (!hs) return c.json({ error: "not found" }, 404);
  return c.json(hs);
});
```

**双重防御理由**:
- zod `.strict()` 在路由入口拒绝未知 key（用户友好错误）
- Set 白名单在 domain 层兜底（防御纵深，未来若有别的调用方也安全）

**关于 `ssh_key_encrypted` 的特别说明**: 客户端传的应该是**明文 PEM**，服务端应在 `repo.update` 内加密后写入。当前实现是否做了这一步需要确认 — 如果直接把客户端传的字符串当密文存，那是另一个 bug，但**不在本 spec 范围**。本 spec 只保证列名白名单防注入。

**测试**: `tests/routes/host-servers.test.ts` 新增 3 个 case：
- PATCH 含未知列名时返回 400（zod `.strict()`）
- PATCH 空对象返回 200 + 当前行（无字段更新）
- PATCH 正常字段（如 hostname）返回 200 + 更新后的行

### A3: typing 清理

**修改文件**: 散落在以下文件中的若干处：
- `src/server/routes/workers.ts` — `c.req.json<...>().catch(() => ({} as any))`
- `src/domain/worker-backup.ts` — `as unknown as WorkerBackup`
- 其他在实施时 grep 到的本计划引入的 cast

**清理原则**:
- **只清本计划（T01-T21）引入的 cast** — 预先存在的 cast（如 da-packer 相关）不在本 spec 范围
- 不引入 runtime 行为变化 — 纯类型层面
- 如果 cast 是为了绕开真正需要的类型错误，**修根本问题**而不是删 cast

**具体替换模式**:

```ts
// 之前
const body = c.req.json<{skipBackup?: boolean}>().catch(() => ({} as any));
// 之后
const body = await c.req.json<{skipBackup?: boolean}>().catch(() => ({}));
const skipBackup: boolean = Boolean(body.skipBackup);
```

```ts
// 之前
const backup = (await pool().query(...)).rows[0] as unknown as WorkerBackup;
// 之后
function rowToBackup(r: PgRow): WorkerBackup {
  return {
    id: r.id,
    workerId: r.worker_id,
    backupType: r.backup_type,
    // ... 显式字段映射
  };
}
const backup = rowToBackup((await pool().query(...)).rows[0]);
```

**不做**:
- 不批量重写整个 routes 层的类型注解
- 不引入新的运行时校验库（除非 zod 已经在用）
- 不动预先存在的 da-packer 测试夹具中的 cast

## 验收标准

- [ ] Migration 037 跑过后，`SELECT * FROM permissions WHERE code='worker:deploy'` 返回 1 行
- [ ] 同样 migration 后，`SELECT * FROM role_permissions WHERE permission_code='worker:deploy'` 返回至少 2 行（super_admin + org_admin）
- [ ] Migration 037 重跑不报错（幂等）
- [ ] PATCH `/api/v1/host-servers/:id` 含未知列名返回 400
- [ ] PATCH `/api/v1/host-servers/:id` 含 SQL 注入尝试（如 `"id = 'x'; --": "y"`）返回 400
- [ ] PATCH `/api/v1/host-servers/:id` 正常字段（如 `hostname`）返回 200
- [ ] 所有现有 host-servers 单测仍然通过（无回归）
- [ ] Hub 全套 `bun:test` 至少 82/91 通过（不低于当前基线）
- [ ] grep `as any\|as unknown as` 在新 code 路径中显著减少（具体计数在实施时记录）

## 任务分解

会拆成 3 个 SDD task（每个独立 commit）：

- **T1**: A1 — Migration 037 + 测试
- **T2**: A2 — HostServerRepo 列白名单 + zod + 测试
- **T3**: A3 — Typing 清理（grep-driven，本计划范围）

每个 task 自己的 commit、独立的 review，可独立 cherry-pick / revert。

## 不在本 spec 范围

- **Category B（备份保留 cron）** — 需要新增 scheduler 基础设施，单独立 spec
- **Category C（真实 SSH 备份执行）** — 涉及 SSH pg_dump/tar、备份文件存储、还原流程，单独立 spec
- **bundle 上传端点补全** — Explore 发现 `routes/bundle.ts` 缺 PUT/POST，但这不在本 spec 范围（属于 C 的"文件存储"设计）
- **DA 端的预存在 cast** — da-packer 相关代码不在本计划范围内
- **ssh_key_encrypted 加密流程审查** — 当前实现是否在 PATCH 时正确加密客户端明文输入，需独立 task 审查

## 风险与回滚

- **A1 风险**: 极低。纯 INSERT 操作。回滚 = 反向 DELETE 这两行。
- **A2 风险**: 低。zod `.strict()` 可能拒绝之前能通过的请求体（如果有客户端在传未知 key），但当前 Hub 前端代码是唯一调用方，已经按 schema 传，不会触发。回滚 = revert 单 commit。
- **A3 风险**: 极低。纯类型清理，runtime 行为不变。回滚 = revert 单 commit。
