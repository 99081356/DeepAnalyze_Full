# Hub Server 全面优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DA Hub 从"满是 e2e 测试残留 + 内联样式硬编码 + 无设计系统"的半成品，升级为可对外演示的企业级多租户管理后台。

**Architecture:** 后端：新增 2 个 migration（015/016）强化元数据 + zod 路由校验 + 幂等 seed 脚本。前端：从 DA 移植 design tokens + CSS + 16 个通用组件（含 Spinner 依赖）+ 新建 5 个 Hub 专属组件，重写 App Shell + 7 个页面。测试：更新 6 个现有 spec + 新增 3 个（T81-T83）。

**Tech Stack:** Hono + PostgreSQL + Bun（后端）、React 18 + Vite + TypeScript（前端）、Playwright（E2E）。

---

## 关键修正（相对于设计文档）

探索代码库后发现设计文档的部分假设与实际不符，本计划已修正：

| 设计文档假设 | 实际情况 | 本计划调整 |
|---|---|---|
| migration 从 002 开始 | 已有 001-014 | 使用 **015/016** |
| skill_packages 缺 category/tags/icon | **已有** category(NOT NULL DEFAULT 'custom')、tags(JSONB NOT NULL DEFAULT '[]')、icon(可空 TEXT) | 015 只加 `use_cases` + 给 icon 设默认值 |
| skill_versions 缺 change_summary | **已有** change_summary(可空 TEXT) | 015 只设默认值；016 强制 NOT NULL |
| skill_sharings 缺 usage_intent | 确认缺失 | 015 新增 usage_intent + business_justification |
| 后端已有 zod | **没有 zod** | 先 `bun add zod` |
| 前端有 components/ 目录 | **空目录**，零 CSS 文件 | 从零创建 |
| 组件列表 15 个 | Button 依赖 Spinner | 实际移植 **16 个**（含 Spinner） |

---

## 文件结构总览

### 后端新增/修改

```
deepanalyze-hub/
├── package.json                                    # 修改：加 zod 依赖
├── src/
│   ├── store/migrations/
│   │   ├── 015_metadata_enrichment.ts              # 新增
│   │   └── 016_metadata_constraints.ts             # 新增
│   ├── server/routes/
│   │   ├── skills.ts                               # 修改：加 zod 校验
│   │   └── skill-sharing.ts                        # 修改：加 zod 校验
│   └── server/validations/
│       └── skill-schemas.ts                        # 新增：zod schema 定义
└── scripts/
    └── seed-realistic.ts                           # 新增
```

### 前端新增/修改

```
deepanalyze-hub/frontend/
├── package.json                                    # 修改：加 clsx + lucide-react
├── vite.config.ts                                  # 修改：加 @ alias
├── src/
│   ├── main.tsx                                    # 修改：引入 CSS
│   ├── App.tsx                                     # 重写：新 Shell
│   ├── utils/
│   │   └── cn.ts                                   # 新增（从 DA 复制）
│   ├── styles/
│   │   ├── design-tokens.css                       # 新增（从 DA 复制）
│   │   ├── themes.css                              # 新增（从 DA 复制）
│   │   ├── base.css                                # 新增（从 DA 复制）
│   │   ├── animations.css                          # 新增（从 DA 复制）
│   │   └── markdown.css                            # 新增（从 DA 复制）
│   ├── components/
│   │   ├── ui/                                     # 16 个（从 DA 复制）
│   │   │   ├── Spinner.tsx
│   │   │   ├── Button.tsx
│   │   │   ├── Badge.tsx
│   │   │   ├── Input.tsx
│   │   │   ├── TextArea.tsx
│   │   │   ├── Select.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── Toast.tsx
│   │   │   ├── Tooltip.tsx
│   │   │   ├── Tabs.tsx
│   │   │   ├── EmptyState.tsx
│   │   │   ├── Skeleton.tsx
│   │   │   ├── ConfirmDialog.tsx
│   │   │   ├── SearchBar.tsx
│   │   │   ├── DropZone.tsx
│   │   │   └── ThemeToggle.tsx
│   │   └── hub/                                    # 5 个新建
│   │       ├── OrgTreeNode.tsx
│   │       ├── SkillCard.tsx
│   │       ├── PermissionMatrix.tsx
│   │       ├── AuditTimeline.tsx
│   │       └── StatusBadge.tsx
│   ├── api/
│   │   └── client.ts                               # 修改：加 category/icon 等字段
│   └── pages/
│       ├── Dashboard.tsx                           # 重写
│       ├── Skills.tsx                              # 重写
│       ├── SkillDetail.tsx                         # 新建
│       ├── OrgTree.tsx                             # 重写
│       ├── Sharings.tsx                            # 重写
│       ├── WorkerApproval.tsx                      # 重写
│       └── Security.tsx                            # 微调
```

### 测试新增/修改

```
deepanalyze/
└── tests/e2e/
    ├── helpers/hubApi.ts                           # 修改：构造数据加新字段
    └── hub/
        ├── hub-auth.spec.ts                        # 修改
        ├── hub-skillsync.spec.ts                   # 修改
        ├── hub-workflow.spec.ts                    # 修改
        ├── hub-sharing.spec.ts                     # 修改
        ├── hub-security.spec.ts                    # 修改
        ├── hub-integration.spec.ts                 # 修改
        ├── hub-seed.spec.ts                        # 新增：T81
        ├── hub-metadata.spec.ts                    # 新增：T82
        └── hub-visual.spec.ts                      # 新增：T83
```

---

## Phase A：后端 Schema + 校验

### Task A1：安装 zod

**Files:**
- Modify: `deepanalyze-hub/package.json`

- [ ] **Step 1: 安装 zod**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun add zod
```

- [ ] **Step 2: 验证安装**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun -e "import { z } from 'zod'; console.log(z.string().min(2).parse('ok'))"
```

Expected output: `ok`

- [ ] **Step 3: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add package.json bun.lockb
git commit -m "chore: add zod for request validation"
```

---

### Task A2：创建 zod 校验 schema

**Files:**
- Create: `deepanalyze-hub/src/server/validations/skill-schemas.ts`

- [ ] **Step 1: 创建校验 schema 文件**

```typescript
// deepanalyze-hub/src/server/validations/skill-schemas.ts
import { z } from "zod";

export const CATEGORY_ENUM = [
  "engineering", "writing", "operations", "business",
  "security", "productivity", "general",
] as const;

export const createPackageSchema = z.object({
  name: z.string().min(1, "name required"),
  description: z.string().min(10, "description min 10 chars"),
  scope: z.enum(["system", "org", "user"]).default("user"),
  org_id: z.string().optional(),
  category: z.enum(CATEGORY_ENUM).default("general"),
  tags: z.array(z.string()).default([]),
  icon: z.string().default("📦"),
});

export const createVersionSchema = z.object({
  version: z.string().min(1, "version required"),
  content: z.string().min(1, "content required"),
  when_to_use: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  data_classification: z.enum(["public", "internal", "confidential", "secret"]).default("public"),
  change_summary: z.string().min(5, "change_summary min 5 chars"),
  autoPublish: z.boolean().default(false),
});

export const createSharingSchema = z.object({
  package_id: z.string().min(1, "package_id required"),
  source_org_id: z.string().optional(),
  target_org_id: z.string().min(1, "target_org_id required"),
  usage_intent: z.string().min(5, "usage_intent min 5 chars"),
  business_justification: z.string().optional(),
  restrictions: z.object({
    max_users: z.number().int().positive().optional(),
    expires_at: z.string().optional(),
    data_classification_max: z.enum(["public", "internal", "confidential", "secret"]).optional(),
  }).optional(),
});

export type CreatePackageInput = z.infer<typeof createPackageSchema>;
export type CreateVersionInput = z.infer<typeof createVersionSchema>;
export type CreateSharingInput = z.infer<typeof createSharingSchema>;
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run typecheck
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/server/validations/skill-schemas.ts
git commit -m "feat: add zod validation schemas for skill/sharing routes"
```

---

### Task A3：在 skill 路由中应用 zod 校验

**Files:**
- Modify: `deepanalyze-hub/src/server/routes/skills.ts`

- [ ] **Step 1: 读取当前 skills.ts**

```bash
cat /mnt/d/code/deepanalyze/deepanalyze-hub/src/server/routes/skills.ts
```

重点看 `app.post("/", ...)` (创建包) 和 `app.post("/:id/versions", ...)` (创建版本) 的现有校验逻辑。

- [ ] **Step 2: 添加 zod import**

在文件顶部 import 区添加：

```typescript
import { createPackageSchema, createVersionSchema } from "../validations/skill-schemas.js";
```

- [ ] **Step 3: 替换 POST `/` 的手动校验**

找到 `app.post("/", jwtAuth, async (c) => {` 内的 body 解析和校验。替换为：

```typescript
const rawBody = await c.req.json().catch(() => ({}));
const parsed = createPackageSchema.safeParse(rawBody);
if (!parsed.success) {
  return c.json({
    error: "Validation failed",
    fields: Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0]])
    ),
  }, 400);
}
const body = parsed.data;
```

删除原来的 `if (!body.name) return c.json({ error: "name required" }, 400);` 等手动校验。

- [ ] **Step 4: 替换 POST `/:id/versions` 的手动校验**

同样找到 `app.post("/:id/versions", jwtAuth, async (c) => {`，替换为使用 `createVersionSchema`：

```typescript
const rawBody = await c.req.json().catch(() => ({}));
const parsed = createVersionSchema.safeParse(rawBody);
if (!parsed.success) {
  return c.json({
    error: "Validation failed",
    fields: Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0]])
    ),
  }, 400);
}
const body = parsed.data;
```

- [ ] **Step 5: 重启 Hub 并验证**

```bash
# 重启 Hub（杀掉旧进程再启动）
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run src/main.ts &

# 测试：缺少 description 应返回 400 + 字段级错误
curl -s http://localhost:22000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.access_token' > /tmp/hub_token

curl -s -X POST http://localhost:22000/api/v1/skills \
  -H "Authorization: Bearer $(cat /tmp/hub_token)" \
  -H "Content-Type: application/json" \
  -d '{"name":"test"}' | jq .
```

Expected: `{"error":"Validation failed","fields":{"description":"description min 10 chars"}}`

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/server/routes/skills.ts
git commit -m "feat: enforce zod validation on skill package/version creation"
```

---

### Task A4：在 sharing 路由中应用 zod 校验

**Files:**
- Modify: `deepanalyze-hub/src/server/routes/skill-sharing.ts`

- [ ] **Step 1: 添加 zod import**

在 `skill-sharing.ts` 顶部添加：

```typescript
import { createSharingSchema } from "../validations/skill-schemas.js";
```

- [ ] **Step 2: 替换 POST `/` 的手动校验**

找到 `app.post("/", jwtAuth, requirePermission("skill:share"), async (c) => {`，替换 body 解析：

```typescript
const rawBody = await c.req.json().catch(() => ({}));
const parsed = createSharingSchema.safeParse(rawBody);
if (!parsed.success) {
  return c.json({
    error: "Validation failed",
    fields: Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0]])
    ),
  }, 400);
}
const body = parsed.data;
```

- [ ] **Step 3: 验证**

```bash
# 缺 usage_intent 应返回 400
curl -s -X POST http://localhost:22000/api/v1/sharings \
  -H "Authorization: Bearer $(cat /tmp/hub_token)" \
  -H "Content-Type: application/json" \
  -d '{"package_id":"x","target_org_id":"y"}' | jq .
```

Expected: `{"error":"Validation failed","fields":{"usage_intent":"usage_intent min 5 chars"}}`

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/server/routes/skill-sharing.ts
git commit -m "feat: enforce zod validation on sharing creation (usage_intent required)"
```

---

### Task A5：Migration 015 — 元数据字段补全

**Files:**
- Create: `deepanalyze-hub/src/store/migrations/015_metadata_enrichment.ts`

- [ ] **Step 1: 创建 migration 文件**

```typescript
// deepanalyze-hub/src/store/migrations/015_metadata_enrichment.ts
/**
 * Migration 015: 元数据补全
 *
 * skill_packages: 已有 category/tags/icon/display_name/trust_level
 *   → 新增 use_cases JSONB
 *   → 给 icon 设默认值 '📦'
 *
 * skill_versions: 已有 change_summary (可空)
 *   → 设默认值 ''
 *
 * skill_sharings: 缺 usage_intent / business_justification
 *   → 新增两列
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // skill_packages: 加 use_cases + icon 默认值
  await query(`ALTER TABLE skill_packages ADD COLUMN IF NOT EXISTS use_cases JSONB NOT NULL DEFAULT '[]'`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon SET DEFAULT '📦'`);
  await query(`UPDATE skill_packages SET icon = '📦' WHERE icon IS NULL`);

  // skill_versions: change_summary 设默认值
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary SET DEFAULT ''`);

  // skill_sharings: 加 usage_intent + business_justification
  await query(`ALTER TABLE skill_sharings ADD COLUMN IF NOT EXISTS usage_intent TEXT`);
  await query(`ALTER TABLE skill_sharings ADD COLUMN IF NOT EXISTS business_justification TEXT`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE skill_sharings DROP COLUMN IF EXISTS business_justification`);
  await query(`ALTER TABLE skill_sharings DROP COLUMN IF EXISTS usage_intent`);
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary DROP DEFAULT`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon DROP DEFAULT`);
  await query(`ALTER TABLE skill_packages DROP COLUMN IF EXISTS use_cases`);
}
```

- [ ] **Step 2: 重启 Hub 触发 migration**

```bash
# 杀旧进程
pkill -f "bun.*src/main.ts" 2>/dev/null; sleep 1
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run src/main.ts &
sleep 3
# 日志应显示 [DB] Running migration: 015_metadata_enrichment.ts
```

- [ ] **Step 3: 验证新列存在**

```bash
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c "\d skill_sharings" | grep usage_intent
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c "\d skill_packages" | grep use_cases
```

Expected: 两行输出显示列存在。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/store/migrations/015_metadata_enrichment.ts
git commit -m "feat: migration 015 — add use_cases/usage_intent/business_justification columns"
```

---

## Phase B：Seed 脚本

### Task B1：创建 seed 脚本（组织树 + 用户）

**Files:**
- Create: `deepanalyze-hub/scripts/seed-realistic.ts`

- [ ] **Step 1: 创建 scripts/ 目录**

```bash
mkdir -p /mnt/d/code/deepanalyze/deepanalyze-hub/scripts
```

- [ ] **Step 2: 创建 seed 脚本第一部分（安全门 + TRUNCATE + 组织树 + 用户）**

```typescript
// deepanalyze-hub/scripts/seed-realistic.ts
/**
 * 真实测试数据 seed 脚本
 * 用法: bun run scripts/seed-realistic.ts
 *
 * 幂等：可重复运行，每次结果一致（先 TRUNCATE 再插入）
 * 安全门：生产环境拒绝运行
 */

import { query } from "../src/store/pg.js";
import { closePool } from "../src/store/pg.js";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";

// ── 安全门 ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  console.error("❌ seed script refused in production environment");
  process.exit(1);
}

// ── 数据定义 ─────────────────────────────────────────────────────────

interface OrgDef {
  id: string;
  name: string;
  code: string;
  type: string;
  level: number;
  parent_code: string | null;
  path: string;
}

const ORGS: OrgDef[] = [
  { id: "org_dsi",         name: "深度智能科技",       code: "DSI",   type: "company",    level: 0, parent_code: null,    path: "dsi" },
  { id: "org_prc",         name: "产品研发中心",       code: "PRC",   type: "department", level: 1, parent_code: "DSI",   path: "dsi.prc" },
  { id: "org_infra",       name: "基础平台部",         code: "INFRA", type: "department", level: 2, parent_code: "PRC",   path: "dsi.prc.infra" },
  { id: "org_agent",       name: "Agent 引擎组",       code: "AGENT", type: "team",       level: 3, parent_code: "INFRA", path: "dsi.prc.infra.agent" },
  { id: "org_data",        name: "数据基础设施组",     code: "DATA",  type: "team",       level: 3, parent_code: "INFRA", path: "dsi.prc.infra.data" },
  { id: "org_app",         name: "应用产品部",         code: "APP",   type: "department", level: 2, parent_code: "PRC",   path: "dsi.prc.app" },
  { id: "org_kb",          name: "知识库产品组",       code: "KB",    type: "team",       level: 3, parent_code: "APP",   path: "dsi.prc.app.kb" },
  { id: "org_comm",        name: "商业化中心",         code: "COMM",  type: "department", level: 1, parent_code: "DSI",   path: "dsi.comm" },
  { id: "org_sol",         name: "解决方案部",         code: "SOL",   type: "department", level: 2, parent_code: "COMM",  path: "dsi.comm.sol" },
  { id: "org_cs",          name: "客户成功部",         code: "CS",    type: "department", level: 2, parent_code: "COMM",  path: "dsi.comm.cs" },
  { id: "org_sec",         name: "安全合规部",         code: "SEC",   type: "department", level: 1, parent_code: "DSI",   path: "dsi.sec" },
];

interface UserDef {
  id: string;
  username: string;
  display_name: string;
  password: string;
  org_code: string;
  is_super_admin: boolean;
  is_org_admin: boolean;
}

const DEFAULT_PW = "Test1234!";
const PW_HASH = bcrypt.hashSync(DEFAULT_PW, 10);

const USERS: UserDef[] = [
  { id: "u_admin",       username: "admin",         display_name: "系统管理员",   password: "admin123", org_code: "DSI",   is_super_admin: true,  is_org_admin: false },
  { id: "u_wangsy",      username: "wang.siyuan",   display_name: "王思远",       password: DEFAULT_PW, org_code: "AGENT", is_super_admin: false, is_org_admin: true  },
  { id: "u_linyq",       username: "lin.yuqing",    display_name: "林雨晴",       password: DEFAULT_PW, org_code: "DATA",  is_super_admin: false, is_org_admin: true  },
  { id: "u_chenyf",      username: "chen.yifan",    display_name: "陈一帆",       password: DEFAULT_PW, org_code: "KB",    is_super_admin: false, is_org_admin: true  },
  { id: "u_zhouml",      username: "zhou.minglang", display_name: "周明朗",       password: DEFAULT_PW, org_code: "SOL",   is_super_admin: false, is_org_admin: true  },
  { id: "u_zhaorh",      username: "zhao.ruihua",   display_name: "赵瑞华",       password: DEFAULT_PW, org_code: "SEC",   is_super_admin: false, is_org_admin: true  },
  { id: "u_liuty",       username: "liu.tianyu",    display_name: "刘天宇",       password: DEFAULT_PW, org_code: "AGENT", is_super_admin: false, is_org_admin: false },
  { id: "u_sunjy",       username: "sun.jiayi",     display_name: "孙佳怡",       password: DEFAULT_PW, org_code: "KB",    is_super_admin: false, is_org_admin: false },
  { id: "u_wuhr",        username: "wu.haoran",     display_name: "吴浩然",       password: DEFAULT_PW, org_code: "SOL",   is_super_admin: false, is_org_admin: false },
  { id: "u_zhengxy",     username: "zheng.xinyi",   display_name: "郑心怡",       password: DEFAULT_PW, org_code: "CS",    is_super_admin: false, is_org_admin: false },
  { id: "u_huangzx",     username: "huang.zixuan",  display_name: "黄子轩",       password: DEFAULT_PW, org_code: "SEC",   is_super_admin: false, is_org_admin: false },
  { id: "u_xush",        username: "xu.shihan",     display_name: "徐诗涵",       password: DEFAULT_PW, org_code: "DATA",  is_super_admin: false, is_org_admin: false },
  { id: "u_hej",         username: "he.jun",        display_name: "何军",         password: DEFAULT_PW, org_code: "CS",    is_super_admin: false, is_org_admin: false },
  { id: "u_guoy",        username: "guo.yang",      display_name: "郭洋",         password: DEFAULT_PW, org_code: "APP",   is_super_admin: false, is_org_admin: false },
  { id: "u_tangl",       username: "tang.lin",      display_name: "唐琳",         password: DEFAULT_PW, org_code: "AGENT", is_super_admin: false, is_org_admin: false },
  { id: "u_fengxy",      username: "feng.xueyao",   display_name: "冯雪瑶",       password: DEFAULT_PW, org_code: "KB",    is_super_admin: false, is_org_admin: false },
  { id: "u_yangzw",      username: "yang.zhiwei",   display_name: "杨智威",       password: DEFAULT_PW, org_code: "SOL",   is_super_admin: false, is_org_admin: false },
  { id: "u_qinr",        username: "qin.rui",       display_name: "秦蕊",         password: DEFAULT_PW, org_code: "SEC",   is_super_admin: false, is_org_admin: false },
  { id: "u_luoht",       username: "luo.haotian",   display_name: "罗浩天",       password: DEFAULT_PW, org_code: "DATA",  is_super_admin: false, is_org_admin: false },
];

// ── 执行 ──────────────────────────────────────────────────────────

async function seed() {
  console.log("🌱 Starting realistic seed...\n");

  // 1. TRUNCATE
  console.log("1. TRUNCATE business tables...");
  await query(`
    TRUNCATE skill_audit_logs, skill_usage_logs, skill_subscriptions,
      skill_sharings, skill_versions, skill_packages, skill_sync_queue,
      skill_approvals, worker_skill_cache, workers, user_api_keys,
      user_roles, users, organizations CASCADE
  `);

  // 2. 插入组织树
  console.log("2. Insert org tree (11 nodes)...");
  for (const org of ORGS) {
    const parent = org.parent_code ? ORGS.find(o => o.code === org.parent_code) : null;
    await query(
      `INSERT INTO organizations (id, name, code, description, parent_id, level, path, type, status, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', '{}')`,
      [org.id, org.name, org.code, `${org.name}（${org.code}）`,
       parent?.id ?? null, org.level, org.path, org.type],
    );
  }

  // 3. 插入用户
  console.log("3. Insert users (19 people)...");
  for (const u of USERS) {
    const org = ORGS.find(o => o.code === u.org_code)!;
    const hash = u.username === "admin" ? bcrypt.hashSync(u.password, 10) : PW_HASH;
    await query(
      `INSERT INTO users (id, username, display_name, password_hash, role, status, auth_source,
         is_super_admin, is_org_admin, organization_id)
       VALUES ($1, $2, $3, $4, 'admin', 'active', 'local', $5, $6, $7)`,
      [u.id, u.username, u.display_name, hash,
       u.is_super_admin, u.is_org_admin, org.id],
    );
  }

  console.log("✅ Org tree + users seeded\n");
}

seed()
  .then(() => { console.log("🎉 Seed complete!"); return closePool(); })
  .then(() => process.exit(0))
  .catch((err) => { console.error("❌ Seed failed:", err); process.exit(1); });
```

注意：此脚本目前只含组织树 + 用户，后续 Task B2 会追加角色绑定，B3 会追加 Skill 包。

- [ ] **Step 3: 运行 seed 验证**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run scripts/seed-realistic.ts
```

Expected output: 显示 `1. TRUNCATE...` → `2. Insert org tree...` → `3. Insert users...` → `✅` → `🎉 Seed complete!`

- [ ] **Step 4: 数据库验证**

```bash
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c \
  "SELECT code, name, level FROM organizations ORDER BY level, code;"
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c \
  "SELECT username, display_name, is_org_admin FROM users ORDER BY username;"
```

Expected: 11 组织 + 19 用户（含 admin）。

- [ ] **Step 5: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add scripts/seed-realistic.ts
git commit -m "feat: seed script — org tree (11 nodes) + 19 users for 深度智能科技"
```

---

### Task B2：扩展 seed 脚本 — 角色绑定

**Files:**
- Modify: `deepanalyze-hub/scripts/seed-realistic.ts`

- [ ] **Step 1: 在 seed() 函数中（"3. 插入用户" 之后）追加角色绑定**

在 `console.log("✅ Org tree + users seeded\n");` 之前插入：

```typescript
  // 4. 绑定角色
  console.log("4. Assign roles...");
  // 获取系统角色 ID
  const { rows: roles } = await query<{ id: string; name: string }>(
    "SELECT id, name FROM roles WHERE is_system = TRUE",
  );
  const roleByCode = Object.fromEntries(roles.map(r => [r.name, r.id]));

  // org_admin 角色绑定
  const ORG_ADMINS: Record<string, string> = {
    "wang.siyuan": "org_agent",
    "lin.yuqing": "org_data",
    "chen.yifan": "org_kb",
    "zhou.minglang": "org_sol",
    "zhao.ruihua": "org_sec",
  };

  for (const [username, orgCode] of Object.entries(ORG_ADMINS)) {
    const user = USERS.find(u => u.username === username)!;
    const org = ORGS.find(o => o.code === orgCode)!;
    // 创建该组织的 org_admin 角色
    const roleId = randomUUID();
    await query(
      `INSERT INTO roles (id, name, org_id, description, is_system)
       VALUES ($1, $2, $3, '子组织管理员', FALSE)`,
      [roleId, `org_admin_${org.code}`, org.id],
    );
    // 复制 org_admin 权限到新角色
    await query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, permission_id FROM role_permissions WHERE role_id = $2`,
      [roleId, roleByCode["role_org_admin"]],
    );
    // 绑定用户
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [user.id, roleId],
    );
  }

  // 给 admin 绑定 super_admin 角色
  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT 'u_admin', id FROM roles WHERE name = 'role_super_admin'`,
  );
```

- [ ] **Step 2: 运行并验证**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run scripts/seed-realistic.ts

# 验证角色绑定
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c \
  "SELECT u.username, r.name FROM user_roles ur JOIN users u ON ur.user_id=u.id JOIN roles r ON ur.role_id=r.id ORDER BY u.username;"
```

Expected: admin → role_super_admin；5 个部门负责人各有 org_admin_XXX 角色。

- [ ] **Step 3: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add scripts/seed-realistic.ts
git commit -m "feat: seed script — add RBAC role bindings for org_admins"
```

---

### Task B3：扩展 seed 脚本 — Skill 包 + 版本 + 共享

**Files:**
- Modify: `deepanalyze-hub/scripts/seed-realistic.ts`

- [ ] **Step 1: 在脚本数据定义区追加 Skill 定义**

在 `USERS` 数组之后添加：

```typescript
interface SkillDef {
  id: string;
  name: string;
  slug: string;
  display_name: string;
  description: string;
  scope: "system" | "org" | "user";
  org_code: string | null;
  author_username: string;
  category: string;
  tags: string[];
  icon: string;
  trust_level: string;
  version: string;
  content: string;
  change_summary: string;
}

const SKILLS: SkillDef[] = [
  {
    id: "sk_agent_debug", name: "da-agent-debug", slug: "da-agent-debug",
    display_name: "DA Agent 调试技巧",
    description: "DA Agent 调试技巧：如何定位工具调用失败、流式中断、上下文超限等问题。包含常见错误模式、日志排查路径、以及工具链断点恢复策略。",
    scope: "system", org_code: null, author_username: "wang.siyuan",
    category: "engineering", tags: ["agent", "debug", "streaming"], icon: "🔧",
    trust_level: "verified",
    version: "1.0.0",
    content: "## DA Agent 调试技巧\n\n### 工具调用失败\n\n- 检查 `tool-setup.ts` 中工具是否正确注册\n- 查看 `/tmp/da_debug*.log` 中 ERROR 级别日志\n- 确认工具参数符合 zod schema\n\n### 流式中断\n\n- SSE 连接超时通常是 30s 无输出\n- 检查 `orchestrator.ts` 中 `streamTimeout`\n- 心跳机制：每 5s 发空注释保持连接\n\n### 上下文超限\n\n- 用 `context_window` 监控 token 使用\n- 超过 80% 时触发摘要压缩\n- 子 Agent 结果用 `push_content` 而非全文返回",
    change_summary: "初版发布：涵盖工具调用、流式、上下文三大场景",
  },
  {
    id: "sk_report_writing", name: "kb-report-writing", slug: "kb-report-writing",
    display_name: "知识库报告写作",
    description: "知识库报告写作规范：结构化输出、引用校验、避免幻觉的实用指南。适用于分析报告、调研报告、技术文档等场景。",
    scope: "system", org_code: null, author_username: "chen.yifan",
    category: "writing", tags: ["report", "citation", "anti-hallucination"], icon: "📝",
    trust_level: "verified",
    version: "2.1.0",
    content: "## 报告写作规范\n\n### 结构\n\n1. **摘要**：100 字以内，结论先行\n2. **正文**：每个发现一个 H2\n3. **引用**：格式 `[[doc:页面ID]]`\n\n### 引用校验\n\n- 每个事实必须有引用\n- 引用 ID 必须在 `wiki_pages` 表存在\n- 避免引用空白页\n\n### 幻觉防护\n\n- 不确定时标注「未找到确凿证据」\n- 数值需要交叉验证\n- 避免跨文档拼接无关信息",
    change_summary: "v2.1：增加引用校验章节，强化幻觉防护",
  },
  {
    id: "sk_cost_opt", name: "infra-cost-opt", slug: "infra-cost-opt",
    display_name: "云成本优化清单",
    description: "AWS/阿里云成本优化 checklist：闲置资源识别、reserved instance 决策、存储生命周期管理。按月执行一次可有效降低 15-30% 云开支。",
    scope: "org", org_code: "DSI", author_username: "lin.yuqing",
    category: "operations", tags: ["aws", "cost", "ri"], icon: "⚙️",
    trust_level: "verified",
    version: "1.2.0",
    content: "## 云成本优化清单\n\n### 闲置资源\n\n- [ ] EC2/ECS 实例 CPU < 5% 连续 7 天\n- [ ] RDS 连接数 < 10 持续 14 天\n- [ ] Load Balancer 无健康目标\n\n### Reserved Instance\n\n- 1 年承诺节省 ~40%\n- 3 年承诺节省 ~60%\n- 建议对稳定负载选 1 年 RI\n\n### 存储生命周期\n\n- S3/OSS：30 天后转 IA\n- 90 天后转 Archive\n- 日志类数据直接 Archive",
    change_summary: "v1.2：补充存储生命周期管理章节",
  },
  {
    id: "sk_onboarding", name: "customer-onboarding", slug: "customer-onboarding",
    display_name: "客户 Onboarding 流程",
    description: "新客户 onboarding 标准流程：需求确认 → 环境配置 → 培训交付 → 验收签字。平均周期 2 周，确保客户首月活跃率 > 80%。",
    scope: "org", org_code: "SOL", author_username: "zhou.minglang",
    category: "business", tags: ["onboarding", "sop"], icon: "💼",
    trust_level: "verified",
    version: "3.0.0",
    content: "## 客户 Onboarding 流程\n\n### 第一周：需求确认\n\n1. Kickoff 会议（1h）\n2. 收集业务场景清单\n3. 确认 KPI 指标\n4. 输出《需求确认书》\n\n### 第二周：环境配置\n\n1. 创建 Hub 组织\n2. 配置 SSO（如需要）\n3. 部署 Worker\n4. 加载初始 Skill 包\n\n### 第三周：培训交付\n\n1. 管理员培训（2h）\n2. 终端用户培训（2h × N 场）\n3. 发放操作手册\n\n### 验收\n\n- 客户完成 3 个真实场景测试\n- 签字确认",
    change_summary: "v3.0：全面重构，按周拆分交付物",
  },
  {
    id: "sk_audit_prep", name: "security-audit-prep", slug: "security-audit-prep",
    display_name: "等保 2.0 审计准备",
    description: "等保 2.0 二级/三级审计准备清单：日志保留 6 个月、访问审计完整性、漏洞扫描证据链。配合安全合规部年度审计使用。",
    scope: "org", org_code: "SEC", author_username: "zhao.ruihua",
    category: "security", tags: ["compliance", "audit", "等保"], icon: "🛡️",
    trust_level: "verified",
    version: "1.1.0",
    content: "## 等保 2.0 审计准备\n\n### 日志保留\n\n- 操作日志 ≥ 6 个月\n- 审计日志 ≥ 12 个月\n- 日志不可篡改（append-only）\n\n### 访问审计\n\n- 所有管理操作有审计记录\n- 审计记录包含：时间、操作人、操作内容、结果\n- 定期导出审计报告\n\n### 漏洞扫描\n\n- 每月一次全量扫描\n- 高危漏洞 24h 内修复\n- 中危漏洞 7 天内修复\n\n### 证据链\n\n- 扫描报告 PDF\n- 修复 commit 记录\n- 复测报告",
    change_summary: "v1.1：增加证据链章节",
  },
  {
    id: "sk_note_taking", name: "personal-note-taking", slug: "personal-note-taking",
    display_name: "个人笔记管理",
    description: "个人笔记整理习惯：obsidian tag 体系、Zettelkasten 实践、每日回顾流程。帮助知识工作者建立可持续的个人知识库。",
    scope: "user", org_code: null, author_username: "sun.jiayi",
    category: "productivity", tags: ["obsidian", "notes", "zettelkasten"], icon: "🗒️",
    trust_level: "community",
    version: "1.0.0",
    content: "## 个人笔记管理\n\n### Tag 体系\n\n- `#area/xxx` — 持续关注领域\n- `#project/xxx` — 进行中项目\n- `#resource/xxx` — 参考资料\n- `#archive/xxx` — 已归档\n\n### Zettelkasten\n\n- 每个 note 只讲一件事\n- note 之间用 `[[wikilink]]` 连接\n- 定期整理 backlinks\n\n### 每日回顾\n\n- 晨间：规划今日 3 件事\n- 晚间：记录完成 + 反思\n- 周末：整理本周笔记",
    change_summary: "初版发布",
  },
];
```

- [ ] **Step 2: 在 seed() 函数中追加 Skill 插入逻辑**

在角色绑定之后（`console.log("✅ Org tree + users seeded\n");` 之前）添加：

```typescript
  // 5. 插入 Skill 包 + 版本
  console.log("5. Insert skill packages + versions (6 packages)...");
  for (const sk of SKILLS) {
    const author = USERS.find(u => u.username === sk.author_username)!;
    const org = sk.org_code ? ORGS.find(o => o.code === sk.org_code) : null;
    const pkgId = sk.id;
    const versionId = `${sk.id}_v1`;

    await query(
      `INSERT INTO skill_packages (id, name, slug, display_name, description, org_id, author_id,
         scope, category, tags, icon, stats, trust_level, active_version_id, is_kill_switched)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         '{"downloads":0,"subscriptions":0,"rating_avg":0}', $12, $13, FALSE)`,
      [pkgId, sk.name, sk.slug, sk.display_name, sk.description,
       org?.id ?? null, author.id, sk.scope, sk.category, JSON.stringify(sk.tags),
       sk.icon, sk.trust_level, versionId],
    );

    await query(
      `INSERT INTO skill_versions (id, package_id, version, content, when_to_use, paths,
         allowed_tools, data_classification, hooks, test_cases, content_hash, status,
         change_summary, created_by, published_at)
       VALUES ($1, $2, $3, $4, NULL, '[]', '[]', 'public', '{}', '[]',
         encode(digest($4, 'sha256'), 'hex'), 'published', $5, $6, NOW())`,
      [versionId, pkgId, sk.version, sk.content, sk.change_summary, author.id],
    );

    // 给每个包创建一个订阅（让数据看起来有使用量）
    await query(
      `INSERT INTO skill_subscriptions (id, package_id, subscriber_type, subscriber_id, source)
       VALUES ($1, $2, 'user', $3, 'market')`,
      [randomUUID(), pkgId, author.id],
    );
  }

  // 6. 创建 1 个共享记录 (INFRA → SOL)
  console.log("6. Insert cross-org sharing (INFRA → SOL)...");
  const costOptPkg = SKILLS.find(s => s.slug === "infra-cost-opt")!;
  const solOrg = ORGS.find(o => o.code === "SOL")!;
  const infraOrg = ORGS.find(o => o.code === "INFRA")!;
  const adminUser = USERS.find(u => u.username === "admin")!;
  await query(
    `INSERT INTO skill_sharings (id, package_id, source_org_id, target_org_id, status,
       initiated_by, approved_by, restrictions, created_at, approved_at, usage_intent, business_justification)
     VALUES ($1, $2, $3, $4, 'approved', $5, $5,
       '{"max_users": 20}', NOW(), NOW(),
       'SOL 团队需要成本优化指导方案', '新客户项目交付中频繁涉及云成本优化')`,
    [randomUUID(), costOptPkg.id, infraOrg.id, solOrg.id, adminUser.id],
  );
```

- [ ] **Step 3: 添加 pg crypto digest 支持**

`content_hash` 用了 `digest()` 函数，需要 `pgcrypto` 扩展。检查是否已启用：

```bash
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c \
  "SELECT * FROM pg_extension WHERE extname = 'pgcrypto';"
```

如果为空，创建 migration 启用：

```bash
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c \
  "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

- [ ] **Step 4: 运行完整 seed**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run scripts/seed-realistic.ts
```

- [ ] **Step 5: 全面验证**

```bash
# 组织数
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT COUNT(*) FROM organizations;"
# Expected: 11（DSI 为根 + 10 子节点）

# 用户数
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT COUNT(*) FROM users;"
# Expected: 19

# Skill 包数
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT COUNT(*) FROM skill_packages;"
# Expected: 6

# Skill 版本数
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT COUNT(*) FROM skill_versions;"
# Expected: 6

# 共享数
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT COUNT(*) FROM skill_sharings;"
# Expected: 1

# 所有包的 description 非空
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT COUNT(*) FROM skill_packages WHERE description IS NULL OR description = '';"
# Expected: 0

# 所有版本的 change_summary 非空
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT COUNT(*) FROM skill_versions WHERE change_summary IS NULL OR change_summary = '';"
# Expected: 0
```

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add scripts/seed-realistic.ts
git commit -m "feat: seed script — 6 skill packages with full metadata + 1 cross-org sharing"
```

---

### Task B4：验证 seed 幂等性

- [ ] **Step 1: 连续运行 2 次**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run scripts/seed-realistic.ts
bun run scripts/seed-realistic.ts
```

两次都应成功，无主键冲突错误。

- [ ] **Step 2: 数据一致性检查**

```bash
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -t -c \
  "SELECT
     (SELECT COUNT(*) FROM organizations) as orgs,
     (SELECT COUNT(*) FROM users) as users,
     (SELECT COUNT(*) FROM skill_packages) as pkgs,
     (SELECT COUNT(*) FROM skill_versions) as versions,
     (SELECT COUNT(*) FROM skill_sharings) as sharings;"
```

Expected: `11 | 19 | 6 | 6 | 1`

---

### Task B5：Migration 016 — 元数据约束（seed 后强制）

**Files:**
- Create: `deepanalyze-hub/src/store/migrations/016_metadata_constraints.ts`

- [ ] **Step 1: 创建 migration 文件**

```typescript
// deepanalyze-hub/src/store/migrations/016_metadata_constraints.ts
/**
 * Migration 016: 元数据约束（seed 后强制）
 *
 * 在 015 加列 + seed 数据就位后，强制 NOT NULL + CHECK 约束。
 * 这确保未来任何直接写 DB 的操作（绕过应用层 zod）也必须满足元数据要求。
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // skill_packages: description NOT NULL
  await query(`ALTER TABLE skill_packages ALTER COLUMN description SET NOT NULL`);

  // skill_packages: icon NOT NULL
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon SET NOT NULL`);

  // skill_packages: category CHECK 枚举
  await query(`
    ALTER TABLE skill_packages
    DROP CONSTRAINT IF EXISTS chk_category_values
  `);
  await query(`
    ALTER TABLE skill_packages
    ADD CONSTRAINT chk_category_values CHECK (category IN (
      'engineering', 'writing', 'operations', 'business',
      'security', 'productivity', 'general', 'custom'
    ))
  `);

  // skill_versions: change_summary NOT NULL
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary SET NOT NULL`);

  // skill_sharings: usage_intent NOT NULL
  await query(`UPDATE skill_sharings SET usage_intent = '' WHERE usage_intent IS NULL`);
  await query(`ALTER TABLE skill_sharings ALTER COLUMN usage_intent SET NOT NULL`);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE skill_sharings ALTER COLUMN usage_intent DROP NOT NULL`);
  await query(`ALTER TABLE skill_versions ALTER COLUMN change_summary DROP NOT NULL`);
  await query(`ALTER TABLE skill_packages DROP CONSTRAINT IF EXISTS chk_category_values`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN icon DROP NOT NULL`);
  await query(`ALTER TABLE skill_packages ALTER COLUMN description DROP NOT NULL`);
}
```

- [ ] **Step 2: 重启 Hub 触发 migration**

```bash
pkill -f "bun.*src/main.ts" 2>/dev/null; sleep 1
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run src/main.ts &
sleep 3
```

- [ ] **Step 3: 验证约束生效**

```bash
# 尝试插入 description 为 NULL 的包 → 应失败
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c \
  "INSERT INTO skill_packages (id, name, slug, scope, category, tags, icon, description) VALUES ('test', 'test', 'test', 'user', 'general', '[]', '📦', NULL);" 2>&1 | tail -2
```

Expected: `ERROR: null value in column "description" violates not-null constraint`

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/store/migrations/016_metadata_constraints.ts
git commit -m "feat: migration 016 — enforce NOT NULL + CHECK constraints on metadata"
```

---

## Phase C：UI 基础设施

### Task C1：添加前端依赖 + 配置

**Files:**
- Modify: `deepanalyze-hub/frontend/package.json`
- Modify: `deepanalyze-hub/frontend/vite.config.ts`

- [ ] **Step 1: 安装依赖**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npm install clsx lucide-react
```

- [ ] **Step 2: 给 vite.config.ts 加 @ 别名**

读取当前文件，修改为：

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:22000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
```

- [ ] **Step 3: 验证构建**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npm run build
```

Expected: 构建成功无错误。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add package.json package-lock.json vite.config.ts
git commit -m "chore: add clsx + lucide-react, configure @ path alias"
```

---

### Task C2：移植 DA CSS 文件

**Files:**
- Create: `deepanalyze-hub/frontend/src/styles/design-tokens.css`
- Create: `deepanalyze-hub/frontend/src/styles/themes.css`
- Create: `deepanalyze-hub/frontend/src/styles/base.css`
- Create: `deepanalyze-hub/frontend/src/styles/animations.css`
- Create: `deepanalyze-hub/frontend/src/styles/markdown.css`
- Modify: `deepanalyze-hub/frontend/src/main.tsx`

**源文件位置**：`/mnt/d/code/deepanalyze/deepanalyze/frontend/src/styles/`

- [ ] **Step 1: 复制 5 个 CSS 文件**

```bash
mkdir -p /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/styles
DA_STYLES=/mnt/d/code/deepanalyze/deepanalyze/frontend/src/styles

for f in design-tokens.css themes.css base.css animations.css markdown.css; do
  cp "$DA_STYLES/$f" /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/styles/
done

# 检查 Button.tsx 等组件引用的 hover class 是否在 themes.css/base.css 中有定义
grep -l "btn-hover\|da-button" /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/styles/*.css || echo "no hover classes found in CSS — need to add"
```

如果 `grep` 输出 "no hover classes found"，在 `base.css` 末尾追加按钮 hover 样式：

```css
/* Button hover styles (ported from DA) */
.btn-hover-primary:hover { filter: brightness(0.95); }
.btn-hover-primary:active { filter: brightness(0.9); }
.btn-hover-secondary:hover { background: var(--bg-hover); }
.btn-hover-secondary:active { background: var(--bg-active); }
.btn-hover-ghost:hover { background: var(--bg-hover); }
.btn-hover-ghost:active { background: var(--bg-active); }
.btn-hover-danger:hover { filter: brightness(0.95); }
.btn-hover-danger:active { filter: brightness(0.9); }
```

- [ ] **Step 2: 修改 main.tsx 引入 CSS**

```typescript
// deepanalyze-hub/frontend/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles/design-tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/animations.css";
import "./styles/markdown.css";
import App from "./App.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

- [ ] **Step 3: 启动前端验证无 CSS 加载错误**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npm run dev &
sleep 3
curl -s http://localhost:5173/ | head -20
```

Expected: HTML 返回正常，浏览器控制台无 404 CSS 错误。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/styles/ src/main.tsx
git commit -m "feat: port DA design tokens, themes, base, animations, markdown CSS"
```

---

### Task C3：移植 cn 工具 + Spinner + 15 个 UI 组件

**Files:**
- Create: `deepanalyze-hub/frontend/src/utils/cn.ts`
- Create: `deepanalyze-hub/frontend/src/components/ui/Spinner.tsx`（Button 的依赖，先移植）
- Create: 15 个组件到 `deepanalyze-hub/frontend/src/components/ui/`

**源目录**：`/mnt/d/code/deepanalyze/deepanalyze/frontend/src/components/ui/`

- [ ] **Step 1: 复制 cn 工具**

```bash
mkdir -p /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/utils
cp /mnt/d/code/deepanalyze/deepanalyze/frontend/src/utils/cn.ts \
   /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/utils/cn.ts
cat /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/utils/cn.ts
```

确认 `cn.ts` 内容是 `clsx` + `twMerge` 组合，还是仅 `clsx`。如果是 `twMerge`（tailwind-merge），Hub 没有 Tailwind，需要简化为只 `clsx`。

- [ ] **Step 2: 逐个复制 UI 组件**

```bash
DA_UI=/mnt/d/code/deepanalyze/deepanalyze/frontend/src/components/ui
HUB_UI=/mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/components/ui
mkdir -p "$HUB_UI"

# 按依赖顺序复制：先 Spinner（无依赖），再其他
for f in Spinner Button Badge Input TextArea Select Modal Toast Tooltip Tabs EmptyState Skeleton ConfirmDialog SearchBar DropZone ThemeToggle; do
  cp "$DA_UI/$f.tsx" "$HUB_UI/$f.tsx"
  echo "✓ $f.tsx"
done
```

- [ ] **Step 3: 检查并修复导入路径**

DA 组件用 `../../utils/cn` 和 `./Spinner` 等相对路径。Hub 目录结构一致（utils 在 `src/utils/`，组件在 `src/components/ui/`），所以相对路径无需修改。

但需要检查每个组件是否有**其他依赖**（如 DA 特有的 utils/hooks）：

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
# 列出所有非标准 import
grep -rn "^import.*from" src/components/ui/ | grep -v "react\|../../utils/cn\|./Spinner\|lucide-react\|clsx" | sort -u
```

对于每个非标准 import，要么从 DA 复制对应文件，要么注释掉（如果非必需）。

- [ ] **Step 4: TypeScript 编译检查**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npx tsc --noEmit 2>&1 | head -30
```

逐个修复编译错误（通常是缺少依赖或 React 18/19 API 差异）。

- [ ] **Step 5: 验证构建**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npm run build 2>&1 | tail -10
```

Expected: 构建成功。

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/utils/cn.ts src/components/ui/
git commit -m "feat: port 16 UI components (Spinner + Button + 14 others) from DA"
```

---

### Task C4：新建 5 个 Hub 专属组件

**Files:**
- Create: `deepanalyze-hub/frontend/src/components/hub/StatusBadge.tsx`
- Create: `deepanalyze-hub/frontend/src/components/hub/SkillCard.tsx`
- Create: `deepanalyze-hub/frontend/src/components/hub/OrgTreeNode.tsx`
- Create: `deepanalyze-hub/frontend/src/components/hub/AuditTimeline.tsx`
- Create: `deepanalyze-hub/frontend/src/components/hub/PermissionMatrix.tsx`

- [ ] **Step 1: 创建 StatusBadge**

```typescript
// deepanalyze-hub/frontend/src/components/hub/StatusBadge.tsx
import { Badge } from "../ui/Badge";

const STATUS_CONFIG: Record<string, { variant: string; label: string }> = {
  online:   { variant: "success", label: "在线" },
  offline:  { variant: "neutral",  label: "离线" },
  pending:  { variant: "warning", label: "待审批" },
  approved: { variant: "success", label: "已批准" },
  rejected: { variant: "danger",  label: "已拒绝" },
  draining: { variant: "warning", label: "排水" },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { variant: "neutral", label: status };
  return <Badge variant={cfg.variant as any}>{cfg.label}</Badge>;
}
```

- [ ] **Step 2: 创建 SkillCard**

```typescript
// deepanalyze-hub/frontend/src/components/hub/SkillCard.tsx
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";

export interface SkillCardData {
  id: string;
  name: string;
  display_name: string;
  description: string;
  scope: "system" | "org" | "user";
  category: string;
  tags: string[];
  icon: string;
  version: string;
  trust_level: string;
  author_name: string;
  subscriptions: number;
  is_kill_switched: boolean;
}

const SCOPE_VARIANT: Record<string, string> = {
  system: "danger",
  org: "info",
  user: "success",
};

const SCOPE_LABEL: Record<string, string> = {
  system: "系统级",
  org: "组织级",
  user: "用户级",
};

export function SkillCard({
  skill,
  onSubscribe,
  onDetail,
}: {
  skill: SkillCardData;
  onSubscribe?: () => void;
  onDetail?: () => void;
}) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-xl)",
        padding: "var(--space-5)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        cursor: "pointer",
        transition: "all var(--transition-fast)",
        opacity: skill.is_kill_switched ? 0.6 : 1,
      }}
      onClick={onDetail}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--brand-primary)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
    >
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
        <div style={{
          width: 44, height: 44, borderRadius: "var(--radius-lg)",
          background: "var(--bg-tertiary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 24, flexShrink: 0,
        }}>
          {skill.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: 2 }}>
            <span style={{ fontSize: "var(--text-lg)", fontWeight: 600, color: "var(--text-primary)" }}>
              {skill.display_name}
            </span>
            <Badge variant={SCOPE_VARIANT[skill.scope] as any} size="sm">
              {SCOPE_LABEL[skill.scope]}
            </Badge>
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
            {skill.name} · v{skill.version}
          </div>
        </div>
      </div>

      <p style={{
        fontSize: "var(--text-sm)", color: "var(--text-secondary)",
        lineHeight: "var(--leading-normal)",
        overflow: "hidden", textOverflow: "ellipsis",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        margin: 0,
      }}>
        {skill.description}
      </p>

      <div style={{ display: "flex", gap: "var(--space-1)", flexWrap: "wrap" }}>
        {skill.tags.map((tag) => (
          <span key={tag} style={{
            fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
            background: "var(--bg-tertiary)", padding: "2px var(--space-2)",
            borderRadius: "var(--radius-sm)",
          }}>
            {tag}
          </span>
        ))}
      </div>

      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        paddingTop: "var(--space-3)", borderTop: "1px solid var(--border-secondary)",
      }}>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
          维护：{skill.author_name} · {skill.subscriptions} 订阅
        </span>
        {onSubscribe && !skill.is_kill_switched && (
          <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); onSubscribe(); }}>
            订阅
          </Button>
        )}
        {skill.is_kill_switched && (
          <Badge variant="danger" size="sm">已禁用</Badge>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 创建 OrgTreeNode**

```typescript
// deepanalyze-hub/frontend/src/components/hub/OrgTreeNode.tsx
import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Badge } from "../ui/Badge";

export interface OrgTreeNodeData {
  id: string;
  name: string;
  code: string;
  type: string;
  level: number;
  user_count?: number;
  children?: OrgTreeNodeData[];
}

const TYPE_ICON: Record<string, string> = {
  company: "🏢",
  department: "📁",
  team: "👥",
};

const TYPE_VARIANT: Record<string, string> = {
  company: "info",
  department: "neutral",
  team: "success",
};

export function OrgTreeNode({
  node,
  selectedId,
  onSelect,
  defaultExpanded = true,
}: {
  node: OrgTreeNodeData;
  selectedId?: string;
  onSelect?: (node: OrgTreeNodeData) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          background: isSelected ? "var(--brand-primary-bg)" : "transparent",
          marginLeft: node.level * 24,
          transition: "background var(--transition-fast)",
        }}
        onClick={() => onSelect?.(node)}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : (
          <span style={{ width: 16 }} />
        )}
        <span style={{ fontSize: 18 }}>{TYPE_ICON[node.type] ?? "📂"}</span>
        <span style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>
          {node.name}
        </span>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
          {node.code}
        </span>
        <Badge variant={TYPE_VARIANT[node.type] as any} size="sm">
          {node.type}
        </Badge>
        {node.user_count != null && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            {node.user_count}人
          </span>
        )}
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              defaultExpanded={defaultExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 创建 AuditTimeline**

```typescript
// deepanalyze-hub/frontend/src/components/hub/AuditTimeline.tsx

export interface AuditEntry {
  id: string;
  actor_name: string;
  action: string;
  from_status?: string | null;
  to_status?: string | null;
  details?: Record<string, unknown>;
  created_at: string;
}

const ACTION_LABELS: Record<string, string> = {
  version_created: "创建版本",
  status_changed: "状态变更",
  kill_switched: "紧急禁用",
  unkill_switched: "解除禁用",
  subscribed: "订阅",
  unsubscribed: "取消订阅",
  sharing_requested: "发起共享",
  sharing_approved: "批准共享",
  sharing_rejected: "拒绝共享",
  sharing_revoked: "撤销共享",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}

export function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <div style={{ padding: "var(--space-8)", textAlign: "center", color: "var(--text-tertiary)" }}>
        暂无审计记录
      </div>
    );
  }
  return (
    <div style={{ position: "relative", paddingLeft: "var(--space-5)" }}>
      <div style={{
        position: "absolute", left: 7, top: 8, bottom: 8, width: 2,
        background: "var(--border-secondary)",
      }} />
      {entries.map((entry, i) => (
        <div key={entry.id} style={{
          position: "relative", paddingBottom: i === entries.length - 1 ? 0 : "var(--space-5)",
        }}>
          <div style={{
            position: "absolute", left: -22, top: 4, width: 12, height: 12,
            borderRadius: "50%", background: "var(--brand-primary)",
            border: "2px solid var(--bg-card)",
          }} />
          <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)" }}>
            {ACTION_LABELS[entry.action] ?? entry.action}
            {entry.to_status && (
              <span style={{ marginLeft: "var(--space-2)", color: "var(--text-tertiary)" }}>
                → {entry.to_status}
              </span>
            )}
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 2 }}>
            {entry.actor_name} · {formatTime(entry.created_at)}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: 创建 PermissionMatrix**

```typescript
// deepanalyze-hub/frontend/src/components/hub/PermissionMatrix.tsx
import { useState } from "react";

export interface PermissionDef {
  code: string;
  resource: string;
  description: string;
}

export interface RolePermRow {
  role_id: string;
  role_name: string;
  permissions: string[]; // array of permission codes
}

export function PermissionMatrix({
  permissions,
  roles,
}: {
  permissions: PermissionDef[];
  roles: RolePermRow[];
}) {
  const [filter, setFilter] = useState("");
  const filteredPerms = permissions.filter(p =>
    p.code.includes(filter) || p.resource.includes(filter) || p.description.includes(filter),
  );

  const resources = Array.from(new Set(filteredPerms.map(p => p.resource)));

  return (
    <div>
      <input
        placeholder="搜索权限..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{
          padding: "var(--space-2) var(--space-3)", marginBottom: "var(--space-3)",
          borderRadius: "var(--radius-md)", border: "1px solid var(--border-primary)",
          width: "100%", fontSize: "var(--text-sm)",
        }}
      />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--border-secondary)" }}>
              <th style={{ textAlign: "left", padding: "var(--space-2) var(--space-3)", color: "var(--text-secondary)" }}>
                权限
              </th>
              {roles.map(r => (
                <th key={r.role_id} style={{
                  textAlign: "center", padding: "var(--space-2) var(--space-3)",
                  color: "var(--text-secondary)", minWidth: 100,
                }}>
                  {r.role_name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {resources.map(res => (
              <>
                <tr key={`hdr-${res}`}>
                  <td colSpan={roles.length + 1} style={{
                    padding: "var(--space-2) var(--space-3)", background: "var(--bg-tertiary)",
                    fontWeight: 600, color: "var(--text-primary)",
                  }}>
                    {res}
                  </td>
                </tr>
                {filteredPerms.filter(p => p.resource === res).map(p => (
                  <tr key={p.code} style={{ borderBottom: "1px solid var(--border-secondary)" }}>
                    <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--text-primary)" }}>
                      <code style={{ fontSize: "var(--text-xs)" }}>{p.code}</code>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                        {p.description}
                      </div>
                    </td>
                    {roles.map(r => {
                      const has = r.permissions.includes(p.code);
                      return (
                        <td key={r.role_id} style={{ textAlign: "center", padding: "var(--space-2)" }}>
                          {has ? "✅" : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: TypeScript 编译验证**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npx tsc --noEmit 2>&1 | head -20
```

修复任何编译错误。

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/components/hub/
git commit -m "feat: 5 Hub-specific components (StatusBadge, SkillCard, OrgTreeNode, AuditTimeline, PermissionMatrix)"
```

---

### Task C5：重写 App Shell

**Files:**
- Modify: `deepanalyze-hub/frontend/src/App.tsx`

- [ ] **Step 1: 读取当前 App.tsx**

```bash
cat /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/App.tsx
```

关注：`Layout` 组件、`ProtectedRoute`、路由列表。

- [ ] **Step 2: 重写 App.tsx**

```typescript
// deepanalyze-hub/frontend/src/App.tsx
import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Search, LogOut, User as UserIcon } from "lucide-react";
import { api, type MeResponse } from "./api/client.js";
import { ThemeToggle } from "./components/ui/ThemeToggle.js";
import { Login } from "./pages/Login.js";
import { Dashboard } from "./pages/Dashboard.js";
import { OrgTree } from "./pages/OrgTree.js";
import { UserList } from "./pages/UserList.js";
import { WorkerApproval } from "./pages/WorkerApproval.js";
import { Skills } from "./pages/Skills.js";
import { SkillDetail } from "./pages/SkillDetail.js";
import { Sharings } from "./pages/Sharings.js";
import { Security } from "./pages/Security.js";

const NAV_ITEMS = [
  { to: "/", label: "仪表盘", icon: "📊" },
  { to: "/orgs", label: "组织树", icon: "🏢" },
  { to: "/users", label: "用户", icon: "👥" },
  { to: "/skills", label: "Skills 市场", icon: "📦" },
  { to: "/sharings", label: "跨组织共享", icon: "🔄" },
  { to: "/workers", label: "Worker 审批", icon: "🖥️" },
  { to: "/security", label: "安全网关", icon: "🛡️" },
];

function Sidebar({
  collapsed, onToggle, currentPath,
}: {
  collapsed: boolean; onToggle: () => void; currentPath: string;
}) {
  return (
    <aside style={{
      width: collapsed ? 64 : 240,
      background: "var(--bg-sidebar, #0f172a)",
      color: "var(--text-on-dark, #e2e8f0)",
      display: "flex", flexDirection: "column",
      transition: "width var(--transition-base)",
      flexShrink: 0,
      fontFamily: "var(--font-sans)",
    }}>
      <div style={{
        padding: "var(--space-5) var(--space-4)",
        display: "flex", alignItems: "center", gap: "var(--space-3)",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
      }}>
        <span style={{ fontSize: 24 }}>🧭</span>
        {!collapsed && (
          <span style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>
            DeepAnalyze Hub
          </span>
        )}
      </div>
      <nav style={{ flex: 1, padding: "var(--space-3) 0" }}>
        {NAV_ITEMS.map((item) => {
          const active = currentPath === item.to ||
            (item.to !== "/" && currentPath.startsWith(item.to));
          return (
            <Link key={item.to} to={item.to} style={{
              display: "flex", alignItems: "center", gap: "var(--space-3)",
              padding: "var(--space-3) var(--space-4)",
              textDecoration: "none",
              color: active ? "#ffffff" : "rgba(226,232,240,0.7)",
              background: active ? "rgba(255,255,255,0.1)" : "transparent",
              borderLeft: active ? "3px solid #3b82f6" : "3px solid transparent",
              fontSize: "var(--text-sm)",
              transition: "all var(--transition-fast)",
            }}>
              <span style={{ fontSize: 18 }}>{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>
      <button onClick={onToggle} style={{
        padding: "var(--space-3)", background: "rgba(255,255,255,0.05)",
        border: "none", color: "rgba(226,232,240,0.7)", cursor: "pointer",
        display: "flex", justifyContent: "center",
      }}>
        {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
      </button>
    </aside>
  );
}

function Header({ user, onLogout }: { user: MeResponse; onLogout: () => void }) {
  const location = useLocation();
  const navItem = NAV_ITEMS.find(n =>
    n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to),
  );

  return (
    <header style={{
      height: 56,
      background: "var(--bg-card, #ffffff)",
      borderBottom: "1px solid var(--border-primary, #e5e7eb)",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 var(--space-6)",
      flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ fontSize: "var(--text-lg)" }}>{navItem?.icon}</span>
        <span style={{ fontSize: "var(--text-base)", fontWeight: 500, color: "var(--text-primary, #1f2937)" }}>
          {navItem?.label ?? "页面"}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
        <button style={{
          display: "flex", alignItems: "center", gap: "var(--space-2)",
          padding: "var(--space-2) var(--space-3)",
          background: "var(--bg-tertiary, #f3f4f6)",
          border: "1px solid var(--border-primary, #e5e7eb)",
          borderRadius: "var(--radius-md)",
          color: "var(--text-tertiary, #6b7280)",
          fontSize: "var(--text-sm)", cursor: "pointer",
        }}>
          <Search size={14} />
          <span>搜索...</span>
          <kbd style={{ fontSize: 10, background: "var(--bg-secondary)", padding: "1px 4px", borderRadius: 3 }}>
            ⌘K
          </kbd>
        </button>
        <ThemeToggle />
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            background: "var(--brand-primary, #3b82f6)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "var(--text-sm)", fontWeight: 600,
          }}>
            {(user.display_name || user.username).charAt(0).toUpperCase()}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-primary, #1f2937)" }}>
              {user.display_name || user.username}
            </span>
            {user.is_super_admin && (
              <span style={{ fontSize: 10, color: "#dc2626" }}>超级管理员</span>
            )}
          </div>
          <button onClick={onLogout} style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-tertiary, #6b7280)", padding: "var(--space-1)",
          }}>
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}

function Layout({
  user, onLogout, children,
}: {
  user: MeResponse; onLogout: () => void; children: React.ReactNode;
}) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem("hub_sidebar_collapsed") === "true",
  );

  useEffect(() => {
    localStorage.setItem("hub_sidebar_collapsed", String(collapsed));
  }, [collapsed]);

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        currentPath={location.pathname}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Header user={user} onLogout={onLogout} />
        <main style={{
          flex: 1, background: "var(--bg-page, #f8fafc)",
          padding: "var(--space-6)", maxWidth: 1400, width: "100%",
          margin: "0 auto", overflowY: "auto",
        }}>
          {children}
        </main>
      </div>
    </div>
  );
}

function ProtectedRoute({
  user, setUser, children,
}: {
  user: MeResponse | null; setUser: (u: MeResponse | null) => void; children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(!user);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem("hub_access_token");
    if (!token) { navigate("/login"); return; }
    if (!user) {
      api.me()
        .then((u) => { setUser(u); setLoading(false); })
        .catch(() => {
          localStorage.removeItem("hub_access_token");
          navigate("/login");
        });
    }
  }, [user, setUser, navigate]);

  if (loading || !user) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>加载中...</div>;
  }

  return (
    <Layout user={user} onLogout={() => {
      localStorage.removeItem("hub_access_token");
      setUser(null);
      navigate("/login");
    }}>
      {children}
    </Layout>
  );
}

export default function App() {
  const [user, setUser] = useState<MeResponse | null>(null);
  return (
    <Routes>
      <Route path="/login" element={<Login onLogin={setUser} />} />
      <Route path="/" element={<ProtectedRoute user={user} setUser={setUser}><Dashboard /></ProtectedRoute>} />
      <Route path="/orgs" element={<ProtectedRoute user={user} setUser={setUser}><OrgTree /></ProtectedRoute>} />
      <Route path="/users" element={<ProtectedRoute user={user} setUser={setUser}><UserList /></ProtectedRoute>} />
      <Route path="/workers" element={<ProtectedRoute user={user} setUser={setUser}><WorkerApproval /></ProtectedRoute>} />
      <Route path="/skills" element={<ProtectedRoute user={user} setUser={setUser}><Skills user={user!} /></ProtectedRoute>} />
      <Route path="/skills/:id" element={<ProtectedRoute user={user} setUser={setUser}><SkillDetail user={user!} /></ProtectedRoute>} />
      <Route path="/sharings" element={<ProtectedRoute user={user} setUser={setUser}><Sharings /></ProtectedRoute>} />
      <Route path="/security" element={<ProtectedRoute user={user} setUser={setUser}><Security /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
```

- [ ] **Step 3: 确认 themes.css 含 sidebar/header 语义 token**

检查 `themes.css` 是否定义了 `--bg-sidebar`、`--bg-card`、`--bg-page`、`--brand-primary` 等。如果没有，在 `themes.css` 的 `:root` 和 `[data-theme="dark"]` 中补充：

```css
:root {
  --bg-sidebar: #0f172a;
  --bg-card: #ffffff;
  --bg-page: #f8fafc;
  --bg-hover: rgba(0,0,0,0.04);
  --bg-active: rgba(0,0,0,0.08);
  --brand-primary: #3b82f6;
  --brand-primary-bg: rgba(59,130,246,0.1);
  --brand-foreground: #ffffff;
  --text-primary: #1f2937;
  --text-secondary: #4b5563;
  --text-tertiary: #6b7280;
  --text-on-dark: #e2e8f0;
  --border-primary: #e5e7eb;
  --border-secondary: #f3f4f6;
  --error: #ef4444;
  --success: #10b981;
  --warning: #f59e0b;
  --info: #3b82f6;
}

[data-theme="dark"] {
  --bg-sidebar: #020617;
  --bg-card: #1e293b;
  --bg-page: #0f172a;
  --bg-hover: rgba(255,255,255,0.06);
  --bg-active: rgba(255,255,255,0.12);
  --text-primary: #f1f5f9;
  --text-secondary: #cbd5e1;
  --text-tertiary: #94a3b8;
  --border-primary: #334155;
  --border-secondary: #1e293b;
}
```

- [ ] **Step 4: 启动前端验证**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npm run dev &
sleep 3
# 打开 http://localhost:5173 登录查看新 Shell
```

- [ ] **Step 5: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/App.tsx src/styles/themes.css
git commit -m "feat: rewrite App Shell — collapsible sidebar + header with search/theme toggle/avatar"
```

---

## Phase D：页面重写

### Task D1：重写 Dashboard

**Files:**
- Modify: `deepanalyze-hub/frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: 读取当前 Dashboard.tsx**

```bash
cat /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/pages/Dashboard.tsx
```

- [ ] **Step 2: 重写为 4 统计卡 + 活动流 + 快速操作**

```typescript
// deepanalyze-hub/frontend/src/pages/Dashboard.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Package, Building2, Server, Share2, AlertCircle } from "lucide-react";
import { api } from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";

interface Stats {
  orgCount: number;
  userCount: number;
  skillCount: number;
  workerOnline: number;
  workerTotal: number;
  sharingCount: number;
  pendingWorkers: number;
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.getOrgs(), api.getUsers(), api.getRaw("/skills"),
      api.getAllWorkers(), api.getPendingWorkers(), api.listSharings({}),
    ]).then(([orgs, users, skills, workers, pending, sharings]) => {
      const workerList = workers.status === "fulfilled" ? workers.value : [];
      setStats({
        orgCount: orgs.status === "fulfilled" ? orgs.value.length : 0,
        userCount: users.status === "fulfilled" ? users.value.users.length : 0,
        skillCount: skills.status === "fulfilled" ? (skills.value?.items?.length ?? 0) : 0,
        workerOnline: Array.isArray(workerList) ? workerList.filter(w => w.status === "online").length : 0,
        workerTotal: Array.isArray(workerList) ? workerList.length : 0,
        sharingCount: sharings.status === "fulfilled" ? sharings.value.length : 0,
        pendingWorkers: pending.status === "fulfilled" ? pending.value.length : 0,
      });
      setLoading(false);
    });
  }, []);

  if (loading || !stats) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>加载中...</div>;
  }

  const cards = [
    { label: "组织数", value: stats.orgCount, icon: <Building2 size={20} />, color: "#3b82f6", link: "/orgs" },
    { label: "Skill 包", value: stats.skillCount, icon: <Package size={20} />, color: "#8b5cf6", link: "/skills" },
    { label: "Worker", value: `${stats.workerOnline}/${stats.workerTotal}`, icon: <Server size={20} />, color: "#10b981", link: "/workers" },
    { label: "跨组织共享", value: stats.sharingCount, icon: <Share2 size={20} />, color: "#f59e0b", link: "/sharings" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      {stats.pendingWorkers > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: "var(--space-3)",
          padding: "var(--space-4)", borderRadius: "var(--radius-lg)",
          background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)",
        }}>
          <AlertCircle size={20} color="#f59e0b" />
          <span style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>
            有 <strong>{stats.pendingWorkers}</strong> 个 Worker 待审批
          </span>
          <Link to="/workers"><Button size="sm" variant="secondary">去审批</Button></Link>
        </div>
      )}

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220, 1fr))", gap: "var(--space-4)",
      }}>
        {cards.map(c => (
          <Link key={c.label} to={c.link} style={{ textDecoration: "none" }}>
            <div style={{
              background: "var(--bg-card)", border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-xl)", padding: "var(--space-5)",
              display: "flex", alignItems: "center", gap: "var(--space-4)",
              transition: "all var(--transition-fast)",
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: "var(--radius-lg)",
                background: `${c.color}15`, color: c.color,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {c.icon}
              </div>
              <div>
                <div style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--text-primary)" }}>
                  {c.value}
                </div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                  {c.label}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-xl)", padding: "var(--space-5)",
      }}>
        <h3 style={{ fontSize: "var(--text-lg)", fontWeight: 600, margin: "0 0 var(--space-4)", color: "var(--text-primary)" }}>
          快速操作
        </h3>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <Link to="/skills"><Button variant="primary" icon={<Package size={16} />}>创建 Skill</Button></Link>
          <Link to="/orgs"><Button variant="secondary" icon={<Building2 size={16} />}>新建组织</Button></Link>
          <Link to="/users"><Button variant="secondary">添加用户</Button></Link>
          <Link to="/security"><Button variant="ghost">Kill Switch</Button></Link>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 启动验证**

```bash
# 前端已在运行
# 打开 http://localhost:5173 登录后查看 Dashboard
# 应看到 4 张统计卡 + 待审批提醒（如果有）+ 快速操作
```

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/pages/Dashboard.tsx
git commit -m "feat: rewrite Dashboard — 4 stat cards + pending alert + quick actions"
```

---

### Task D2：重写 Skills 市场页

**Files:**
- Modify: `deepanalyze-hub/frontend/src/pages/Skills.tsx`
- Modify: `deepanalyze-hub/frontend/src/api/client.ts`

- [ ] **Step 1: 在 client.ts 中扩展 SkillPackageV2 类型**

找到 `SkillPackageV2` interface，添加：

```typescript
export interface SkillPackageV2 {
  id: string;
  name: string;
  slug: string;
  display_name: string;        // 新增
  description: string;         // 改为非空
  scope: "system" | "org" | "user";
  category: string;            // 新增
  tags: string[];
  icon: string;                // 新增
  trust_level: string;         // 新增
  author_name?: string;        // 新增
  stats: { downloads: number; subscriptions: number; rating_avg: number };
  is_kill_switched: boolean;
  active_version?: string;     // 新增
  created_at: string;
}
```

- [ ] **Step 2: 重写 Skills.tsx**

```typescript
// deepanalyze-hub/frontend/src/pages/Skills.tsx
import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api, type MeResponse, type SkillPackageV2 } from "../api/client.js";
import { SkillCard, type SkillCardData } from "../components/hub/SkillCard.js";
import { SearchBar } from "../components/ui/SearchBar.js";
import { Badge } from "../components/ui/Badge.js";
import { EmptyState } from "../components/ui/EmptyState.js";

const CATEGORIES = ["全部", "engineering", "writing", "operations", "business", "security", "productivity"];

function toCardData(pkg: SkillPackageV2): SkillCardData {
  return {
    id: pkg.id,
    name: pkg.name,
    display_name: pkg.display_name || pkg.name,
    description: pkg.description ?? "",
    scope: pkg.scope,
    category: pkg.category ?? "general",
    tags: pkg.tags ?? [],
    icon: pkg.icon ?? "📦",
    version: pkg.active_version ?? "—",
    trust_level: pkg.trust_level ?? "community",
    author_name: pkg.author_name ?? "未知",
    subscriptions: pkg.stats?.subscriptions ?? 0,
    is_kill_switched: pkg.is_kill_switched,
  };
}

export function Skills({ user }: { user: MeResponse }) {
  const navigate = useNavigate();
  const [packages, setPackages] = useState<SkillPackageV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");

  useEffect(() => {
    api.getRaw<{ items: SkillPackageV2[] }>("/skills")
      .then((data) => { setPackages(data.items ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = packages;
    if (category !== "全部") list = list.filter(p => p.category === category);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.display_name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.tags?.some((t: string) => t.includes(q)),
      );
    }
    return list;
  }, [packages, search, category]);

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>加载中...</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <SearchBar placeholder="搜索 Skill 包..." value={search} onChange={setSearch} />
        </div>
      </div>

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            style={{
              padding: "var(--space-2) var(--space-3)",
              borderRadius: "var(--radius-full)",
              border: category === cat ? "1px solid var(--brand-primary)" : "1px solid var(--border-primary)",
              background: category === cat ? "var(--brand-primary-bg)" : "var(--bg-card)",
              color: category === cat ? "var(--brand-primary)" : "var(--text-secondary)",
              fontSize: "var(--text-xs)", cursor: "pointer",
              transition: "all var(--transition-fast)",
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-tertiary)" }}>
        共 {filtered.length} 个 Skill 包
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="未找到匹配的 Skill" description="尝试调整搜索条件或切换分类" />
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: "var(--space-4)",
        }}>
          {filtered.map(pkg => (
            <SkillCard
              key={pkg.id}
              skill={toCardData(pkg)}
              onDetail={() => navigate(`/skills/${pkg.id}`)}
              onSubscribe={() => api.subscribeSkill(pkg.id).then(() => location.reload())}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 后端适配 — 确保 `/skills` 返回新字段**

检查 `deepanalyze-hub/src/server/routes/skills.ts` 的 `GET /` 列表接口，确保 SELECT 包含 `display_name, category, icon, trust_level` 和 join 作者名。如缺少，在 domain 层 `listPackagesForUser` 的 SELECT 中补上。

- [ ] **Step 4: 启动验证**

```bash
# 确保 seed 已运行，前端访问 /skills
# 应看到 6 张 SkillCard（含真实图标/分类/描述/标签）
```

- [ ] **Step 5: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/pages/Skills.tsx src/api/client.ts
git commit -m "feat: rewrite Skills marketplace — card grid + category filter + search"
```

---

### Task D3：新建 SkillDetail 页

**Files:**
- Create: `deepanalyze-hub/frontend/src/pages/SkillDetail.tsx`

- [ ] **Step 1: 创建 SkillDetail.tsx**

```typescript
// deepanalyze-hub/frontend/src/pages/SkillDetail.tsx
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Download, Bell, BellOff, Ban } from "lucide-react";
import { api, type MeResponse, type SkillPackageV2 } from "../api/client.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Tabs } from "../components/ui/Tabs.js";
import { ConfirmDialog } from "../components/ui/ConfirmDialog.js";
import { AuditTimeline, type AuditEntry } from "../components/hub/AuditTimeline.js";

const SCOPE_LABEL: Record<string, string> = { system: "系统级", org: "组织级", user: "用户级" };
const SCOPE_VARIANT: Record<string, string> = { system: "danger", org: "info", user: "success" };

export function SkillDetail({ user }: { user: MeResponse }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pkg, setPkg] = useState<SkillPackageV2 | null>(null);
  const [version, setVersion] = useState<{ content: string; version: string; change_summary: string } | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showKill, setShowKill] = useState(false);
  const [activeTab, setActiveTab] = useState("content");

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getRaw<SkillPackageV2>(`/skills/${id}`),
      api.getRaw<{ items: any[] }>(`/skills/${id}/versions`).then(v => v.items?.[0] ?? null),
      api.getRaw<{ items: AuditEntry[] }>(`/skills/${id}/audit`).catch(() => ({ items: [] })),
    ]).then(([p, v, a]) => {
      setPkg(p);
      setVersion(v);
      setAudit(a.items ?? []);
      setLoading(false);
    });
  }, [id]);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>加载中...</div>;
  if (!pkg) return <div style={{ padding: 40, textAlign: "center" }}>未找到 Skill</div>;

  return (
    <div>
      <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => navigate("/skills")}>
        返回列表
      </Button>

      {/* Hero */}
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-xl)", padding: "var(--space-6)", margin: "var(--space-4) 0",
      }}>
        <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "flex-start" }}>
          <div style={{
            width: 64, height: 64, borderRadius: "var(--radius-xl)",
            background: "var(--bg-tertiary)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 32,
          }}>
            {pkg.icon ?? "📦"}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>
                {pkg.display_name ?? pkg.name}
              </h1>
              <Badge variant={SCOPE_VARIANT[pkg.scope] as any}>{SCOPE_LABEL[pkg.scope]}</Badge>
              {pkg.is_kill_switched && <Badge variant="danger">已禁用</Badge>}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", marginTop: 4 }}>
              {pkg.name} · v{version?.version ?? "—"} · {pkg.trust_level}
            </div>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "var(--space-3)", lineHeight: "var(--leading-relaxed)" }}>
              {pkg.description}
            </p>
            <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
              {!pkg.is_kill_switched && (
                <Button icon={<Bell size={16} />} onClick={() => api.subscribeSkill(pkg.id).then(() => location.reload())}>
                  订阅
                </Button>
              )}
              <Button variant="secondary" icon={<Download size={16} />} onClick={() => navigate("/sharings")}>
                共享
              </Button>
              {(user.is_super_admin || user.permissions?.includes("skill:kill")) && !pkg.is_kill_switched && (
                <Button variant="danger" icon={<Ban size={16} />} onClick={() => setShowKill(true)}>
                  Kill Switch
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        tabs={[
          { key: "content", label: "内容预览" },
          { key: "version", label: "版本历史" },
          { key: "audit", label: "审计日志" },
          { key: "stats", label: "使用统计" },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-xl)", padding: "var(--space-5)", marginTop: "var(--space-3)",
      }}>
        {activeTab === "content" && version && (
          <div className="markdown-body" style={{ fontSize: "var(--text-sm)" }}>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", margin: 0 }}>
              {version.content}
            </pre>
          </div>
        )}
        {activeTab === "version" && version && (
          <div>
            <strong>v{version.version}</strong>
            <p style={{ color: "var(--text-secondary)", marginTop: "var(--space-2)" }}>
              {version.change_summary}
            </p>
          </div>
        )}
        {activeTab === "audit" && <AuditTimeline entries={audit} />}
        {activeTab === "stats" && (
          <div style={{ color: "var(--text-tertiary)" }}>使用统计待接入</div>
        )}
      </div>

      <ConfirmDialog
        open={showKill}
        title="确认 Kill Switch"
        message={`确定要禁用「${pkg.display_name ?? pkg.name}」吗？所有已订阅的 Worker 将停止使用此 Skill。`}
        confirmLabel="确认禁用"
        variant="danger"
        onConfirm={() => {
          api.killSwitchSkill(pkg.id, "手动禁用").then(() => { setShowKill(false); location.reload(); });
        }}
        onCancel={() => setShowKill(false)}
      />
    </div>
  );
}
```

注意：此文件使用了 `Tabs` 和 `ConfirmDialog` 组件。如果它们的 props 与上面的用法不一致（如 `tabs` prop 格式），请读取实际组件源码调整。

- [ ] **Step 2: TypeScript 编译验证**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npx tsc --noEmit 2>&1 | grep SkillDetail
```

- [ ] **Step 3: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/pages/SkillDetail.tsx
git commit -m "feat: new SkillDetail page — hero + 4 tabs (content/version/audit/stats)"
```

---

### Task D4：重写 OrgTree 页

**Files:**
- Modify: `deepanalyze-hub/frontend/src/pages/OrgTree.tsx`

- [ ] **Step 1: 读取当前 OrgTree.tsx**

```bash
cat /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/pages/OrgTree.tsx
```

- [ ] **Step 2: 重写为折叠树 + 详情侧栏**

```typescript
// deepanalyze-hub/frontend/src/pages/OrgTree.tsx
import { useEffect, useState } from "react";
import { api, type OrgNode } from "../api/client.js";
import { OrgTreeNode, type OrgTreeNodeData } from "../components/hub/OrgTreeNode.js";
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";

function toTreeNode(node: OrgNode): OrgTreeNodeData {
  return {
    id: node.id,
    name: node.name,
    code: node.code,
    type: node.type,
    level: node.level,
    user_count: node.user_count,
    children: node.children?.map(toTreeNode),
  };
}

export function OrgTree() {
  const [tree, setTree] = useState<OrgNode[]>([]);
  const [selected, setSelected] = useState<OrgNode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getOrgTree().then((data) => { setTree(data); setLoading(false); });
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)" }}>加载中...</div>;

  const selectedNode = selected ?? tree[0];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "var(--space-4)" }}>
      {/* 左侧：树 */}
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-xl)", padding: "var(--space-4)",
      }}>
        {tree.map((root) => (
          <OrgTreeNode
            key={root.id}
            node={toTreeNode(root)}
            selectedId={selectedNode?.id}
            onSelect={(n) => {
              // 在原始 tree 中找到对应的 OrgNode（含完整数据）
              const find = (nodes: OrgNode[]): OrgNode | undefined =>
                nodes.find(x => x.id === n.id) ?? nodes.flatMap(x => x.children ?? []).map(c => find([c])).find(Boolean);
              const found = find([root]);
              if (found) setSelected(found);
            }}
          />
        ))}
      </div>

      {/* 右侧：详情侧栏 */}
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-xl)", padding: "var(--space-5)",
        height: "fit-content", position: "sticky", top: "var(--space-6)",
      }}>
        {selectedNode && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
              <span style={{ fontSize: 24 }}>{selectedNode.type === "company" ? "🏢" : selectedNode.type === "department" ? "📁" : "👥"}</span>
              <div>
                <div style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>{selectedNode.name}</div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
                  {selectedNode.code}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
              <Badge>{selectedNode.type}</Badge>
              <Badge variant="info">Level {selectedNode.level}</Badge>
              {selectedNode.user_count != null && (
                <Badge variant="success">{selectedNode.user_count} 成员</Badge>
              )}
            </div>
            <Button variant="secondary" size="sm">添加子节点</Button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 启动验证**

```bash
# 访问 /orgs，应看到缩进折叠树 + 右侧详情
```

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/pages/OrgTree.tsx
git commit -m "feat: rewrite OrgTree — collapsible tree + detail sidebar"
```

---

### Task D5：重写 Sharings 页

**Files:**
- Modify: `deepanalyze-hub/frontend/src/pages/Sharings.tsx`

- [ ] **Step 1: 读取当前 Sharings.tsx**

```bash
cat /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/pages/Sharings.tsx
```

- [ ] **Step 2: 重写为状态卡片 + 时间轴**

将现有表格布局替换为卡片列表。每个 sharing 显示源组织→目标组织、restrictions、4 步时间轴。参考设计文档 4.2⑤。

核心结构：

```typescript
// 伪代码结构（实际实现时填充完整逻辑）
const STATUS_TABS = ["全部", "pending", "approved", "rejected", "revoked"];

// 每张卡片：
<div style={{ card style }}>
  <div>源组织 → 目标组织</div>
  <div>restrictions: max_users, expires_at</div>
  <div>4 步时间轴：发起 → 源组织批准 → 目标组织批准 → 生效/撤销</div>
  <div>操作按钮（待审批时显示通过/拒绝）</div>
</div>
```

**实现要点**：
- 保留现有的 `api.listSharings`、`api.approveSharing`、`api.rejectSharing`、`api.revokeSharing` 调用
- 状态筛选改为 tab chips（不是 dropdown）
- 表格行改为卡片
- 用 `AuditTimeline` 组件显示 4 步状态流转
- 用 `ConfirmDialog` 包裹 reject/revoke 操作

- [ ] **Step 3: 启动验证**

```bash
# seed 后应有 1 条 approved 共享（INFRA → SOL）
# 访问 /sharings 查看
```

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/pages/Sharings.tsx
git commit -m "feat: rewrite Sharings — status tab chips + card list + timeline"
```

---

### Task D6：重写 WorkerApproval 页

**Files:**
- Modify: `deepanalyze-hub/frontend/src/pages/WorkerApproval.tsx`

- [ ] **Step 1: 读取当前 WorkerApproval.tsx**

```bash
cat /mnt/d/code/deepanalyze/deepanalyze-hub/frontend/src/pages/WorkerApproval.tsx
```

- [ ] **Step 2: 重写为待审批队列 + 状态表格**

将内联样式替换为 design tokens。顶部显示 pending 卡片（橙色背景），下方表格用 `StatusBadge` 显示 worker 状态。

**核心改动**：
- 所有 `style={{ background: "#xxx" }}` → `style={{ background: "var(--bg-card)" }}`
- 所有 `style={{ color: "#xxx" }}` → `style={{ color: "var(--text-primary)" }}`
- worker 状态用 `<StatusBadge status={w.status} />`
- 待审批卡片用 `rgba(245,158,11,0.08)` 背景 + ConfirmDialog 包裹通过/拒绝

- [ ] **Step 3: 启动验证**

```bash
# 访问 /workers 查看新布局
```

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/pages/WorkerApproval.tsx
git commit -m "feat: rewrite WorkerApproval — pending queue + status table with StatusBadge"
```

---

### Task D7：微调 Security 页

**Files:**
- Modify: `deepanalyze-hub/frontend/src/pages/Security.tsx`

- [ ] **Step 1: 全局替换硬编码颜色**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
# 检查硬编码颜色
grep -n "#[0-9a-fA-F]\{3,6\}" src/pages/Security.tsx | head -20
```

将每个 `#xxx` 替换为对应的 CSS 变量：
- `#1f2937` → `var(--text-primary)`
- `#6b7280` → `var(--text-tertiary)`
- `#e5e7eb` → `var(--border-primary)`
- `#f3f4f6` → `var(--bg-tertiary)`
- `#ffffff` → `var(--bg-card)`
- `#dc2626` → `var(--error)`
- `#2563eb` → `var(--brand-primary)`
- `#10b981` → `var(--success)`

- [ ] **Step 2: 用 Badge 组件替换内联状态标签**

找到 `<span>enabled</span>` 等状态标签，替换为 `<Badge variant="success">enabled</Badge>`。

- [ ] **Step 3: 验证页面正常渲染**

```bash
# 访问 /security，浅色 + 深色主题切换都正常
```

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
git add src/pages/Security.tsx
git commit -m "style: Security page — replace hardcoded colors with design tokens"
```

---

## Phase E：测试更新

### Task E1：更新 hubApi helper — 构造数据加新字段

**Files:**
- Modify: `deepanalyze/tests/e2e/helpers/hubApi.ts`

- [ ] **Step 1: 读取当前 hubApi.ts**

```bash
cat /mnt/d/code/deepanalyze/deepanalyze/tests/e2e/helpers/hubApi.ts
```

- [ ] **Step 2: 找到所有 createPackage / createVersion / createSharing 调用**

在 helper 中找到构造 skill 包、版本、共享的函数。每个构造对象都需要补字段：

```typescript
// createPackage 签名变更前
{ name, scope, org_id }

// 变更后
{ name, description: "E2E 测试 Skill 包描述", scope, org_id,
  category: "engineering", tags: ["e2e"], icon: "🧪" }

// createVersion 签名变更前
{ version, content }

// 变更后
{ version, content, change_summary: "e2e 测试版本" }

// createSharing 签名变更前
{ package_id, source_org_id, target_org_id }

// 变更后
{ package_id, source_org_id, target_org_id,
  usage_intent: "e2e 测试共享用途说明" }
```

- [ ] **Step 3: 更新所有 helper 方法签名**

在 hubApi.ts 中修改 `createPackage`、`createVersion`、`createSharing` 方法，添加新字段到默认值。

- [ ] **Step 4: 验证 helper 编译**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx tsc --noEmit tests/e2e/helpers/hubApi.ts 2>&1 | head -10
```

- [ ] **Step 5: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add tests/e2e/helpers/hubApi.ts
git commit -m "test: update hubApi helper — add metadata fields to package/version/sharing"
```

---

### Task E2：修复现有 6 个 spec 文件

**Files:**
- Modify: `deepanalyze/tests/e2e/hub/hub-auth.spec.ts`
- Modify: `deepanalyze/tests/e2e/hub/hub-skillsync.spec.ts`
- Modify: `deepanalyze/tests/e2e/hub/hub-workflow.spec.ts`
- Modify: `deepanalyze/tests/e2e/hub/hub-sharing.spec.ts`
- Modify: `deepanalyze/tests/e2e/hub/hub-security.spec.ts`
- Modify: `deepanalyze/tests/e2e/hub/hub-integration.spec.ts`

- [ ] **Step 1: 逐个运行现有 spec，记录失败点**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze

for spec in hub-auth hub-skillsync hub-workflow hub-sharing hub-security hub-integration; do
  echo "=== Running $spec ==="
  npx playwright test tests/e2e/hub/$spec.spec.ts --reporter=line 2>&1 | tail -5
done
```

- [ ] **Step 2: 逐个修复**

每个 spec 中直接构造 POST body 的地方（不经过 helper），手动添加：
- 创建包：加 `description`、`category`、`tags`、`icon`
- 创建版本：加 `change_summary`
- 创建共享：加 `usage_intent`

**逐文件修复流程**：
1. 读取 spec 文件
2. 搜索 `.post(`/skills`` / `.post(`/sharings`` / `createPackage` / `createVersion` / `createSharing`
3. 给每个 body 补字段
4. 单独运行该 spec 验证通过

- [ ] **Step 3: 全量运行 Hub 测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx playwright test tests/e2e/hub/ --reporter=line 2>&1 | tail -20
```

Expected: 全部通过（或仅剩已知的非阻塞警告）。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add tests/e2e/hub/
git commit -m "test: fix 6 existing hub specs to pass with new metadata validation"
```

---

### Task E3：新增 T81 — seed 幂等性测试

**Files:**
- Create: `deepanalyze/tests/e2e/hub/hub-seed.spec.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
// deepanalyze/tests/e2e/hub/hub-seed.spec.ts
import { test, expect } from "@playwright/test";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

test.describe.serial("Hub seed — T81", () => {
  test("T81: seed script is idempotent (run twice, same counts)", async () => {
    // 第一次运行
    await execAsync("cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run scripts/seed-realistic.ts");

    // 通过 API 验证数据
    const { stdout: loginOut } = await execAsync(
      `curl -s http://localhost:22000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}'`,
    );
    const token = JSON.parse(loginOut).access_token;

    const fetchCount = async (endpoint: string) => {
      const { stdout } = await execAsync(
        `curl -s http://localhost:22000/api/v1${endpoint} -H 'Authorization: Bearer ${token}'`,
      );
      return JSON.parse(stdout);
    };

    const orgs1 = await fetchCount("/orgs");
    const users1 = await fetchCount("/users");
    const skills1 = await fetchCount("/skills");

    // 第二次运行
    await execAsync("cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run scripts/seed-realistic.ts");

    const orgs2 = await fetchCount("/orgs");
    const users2 = await fetchCount("/users");
    const skills2 = await fetchCount("/skills");

    // 幂等：两次计数一致
    expect(orgs2.length).toBe(orgs1.length);
    expect(users2.users.length).toBe(users1.users.length);
    expect(skills2.items.length).toBe(skills1.items.length);

    // 具体数值（设计文档写"12节点"但实际树结构为 11 节点：DSI + 3 dept + 4 sub-dept + 3 team）
    expect(orgs2.length).toBe(11);
    expect(users2.users.length).toBe(19);
    expect(skills2.items.length).toBe(6);
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx playwright test tests/e2e/hub/hub-seed.spec.ts --reporter=line
```

- [ ] **Step 3: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add tests/e2e/hub/hub-seed.spec.ts
git commit -m "test: T81 — seed script idempotency"
```

---

### Task E4：新增 T82 — 元数据校验测试

**Files:**
- Create: `deepanalyze/tests/e2e/hub/hub-metadata.spec.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
// deepanalyze/tests/e2e/hub/hub-metadata.spec.ts
import { test, expect, request } from "@playwright/test";
import { adminLogin, uniq } from "../helpers/hubApi";

test.describe.serial("Hub metadata validation — T82", () => {
  let adminToken: string;

  test.beforeAll(async () => {
    const ctx = await request.newContext();
    const admin = await adminLogin(ctx);
    adminToken = admin.token;
  });

  const postSkill = (body: object) =>
    request.newContext().then(ctx =>
      ctx.post("http://localhost:22000/api/v1/skills", {
        data: body,
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      }),
    );

  test("T82-a: missing description → 400", async () => {
    const resp = await postSkill({ name: uniq("e2e82"), scope: "user" });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("Validation");
    expect(body.fields.description).toBeTruthy();
  });

  test("T82-b: short description (<10 chars) → 400", async () => {
    const resp = await postSkill({ name: uniq("e2e82"), description: "短", scope: "user" });
    expect(resp.status()).toBe(400);
  });

  test("T82-c: invalid category → 400", async () => {
    const resp = await postSkill({
      name: uniq("e2e82"),
      description: "这是一个合法长度的描述",
      category: "nonexistent_category",
      scope: "user",
    });
    expect(resp.status()).toBe(400);
    expect(body.fields.category).toBeTruthy();
  });

  test("T82-d: valid input → 201", async () => {
    const resp = await postSkill({
      name: uniq("e2e82_ok"),
      description: "这是一个合法的 E2E 测试 Skill 描述",
      category: "engineering",
      tags: ["e2e", "test"],
      icon: "🧪",
      scope: "user",
    });
    expect(resp.status()).toBe(201);
  });

  test("T82-e: version without change_summary → 400", async () => {
    // 先创建合法的包
    const pkgResp = await postSkill({
      name: uniq("e2e82_ver"),
      description: "用于测试版本校验的 Skill 包",
      category: "general",
      scope: "user",
    });
    const pkg = await pkgResp.json();
    const pkgId = pkg.package.id;

    // 创建版本，缺 change_summary
    const verResp = await request.newContext().then(ctx =>
      ctx.post(`http://localhost:22000/api/v1/skills/${pkgId}/versions`, {
        data: { version: "1.0.0", content: "test content" },
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      }),
    );
    expect(verResp.status()).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx playwright test tests/e2e/hub/hub-metadata.spec.ts --reporter=line
```

- [ ] **Step 3: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add tests/e2e/hub/hub-metadata.spec.ts
git commit -m "test: T82 — metadata validation (description/category/change_summary)"
```

---

### Task E5：新增 T83 — UI 视觉回归测试

**Files:**
- Create: `deepanalyze/tests/e2e/hub/hub-visual.spec.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
// deepanalyze/tests/e2e/hub/hub-visual.spec.ts
import { test, expect } from "@playwright/test";
import { openHub, hubShot } from "../helpers/hubUi";

test.describe.serial("Hub visual regression — T83", () => {
  test.beforeEach(async ({ page }) => {
    await openHub(page);
  });

  const PAGES = [
    { name: "dashboard", path: "/" },
    { name: "orgs", path: "/orgs" },
    { name: "skills", path: "/skills" },
    { name: "sharings", path: "/sharings" },
    { name: "workers", path: "/workers" },
    { name: "security", path: "/security" },
  ];

  for (const p of PAGES) {
    test(`T83: ${p.name} page renders without console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      await page.goto(`http://localhost:5173/#${p.path}`);
      await page.waitForLoadState("networkidle");
      await hubShot(page, `t83-${p.name}-light`);

      // 过滤已知无害错误（favicon, ResizeObserver）
      const critical = errors.filter(e =>
        !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("ERR_CONNECTION_REFUSED"),
      );
      expect(critical).toEqual([]);
    });
  }

  test("T83: theme toggle switches to dark mode", async ({ page }) => {
    await page.goto("http://localhost:5173/#/");
    await page.waitForLoadState("networkidle");

    // 点击主题切换按钮
    const toggle = page.locator('button[title*="主题"], button[title*="theme"], [data-testid="theme-toggle"]').first();
    await toggle.click();
    await page.waitForTimeout(500);

    // 截图深色模式
    await hubShot(page, "t83-dashboard-dark");

    // 验证 html 有 data-theme=dark 或 class=dark
    const htmlAttr = await page.evaluate(() => document.documentElement.dataset.theme || document.documentElement.className);
    expect(htmlAttr).toContain("dark");
  });
});
```

- [ ] **Step 2: 运行测试（生成基线截图）**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx playwright test tests/e2e/hub/hub-visual.spec.ts --reporter=line
# 第一次运行生成基线截图到 tests/e2e/screenshots/hub/
```

- [ ] **Step 3: 验证截图存在**

```bash
ls /mnt/d/code/deepanalyze/deepanalyze/tests/e2e/screenshots/hub/t83-* | head -10
```

Expected: 7 个截图（6 页面浅色 + 1 dashboard 深色）。

- [ ] **Step 4: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add tests/e2e/hub/hub-visual.spec.ts
git commit -m "test: T83 — visual regression for 6 pages + dark mode toggle"
```

---

## 验收检查

### 全量回归测试

- [ ] **运行所有 Hub E2E 测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx playwright test tests/e2e/hub/ --reporter=line 2>&1 | tail -30
```

Expected: 全部通过（T61-T83）。

- [ ] **验证演示就绪**

1. 打开 `http://localhost:5173`，用 admin/admin123 登录
2. Dashboard 显示 4 统计卡（组织 11 / Skill 6 / Worker / 共享 1）
3. Skills 市场显示 6 张带图标/分类/描述的 SkillCard
4. 点击某 SkillCard 进入详情页，切换 4 个 Tab
5. 组织树显示缩进折叠树 + 右侧详情
6. 共享页显示 1 条 approved 共享（INFRA → SOL）
7. 右上角主题切换正常，深色模式无样式崩塌
8. Sidebar 折叠/展开正常，状态持久化

- [ ] **验证元数据完整性**

```bash
docker exec da-postgres psql -U da_hub -d deepanalyze_hub -c \
  "SELECT
     (SELECT COUNT(*) FROM skill_packages WHERE description IS NULL OR description = '') as null_desc,
     (SELECT COUNT(*) FROM skill_packages WHERE category IS NULL OR category = '') as null_cat,
     (SELECT COUNT(*) FROM skill_packages WHERE icon IS NULL OR icon = '') as null_icon,
     (SELECT COUNT(*) FROM skill_versions WHERE change_summary IS NULL OR change_summary = '') as null_summary,
     (SELECT COUNT(*) FROM skill_sharings WHERE usage_intent IS NULL OR usage_intent = '') as null_intent;"
```

Expected: 全部为 0。

---

## 完成标记

所有 Task A1-E5 完成后，标记设计文档 `docs/superpowers/specs/2026-06-21-hub-overhaul-design.md` 中的验收标准为通过。
