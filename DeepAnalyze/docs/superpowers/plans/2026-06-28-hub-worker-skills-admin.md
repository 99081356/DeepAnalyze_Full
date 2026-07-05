# Hub Worker 技能市场管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Hub Admin 增加 Phase 1 Marketplace 管理界面（`/worker-skills`）+ 跨系统推广能力（Phase 2 → Phase 1），同时修复 admin 端点的裸奔安全漏洞。

**Architecture:** 后端在现有 `marketplace.ts` 路由文件追加新端点 + 给 `/admin/*` 加 jwtAuth 中间件 + 新增 source 列溯源；前端新建 `WorkerSkills.tsx` 页面 + 改名现有 `/skills` 导航 + 在 Phase 2 Skills 页加推广按钮。所有 admin API 走 `skill:approve` 权限码（已存在于 `ADMIN_PRIVILEGE_CODES`）。

**Tech Stack:** Bun + Hono（后端），React 18 + Vite + Zustand（前端），PostgreSQL（数据），TypeScript strict（两端）

## Global Constraints

- **认证模式**：admin 端点统一用 `jwtAuth` + `requirePermission("skill:approve")`（jwt-auth.ts + require-permission.ts 已存在，不要修改这两个文件）
- **reviewer_id 审计**：所有 admin 写操作必须用 `c.get("userId") as string`，禁止硬编码 `'system'`
- **状态机保护**：所有 UPDATE 语句的 WHERE 子句必须包含 `review_status = $X` 状态校验，避免双击/双 admin 造成中间状态
- **slug 唯一约束**：Phase 1 `marketplace_skills.slug` 是 UNIQUE；推广时 slug 冲突返回 409
- **DB 写入失败不能阻塞 worker 操作**：推广、批准、下架都用 `RETURNING` 一次完成；不要分两步 SELECT + UPDATE
- **前端 API 模式**：所有新方法加到 `deepanalyze-hub/frontend/src/api/client.ts` 的 `api` 对象里（Hub 现有模式，不要新建文件）
- **前端 UI 模式**：用 `CSSProperties` + `var(--xxx)` CSS 变量（参考 `WorkerApproval.tsx`），不引入新 UI 库；新建组件不放在 `components/ui/`（保留给通用组件），而是 co-locate 在使用它的 page 文件里
- **Hub 无测试框架**：没有 jest/vitest/playwright；验证靠 `tsc --noEmit` + 手动 curl/浏览器验证
- **Migration 文件格式**：导出 `up(query)` 函数，文件名 `NNN_name.ts`，放 `src/store/migrations/` 下，runner 自动发现（无需注册到 index）
- **Phase 2 → Phase 1 复制是一次性快照**：不维护自动同步；源包更新不传播到推广副本
- **super_admin 跨 org**：推广按钮对所有 super admin 可见，跨 org scope 由 super admin 自己负责
- **未消耗的依赖**：`is_super_admin` 字段从 `MeResponse.is_super_admin`（snake_case）取，不要从 auth store 拿
- **i18n**：所有界面文案用中文（参考现有页面的中文标签）
- **TypeScript strict**：两端 tsconfig 都是 strict 模式，禁止 `any`（除了显式 `as any` 标注的边界）

---

## Task 1: Migration 018 — marketplace_skills 加溯源列

**Files:**
- Create: `deepanalyze-hub/src/store/migrations/018_marketplace_source_cols.ts`

**Interfaces:**
- Consumes: `query` 函数（由 migration runner 注入，类型：`<T extends QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>>`）
- Produces: `marketplace_skills.source_package_id` (TEXT, nullable)、`marketplace_skills.source_version_id` (TEXT, nullable)；后续 Task 4 的 promote 端点会写入这两列

**背景：** Phase 2 → Phase 1 推广时，需要记录"这个 Phase 1 skill 来自哪个 Phase 2 package + 哪个 version"，便于审计和追溯。两列都可空（旧数据保持 NULL）。

- [ ] **Step 1: 创建 migration 文件**

写入 `deepanalyze-hub/src/store/migrations/018_marketplace_source_cols.ts`：

```typescript
/**
 * Migration 018: marketplace_skills 加溯源列
 *
 * 给 Phase 1 marketplace_skills 表加 source_package_id / source_version_id，
 * 用于记录"该 skill 是从 Phase 2 哪个 package 的哪个 version 推广而来"。
 * 旧数据保持 NULL（表示非推广来源）。
 *
 * 配套：marketplace.ts 的 /admin/promote 端点写入这两列。
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE marketplace_skills
      ADD COLUMN IF NOT EXISTS source_package_id TEXT,
      ADD COLUMN IF NOT EXISTS source_version_id TEXT;
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE marketplace_skills
      DROP COLUMN IF EXISTS source_version_id,
      DROP COLUMN IF EXISTS source_package_id;
  `);
}
```

- [ ] **Step 2: 运行 migration**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/store/migrate.ts
```

Expected: 输出包含 `[DB] Running migration: 018_marketplace_source_cols.ts` 和 `[DB] Migration applied: 018_marketplace_source_cols.ts`

- [ ] **Step 3: 验证列存在**

Run:
```bash
PG_PASSWORD=$(grep '^PG_PASSWORD=' /mnt/d/code/deepanalyze/deepanalyze/.env | cut -d= -f2) \
psql -h localhost -U $(grep '^PG_USER=' /mnt/d/code/deepanalyze/deepanalyze/.env | cut -d= -f2) \
  -d $(grep '^PG_DB=' /mnt/d/code/deepanalyze/deepanalyze/.env | cut -d= -f2) \
  -c "\d marketplace_skills"
```

Expected: 表结构输出中能看到 `source_package_id | text |` 和 `source_version_id | text |` 两行（nullable）

如果 psql 找不到 PG_PASSWORD，手动执行：
```bash
psql -h localhost -U deepanalyze -d deepanalyze -c "\d marketplace_skills"
```
（按 .env 实际值替换）

- [ ] **Step 4: Typecheck**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run typecheck
```

Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/store/migrations/018_marketplace_source_cols.ts
git commit -m "feat(hub/migrations): marketplace_skills 加 source_package_id/source_version_id 溯源列"
```

---

## Task 2: 后端 admin 安全修复 + list 扩展 + reviewer_id 真实化

**Files:**
- Modify: `deepanalyze-hub/src/server/routes/marketplace.ts`

**Interfaces:**
- Consumes: `jwtAuth`（`../middleware/jwt-auth.js`）、`requirePermission`（`../middleware/require-permission.js`），都已存在；调用后 `c.get("userId")` 返回 admin 的真实 userId
- Produces:
  - `GET /admin/skills?status=&search=&limit=&offset=` 返回 `{ skills: AdminSkillRow[]; total: number; limit: number; offset: number }`
  - `AdminSkillRow` 字段：id, slug, name, description, prompt, tools, model_role, tags, version, review_status, reviewer_id, review_notes, submitter_id, download_count, rating_avg, review_count, published_at, created_at, updated_at, source_package_id, source_version_id
  - 所有 admin 路由强制 `jwtAuth + requirePermission("skill:approve")`

**背景：** 当前 `/admin/*` 三个端点裸奔无 auth；`reviewer_id` 硬编码 `'system'`；list 端点不支持搜索/分页。本任务一次性修这三个问题。

- [ ] **Step 1: 加 import 和 admin 中间件**

打开 `deepanalyze-hub/src/server/routes/marketplace.ts`，在现有 import 块（行 23-31）后追加：

```typescript
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
```

然后在 `export function createMarketplaceRoutes(): Hono {` 内、`const app = new Hono();` 之后、第一个 `app.get(...)` 之前，加：

```typescript
  // ─── Admin routes: require JWT + skill:approve permission ──────────────
  // 所有 /admin/* 路由统一走这个中间件，避免裸奔。
  app.use("/admin/*", jwtAuth, requirePermission("skill:approve"));
```

- [ ] **Step 2: 扩展 `/admin/skills` GET 端点**

定位现有的 `app.get("/admin/skills", async (c) => { ... })`（约行 309-328），**整段替换**为：

```typescript
  app.get("/admin/skills", async (c) => {
    const status = c.req.query("status"); // pending/approved/rejected/deprecated/all
    const search = c.req.query("search") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const whereParts: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (status && status !== "all") {
      whereParts.push(`review_status = $${idx++}`);
      params.push(status);
    }
    if (search) {
      whereParts.push(`(name ILIKE $${idx} OR slug ILIKE $${idx} OR description ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const countRes = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM marketplace_skills ${whereClause}`,
      params,
    );
    const total = parseInt(countRes.rows[0].total, 10);

    // pending 状态按 created_at ASC（FIFO 审核），其他状态按 created_at DESC
    const orderBy =
      status === "pending" ? "created_at ASC" : "created_at DESC";

    const { rows } = await query(
      `SELECT id, slug, name, description, prompt, tools, model_role, tags, version,
              review_status, reviewer_id, review_notes, submitter_id,
              download_count, rating_avg, review_count, published_at, created_at, updated_at,
              source_package_id, source_version_id
       FROM marketplace_skills ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );

    return c.json({ skills: rows, total, limit, offset });
  });
```

- [ ] **Step 3: approve 端点改用真实 userId**

定位现有 `app.post("/admin/skills/:id/approve", async (c) => { ... })`（约行 332-348），**整段替换**为：

```typescript
  app.post("/admin/skills/:id/approve", async (c) => {
    const { id } = c.req.param();
    const reviewerId = c.get("userId") as string;

    const { rows } = await query(
      `UPDATE marketplace_skills
       SET review_status = 'approved', reviewer_id = $2, published_at = now(), updated_at = now()
       WHERE id = $1 AND review_status = 'pending'
       RETURNING id, slug, name`,
      [id, reviewerId],
    );

    if (rows.length === 0) {
      return c.json({ error: "Skill not found or not in pending status" }, 404);
    }

    return c.json({ success: true, skill: rows[0] });
  });
```

- [ ] **Step 4: reject 端点改用真实 userId**

定位现有 `app.post("/admin/skills/:id/reject", async (c) => { ... })`（约行 352-369），**整段替换**为：

```typescript
  app.post("/admin/skills/:id/reject", async (c) => {
    const { id } = c.req.param();
    const reviewerId = c.get("userId") as string;
    const body = await c.req.json<{ reason?: string }>();

    const { rows } = await query(
      `UPDATE marketplace_skills
       SET review_status = 'rejected', reviewer_id = $2, review_notes = $3, updated_at = now()
       WHERE id = $1 AND review_status = 'pending'
       RETURNING id, slug, name`,
      [id, reviewerId, body.reason || ""],
    );

    if (rows.length === 0) {
      return c.json({ error: "Skill not found or not in pending status" }, 404);
    }

    return c.json({ success: true, skill: rows[0] });
  });
```

- [ ] **Step 5: Typecheck**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run typecheck
```

Expected: 0 errors

- [ ] **Step 6: 启动 Hub + 验证认证保护**

启动 Hub（如果没在运行）：
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/main.ts &
sleep 3
```

验证无 token 被拒：
```bash
curl -sS http://localhost:8080/api/v1/marketplace/admin/skills -o /dev/null -w "%{http_code}\n"
```

Expected: `401`

如果有 Hub 已有的 admin 用户登录 token（从浏览器 devtools 拿 `hub_access_token`），可以验证有 token 时返回 200：
```bash
curl -sS http://localhost:8080/api/v1/marketplace/admin/skills \
  -H "Authorization: Bearer <你的-token>" \
  | head -c 200
```

Expected: 返回 JSON 含 `"skills":[...],"total":...`；如果没有 admin token，跳过这步，由前端集成时验证

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/server/routes/marketplace.ts
git commit -m "fix(hub/marketplace): admin 端点加 jwtAuth + 扩展 list + reviewer_id 真实化

- app.use('/admin/*', jwtAuth, requirePermission('skill:approve')) 修裸奔
- /admin/skills 支持 status/search/limit/offset
- approve/reject 用 c.get('userId') 替代硬编码 'system'"
```

---

## Task 3: 后端 deprecate + delete 端点

**Files:**
- Modify: `deepanalyze-hub/src/server/routes/marketplace.ts`

**Interfaces:**
- Consumes: Task 2 已应用的 `app.use("/admin/*", ...)` 中间件（自动覆盖新端点）
- Produces:
  - `POST /admin/skills/:id/deprecate` body `{ reason?: string }` → `{ success: true, skill: { id, slug, name } }`，转换 approved → deprecated
  - `DELETE /admin/skills/:id` → `{ success: true, skill: { id, slug, name } }`，仅允许 pending/rejected 状态

**背景：** Phase 1 状态机需要"下架"和"硬删除"两个动作。deprecate 让 DA Worker 不再看到该 skill（已下载的本地缓存继续可用）；delete 用于清理 spam/测试垃圾。

- [ ] **Step 1: 在 marketplace.ts 加 deprecate 端点**

在 Task 2 修改过的 reject 端点之后、`// ─── Admin: list all plugins` 之前，插入：

```typescript
  // ─── Admin: deprecate skill (approved → deprecated) ────────────────────

  app.post("/admin/skills/:id/deprecate", async (c) => {
    const { id } = c.req.param();
    const reviewerId = c.get("userId") as string;
    const body = await c.req.json<{ reason?: string }>();

    const { rows } = await query(
      `UPDATE marketplace_skills
       SET review_status = 'deprecated', reviewer_id = $2, review_notes = $3, updated_at = now()
       WHERE id = $1 AND review_status = 'approved'
       RETURNING id, slug, name`,
      [id, reviewerId, body.reason || ""],
    );

    if (rows.length === 0) {
      return c.json({ error: "Skill not found or not in approved status" }, 404);
    }

    return c.json({ success: true, skill: rows[0] });
  });

  // ─── Admin: hard delete skill (only pending or rejected) ───────────────

  app.delete("/admin/skills/:id", async (c) => {
    const { id } = c.req.param();

    const { rows } = await query(
      `DELETE FROM marketplace_skills
       WHERE id = $1 AND review_status IN ('pending', 'rejected')
       RETURNING id, slug, name`,
      [id],
    );

    if (rows.length === 0) {
      return c.json({ error: "Can only delete pending or rejected skills" }, 400);
    }

    return c.json({ success: true, skill: rows[0] });
  });
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run typecheck
```

Expected: 0 errors

- [ ] **Step 3: 重启 Hub + 验证状态机**

如果 Hub 已在运行，重启：
```bash
pkill -f "bun.*src/main.ts" 2>/dev/null; sleep 1
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/main.ts &
sleep 3
```

无 token 验证（应该 401）：
```bash
curl -sS -X POST http://localhost:8080/api/v1/marketplace/admin/skills/fake-id/deprecate \
  -H "Content-Type: application/json" -d '{"reason":"x"}' \
  -o /dev/null -w "%{http_code}\n"
```

Expected: `401`

注意：deprecate/delete 端点的功能验证依赖有 approved 状态的 skill 和真实 admin token，留到 Task 6/7 前端联调时一起验证。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/server/routes/marketplace.ts
git commit -m "feat(hub/marketplace): 新增 deprecate + DELETE admin 端点

- POST /admin/skills/:id/deprecate (approved → deprecated)
- DELETE /admin/skills/:id (仅 pending/rejected)
- WHERE review_status = X 状态机保护"
```

---

## Task 4: 后端 promote 端点（Phase 2 → Phase 1）

**Files:**
- Modify: `deepanalyze-hub/src/server/routes/marketplace.ts`

**Interfaces:**
- Consumes:
  - `skill_packages` 表（Phase 2 包元信息）：实际字段 `id, slug, name, display_name, description, tags (JSONB), is_kill_switched (BOOL)` —— **注意**：没有 `status` 列，用 `is_kill_switched` 判断是否 killed；slug 在 Phase 2 不是全局 UNIQUE（只 `UNIQUE(name, org_id, scope)`），但推广到 Phase 1 时 Phase 1 的 UNIQUE 约束会自动拦截冲突
  - `skill_versions` 表（Phase 2 版本）：实际字段 `id, package_id, version, content (TEXT), allowed_tools (JSONB), status` —— **注意**：没有 `prompt`/`tools`/`model_role`/`anti_hallucination_level`/`compatibility`/`version_string`；`content` 即 prompt 内容，`allowed_tools` 是 JSONB 数组，`version` 是版本字符串
  - Task 1 加的 `source_package_id` / `source_version_id` 列
- Produces:
  - `POST /admin/promote` body `{ packageId: string }` → `{ success: true, skill: { id, slug, name, version } }`
  - 失败：`404`（package 不存在）、`400`（无 published 版本 / package killed）、`409`（slug 冲突）

**背景：** Phase 2 企业技能包成熟稳定后，super admin 可以把它"推广"到 Phase 1，让所有 DA Worker 能下载安装。一次性快照复制，不维护自动同步。

**字段映射（重要 — 已根据实际 schema 核对）：**

| Phase 1 marketplace_skills | Phase 2 源字段 | 备注 |
|------|------|------|
| `slug` | `skill_packages.slug` | Phase 1 UNIQUE，冲突时 409 |
| `name` | `skill_packages.display_name`（空则 fallback `skill_packages.name`） | display_name 更友好 |
| `description` | `skill_packages.description` | |
| `prompt` | `skill_versions.content` | content 即 prompt 内容 |
| `tools` | `skill_versions.allowed_tools`（JSONB → TEXT[]） | 用 `ARRAY(SELECT jsonb_array_elements_text(allowed_tools))` 转 |
| `model_role` | （无对应字段） | 默认 `'main'` |
| `anti_hallucination_level` | （无对应字段） | `null` |
| `tags` | `skill_packages.tags`（JSONB → TEXT[]） | 同上转换 |
| `version` | `skill_versions.version` | |
| `compatibility` | （无对应字段） | 默认 `{minVersion: "0.1.0"}` |
| `submitter_id` / `reviewer_id` | admin userId | 两字段都是 admin |
| `source_package_id` | `skill_packages.id` | 溯源 |
| `source_version_id` | `skill_versions.id` | 溯源 |

- [ ] **Step 1: 加 promote 端点（用上述字段映射）**

在 `marketplace.ts` 中，Task 3 加的 `app.delete("/admin/skills/:id", ...)` 之后、`// ─── Admin: list all plugins` 之前，插入：

```typescript
  // ─── Admin: promote Phase 2 package → Phase 1 marketplace ──────────────
  // 一次性快照复制：读 skill_packages + 最新 published skill_versions，
  // 写入 marketplace_skills (review_status='approved')。
  // slug 冲突 → 409；无 published 版本 → 400；killed package → 400。
  //
  // 字段映射参见 plan Task 4（skill_versions.content → prompt,
  // allowed_tools JSONB → tools TEXT[], 无 model_role/anti_hallucination/compatibility）。

  app.post("/admin/promote", async (c) => {
    const body = await c.req.json<{ packageId: string }>();
    const adminId = c.get("userId") as string;

    if (!body.packageId) {
      return c.json({ error: "packageId is required" }, 400);
    }

    // 1. 读 package（用 is_kill_switched 判断 killed，不是 status）
    const pkgRes = await query(
      `SELECT id, slug, name, display_name, description, tags, is_kill_switched
       FROM skill_packages WHERE id = $1`,
      [body.packageId],
    );
    if (pkgRes.rows.length === 0) {
      return c.json({ error: "Package not found" }, 404);
    }
    const pkg = pkgRes.rows[0] as {
      id: string;
      slug: string;
      name: string;
      display_name: string | null;
      description: string | null;
      tags: unknown; // JSONB
      is_kill_switched: boolean;
    };

    if (pkg.is_kill_switched) {
      return c.json({ error: "Package is kill-switched, cannot promote" }, 400);
    }

    // 2. 读最新 published 版本（status='published'，非 internal_test/canary）
    const verRes = await query(
      `SELECT id, version, content, allowed_tools
       FROM skill_versions
       WHERE package_id = $1 AND status = 'published'
       ORDER BY created_at DESC LIMIT 1`,
      [body.packageId],
    );
    if (verRes.rows.length === 0) {
      return c.json({ error: "Package has no published version" }, 400);
    }
    const ver = verRes.rows[0] as {
      id: string;
      version: string;
      content: string | null;
      allowed_tools: unknown; // JSONB array
    };

    // 3. slug 冲突检查
    const existing = await query(
      `SELECT id FROM marketplace_skills WHERE slug = $1`,
      [pkg.slug],
    );
    if (existing.rows.length > 0) {
      return c.json({
        error: `Slug '${pkg.slug}' already exists in worker market. Rename the source package or deprecate the existing worker skill first.`,
      }, 409);
    }

    // 4. 字段转换：JSONB → TEXT[]（pg 不允许直接 cast JSONB to TEXT[]，用 jsonb_array_elements_text）
    //    allowed_tools/tags 都可能是空数组或非数组 JSON，需 defensive 处理
    const safeName = pkg.display_name || pkg.name;
    const toolsArray = Array.isArray(ver.allowed_tools)
      ? (ver.allowed_tools as string[]).filter((t) => typeof t === "string")
      : ["*"];
    const tagsArray = Array.isArray(pkg.tags)
      ? (pkg.tags as string[]).filter((t) => typeof t === "string")
      : [];

    // 5. INSERT 到 marketplace_skills
    const newId = randomUUID();
    await query(
      `INSERT INTO marketplace_skills
        (id, slug, name, description, prompt, tools, model_role,
         anti_hallucination_level, tags, version, submitter_id, reviewer_id,
         review_status, published_at, compatibility,
         source_package_id, source_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'main', NULL, $7, $8, $9, $10, 'approved', now(), $11, $12, $13)`,
      [
        newId,
        pkg.slug,
        safeName,
        pkg.description || "",
        ver.content || "",
        toolsArray,
        tagsArray,
        ver.version,
        adminId,
        adminId,
        JSON.stringify({ minVersion: "0.1.0" }),
        pkg.id,
        ver.id,
      ],
    );

    return c.json({
      success: true,
      skill: { id: newId, slug: pkg.slug, name: safeName, version: ver.version },
    });
  });
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run typecheck
```

Expected: 0 errors

- [ ] **Step 3: 重启 Hub + 验证认证保护**

```bash
pkill -f "bun.*src/main.ts" 2>/dev/null; sleep 1
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/main.ts &
sleep 3

curl -sS -X POST http://localhost:8080/api/v1/marketplace/admin/promote \
  -H "Content-Type: application/json" -d '{"packageId":"fake"}' \
  -o /dev/null -w "%{http_code}\n"
```

Expected: `401`

带无效 packageId 的功能验证留到 Task 8/9 前端联调（需要真实 admin token 和 Phase 2 package）。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/server/routes/marketplace.ts
git commit -m "feat(hub/marketplace): 跨系统推广端点 POST /admin/promote

- 读 Phase 2 skill_packages + 最新 published skill_versions
- 字段映射：content→prompt, allowed_tools(JSONB)→tools(TEXT[])
- 用 is_kill_switched 判断 killed（不是 status='killed'）
- 复制到 marketplace_skills (approved 状态，带 source_*_id 溯源)
- slug 冲突 409 / kill-switched 400 / 无 published 400"
```

---

## Task 5: 前端 admin API client + types

**Files:**
- Modify: `deepanalyze-hub/frontend/src/api/client.ts`

**Interfaces:**
- Consumes: 现有 `request<T>(method, path, body?)` 函数（client.ts 内部，不导出，直接在 `api` 对象里调用）
- Produces: 扩展 `api` 对象，新增方法：
  - `api.listMarketplaceAdminSkills(params: { status?: string; search?: string; limit?: number; offset?: number }): Promise<{ skills: AdminSkill[]; total: number; limit: number; offset: number }>`
  - `api.approveMarketplaceSkill(id: string): Promise<{ success: true; skill: { id: string; slug: string; name: string } }>`
  - `api.rejectMarketplaceSkill(id: string, reason: string): Promise<...>`
  - `api.deprecateMarketplaceSkill(id: string, reason: string): Promise<...>`
  - `api.removeMarketplaceSkill(id: string): Promise<...>`
  - `api.promotePackageToMarketplace(packageId: string): Promise<{ success: true; skill: { id: string; slug: string; name: string; version: string } }>`
- 类型导出：`export interface AdminSkill { ... }`

**背景：** 所有新方法加到现有 `api` 对象里（Hub 现有模式，不新建文件）。Task 6/8 会用到这些方法。

- [ ] **Step 1: 加 AdminSkill 类型**

打开 `deepanalyze-hub/frontend/src/api/client.ts`，在现有 `SkillPackageV2` interface 附近（约行 249 之后）追加：

```typescript
// ─── Phase 1 Marketplace admin (Worker 技能市场管理) ─────────────────────

export interface AdminSkill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  tools: string[] | null;
  model_role: string | null;
  tags: string[] | null;
  version: string;
  review_status: "pending" | "approved" | "rejected" | "deprecated";
  reviewer_id: string | null;
  review_notes: string | null;
  submitter_id: string;
  download_count: number;
  rating_avg: string | number; // pg NUMERIC 返回 string，前端用 Number() 转
  review_count: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  source_package_id: string | null;
  source_version_id: string | null;
}

export interface AdminSkillListResponse {
  skills: AdminSkill[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminSkillMutationResponse {
  success: true;
  skill: { id: string; slug: string; name: string };
}

export interface PromoteResponse {
  success: true;
  skill: { id: string; slug: string; name: string; version: string };
}
```

- [ ] **Step 2: 在 api 对象里追加方法**

在 `export const api = { ... }` 内部，找到现有 marketplace/skills 相关方法附近（如果存在），或在 `api` 对象最后（`logout` 等之后）追加：

```typescript
  // ─── Phase 1 Marketplace admin (Worker 技能市场管理) ───────────────────

  listMarketplaceAdminSkills: (params: {
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.search) qs.set("search", params.search);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return request<AdminSkillListResponse>(
      "GET",
      `/marketplace/admin/skills${query ? `?${query}` : ""}`,
    );
  },

  approveMarketplaceSkill: (id: string) =>
    request<AdminSkillMutationResponse>(
      "POST",
      `/marketplace/admin/skills/${id}/approve`,
    ),

  rejectMarketplaceSkill: (id: string, reason: string) =>
    request<AdminSkillMutationResponse>(
      "POST",
      `/marketplace/admin/skills/${id}/reject`,
      { reason },
    ),

  deprecateMarketplaceSkill: (id: string, reason: string) =>
    request<AdminSkillMutationResponse>(
      "POST",
      `/marketplace/admin/skills/${id}/deprecate`,
      { reason },
    ),

  removeMarketplaceSkill: (id: string) =>
    request<AdminSkillMutationResponse>(
      "DELETE",
      `/marketplace/admin/skills/${id}`,
    ),

  promotePackageToMarketplace: (packageId: string) =>
    request<PromoteResponse>(
      "POST",
      `/marketplace/admin/promote`,
      { packageId },
    ),
```

- [ ] **Step 3: Typecheck**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add frontend/src/api/client.ts
git commit -m "feat(hub/api): admin marketplace API methods + AdminSkill 类型

listMarketplaceAdminSkills / approve / reject / deprecate / remove / promote
全部加到现有 api 对象，复用 request<T> 内部封装"
```

---

## Task 6: 前端 WorkerSkills 页面

**Files:**
- Create: `deepanalyze-hub/frontend/src/pages/WorkerSkills.tsx`

**Interfaces:**
- Consumes:
  - `api` 对象（Task 5 扩展后的 `listMarketplaceAdminSkills` / `approveMarketplaceSkill` / `rejectMarketplaceSkill` / `deprecateMarketplaceSkill` / `removeMarketplaceSkill`）
  - `useUIStore`（`../store/ui.js`）的 `showConfirm` / `addToast`
  - UI 组件：`Tabs`（`../components/ui/Tabs.js`）、`SearchBar`、`EmptyState`、`StatusBadge`（`../components/hub/StatusBadge.js`）、`Button`、`Spinner`
- Produces:
  - `export function WorkerSkills(): JSX.Element` —— 整页组件，自包含（含 ReasonDialog 子组件 co-locate 在同文件）
  - 由 Task 7 注册到 `/worker-skills` 路由

**背景：** 这是 admin 管理界面，参考 `WorkerApproval.tsx` 的 page+banner+list 模式。Tabs 切换 status，搜索、操作按钮都跟 status 联动。

- [ ] **Step 1: 创建页面文件骨架**

写入 `deepanalyze-hub/frontend/src/pages/WorkerSkills.tsx`：

```typescript
import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, type AdminSkill } from "../api/client.js";
import { useUIStore } from "../store/ui.js";
import { Tabs } from "../components/ui/Tabs.js";
import { SearchBar } from "../components/ui/SearchBar.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Button } from "../components/ui/Button.js";
import { StatusBadge } from "../components/hub/StatusBadge.js";

/* -------------------------------------------------------------------------- */
/*  Constants & Styles                                                        */
/* -------------------------------------------------------------------------- */

type ReviewStatus = "pending" | "approved" | "rejected" | "deprecated" | "all";

const STATUS_TABS: { key: ReviewStatus; label: string }[] = [
  { key: "pending", label: "待审核" },
  { key: "approved", label: "已批准" },
  { key: "rejected", label: "已拒绝" },
  { key: "deprecated", label: "已弃用" },
  { key: "all", label: "全部" },
];

const pageStyle: CSSProperties = {
  padding: "var(--space-6)",
  maxWidth: 1200,
  margin: "0 auto",
};

const bannerStyle: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  marginBottom: "var(--space-4)",
  background: "var(--info-light, #e7f1ff)",
  borderLeft: "3px solid var(--info, #2196f3)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-sm)",
  color: "var(--text-primary)",
};

const errorStyle: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  background: "var(--error-light)",
  border: "1px solid var(--error)",
  borderRadius: "var(--radius-lg)",
  color: "var(--error-dark)",
  fontSize: "var(--text-sm)",
  margin: "var(--space-3) 0",
};

const cardStyle: CSSProperties = {
  padding: "var(--space-4)",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const cardTitleStyle: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: 600,
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

const metaStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--text-secondary)",
};

const promptPreviewStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--text-xs)",
  background: "var(--bg-secondary)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border)",
  maxHeight: 100,
  overflow: "hidden" as const,
  whiteSpace: "pre-wrap" as const,
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  flexWrap: "wrap" as const,
  marginTop: "var(--space-2)",
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function WorkerSkills() {
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  const [tab, setTab] = useState<ReviewStatus>("pending");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonDialog, setReasonDialog] = useState<{
    kind: "reject" | "deprecate";
    skill: AdminSkill;
  } | null>(null);

  /* -- debounce search 300ms -- */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  /* -- load -- */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMarketplaceAdminSkills({
        status: tab,
        search: debouncedSearch,
        limit: 100,
      });
      setSkills(res.skills);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [tab, debouncedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  /* -- actions -- */
  const handleApprove = async (skill: AdminSkill) => {
    const ok = await showConfirm({
      title: "批准 Skill",
      message: `确认批准 "${skill.name}"？批准后所有连接的 DA Worker 都能下载安装。`,
      confirmText: "批准",
    });
    if (!ok) return;
    try {
      await api.approveMarketplaceSkill(skill.id);
      addToast({ variant: "success", message: `已批准 ${skill.name}` });
      await load();
    } catch (e) {
      addToast({ variant: "error", message: e instanceof Error ? e.message : "批准失败" });
    }
  };

  const handleSubmitReason = async (reason: string) => {
    if (!reasonDialog) return;
    const { kind, skill } = reasonDialog;
    try {
      if (kind === "reject") {
        await api.rejectMarketplaceSkill(skill.id, reason);
        addToast({ variant: "success", message: `已拒绝 ${skill.name}` });
      } else {
        await api.deprecateMarketplaceSkill(skill.id, reason);
        addToast({ variant: "warning", message: `已下架 ${skill.name}` });
      }
      setReasonDialog(null);
      await load();
    } catch (e) {
      addToast({ variant: "error", message: e instanceof Error ? e.message : "操作失败" });
    }
  };

  const handleRemove = async (skill: AdminSkill) => {
    const ok = await showConfirm({
      title: "永久删除 Skill",
      message: `确认永久删除 "${skill.name}"？此操作不可恢复。仅建议对 spam 或测试垃圾使用。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeMarketplaceSkill(skill.id);
      addToast({ variant: "success", message: `已删除 ${skill.name}` });
      await load();
    } catch (e) {
      addToast({ variant: "error", message: e instanceof Error ? e.message : "删除失败" });
    }
  };

  /* -- render -- */
  return (
    <div style={pageStyle}>
      <div style={bannerStyle}>
        管理 DA Worker 可下载安装的 Skill。批准后，所有连接的 DA Worker 都能在
        "资源市场"面板看到并安装。与{" "}
        <Link to="/skills">企业技能包</Link>（多租户订阅制）不同。
      </div>

      <h1 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-4)" }}>
        Worker 技能市场
      </h1>

      <Tabs
        items={STATUS_TABS.map((t) => ({
          key: t.key,
          label: `${t.label}${t.key === tab && total > 0 ? ` (${total})` : ""}`,
        }))}
        activeKey={tab}
        onChange={(k) => setTab(k as ReviewStatus)}
      />

      <div style={{ margin: "var(--space-4) 0" }}>
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="搜索 name / slug / description"
        />
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      {loading ? (
        <div style={{ padding: "var(--space-8)", textAlign: "center" }}>
          加载中...
        </div>
      ) : skills.length === 0 ? (
        <EmptyState
          title="暂无 skill"
          description={
            debouncedSearch
              ? `未找到匹配 "${debouncedSearch}" 的 skill`
              : `当前 Tab（${tab}）下没有 skill`
          }
        />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {skills.map((s) => (
            <SkillAdminCard
              key={s.id}
              skill={s}
              onApprove={handleApprove}
              onReject={(skill) => setReasonDialog({ kind: "reject", skill })}
              onDeprecate={(skill) => setReasonDialog({ kind: "deprecate", skill })}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      {reasonDialog && (
        <ReasonDialog
          kind={reasonDialog.kind}
          skillName={reasonDialog.skill.name}
          onSubmit={handleSubmitReason}
          onCancel={() => setReasonDialog(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  SkillAdminCard                                                            */
/* -------------------------------------------------------------------------- */

interface SkillAdminCardProps {
  skill: AdminSkill;
  onApprove: (s: AdminSkill) => void;
  onReject: (s: AdminSkill) => void;
  onDeprecate: (s: AdminSkill) => void;
  onRemove: (s: AdminSkill) => void;
}

function SkillAdminCard({ skill, onApprove, onReject, onDeprecate, onRemove }: SkillAdminCardProps) {
  return (
    <div style={cardStyle}>
      <div style={cardTitleStyle}>
        <span>{skill.name}</span>
        <StatusBadge status={skill.review_status} />
        {skill.source_package_id && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            🔗 源自企业包
          </span>
        )}
      </div>
      <div style={metaStyle}>
        by {skill.submitter_id} · v{skill.version} · 提交于{" "}
        {new Date(skill.created_at).toLocaleString("zh-CN")}
        {skill.published_at && ` · 发布于 ${new Date(skill.published_at).toLocaleString("zh-CN")}`}
      </div>
      {skill.description && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
          {skill.description}
        </div>
      )}
      <pre style={promptPreviewStyle}>{skill.prompt}</pre>
      {skill.tags && skill.tags.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-1)", flexWrap: "wrap" }}>
          {skill.tags.map((t) => (
            <span
              key={t}
              style={{
                fontSize: "var(--text-xs)",
                padding: "2px 8px",
                background: "var(--bg-secondary)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {skill.review_notes && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
          审核备注：{skill.review_notes}
        </div>
      )}
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
        下载 {skill.download_count} · 评分 {Number(skill.rating_avg).toFixed(1)} (
        {skill.review_count} 评)
      </div>
      <div style={actionRowStyle}>
        {skill.review_status === "pending" && (
          <>
            <Button size="sm" variant="primary" onClick={() => onApprove(skill)}>
              批准
            </Button>
            <Button size="sm" variant="danger" onClick={() => onReject(skill)}>
              拒绝
            </Button>
          </>
        )}
        {skill.review_status === "approved" && (
          <Button size="sm" variant="warning" onClick={() => onDeprecate(skill)}>
            下架
          </Button>
        )}
        {skill.review_status === "rejected" && (
          <Button size="sm" variant="ghost" onClick={() => onRemove(skill)}>
            删除
          </Button>
        )}
        {skill.review_status === "deprecated" && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            （历史记录，不可操作）
          </span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  ReasonDialog (Modal-based, 输入审核原因)                                  */
/* -------------------------------------------------------------------------- */

interface ReasonDialogProps {
  kind: "reject" | "deprecate";
  skillName: string;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}

function ReasonDialog({ kind, skillName, onSubmit, onCancel }: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const verb = kind === "reject" ? "拒绝" : "下架";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          padding: "var(--space-6)",
          borderRadius: "var(--radius-lg)",
          minWidth: 400,
          maxWidth: 600,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
        <h3 style={{ margin: 0 }}>
          {verb} "{skillName}"
        </h3>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
          请输入{verb}原因（可选，但建议填写）：
        </p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={`${verb}原因...`}
          style={{
            minHeight: 80,
            padding: "var(--space-2) var(--space-3)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            fontFamily: "inherit",
            fontSize: "var(--text-sm)",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm"
            variant={kind === "reject" ? "danger" : "warning"}
            onClick={() => onSubmit(reason)}
          >
            确认{verb}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend && npx tsc --noEmit
```

Expected: 0 errors

如果出现"Tabs props 不匹配"或"SearchBar props 不匹配"，先 Read 实际组件定义（`../components/ui/Tabs.tsx`、`../components/ui/SearchBar.tsx`、`../components/ui/EmptyState.tsx`、`../components/ui/Button.tsx`），按实际 prop 签名调整 Step 1 的 JSX 调用。

- [ ] **Step 3: 手动浏览器验证（延后到 Task 7 注册路由后）**

这一步只验证 typecheck；真正的浏览器验证留到 Task 7 把 `/worker-skills` 路由注册后再做（不然访问不到）。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add frontend/src/pages/WorkerSkills.tsx
git commit -m "feat(hub/admin): WorkerSkills 页面 - Phase 1 skill 管理

- Tabs 切换 pending/approved/rejected/deprecated/all
- 搜索（300ms debounce）+ 卡片列表 + status badge
- approve/reject/deprecate/remove 操作 + ReasonDialog
- 复用 useUIStore.showConfirm/addToast"
```

---

## Task 7: 前端 nav 改名 + /worker-skills 路由

**Files:**
- Modify: `deepanalyze-hub/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `WorkerSkills` 组件（Task 6）
- Produces: `/worker-skills` 路由 + NAV_ITEMS 更新

**背景：** Task 6 已写完页面但没注册。本任务把现有 `/skills` 标签改名"企业技能包"，新增"Worker 技能市场"，并注册 `/worker-skills` 路由。

- [ ] **Step 1: 加 import**

打开 `deepanalyze-hub/frontend/src/App.tsx`，在现有 page imports 区（约行 1-10）追加：

```typescript
import { WorkerSkills } from "./pages/WorkerSkills.js";
```

- [ ] **Step 2: 改 NAV_ITEMS**

定位 `const NAV_ITEMS = [...]`（约行 22-30），**整段替换**为：

```typescript
const NAV_ITEMS = [
  { to: "/", label: "仪表盘", icon: "📊" },
  { to: "/orgs", label: "组织树", icon: "🏢" },
  { to: "/users", label: "用户", icon: "👥" },
  { to: "/skills", label: "企业技能包", icon: "📦" },
  { to: "/worker-skills", label: "Worker 技能市场", icon: "🌐" },
  { to: "/sharings", label: "跨组织共享", icon: "🔄" },
  { to: "/workers", label: "Worker 审批", icon: "🖥️" },
  { to: "/security", label: "安全网关", icon: "🛡️" },
] as const;
```

- [ ] **Step 3: 加路由**

定位现有 `<Route>` 注册块（约行 539-546），在 `<Route path="/skills" ...>` 那一行之后追加：

```tsx
      <Route path="/worker-skills" element={<ProtectedRoute user={user} setUser={setUser}><WorkerSkills /></ProtectedRoute>} />
```

- [ ] **Step 4: Typecheck + build**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 5: 浏览器验证**

启动前端 dev server（如果 Hub 后端已运行）：
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend && npm run dev &
sleep 5
```

打开浏览器到 `http://localhost:5174`（Vite 默认端口，可能与 Hub 后端 8080 不同；按 console 输出确认），以 admin 身份登录：

1. 左侧导航应能看到"Worker 技能市场 🌐"标签
2. "Skills 市场 📦"标签应改名为"企业技能包 📦"
3. 点击"Worker 技能市场" → 看到 `WorkerSkills` 页面（顶部蓝色 banner + Tabs + 搜索框）
4. 切到"已批准" Tab → 应看到现有的 2 个 skill（code-review、deep-research），如果看到说明 API + 前端联通
5. 控制台不应有报错（已知的 favicon/ResizeObserver 除外）

如果看不到 2 个 skill：
- 检查浏览器 devtools Network 标签的 `/api/v1/marketplace/admin/skills?status=approved` 请求
- 401 → token 没传，检查 localStorage `hub_access_token`
- 403 → 当前用户没有 `skill:approve` 权限或不是 super admin，换用户或在 DB 给当前用户加权限
- 500 → 检查 Hub 后端日志

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add frontend/src/App.tsx
git commit -m "feat(hub/admin): /worker-skills 路由 + nav 改名

- 现有 '/skills' 标签改名为'企业技能包'
- 新增'/worker-skills' Worker 技能市场标签
- 注册 WorkerSkills 页面到 ProtectedRoute"
```

---

## Task 8: 前端 Skills.tsx banner + promote 按钮

**Files:**
- Modify: `deepanalyze-hub/frontend/src/pages/Skills.tsx`

**Interfaces:**
- Consumes:
  - `api.promotePackageToMarketplace`（Task 5）
  - `useUIStore.showConfirm` / `addToast`
  - `MeResponse.is_super_admin`（通过 Skills 的 `user` prop）
  - `SkillPackageV2.is_kill_switched` / 现有 version 信息
- Produces: 在 Phase 2 Skills 页面顶部加说明 banner + 每张卡片加"推广到 Worker 市场"按钮（仅 super admin + package 非 killed 时可见）

**背景：** 这是跨系统推广的 UI 入口。让 super admin 在 Phase 2 Skills 页面看到好 skill 就能直接推广到 Phase 1，无需切到 admin API。

**重要约束：**
- `Skills` 组件当前签名是 `Skills({ user: _user })`，user 是 `_user`（被忽略）。本任务要把 `_user` 改成 `user` 并使用 `user.is_super_admin`
- 按钮可见条件：`user.is_super_admin && !pkg.is_kill_switched`
- 后端会校验 published 版本，前端不预先判断（如果 package 没 published 版本，后端返回 400，toast 错误信息）

- [ ] **Step 1: 改 Skills 组件签名，启用 user**

打开 `deepanalyze-hub/frontend/src/pages/Skills.tsx`，定位约行 52：

```typescript
export function Skills({ user: _user }: { user: MeResponse }) {
```

改为：

```typescript
export function Skills({ user }: { user: MeResponse }) {
```

在文件顶部 imports 追加：

```typescript
import { useUIStore } from "../store/ui.js";
```

在组件内部（约行 53 之后）加：

```typescript
  const showConfirm = useUIStore((s) => s.showConfirm);
  const addToast = useUIStore((s) => s.addToast);

  /* -- promote Phase 2 → Phase 1 -- */

  const handlePromote = async (pkg: SkillPackageV2) => {
    const ok = await showConfirm({
      title: "推广到 Worker 市场",
      message: `将 "${pkg.name}" 推广到 DA Worker 市场？\n\n所有连接的 DA Worker 将能下载安装。`,
      confirmText: "确认推广",
    });
    if (!ok) return;
    try {
      const result = await api.promotePackageToMarketplace(pkg.id);
      addToast({
        variant: "success",
        message: `已推广到 Worker 市场（${result.skill.slug} v${result.skill.version}）`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "推广失败";
      addToast({ variant: "error", message: msg });
    }
  };
```

- [ ] **Step 2: 在页面顶部加说明 banner**

定位 `return (...)` 内的最外层 `<div>`，在它之后、第一个内容之前，插入 banner：

```tsx
      <div
        style={{
          padding: "var(--space-4) var(--space-5)",
          marginBottom: "var(--space-4)",
          background: "var(--info-light, #e7f1ff)",
          borderLeft: "3px solid var(--info, #2196f3)",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--text-sm)",
        }}
      >
        本页管理 <strong>企业内部技能包</strong>（多租户订阅制，供企业内部用户使用）。
        如需管理 <strong>DA Worker</strong> 可下载安装的全局 skill，请前往{" "}
        <a
          href="/worker-skills"
          style={{ color: "var(--info, #2196f3)", textDecoration: "underline" }}
        >
          Worker 技能市场
        </a>
        。
      </div>
```

- [ ] **Step 3: 在 SkillCard 上加 promote 按钮**

定位渲染 `SkillCard` 的位置（搜 `SkillCard` 或 `toCardData`）。当前页面用 `SkillCard` 组件渲染卡片，但 promote 按钮需要附加在每张卡片上。

**先 Read** `../components/hub/SkillCard.tsx` 检查 `SkillCard` 是否支持 `actions` 或 `extra` slot prop。如果支持，传 `actions` JSX；如果不支持，把 `<SkillCard>` 包裹一个外层 `<div>`，按钮放在 `<SkillCard>` 下方。

假设 SkillCard 不支持 actions slot（按 Read 结果调整），改为在卡片网格里给每张卡片加一个 wrapper：

```tsx
{packages.map((pkg) => (
  <div key={pkg.id} style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
    <SkillCard data={toCardData(pkg)} />
    {user.is_super_admin && !pkg.is_kill_switched && (
      <Button
        size="sm"
        variant="primary"
        onClick={() => handlePromote(pkg)}
      >
        推广到 Worker 市场
      </Button>
    )}
  </div>
))}
```

如果 SkillCard 支持 actions slot，按实际签名传：
```tsx
<SkillCard data={toCardData(pkg)} actions={...} />
```

按 Read 结果决定。

- [ ] **Step 4: Typecheck**

Run:
```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 5: 浏览器验证**

重启前端（或等 Vite HMR）：

1. 访问 `/skills`（企业技能包）→ 顶部应出现蓝色 banner，含"Worker 技能市场"链接，点链接跳转 `/worker-skills`
2. 以 super admin 身份登录 → 每张非 killed 的 package 卡片下方应出现"推广到 Worker 市场"按钮
3. 点击按钮 → 弹 confirm dialog → 确认 → toast 显示"已推广到 Worker 市场（slug vX.Y.Z）"
4. 切到 `/worker-skills` 已批准 Tab → 应看到刚推广的 skill，带"🔗 源自企业包"标记
5. 非 super admin 登录 → 按钮不出现（验证权限隔离）

错误场景验证：
- 推广一个无 published 版本的 package → toast 显示 "HTTP 400: Package has no published version"
- 推广一个 killed package → 按钮不可见（前端已隐藏），如果通过 API 调用应得到 400
- 重复推广（slug 已存在）→ toast 显示 "HTTP 409: Slug '...' already exists..."

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add frontend/src/pages/Skills.tsx
git commit -m "feat(hub/admin): Skills 页加 banner + 推广按钮

- 顶部 banner 说明企业技能包定位，链接到 /worker-skills
- super admin 视角下非 killed package 显示'推广到 Worker 市场'按钮
- 调 api.promotePackageToMarketplace + 成功/失败 toast"
```

---

## Task 9: 端到端集成验证

**Files:**
- 无修改；纯验证任务

**背景：** 前面 8 个任务每个都做了局部验证，本任务做端到端：所有功能联动验证一遍，确保符合 spec 的成功标准。

- [ ] **Step 1: 跑 typecheck（前后端）**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run typecheck && cd frontend && npx tsc --noEmit
```

Expected: 两端都 0 errors

- [ ] **Step 2: 重启 Hub 全栈**

```bash
pkill -f "bun.*src/main.ts" 2>/dev/null; sleep 1
cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/main.ts &
sleep 3
# 前端 HMR 应自动重载；如果开发模式没起前端：
cd frontend && npm run dev &
sleep 5
```

- [ ] **Step 3: 安全验证 — admin 端点无 token 全部 401**

```bash
for ep in \
  "GET /api/v1/marketplace/admin/skills" \
  "POST /api/v1/marketplace/admin/skills/fake/approve" \
  "POST /api/v1/marketplace/admin/skills/fake/reject" \
  "POST /api/v1/marketplace/admin/skills/fake/deprecate" \
  "DELETE /api/v1/marketplace/admin/skills/fake" \
  "POST /api/v1/marketplace/admin/promote"; do
  method=$(echo $ep | cut -d' ' -f1)
  path=$(echo $ep | cut -d' ' -f2)
  code=$(curl -sS -X $method "http://localhost:8080${path}" \
    -H "Content-Type: application/json" \
    -d '{"reason":"x","packageId":"x"}' \
    -o /dev/null -w "%{http_code}")
  echo "$ep → $code"
done
```

Expected: 全部 → `401`

如果有任何一个不是 401（特别是 200/404），说明 Task 2 的 `app.use("/admin/*", ...)` 没生效，回去检查。

- [ ] **Step 4: 浏览器端到端（admin 视角）**

以 super admin 登录 Hub 前端，按顺序验证：

1. **导航验证**：左侧导航包含"企业技能包 📦"（改名）和"Worker 技能市场 🌐"（新增）
2. **Skills 页面 banner**：点击"企业技能包"→ 顶部出现蓝色 banner，含"Worker 技能市场"链接
3. **跨系统推广**：
   - 在"企业技能包"找一个非 killed 的 package
   - super admin 视角下卡片下方应出现"推广到 Worker 市场"按钮
   - 点击 → confirm → 确认 → 成功 toast
   - 切到"Worker 技能市场"已批准 Tab → 看到刚推广的 skill + "🔗 源自企业包"标记
4. **DA Worker 视角验证**：
   - 打开 DA 前端（`http://localhost:21000` 或 `http://localhost:5173`）
   - 进入一个 session → 切到右侧"资源市场"面板
   - 应能看到刚推广的 skill（因为 Phase 1 marketplace_skills 表新增了一行 approved）
5. **状态机验证**（如果有 pending skill）：
   - 切到"待审核" Tab
   - 点批准 → confirm → 卡片消失 → 切"已批准"看到
   - 点下架 → ReasonDialog → 输入原因 → 提交 → 卡片消失 → 切"已弃用"看到
   - 在"已拒绝"找一个 → 点删除 → 强 confirm → 确认 → 卡片消失
6. **错误场景**：
   - 推广一个 slug 已存在的 package → 失败 toast "HTTP 409: Slug '...' already exists"
   - 推广 killed package → 按钮不可见（前端隐藏）
   - 双击批准 → 第二次卡片已消失，不会出错
7. **权限隔离**：
   - 退出，用非 super admin 用户登录
   - 访问 `/worker-skills` → 页面加载，但 API 返回 403 → 前端显示错误 banner
   - 访问 `/skills` → 卡片下方不应出现"推广"按钮

- [ ] **Step 5: 数据一致性检查**

```bash
psql -h localhost -U deepanalyze -d deepanalyze -c "
SELECT review_status, COUNT(*) FROM marketplace_skills GROUP BY review_status;
"
```

Expected: 数字与 UI 各 Tab 显示一致

```bash
psql -h localhost -U deepanalyze -d deepanalyze -c "
SELECT slug, name, version, source_package_id IS NOT NULL AS from_promote
FROM marketplace_skills WHERE review_status = 'approved';
"
```

Expected: 推广来的 skill 行 `from_promote = t`，原生 submit 的为 `f`

- [ ] **Step 6: 日志检查**

检查 Hub 后端日志（启动 Hub 的终端输出或 `/tmp/da_debug*.log`）：
- 不应有未捕获的 ERROR/Uncaught exception
- 可接受的 WARNING：401/403 路径上的（来自 curl 探测）
- promote 操作应留下 INSERT 成功的痕迹（如果有 DB log）

- [ ] **Step 7: 不提交（本任务是验证）**

不需要 commit。如果有发现 bug，开新分支或回到对应 Task 修复后重新走该 Task 的 commit step。

---

## Self-Review Checklist

完成本计划后，对照 spec 自查：

- [x] **Spec 覆盖**：
  - 安全修复 → Task 2
  - list 端点扩展（search/limit/offset） → Task 2
  - approve/reject 真实 userId → Task 2
  - deprecate 端点 → Task 3
  - delete 端点 → Task 3
  - promote 端点 → Task 4
  - source_package_id/source_version_id 列 → Task 1
  - AdminSkill 类型 + API methods → Task 5
  - WorkerSkills 页面 → Task 6
  - nav 改名 + 路由 → Task 7
  - Skills.tsx banner → Task 8
  - Skills.tsx promote 按钮 → Task 8
  - 端到端验证 → Task 9
  - 状态机保护 → Task 2/3/4 的 SQL 都有 `WHERE review_status = X`
  - slug 冲突 409 → Task 4
  - super_admin 检查 → Task 8 用 `user.is_super_admin`
- [x] **Placeholder 扫描**：每个 step 都有完整代码块或具体命令；无 TBD/TODO
- [x] **类型一致性**：`AdminSkill` 字段名在 Task 5（定义）和 Task 6（消费）一致（snake_case，因为后端返回 pg 行原样，没做 camelCase 转换）
- [x] **权限码一致**：`skill:approve` 在所有 admin 端点和 UI 按钮校验都用同一个
