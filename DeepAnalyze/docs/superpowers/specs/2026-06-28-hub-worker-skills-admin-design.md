# Hub Worker 技能市场管理设计（Phase 1 Marketplace Admin）

**日期：** 2026-06-28
**作者：** Claude（经 brainstorming 流程）
**状态：** 设计已审核，待制定实施计划
**关联：** 与 `2026-06-27-marketplace-browse-experience-design.md` 互补——前者是 DA Worker 端的浏览体验，本设计是 Hub Admin 端的管理体验

## 背景与动机

DA Worker 通过 `MarketplacePanel` 从 Hub 拉取并安装 skill。这条链路对应 Hub 后端的 `marketplace_skills` 表（Phase 1），目前已有 2 个 approved skill（`code-review`、`deep-research`）。

当前存在三个问题：

1. **没有管理界面**：Hub Admin 前端没有任何页面消费 `/api/v1/marketplace/admin/*` 接口。管理员无法看到哪些 skill 被 submit、无法 approve/reject、无法下架。skill 的批准需要直接操作数据库或调用裸 API，这不可持续。

2. **混淆 Phase 1 和 Phase 2**：Hub 现有两套并行的 skill 系统（详见下表），现有导航标签 "Skills 市场" 只展示 Phase 2。用户看到 24 个测试包时无法判断它们是不是 DA 可见的，造成"绕晕了"的体验。

3. **Admin 端点裸奔**：`/api/v1/marketplace/admin/*` 三个端点完全没有任何 auth 中间件（对比：`/skills/submit` 有 `workerAuth`，Phase 2 全部路由有 `jwtAuth + requirePermission`）。任何能访问 Hub 的人都能直接 approve/reject skill，这是安全漏洞。

| 系统 | 表 | 用途 | 消费者 | 当前数据 |
|------|-----|------|--------|---------|
| **Phase 1 Marketplace** | `marketplace_skills` | 全局 skill 共享给 DA Worker 下载安装 | DA Worker（`MarketplacePanel`） | 2 approved |
| **Phase 2 Enterprise Skills** | `skill_packages` + `skill_versions` + `skill_subscriptions` | 企业多租户技能包（订阅、kill switch、跨组织共享、灰度） | Hub 内部企业用户 | 24（e2e 测试遗留） |

### 24 个 Phase 2 测试包的真相

它们是 **Phase 2/3/4 e2e 测试运行的遗留垃圾**——每次跑测试就插入新的 `skill_packages` 行，没有清理逻辑。它们：

- **与 DA 无关**：DA 完全不读 `skill_packages` 表
- **不是测试数据**：是测试**遗留垃圾**，应该清理
- **不属于本次设计范围**：清理是一个独立的 maintenance 任务，本设计只在 UI 加说明文字消除混淆

## 设计目标

| 目标 | 含义 |
|------|------|
| 可视化管理 | Hub Admin 能在界面上完成 approve/reject/deprecate/delete |
| 状态全可见 | pending/approved/rejected/deprecated 四种状态都有专属视图 |
| 消除混淆 | 用户一眼就知道两个 skill 页面分别管理什么 |
| 安全收口 | Admin 端点全部走 `jwtAuth + requirePermission("skill:approve")` |
| 审计可追溯 | 真实审核人 ID 写入 `reviewer_id`，不再硬编码 `'system'` |
| 复用现有组件 | 不重复造 UI 组件，复用 `WorkerApproval` 的 list+action 模式 |

## 架构与数据流

```
Hub Admin 登录
  ↓
访问 /worker-skills（待审核 Tab 默认）
  ↓
GET /api/v1/marketplace/admin/skills?status=pending
    (jwtAuth + requirePermission("skill:approve"))
  ↓
渲染卡片列表，每张卡片显示 name/slug/description/prompt 预览/作者/提交时间

Admin 点击"批准"
  ↓
POST /api/v1/marketplace/admin/skills/:id/approve
  ↓
UPDATE marketplace_skills SET review_status='approved', reviewer_id=<真实userId>,
                              published_at=now(), updated_at=now()
  ↓
DA Worker 下次拉取（GET /api/v1/marketplace/skills，只看 approved）
  ↓
新 skill 自动出现在 DA 的 MarketplacePanel，可安装

Admin 点击"下架"（deprecated）
  ↓
POST /api/v1/marketplace/admin/skills/:id/deprecate { reason }
  ↓
UPDATE marketplace_skills SET review_status='deprecated', reviewer_id=<userId>,
                              review_notes=<reason>
  ↓
DA Worker 不再看到该 skill（已下载的 DA 实例本地缓存继续可用，符合预期）
```

## 后端设计

### 安全修复（关键，必做）

**文件：** `deepanalyze-hub/src/server/routes/marketplace.ts`

在 `createMarketplaceRoutes()` 顶部统一应用认证中间件到所有 `/admin/*` 路由：

```typescript
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";

// 在 createMarketplaceRoutes() 内、所有 app.get/app.post 之前
app.use("/admin/*", jwtAuth, requirePermission("skill:approve"));
```

这覆盖现有 3 个 admin 路由（list/approve/reject）以及新增的 deprecate/delete。权限码 `skill:approve` 已存在于 `ADMIN_PRIVILEGE_CODES`（`require-permission.ts:14`），且 write-scope API key 已被自动阻止执行此权限。

### 现有端点改造

#### `/admin/skills` (GET) —— 列表

扩展为支持搜索 + 分页（向后兼容）：

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

  const { rows } = await query(
    `SELECT id, slug, name, description, prompt, tools, model_role, tags, version,
            review_status, reviewer_id, review_notes, submitter_id,
            download_count, rating_avg, review_count, published_at, created_at, updated_at
     FROM marketplace_skills ${whereClause}
     ORDER BY ${status === "pending" ? "created_at ASC" : "created_at DESC"}
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );

  return c.json({ skills: rows, total, limit, offset });
});
```

**关键设计决策：**
- `status=pending` 时按 `created_at ASC`（最早提交的最先审核），其他状态按 `DESC`（最新变更的在前）
- 返回结构保持 `{ skills, ... }`，新增 `total/limit/offset` 字段不破坏现有消费者（无消费者）
- 返回完整的 `prompt/tools/tags` 等字段，便于 admin 在列表里直接预览无需跳详情页

#### `/admin/skills/:id/approve` (POST) —— 批准

改造：`reviewer_id` 从硬编码 `'system'` 改为真实 `userId`：

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
  if (rows.length === 0) return c.json({ error: "Skill not found or not in pending status" }, 404);
  return c.json({ success: true, skill: rows[0] });
});
```

#### `/admin/skills/:id/reject` (POST) —— 拒绝

同样改 `reviewer_id` 为真实 `userId`：

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
  if (rows.length === 0) return c.json({ error: "Skill not found or not in pending status" }, 404);
  return c.json({ success: true, skill: rows[0] });
});
```

### 新增端点

#### `/admin/skills/:id/deprecate` (POST) —— 下架

approved → deprecated。已下载的 DA 实例本地缓存继续可用，但 DA 不再看到该 skill。

```typescript
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
```

#### `/admin/skills/:id` (DELETE) —— 硬删除

仅允许 pending/rejected 状态的 skill 被硬删除（用于清理 spam/测试垃圾）。approved 必须先 deprecate 才能走下一步——这是有意为之的状态机约束。

```typescript
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

### 状态机

```
                ┌──────────────────────── submit
                ▼
            ┌─────────┐  approve   ┌──────────┐
            │ pending │ ─────────► │ approved │
            └─────────┘            └──────────┘
                │                       │
                │ reject                │ deprecate
                ▼                       ▼
            ┌──────────┐            ┌─────────────┐
            │ rejected │            │ deprecated  │
            └──────────┘            └─────────────┘
                │                       │
                │ DELETE                │ (无法直接 DELETE，先 reject 再 DELETE 路径不存在；
                ▼                       │  deprecated 状态保留历史，不可恢复为 approved）
            [删除]                      │
                                       ▼
                                  （保留为历史记录）
```

**约束：**
- `deprecated` 不可恢复为 `approved`（YAGNI：如需重新上线，作者重新 submit）
- `rejected` 可以被 DELETE（清理 spam/无用 submission）
- `approved` 必须 deprecate 后才能...实际上 deprecated 也不能 DELETE，所以 approved 走 deprecate 后是永久保留
- 所有状态转换都通过 `WHERE review_status = X` 做并发保护，避免双击造成中间状态

## 前端设计

### 新建 `/worker-skills` 页面

**文件（新建）：** `deepanalyze-hub/frontend/src/pages/WorkerSkills.tsx`

复用 `WorkerApproval.tsx` 的 list+action 模式（已验证的范式）+ `Skills.tsx` 的卡片网格。

```tsx
export function WorkerSkillsPage() {
  const [tab, setTab] = useState<"pending"|"approved"|"rejected"|"deprecated"|"all">("pending");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");  // 300ms debounce
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showConfirm, addToast } = useUIStore();

  // 列表加载
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await marketplaceAdminApi.list({
        status: tab,
        search: debouncedSearch,
        limit: 100,
      });
      setSkills(res.skills);
      setCounts(prev => ({ ...prev, [tab]: res.total }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [tab, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  // 各操作（approve/reject/deprecate/remove）都先 showConfirm，确认后调用 API、刷新列表、addToast
  const handleApprove = async (id: string, name: string) => {
    const ok = await showConfirm({
      title: "批准 Skill",
      message: `确认批准 "${name}"？批准后所有连接的 DA Worker 都能下载安装。`,
      confirmText: "批准",
    });
    if (!ok) return;
    await marketplaceAdminApi.approve(id);
    addToast({ variant: "success", message: `已批准 ${name}` });
    await load();
  };

  // reject/deprecate 需要带 reason：用本地 state 控制 ReasonDialog 的显示，
  // 复用现有 Modal + TextArea 组件，提交时调 API
  const [reasonDialog, setReasonDialog] = useState<{
    kind: "reject" | "deprecate";
    skill: AdminSkill;
  } | null>(null);

  const handleSubmitReason = async (reason: string) => {
    if (!reasonDialog) return;
    const { kind, skill } = reasonDialog;
    if (kind === "reject") {
      await marketplaceAdminApi.reject(skill.id, reason);
      addToast({ variant: "success", message: `已拒绝 ${skill.name}` });
    } else {
      await marketplaceAdminApi.deprecate(skill.id, reason);
      addToast({ variant: "warning", message: `已下架 ${skill.name}` });
    }
    setReasonDialog(null);
    await load();
  };

  // remove 强制确认两次（showConfirm 标题里显示 skill 名）
  const handleRemove = async (id: string, name: string) => {
    const ok = await showConfirm({
      title: "永久删除 Skill",
      message: `确认永久删除 "${name}"？此操作不可恢复。仅建议对 spam 或测试垃圾使用。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    await marketplaceAdminApi.remove(id);
    addToast({ variant: "success", message: `已删除 ${name}` });
    await load();
  };

  return (
    <div style={pageStyle}>
      {/* 解释条幅——用 inline 样式（参考 WorkerApproval.tsx 的 banner 模式，不新建组件；
          Hub 现有页面都用 CSSProperties + CSS variables，不引入 PageLayout 抽象） */}
      <div style={{
        padding: "var(--space-4) var(--space-5)",
        marginBottom: "var(--space-4)",
        background: "var(--info-light, #e7f1ff)",
        borderLeft: `3px solid var(--info, #2196f3)`,
        borderRadius: "var(--radius-md)",
        fontSize: "var(--text-sm)",
      }}>
        管理 DA Worker 可下载安装的 Skill。批准后，所有连接的 DA Worker 都能在"资源市场"面板看到并安装。
        与 <Link to="/skills">企业技能包</Link>（多租户订阅制）不同。
      </div>

      {reasonDialog && (
        <ReasonDialog
          kind={reasonDialog.kind}
          skillName={reasonDialog.skill.name}
          onSubmit={handleSubmitReason}
          onCancel={() => setReasonDialog(null)}
        />
      )}

      <Tabs value={tab} onChange={setTab}>
        <Tab value="pending">待审核 {counts.pending && `(${counts.pending})`}</Tab>
        <Tab value="approved">已批准 {counts.approved && `(${counts.approved})`}</Tab>
        <Tab value="rejected">已拒绝</Tab>
        <Tab value="deprecated">已弃用</Tab>
        <Tab value="all">全部</Tab>
      </Tabs>

      <SearchBar value={search} onChange={setSearch} placeholder="搜索 name / slug / description" />

      {error && <ErrorBanner>{error} <RetryButton onClick={load}>重试</RetryButton></ErrorBanner>}

      {loading ? <Spinner /> :
        skills.length === 0 ? <EmptyState message={emptyMessageFor(tab)} /> :
        <SkillsGrid>
          {skills.map(s => (
            <AdminSkillCard key={s.id} skill={s}>
              <CardHeader>
                <CardTitle>{s.name}</CardTitle>
                <StatusBadge status={s.reviewStatus} />
              </CardHeader>
              <CardMeta>by {s.submitterId} · v{s.version} · 提交于 {formatDate(s.createdAt)}</CardMeta>
              <CardDescription>{s.description}</CardDescription>
              <PromptPreview prompt={s.prompt} maxLines={3} />
              {s.tags && s.tags.length > 0 && <TagList tags={s.tags} />}
              {s.reviewNotes && <ReviewNote>审核备注：{s.reviewNotes}</ReviewNote>}
              <CardStats>
                <Stat label="下载" value={s.downloadCount} />
                <Stat label="评分" value={Number(s.ratingAvg).toFixed(1)} />
              </CardStats>
              <ActionsByStatus skill={s} onApprove={...} onReject={...} onDeprecate={...} onRemove={...} />
            </AdminSkillCard>
          ))}
        </SkillsGrid>
      }
    </div>
  );
}
```

**按状态显示的操作按钮：**

| 状态 | 按钮 |
|------|------|
| pending | [批准] [拒绝（带原因）] |
| approved | [下架（带原因）] |
| rejected | [删除（强确认）] |
| deprecated | （无操作，仅历史展示） |

### 注册路由 + 导航

**修改 `deepanalyze-hub/frontend/src/App.tsx`：**

```typescript
const NAV_ITEMS = [
  { to: "/", label: "仪表盘", icon: "📊" },
  { to: "/orgs", label: "组织树", icon: "🏢" },
  { to: "/users", label: "用户", icon: "👥" },
  { to: "/skills", label: "企业技能包", icon: "📦" },             // ← 改名（原 "Skills 市场"）
  { to: "/worker-skills", label: "Worker 技能市场", icon: "🌐" }, // ← 新增
  { to: "/sharings", label: "跨组织共享", icon: "🔄" },
  { to: "/workers", label: "Worker 审批", icon: "🖥️" },
  { to: "/security", label: "安全网关", icon: "🛡️" },
] as const;
```

**修改 `App.tsx` 的路由注册部分，新增：**

```tsx
<Route path="/worker-skills" element={
  <ProtectedRoute><WorkerSkillsPage /></ProtectedRoute>
} />
```

`ProtectedRoute` 已存在（仅校验 token 有效性），权限检查在 API 层强制（401/403 时前端展示友好错误）。

### API 客户端封装

**新增 `deepanalyze-hub/frontend/src/api/marketplace-admin.ts`：**

```typescript
import { apiFetch } from "./client";  // 复用现有 fetch 封装，自动带 token

export interface AdminSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  modelRole: string;
  tags: string[];
  version: string;
  reviewStatus: "pending" | "approved" | "rejected" | "deprecated";
  reviewerId: string | null;
  reviewNotes: string | null;
  submitterId: string;
  downloadCount: number;
  ratingAvg: string | number;  // NUMERIC 返回为 string，前端用 Number() 转
  reviewCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const marketplaceAdminApi = {
  list: (params: { status?: string; search?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.search) qs.set("search", params.search);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return apiFetch<{ skills: AdminSkill[]; total: number; limit: number; offset: number }>(
      `/api/v1/marketplace/admin/skills?${qs}`,
    );
  },
  approve: (id: string) =>
    apiFetch<{ success: true; skill: { id: string; slug: string; name: string } }>(
      `/api/v1/marketplace/admin/skills/${id}/approve`,
      { method: "POST" },
    ),
  reject: (id: string, reason: string) =>
    apiFetch(`/api/v1/marketplace/admin/skills/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  deprecate: (id: string, reason: string) =>
    apiFetch(`/api/v1/marketplace/admin/skills/${id}/deprecate`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  remove: (id: string) =>
    apiFetch(`/api/v1/marketplace/admin/skills/${id}`, { method: "DELETE" }),
};
```

### 企业技能包页面加澄清提示（消除遗留混淆）

**修改 `deepanalyze-hub/frontend/src/pages/Skills.tsx`：**

在页面顶部加轻量提示条（用 inline 样式，参考 WorkerApproval.tsx 的 banner 模式，不新建组件）：

```tsx
<div style={{
  padding: "var(--space-4) var(--space-5)",
  marginBottom: "var(--space-4)",
  background: "var(--info-light, #e7f1ff)",
  borderLeft: "3px solid var(--info, #2196f3)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-sm)",
}}>
  本页管理 <strong>企业内部技能包</strong>（多租户订阅制，供企业内部用户使用）。
  如需管理 <strong>DA Worker</strong> 可下载安装的全局 skill，请前往
  <Link to="/worker-skills">Worker 技能市场</Link>。
</div>
```

这条提示一次性把两套系统的关系讲清楚，新 admin 用户不会再次被绕晕。

## 跨系统推广（Phase 2 → Phase 1）

### 设计目标

让系统管理员把 Phase 2 企业技能包里成熟稳定的 skill **复制**到 Phase 1 Worker 市场，使所有连接的 DA Worker 能下载安装。这是单向、一次性快照复制，不做自动同步。

### 数据流

```
Admin 在 Phase 2 /skills 页面找到好 skill
  ↓ 点击"推广到 Worker 市场"
POST /api/v1/marketplace/admin/promote  { packageId }
  (jwtAuth + requirePermission("skill:approve"))
  ↓
后端读 skill_packages + skill_versions（最新 published 版本）
  ↓
字段映射 → INSERT 到 marketplace_skills（review_status='approved'）
  ↓
DA Worker 下次拉取 → 自动看到新 skill
```

### 字段映射

Phase 2 字段比 Phase 1 多（多版本、订阅、灰度），复制时做减法：

| Phase 1 字段 | 来源 |
|------|------|
| `id` | 新生成的 UUID |
| `slug` | package.slug（**冲突时报错**，见决策 3） |
| `name` | package.name |
| `description` | package.description |
| `prompt` | 最新 `published` 版本的 prompt 字段 |
| `tools` | 最新 `published` 版本的 tools |
| `model_role` | 最新 `published` 版本的 model_role（无则 `'main'`） |
| `anti_hallucination_level` | 最新 `published` 版本（无则 null） |
| `tags` | package.tags |
| `version` | 最新 `published` 版本的 version 字符串（如 `1.2.0`） |
| `submitter_id` | 操作的 admin userId（审计） |
| `reviewer_id` | 同 admin userId（自我批准） |
| `review_status` | `approved`（admin 推广即上线，不走 pending，见决策 1） |
| `published_at` | now() |
| `compatibility` | 最新 `published` 版本的 compatibility JSON（无则默认 `{minVersion: "0.1.0"}`） |
| `source_package_id` | **新增字段**，记录溯源（见决策 2） |
| `source_version_id` | **新增字段**，记录推广时复制的具体版本 |

### 后端实现

#### 新增 migration（溯源列）

**新建 `deepanalyze-hub/src/store/migrations/018_marketplace_source_cols.ts`：**

```typescript
export const migration = {
  version: 18,
  name: "marketplace_source_cols",
  sql: `
ALTER TABLE marketplace_skills
  ADD COLUMN IF NOT EXISTS source_package_id TEXT,
  ADD COLUMN IF NOT EXISTS source_version_id TEXT;
`,
};
```

在 `src/store/migrations/index.ts` 追加注册。

#### 新增 promote 端点

**修改 `deepanalyze-hub/src/server/routes/marketplace.ts`，新增：**

```typescript
app.post("/admin/promote", async (c) => {
  const body = await c.req.json<{ packageId: string }>();
  const adminId = c.get("userId") as string;

  if (!body.packageId) return c.json({ error: "packageId is required" }, 400);

  // 1. 读 package
  const pkgRes = await query(
    `SELECT id, slug, name, description, tags FROM skill_packages WHERE id = $1`,
    [body.packageId],
  );
  if (pkgRes.rows.length === 0) return c.json({ error: "Package not found" }, 404);
  const pkg = pkgRes.rows[0];

  // 2. 读最新 published 版本
  const verRes = await query(
    `SELECT id, version_string, prompt, tools, model_role, anti_hallucination_level,
            compatibility
     FROM skill_versions
     WHERE package_id = $1 AND status = 'published'
     ORDER BY created_at DESC LIMIT 1`,
    [body.packageId],
  );
  if (verRes.rows.length === 0) {
    return c.json({ error: "Package has no published version" }, 400);
  }
  const ver = verRes.rows[0];

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

  // 4. INSERT 到 marketplace_skills
  const newId = randomUUID();
  await query(
    `INSERT INTO marketplace_skills
      (id, slug, name, description, prompt, tools, model_role, anti_hallucination_level,
       tags, version, submitter_id, reviewer_id, review_status, published_at,
       compatibility, source_package_id, source_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'approved', now(), $13, $14, $15)`,
    [
      newId, pkg.slug, pkg.name, pkg.description || "",
      ver.prompt, ver.tools || ["*"], ver.model_role || "main",
      ver.anti_hallucination_level ?? null,
      pkg.tags || [], ver.version_string,
      adminId, adminId,
      JSON.stringify(ver.compatibility ?? { minVersion: "0.1.0" }),
      pkg.id, ver.id,
    ],
  );

  return c.json({
    success: true,
    skill: { id: newId, slug: pkg.slug, name: pkg.name, version: ver.version_string },
  });
});
```

注意 `app.use("/admin/*", jwtAuth, requirePermission("skill:approve"))` 已覆盖此路由。

### 前端实现

#### Phase 2 `/skills` 页面加"推广"按钮

**修改 `deepanalyze-hub/frontend/src/pages/Skills.tsx`：**

在每张 package 卡片的 actions 区加按钮：

```tsx
{isSuperAdmin && pkg.latestVersion?.status === "published" && (
  <Button
    variant="primary"
    size="sm"
    onClick={() => handlePromote(pkg)}
  >
    推广到 Worker 市场
  </Button>
)}
```

`isSuperAdmin` 从现有 auth store 取。`pkg.latestVersion` 取最新 published 版本（已有逻辑）。

按钮可见条件：
- 当前用户是 super admin（避免普通企业用户误操作）
- package 至少有一个 published 版本（没有 published 则按钮不显示，因为没法复制）

`handlePromote` 实现：

```typescript
const handlePromote = async (pkg: SkillPackage) => {
  const ok = await showConfirm({
    title: "推广到 Worker 市场",
    message: `将 "${pkg.name}" (v${pkg.latestVersion.versionString}) 推广到 DA Worker 市场？\n\n所有连接的 DA Worker 将能下载安装。`,
    confirmText: "确认推广",
  });
  if (!ok) return;

  try {
    const result = await marketplaceAdminApi.promote(pkg.id);
    addToast({
      variant: "success",
      message: `已推广到 Worker 市场`,
      action: { label: "查看", to: `/worker-skills` },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "推广失败";
    addToast({ variant: "error", message: msg });
  }
};
```

#### API 客户端

**修改 `deepanalyze-hub/frontend/src/api/marketplace-admin.ts`，新增：**

```typescript
promote: (packageId: string) =>
  apiFetch<{ success: true; skill: { id: string; slug: string; name: string; version: string } }>(
    "/api/v1/marketplace/admin/promote",
    { method: "POST", body: JSON.stringify({ packageId }) },
  ),
```

### 同步策略

**一次性快照，不做自动同步。**

- Phase 2 后续版本演进（canary/published 更新）**不会**自动反映到 Phase 1
- admin 想更新 Phase 1 副本：先在 `/worker-skills` 把旧的 deprecate → 再回到 `/skills` 重新推广（slug 冲突时 admin 需要先在 Phase 2 改名或先 DELETE 旧条目）
- 自动同步会引入"Phase 2 灰度变更瞬间影响所有 DA Worker"的不可控风险，YAGNI

### 状态机扩展

推广后产生的 `marketplace_skills` 行进入正常 Phase 1 状态机（approved → deprecated），但带 `source_package_id` 溯源。在 `/worker-skills` 详情卡片上展示：

```
🔗 源自企业包：code-review (v1.2.0)
```

帮助 admin 识别哪些 skill 是推广来的、来自哪里。

### 边界情况（推广专属）

| 场景 | 行为 |
|------|------|
| 推广一个没有 published 版本的 package | 返回 400 "Package has no published version" |
| 推广时 slug 已存在于 Phase 1 | 返回 409，提示 admin 处理冲突 |
| 推广的 package 处于 killed 状态 | 后端校验：`pkg.status = 'killed'` 时返回 400 "Package is killed, cannot promote" |
| 同一 package 重复推广 | 不阻止（每次 INSERT 新行），但 slug 冲突会自动拦截；admin 应先 deprecate 旧推广 |
| Phase 2 源包被删除 | Phase 1 副本不受影响（独立行）；溯源列指向已不存在的 package（弱关联） |
| 推广一个 org-scoped 为 private 的 package | super admin 可见即可推广（super admin 跨 org 是预期行为） |

## 复用的现有能力

- `WorkerApproval.tsx` 的 list+action 模式（已验证的范式）
- `Skills.tsx` 的卡片网格 + SearchBar 模式
- `useUIStore` 的 `showConfirm` / `addToast` 钩子
- `ProtectedRoute` 路由守卫
- `jwtAuth` + `requirePermission` 中间件（已实现，已包含 write-scope API key 阻止逻辑）
- 权限码 `skill:approve`（已存在于 `ADMIN_PRIVILEGE_CODES`）
- `apiFetch` 封装（自动带 token、处理 401 重定向）

## 边界情况

| 场景 | 行为 |
|------|------|
| Worker 通过 `/skills/submit` 提交新 skill | review_status=pending，admin 在"待审核" Tab 看到 |
| Admin 批准 pending skill | status→approved，立即对 DA 可见 |
| Admin 拒绝 pending skill | status→rejected，review_notes 记录原因 |
| Admin 弃用 approved skill | status→deprecated，DA 不再看到；已下载的 DA 实例继续可用（本地缓存） |
| Admin 删除 rejected skill | 硬删除，列表消失；不可恢复 |
| 同一 skill 被 admin 同时操作（双击/双 admin） | UPDATE WHERE review_status=X 保护，第二次操作返回 404 |
| 非 admin 用户访问 /admin/* | 401（无 token）或 403（无 permission） |
| 非 admin 用户访问 /worker-skills 页面 | 页面加载，但 API 返回 403，前端展示错误 banner |
| search 含特殊字符 | 参数化查询，无 SQL 注入 |
| search 匹配 0 条 | 显示空状态："未找到匹配的 skill" |
| 同一 skill 在多 Tab 都计数 | 只在 active Tab 计数；切换 Tab 时重新拉取 total |
| admin 同时开两个浏览器操作 | SQL `WHERE review_status=X` 保护，先到的成功，后到的 404 |

## 性能考量

| 关注点 | 决策 |
|--------|------|
| 列表分页 | limit 默认 50，最大 200；本期只有 2 个 skill，全量返回；上限保护未来 |
| 搜索响应 | 后端 ILIKE + 索引（已有 `idx_marketplace_skills_status`）；前端 300ms debounce |
| `pending` 状态排序 | 按 `created_at ASC`（FIFO），管理员看到最早提交的最先 |
| 其他状态排序 | 按 `created_at DESC`（最新变更的在前） |
| Tab 切换 | 重新拉取，不缓存（数据量小，避免缓存一致性问题） |
| `counts` 缓存 | 仅缓存当前 active Tab 的 count（切换 Tab 时不预先拉其他 Tab，避免 N 次预拉） |

## 安全考量

1. **修裸奔漏洞（关键）**：所有 `/admin/*` 端点加 `jwtAuth + requirePermission("skill:approve")`
2. **write-scope API key 自动阻止**：`skill:approve` 已在 `ADMIN_PRIVILEGE_CODES`，write-scope key 调用返回 403
3. **reviewer_id 审计**：从硬编码 `'system'` 改为真实 `userId`，每次操作留下真实审核人
4. **删除保护**：`DELETE` 仅允许 pending/rejected 状态；approved 必须先 deprecate
5. **deprecated 不可恢复**（YAGNI）：避免状态机过度复杂；如需重新上线作者重新 submit
6. **SQL 注入**：所有用户输入（search/status）走参数化查询
7. **XSS**：`prompt`、`description` 等字段在前端渲染时由 React 自动 escape

## 修改文件清单

| 文件 | 改动类型 | 改动概要 |
|------|---------|---------|
| `deepanalyze-hub/src/server/routes/marketplace.ts` | 修改 | (1) 加 `app.use("/admin/*", jwtAuth, requirePermission("skill:approve"))`；(2) 扩展 `/admin/skills` 列表支持 search+limit+offset；(3) approve/reject 改 reviewer_id 为真实 userId；(4) 新增 deprecate 端点；(5) 新增 DELETE 端点；(6) 新增 `/admin/promote` 跨系统推广端点 |
| `deepanalyze-hub/src/store/migrations/018_marketplace_source_cols.ts` | 新建 | `marketplace_skills` 加 `source_package_id` / `source_version_id` 溯源列 |
| `deepanalyze-hub/src/store/migrations/index.ts` | 修改 | 注册 migration 018 |
| `deepanalyze-hub/frontend/src/pages/WorkerSkills.tsx` | 新建 | Worker 技能市场管理页面，含 Tabs、搜索、列表、操作按钮、ReasonDialog |
| `deepanalyze-hub/frontend/src/App.tsx` | 修改 | (1) NAV_ITEMS 中 `/skills` 改名为"企业技能包"；(2) 新增 `/worker-skills` 导航项；(3) 路由注册新页面 |
| `deepanalyze-hub/frontend/src/api/marketplace-admin.ts` | 新建 | admin API 客户端封装（list/approve/reject/deprecate/remove/promote） |
| `deepanalyze-hub/frontend/src/pages/Skills.tsx` | 修改 | (1) 顶部加说明条幅，链接到 `/worker-skills`；(2) 每张卡片加"推广到 Worker 市场"按钮（仅 super admin + 有 published 版本时可见） |

## 不在本次范围内（YAGNI）

- **重新批准 deprecated skill**：作者重新 submit 即可
- **Inline 编辑 skill 内容**（prompt/tools/tags）：作者重新 submit 新版本
- **批量操作**（批量批准/拒绝）：当前 2 个 skill，没必要
- **24 个 Phase 2 测试包清理**：独立 maintenance 任务，本次只在 UI 加说明文字
- **Plugin 市场管理**：当前 0 个 plugin，UI 占位不在本期实现
- **审核流程通知**（邮件/站内信通知作者）：当前 submitter 都是 'system'，无意义
- **审核备注历史**（多次审核留痕）：当前 `review_notes` 单字段，覆盖最新一次原因即可
- **跨系统自动同步**：Phase 2 → Phase 1 推广是一次性快照；Phase 2 后续版本更新不自动同步到 Phase 1（见"跨系统推广 > 同步策略"）
- **反向推广**（Phase 1 → Phase 2）：DA Worker 自创的 skill 反向进入企业治理流程，本期不做

## 测试策略

### 后端单元测试

**Admin 路由（已有 + 新增）：**

- `GET /admin/skills` 无 token → 401
- `GET /admin/skills` 有 token 但无 `skill:approve` permission → 403
- `GET /admin/skills?status=pending` → 仅返回 pending
- `GET /admin/skills?search=code` → ILIKE 匹配
- `POST /admin/skills/:id/approve` 对 pending → 200, reviewer_id 真实
- `POST /admin/skills/:id/approve` 对 approved → 404（状态保护）
- `POST /admin/skills/:id/approve` 双击 → 第一次 200, 第二次 404
- `POST /admin/skills/:id/reject` 带 reason → 200, review_notes 写入
- `POST /admin/skills/:id/deprecate` 对 approved → 200
- `POST /admin/skills/:id/deprecate` 对 pending → 404
- `DELETE /admin/skills/:id` 对 rejected → 200
- `DELETE /admin/skills/:id` 对 approved → 400

**跨系统推广专属：**

- `POST /admin/promote` 无 token → 401
- `POST /admin/promote` 有 token 无 `skill:approve` → 403
- `POST /admin/promote { packageId }` 对正常 package + published 版本 → 200, 返回新 skill id；新行的 `source_package_id` / `source_version_id` 正确
- `POST /admin/promote` 对不存在的 packageId → 404
- `POST /admin/promote` 对没有 published 版本的 package → 400
- `POST /admin/promote` 当 slug 已存在于 marketplace_skills → 409
- `POST /admin/promote` 对 killed 状态的 package → 400
- `POST /admin/promote` 后，DA Worker 通过 `GET /skills` 立即能看到新 skill（approved 状态）

### 前端组件测试

**WorkerSkills 页面：**

- 初始挂载默认 Tab=pending，触发一次 `list({ status: "pending" })`
- 输入搜索词触发 300ms debounce 后才调 API
- Tab 切换触发对应 status 的 list
- approve 按钮点击触发 confirm dialog，确认后调 API + 刷新列表 + addToast
- reject/deprecate 按钮点击触发 ReasonDialog，提交后调 API + 刷新 + addToast
- remove 按钮点击触发 danger confirm dialog，确认后调 DELETE + 刷新
- 不同状态的卡片渲染对应按钮组合

**Skills 页面（Phase 2）：**

- super admin 视角：有 published 版本的 package 显示"推广"按钮，无 published 的不显示
- 非 super admin 视角：不显示"推广"按钮
- 点击推广按钮触发 confirm，确认后调 promote API + addToast 成功提示

### E2E 验证

1. Admin 登录 Hub → 访问 `/worker-skills` → 看到 2 个 approved skill（code-review/deep-research）
2. 切换到"待审核" Tab（当前应为空）
3. 通过 API submit 一个测试 skill → 切回 pending Tab → 看到该 skill
4. 点击"批准" → confirm → 卡片消失，切到 approved Tab 看到该 skill
5. 在 approved Tab 找到该 skill → 点击"下架" → ReasonDialog 输入原因 → 提交 → 卡片消失，切到 deprecated Tab 看到
6. 切换到 `/skills` 页面（Phase 2）→ 看到顶部说明条幅，含跳转 `/worker-skills` 链接
7. 在 `/skills` 选一个有 published 版本的 package → 点击"推广到 Worker 市场" → confirm
8. 切回 `/worker-skills` approved Tab → 看到刚推广的 skill，卡片显示"🔗 源自企业包"溯源
9. 非 admin 用户访问 `/worker-skills` → 看到 403 错误 banner
10. 通过 DA Worker 视角验证：批准后能在 DA 的 MarketplacePanel 看到新 skill；下架后看不到；推广后能立即看到

## 成功标准

**Phase 1 Admin 管理：**

- Hub Admin 登录后能在 `/worker-skills` 页面完成所有 approve/reject/deprecate/delete 操作
- 现有导航标签 "Skills 市场" 改名为 "企业技能包"，新标签 "Worker 技能市场" 出现
- `/skills` 页面顶部出现说明条幅，含跳转 `/worker-skills` 的链接
- 所有 `/api/v1/marketplace/admin/*` 端点必须带有效 token + `skill:approve` 权限才能访问
- `reviewer_id` 字段不再出现硬编码的 `'system'`，而是真实 admin userId
- approve 一个 pending skill 后，DA Worker 下次拉取能立即看到
- deprecate 一个 approved skill 后，DA Worker 不再看到（已下载的继续可用）
- 删除 rejected skill 后列表立即消失
- 双击 approve 第二次返回 404，不会产生中间状态
- 非 admin 用户访问 admin API 返回 401/403

**跨系统推广：**

- super admin 在 `/skills` 页面看到"推广到 Worker 市场"按钮（仅有 published 版本的 package）
- 推广成功后，`/worker-skills` approved Tab 出现新 skill，含溯源标识
- 推广后 DA Worker 立即能拉取到该 skill
- slug 冲突时返回 409，前端展示错误 toast
- 推广 killed package 返回 400
- 推广无 published 版本的 package 返回 400
- 同一 package 重复推广由 slug 冲突自动拦截

**整体：**

- 无新增 ERROR/WARNING 日志（除了测试本身预期的失败场景）
