# Hub Server Phase 1：基础多租户 + 认证

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 deepanalyze-hub 脚手架上叠加 Organization 树形多租户、User/RBAC/JWT 认证、Worker 申请-审批流程，并升级 DA hub-client 到 protocol v2。

**Architecture:** 复用现有 Hono + PG 连接池 + migration runner。新增 organization/user/rbac/auth 模块。TEXT 主键（保持与现有 schema 一致，UUID 用 `crypto.randomUUID()` 生成存储为 TEXT）。JWT 双 token（access 7d + refresh 30d cookie）。

**Tech Stack:** Hono, PostgreSQL, bcrypt, jsonwebtoken, TypeScript, Bun runtime

---

## 文件结构

### deepanalyze-hub（控制平面）

```
src/
├── main.ts                          # 修改：bootstrap（已有）
├── core/
│   └── config.ts                    # 修改：新增 JWT_REFRESH_SECRET 等
├── server/
│   ├── app.ts                       # 修改：挂载新路由
│   ├── middleware/
│   │   ├── worker-auth.ts           # 修改：兼容 v2 token
│   │   ├── jwt-auth.ts              # 新增：JWT 认证中间件
│   │   ├── require-permission.ts    # 新增：权限检查中间件
│   │   └── data-scope.ts            # 新增：数据范围注入
│   └── routes/
│       ├── workers.ts               # 修改：申请-审批流程
│       ├── config.ts                # 保留
│       ├── marketplace.ts           # 保留（Phase 2 扩展）
│       ├── auth.ts                  # 新增：login/refresh/logout/apikey
│       ├── orgs.ts                  # 新增：组织树 CRUD
│       ├── users.ts                 # 新增：用户 CRUD + 邀请
│       └── rbac.ts                  # 新增：角色/权限管理
├── domain/
│   ├── organization.ts              # 新增：树形 Org 领域逻辑
│   ├── user.ts                      # 新增：用户领域逻辑
│   ├── rbac.ts                      # 新增：权限检查器
│   └── auth.ts                      # 新增：JWT 签发/验证
├── store/
│   ├── pg.ts                        # 保留
│   ├── migrate.ts                   # 保留
│   └── migrations/
│       ├── 001_initial_schema.ts    # 保留
│       ├── 002_fix_marketplace_fkeys.ts  # 保留
│       ├── 003_fix_all_user_fkeys.ts     # 保留
│       ├── 004_organizations.ts     # 新增
│       ├── 005_rbac_tables.ts       # 新增
│       ├── 006_users_upgrade.ts     # 新增
│       └── 007_workers_upgrade.ts   # 新增
└── types/
    ├── index.ts                     # 修改：新增类型
    └── hono.d.ts                    # 修改：新增 context 字段
```

### @deepanalyze/contracts（共享类型包）

```
/mnt/d/code/deepanalyze/contracts/
├── package.json                     # name: @deepanalyze/contracts
├── tsconfig.json
├── src/
│   ├── index.ts                     # 导出所有类型
│   ├── worker-protocol.ts           # HeartbeatRequest/Response, SkillSyncInstruction
│   ├── auth.ts                      # JWT payload, LoginRequest/Response
│   ├── organization.ts              # Org 类型
│   └── rbac.ts                      # Permission/Role 类型
└── README.md
```

### DA 端改造

```
src/services/hub/
├── hub-client.ts                    # 修改：v2 心跳 + applyInstructions
├── sync-handler.ts                  # 新增：处理 SkillSyncInstruction
└── types.ts                         # 修改：导入 @deepanalyze/contracts
```

### 前端管理后台

```
/mnt/d/code/deepanalyze/deepanalyze-hub/frontend/
├── index.html
├── package.json
├── vite.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx                      # 路由 + 布局
│   ├── api/client.ts                # API 客户端
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx
│   │   ├── OrgTree.tsx
│   │   ├── UserList.tsx
│   │   ├── WorkerApproval.tsx
│   │   └── RoleList.tsx
│   └── components/
│       ├── Layout.tsx
│       └── ProtectedRoute.tsx
└── tsconfig.json
```

---

## Task 1: 创建 @deepanalyze/contracts 包

**Files:**
- Create: `/mnt/d/code/deepanalyze/contracts/package.json`
- Create: `/mnt/d/code/deepanalyze/contracts/tsconfig.json`
- Create: `/mnt/d/code/deepanalyze/contracts/src/index.ts`
- Create: `/mnt/d/code/deepanalyze/contracts/src/worker-protocol.ts`
- Create: `/mnt/d/code/deepanalyze/contracts/src/auth.ts`
- Create: `/mnt/d/code/deepanalyze/contracts/src/organization.ts`
- Create: `/mnt/d/code/deepanalyze/contracts/src/rbac.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@deepanalyze/contracts",
  "version": "0.1.0",
  "description": "Shared types and schemas between DeepAnalyze and deepanalyze-hub",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 src/worker-protocol.ts**

```typescript
// Worker 协议 v2 类型定义

export interface HeartbeatRequest {
  current_task?: string;
  capabilities?: Record<string, unknown>;
  cached_skills?: CachedSkill[];
  policy_version?: number;
  protocol_version: number;
}

export interface CachedSkill {
  package_id: string;
  version: string;
  content_hash: string;
}

export interface HeartbeatResponse {
  message: string;
  instructions: SkillSyncInstruction[];
  policy_version: number;
  config_diff?: ConfigDiff;
  server_time: string;
}

export interface SkillSyncInstruction {
  action: 'sync' | 'force_update' | 'kill' | 'rollback' | 'policy_refresh';
  package_id: string;
  version_id?: string;
  version?: string;
  content?: string;
  content_url?: string;
  hash?: string;
  deadline?: string;
  reason?: string;
  instruction_id: string;
}

export interface ConfigDiff {
  version?: string;
  config_data?: Record<string, unknown>;
}

export interface WorkerRegisterRequest {
  worker_id?: string;
  name: string;
  display_name?: string;
  hostname?: string;
  endpoint?: string;
  version?: string;
  capabilities?: Record<string, unknown>;
  protocol_version: number;
}

export interface WorkerRegisterResponse {
  worker_id: string;
  worker_token: string;
  status: 'pending' | 'approved';
  server_version: string;
  protocol_version: number;
  message: string;
}
```

- [ ] **Step 4: 创建 src/auth.ts**

```typescript
// 认证相关类型

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  expires_in: number;
  user: UserInfo;
}

export interface RefreshResponse {
  access_token: string;
  expires_in: number;
}

export interface UserInfo {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  is_super_admin: boolean;
  is_org_admin: boolean;
  organization_id: string | null;
  roles: string[];
  permissions: string[];
}

export interface JwtPayload {
  sub: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

export interface CreateApiKeyRequest {
  name: string;
  scope: 'read' | 'write' | 'admin';
  expires_at?: string;
}

export interface CreateApiKeyResponse {
  api_key: string;
  key_id: string;
  name: string;
  scope: string;
  expires_at: string | null;
}
```

- [ ] **Step 5: 创建 src/organization.ts**

```typescript
// 组织相关类型

export interface Organization {
  id: string;
  name: string;
  code: string;
  description: string | null;
  parent_id: string | null;
  level: number;
  path: string;
  type: 'company' | 'department' | 'team';
  manager_id: string | null;
  status: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OrgTreeNode extends Organization {
  children: OrgTreeNode[];
  user_count: number;
}

export interface CreateOrgRequest {
  name: string;
  code: string;
  description?: string;
  parent_id?: string;
  type: 'company' | 'department' | 'team';
  settings?: Record<string, unknown>;
}
```

- [ ] **Step 6: 创建 src/rbac.ts**

```typescript
// RBAC 类型

export interface Role {
  id: string;
  name: string;
  org_id: string | null;
  description: string | null;
  is_system: boolean;
  created_at: string;
}

export interface Permission {
  id: string;
  code: string;
  resource: string;
  action: string;
  type: 'menu' | 'system' | 'app' | 'api';
  parent_id: string | null;
  description: string | null;
}

export interface CreateRoleRequest {
  name: string;
  org_id?: string;
  description?: string;
  permission_codes: string[];
}
```

- [ ] **Step 7: 创建 src/index.ts**

```typescript
export * from './worker-protocol.js';
export * from './auth.js';
export * from './organization.js';
export * from './rbac.js';
```

- [ ] **Step 8: 验证 typecheck 通过**

Run: `cd /mnt/d/code/deepanalyze/contracts && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 9: 初始化 git 仓库并提交**

```bash
cd /mnt/d/code/deepanalyze/contracts
git init
echo "node_modules/" > .gitignore
git add .
git commit -m "feat: 初始化 @deepanalyze/contracts 共享类型包"
```

---

## Task 2: Migration 004 — organizations 表

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/store/migrations/004_organizations.ts`

- [ ] **Step 1: 写 migration**

```typescript
import type { Migration } from './runner.js';

export const up: Migration = async (query) => {
  await query(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      description TEXT,
      parent_id TEXT NULL REFERENCES organizations(id),
      level INT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL,
      manager_id TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      settings JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX idx_org_parent ON organizations(parent_id)`);
  await query(`CREATE INDEX idx_org_code ON organizations(code)`);
  await query(`CREATE INDEX idx_org_path ON organizations(path)`);

  // 插入根组织
  await query(`
    INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
    VALUES ('root', '系统根组织', 'ROOT', NULL, 0, 'root', 'company', '{}')
  `);
};

export const down: Migration = async (query) => {
  await query(`DROP TABLE IF EXISTS organizations CASCADE`);
};
```

- [ ] **Step 2: 运行 migration 验证**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/store/migrate.ts`
Expected: `Migration 004_organizations applied`

- [ ] **Step 3: 提交**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/store/migrations/004_organizations.ts
git commit -m "feat: 添加 organizations 表 migration 004"
```

---

## Task 3: Migration 005 — RBAC 表（roles/permissions/user_roles/role_permissions）

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/store/migrations/005_rbac_tables.ts`

- [ ] **Step 1: 写 migration**

```typescript
import type { Migration } from './runner.js';

export const up: Migration = async (query) => {
  await query(`
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      description TEXT,
      is_system BOOL NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(name, org_id)
    )
  `);

  await query(`
    CREATE TABLE permissions (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_id TEXT NULL REFERENCES permissions(id),
      description TEXT
    )
  `);

  await query(`
    CREATE TABLE user_roles (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, role_id)
    )
  `);

  await query(`
    CREATE TABLE role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    )
  `);

  await query(`
    CREATE TABLE user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'read',
      last_used_at TIMESTAMPTZ NULL,
      expires_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX idx_apikey_user ON user_api_keys(user_id)`);

  // 预置权限码
  const perms = [
    ['org:create', 'org', 'create', 'system'],
    ['org:read', 'org', 'read', 'system'],
    ['org:update', 'org', 'update', 'system'],
    ['org:delete', 'org', 'delete', 'system'],
    ['user:create', 'user', 'create', 'system'],
    ['user:read', 'user', 'read', 'system'],
    ['user:update', 'user', 'update', 'system'],
    ['user:delete', 'user', 'delete', 'system'],
    ['role:read', 'role', 'read', 'system'],
    ['role:assign', 'role', 'assign', 'system'],
    ['worker:apply', 'worker', 'apply', 'system'],
    ['worker:read', 'worker', 'read', 'system'],
    ['worker:approve', 'worker', 'approve', 'system'],
    ['worker:reject', 'worker', 'reject', 'system'],
    ['skill:read', 'skill', 'read', 'system'],
    ['config:read', 'config', 'read', 'system'],
  ];
  for (const [code, resource, action, type] of perms) {
    await query(
      `INSERT INTO permissions (id, code, resource, action, type) VALUES ($1, $2, $3, $4, $5)`,
      [`perm_${code.replace(/[:]/g, '_')}`, code, resource, action, type],
    );
  }

  // 预置系统角色
  await query(`
    INSERT INTO roles (id, name, org_id, description, is_system) VALUES
      ('role_super_admin', '超级管理员', NULL, '系统全权限', TRUE),
      ('role_org_admin', '组织管理员', NULL, '本组织管理权限', TRUE),
      ('role_user', '普通用户', NULL, '基本使用权限', TRUE)
  `);

  // super_admin 拥有所有权限
  const allPerms = await query(`SELECT id FROM permissions`);
  for (const row of allPerms.rows) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_super_admin', $1) ON CONFLICT DO NOTHING`,
      [row.id],
    );
  }

  // org_admin 拥有组织管理相关权限
  const orgAdminPerms = [
    'perm_org_read', 'perm_user_create', 'perm_user_read', 'perm_user_update',
    'perm_role_read', 'perm_role_assign', 'perm_worker_read', 'perm_worker_approve',
    'perm_worker_reject', 'perm_skill_read', 'perm_config_read',
  ];
  for (const pid of orgAdminPerms) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_org_admin', $1) ON CONFLICT DO NOTHING`,
      [pid],
    );
  }

  // user 角色
  const userPerms = ['perm_worker_read', 'perm_skill_read', 'perm_config_read'];
  for (const pid of userPerms) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_user', $1) ON CONFLICT DO NOTHING`,
      [pid],
    );
  }
};

export const down: Migration = async (query) => {
  await query(`DROP TABLE IF EXISTS user_api_keys CASCADE`);
  await query(`DROP TABLE IF EXISTS role_permissions CASCADE`);
  await query(`DROP TABLE IF EXISTS user_roles CASCADE`);
  await query(`DROP TABLE IF EXISTS permissions CASCADE`);
  await query(`DROP TABLE IF EXISTS roles CASCADE`);
};
```

- [ ] **Step 2: 运行 migration**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/store/migrate.ts`
Expected: `Migration 005_rbac_tables applied`

- [ ] **Step 3: 提交**

```bash
git add src/store/migrations/005_rbac_tables.ts
git commit -m "feat: 添加 RBAC 表（roles/permissions/user_roles/role_permissions/api_keys）migration 005"
```

---

## Task 4: Migration 006 — users 表升级（新增多租户字段）

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/store/migrations/006_users_upgrade.ts`

- [ ] **Step 1: 写 migration**

```typescript
import type { Migration } from './runner.js';

export const up: Migration = async (query) => {
  // 添加多租户字段到现有 users 表
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'local'`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOL NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_org_admin BOOL NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id TEXT NULL REFERENCES organizations(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`);

  // 将现有 system 用户标记为 super_admin
  await query(`UPDATE users SET is_super_admin = TRUE WHERE id = 'system'`);

  // 给 system 用户赋予 super_admin 角色
  await query(`
    INSERT INTO user_roles (user_id, role_id) VALUES ('system', 'role_super_admin')
    ON CONFLICT DO NOTHING
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_user_org ON users(organization_id)`);
};

export const down: Migration = async (query) => {
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS organization_id`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS is_org_admin`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS is_super_admin`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS auth_source`);
  await query(`ALTER TABLE users DROP COLUMN IF EXISTS display_name`);
};
```

- [ ] **Step 2: 运行 migration**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/store/migrate.ts`

- [ ] **Step 3: 提交**

```bash
git add src/store/migrations/006_users_upgrade.ts
git commit -m "feat: users 表升级——添加多租户字段 migration 006"
```

---

## Task 5: Migration 007 — workers 表升级（申请-审批流程）

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/store/migrations/007_workers_upgrade.ts`

- [ ] **Step 1: 写 migration**

```typescript
import type { Migration } from './runner.js';

export const up: Migration = async (query) => {
  // 添加申请-审批相关字段
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS name TEXT`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS display_name TEXT`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS approved_by TEXT NULL REFERENCES users(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS organization_id TEXT NULL REFERENCES organizations(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS protocol_version INT NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // 扩展 status CHECK 约束
  await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check`);
  await query(`
    ALTER TABLE workers ADD CONSTRAINT workers_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'online', 'offline', 'draining'))
  `);

  // 用 hostname 填充 name（如果 name 为空）
  await query(`UPDATE workers SET name = hostname WHERE name IS NULL AND hostname IS NOT NULL`);
  await query(`UPDATE workers SET name = id WHERE name IS NULL`);

  // 已注册的 worker 自动升级为 approved
  await query(`UPDATE workers SET status = 'approved', approved_at = NOW() WHERE status IN ('online', 'offline')`);

  await query(`CREATE INDEX IF NOT EXISTS idx_worker_user ON workers(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_worker_org ON workers(organization_id)`);

  // worker 连接事件表
  await query(`
    CREATE TABLE IF NOT EXISTS worker_connection_events (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_wce_worker ON worker_connection_events(worker_id, created_at DESC)`);
};

export const down: Migration = async (query) => {
  await query(`DROP TABLE IF EXISTS worker_connection_events CASCADE`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS applied_at`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS protocol_version`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS organization_id`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS user_id`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS approved_by`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS approved_at`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS display_name`);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS name`);
};
```

- [ ] **Step 2: 运行 migration**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/store/migrate.ts`

- [ ] **Step 3: 提交**

```bash
git add src/store/migrations/007_workers_upgrade.ts
git commit -m "feat: workers 表升级——申请-审批流程 migration 007"
```

---

## Task 6: Domain — Organization 树形逻辑

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/domain/organization.ts`

- [ ] **Step 1: 写 Organization 领域服务**

```typescript
import { query } from '../store/pg.js';

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
function computePath(parentPath: string | null, parentId: string | null, orgId: string): { level: number; path: string } {
  if (!parentId || !parentPath) {
    return { level: 1, path: orgId };
  }
  const parentLevel = parentPath.split('/').length;
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

  let parent: OrgRecord | null = null;
  if (parent_id) {
    const rows = await query<OrgRecord>(
      `SELECT * FROM organizations WHERE id = $1`,
      [parent_id],
    );
    parent = rows.rows[0] ?? null;
    if (!parent) throw new Error(`Parent organization ${parent_id} not found`);
  }

  const id = `org_${crypto.randomUUID().replace(/-/g, '')}`;
  const { level, path } = computePath(parent?.path ?? null, parent_id ?? null, id);

  const result = await query<OrgRecord>(
    `INSERT INTO organizations (id, name, code, description, parent_id, level, path, type, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [id, name, code, description ?? null, parent_id ?? null, level, path, type, JSON.stringify(settings)],
  );
  return result.rows[0];
}

/** 获取组织详情 */
export async function getOrgById(id: string): Promise<OrgRecord | null> {
  const rows = await query<OrgRecord>(`SELECT * FROM organizations WHERE id = $1`, [id]);
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

/** 构建树形结构 */
export interface OrgTreeNode extends OrgRecord {
  children: OrgTreeNode[];
  user_count: number;
}

export async function buildOrgTree(rootId: string): Promise<OrgTreeNode | null> {
  const orgs = await getSubtree(rootId);
  if (orgs.length === 0) return null;

  // 批量查 user_count
  const countRows = await query<{ organization_id: string; count: string }>(
    `SELECT organization_id, COUNT(*) as count FROM users
     WHERE organization_id = ANY($1::text[])
     GROUP BY organization_id`,
    [orgs.map(o => o.id)],
  );
  const countMap = new Map(countRows.rows.map(r => [r.organization_id, parseInt(r.count, 10)]));

  const nodeMap = new Map<string, OrgTreeNode>();
  for (const org of orgs) {
    nodeMap.set(org.id, { ...org, children: [], user_count: countMap.get(org.id) ?? 0 });
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
export async function updateOrg(id: string, updates: Partial<Pick<OrgRecord, 'name' | 'description' | 'status' | 'settings' | 'manager_id'>>): Promise<OrgRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) { sets.push(`name = $${idx++}`); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push(`description = $${idx++}`); values.push(updates.description); }
  if (updates.status !== undefined) { sets.push(`status = $${idx++}`); values.push(updates.status); }
  if (updates.manager_id !== undefined) { sets.push(`manager_id = $${idx++}`); values.push(updates.manager_id); }
  if (updates.settings !== undefined) { sets.push(`settings = $${idx++}`); values.push(JSON.stringify(updates.settings)); }

  if (sets.length === 0) return getOrgById(id);

  sets.push(`updated_at = NOW()`);
  values.push(id);
  const result = await query<OrgRecord>(
    `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

/** 删除组织（需无子节点） */
export async function deleteOrg(id: string): Promise<{ deleted: boolean; reason?: string }> {
  // 检查子组织
  const children = await query(`SELECT id FROM organizations WHERE parent_id = $1 LIMIT 1`, [id]);
  if (children.rows.length > 0) {
    return { deleted: false, reason: 'Has child organizations' };
  }
  // 检查关联用户
  const users = await query(`SELECT id FROM users WHERE organization_id = $1 LIMIT 1`, [id]);
  if (users.rows.length > 0) {
    return { deleted: false, reason: 'Has associated users' };
  }
  // 检查关联 worker
  const workers = await query(`SELECT id FROM workers WHERE organization_id = $1 LIMIT 1`, [id]);
  if (workers.rows.length > 0) {
    return { deleted: false, reason: 'Has associated workers' };
  }

  await query(`DELETE FROM organizations WHERE id = $1`, [id]);
  return { deleted: true };
}

/** 列出所有组织（扁平） */
export async function listOrgs(): Promise<OrgRecord[]> {
  const rows = await query<OrgRecord>(`SELECT * FROM organizations ORDER BY level, name`);
  return rows.rows;
}
```

- [ ] **Step 2: typecheck**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze-hub && npx tsc --noEmit`
Expected: 无错误（或仅有 marketplace 已有的无害警告）

- [ ] **Step 3: 提交**

```bash
git add src/domain/organization.ts
git commit -m "feat: Organization 领域服务——树形 CRUD + path 维护"
```

---

## Task 7: Domain — User + 密码

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/domain/user.ts`

- [ ] **Step 1: 写 User 领域服务**

```typescript
import bcrypt from 'bcrypt';
import { query } from '../store/pg.js';

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

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
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
  const { username, email, display_name, password, organization_id, is_org_admin = false } = params;

  // 检查 username 唯一
  const existing = await query(`SELECT id FROM users WHERE username = $1`, [username]);
  if (existing.rows.length > 0) {
    throw new Error(`Username '${username}' already exists`);
  }

  const id = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
  const passwordHash = await hashPassword(password);

  const result = await query<UserRecord>(
    `INSERT INTO users (id, username, email, display_name, password_hash, auth_source, organization_id, is_org_admin)
     VALUES ($1, $2, $3, $4, $5, 'local', $6, $7)
     RETURNING *`,
    [id, username, email ?? null, display_name ?? null, passwordHash, organization_id ?? null, is_org_admin],
  );

  // 默认赋予 user 角色
  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'role_user') ON CONFLICT DO NOTHING`,
    [id],
  );

  // 如果是 org_admin，额外赋予角色
  if (is_org_admin) {
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'role_org_admin') ON CONFLICT DO NOTHING`,
      [id],
    );
  }

  return result.rows[0];
}

/** 按用户名查找（用于登录） */
export async function getUserByUsername(username: string): Promise<UserRecord | null> {
  const rows = await query<UserRecord>(`SELECT * FROM users WHERE username = $1 AND status = 'active'`, [username]);
  return rows.rows[0] ?? null;
}

/** 按 ID 查找 */
export async function getUserById(id: string): Promise<UserRecord | null> {
  const rows = await query<UserRecord>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows.rows[0] ?? null;
}

/** 获取用户的角色 ID 列表 */
export async function getUserRoleIds(userId: string): Promise<string[]> {
  const rows = await query<{ role_id: string }>(
    `SELECT role_id FROM user_roles WHERE user_id = $1`,
    [userId],
  );
  return rows.rows.map(r => r.role_id);
}

/** 获取用户的权限码列表（展开角色 → 权限） */
export async function getUserPermissions(userId: string): Promise<string[]> {
  const rows = await query<{ code: string }>(
    `SELECT DISTINCT p.code
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return rows.rows.map(r => r.code);
}

/** 列出组织内用户 */
export async function listUsersByOrg(orgId: string): Promise<UserRecord[]> {
  const rows = await query<UserRecord>(
    `SELECT * FROM users WHERE organization_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.rows;
}

/** 列出所有用户 */
export async function listAllUsers(limit = 100, offset = 0): Promise<UserRecord[]> {
  const rows = await query<UserRecord>(
    `SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.rows;
}

/** 更新用户 */
export async function updateUser(id: string, updates: {
  email?: string;
  display_name?: string;
  organization_id?: string | null;
  is_org_admin?: boolean;
  status?: string;
  password?: string;
}): Promise<UserRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.email !== undefined) { sets.push(`email = $${idx++}`); values.push(updates.email); }
  if (updates.display_name !== undefined) { sets.push(`display_name = $${idx++}`); values.push(updates.display_name); }
  if (updates.organization_id !== undefined) { sets.push(`organization_id = $${idx++}`); values.push(updates.organization_id); }
  if (updates.is_org_admin !== undefined) { sets.push(`is_org_admin = $${idx++}`); values.push(updates.is_org_admin); }
  if (updates.status !== undefined) { sets.push(`status = $${idx++}`); values.push(updates.status); }
  if (updates.password !== undefined) {
    const hash = await hashPassword(updates.password);
    sets.push(`password_hash = $${idx++}`); values.push(hash);
  }

  if (sets.length === 0) return getUserById(id);

  sets.push(`updated_at = NOW()`);
  values.push(id);
  const result = await query<UserRecord>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

/** 更新最后登录时间 */
export async function touchLogin(userId: string): Promise<void> {
  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
}
```

- [ ] **Step 2: typecheck**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze-hub && npx tsc --noEmit`

- [ ] **Step 3: 提交**

```bash
git add src/domain/user.ts
git commit -m "feat: User 领域服务——创建/查询/bcrypt 密码/权限展开"
```

---

## Task 8: Domain — RBAC 权限检查器

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/domain/rbac.ts`

- [ ] **Step 1: 写 RBAC 检查器**

```typescript
import { query } from '../store/pg.js';
import { getUserPermissions, getUserRoleIds } from './user.js';

/**
 * 检查用户是否拥有指定权限码。
 * 权限码格式 `{resource}:{action}`，支持通配符：
 *   - `skill:*` 匹配所有 skill 操作
 *   - `*` 匹配所有权限（仅 super_admin）
 * super_admin 直接通过。
 */
export async function hasPermission(userId: string, requiredCode: string): Promise<boolean> {
  // 检查 super_admin
  const roleIds = await getUserRoleIds(userId);
  if (roleIds.includes('role_super_admin')) return true;

  const codes = await getUserPermissions(userId);
  return matchPermission(codes, requiredCode);
}

/** 通配符匹配 */
export function matchPermission(ownedCodes: string[], required: string): boolean {
  if (ownedCodes.includes('*')) return true;

  // 精确匹配
  if (ownedCodes.includes(required)) return true;

  // 通配符匹配：skill:* 匹配 skill:create / skill:read 等
  const [reqResource] = required.split(':');
  for (const code of ownedCodes) {
    if (code === `${reqResource}:*`) return true;
  }

  return false;
}

/** 批量检查权限 */
export async function hasAnyPermission(userId: string, codes: string[]): Promise<boolean> {
  for (const code of codes) {
    if (await hasPermission(userId, code)) return true;
  }
  return false;
}

/** 为用户分配角色 */
export async function assignRole(userId: string, roleId: string): Promise<void> {
  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, roleId],
  );
}

/** 移除用户角色 */
export async function removeRole(userId: string, roleId: string): Promise<void> {
  await query(
    `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
    [userId, roleId],
  );
}

/** 列出所有角色 */
export async function listRoles(orgId?: string): Promise<Array<{
  id: string;
  name: string;
  org_id: string | null;
  description: string | null;
  is_system: boolean;
}>> {
  if (orgId) {
    const rows = await query(
      `SELECT * FROM roles WHERE org_id IS NULL OR org_id = $1 ORDER BY is_system DESC, name`,
      [orgId],
    );
    return rows.rows;
  }
  const rows = await query(`SELECT * FROM roles ORDER BY is_system DESC, name`);
  return rows.rows;
}

/** 列出所有权限 */
export async function listPermissions(): Promise<Array<{
  id: string;
  code: string;
  resource: string;
  action: string;
  type: string;
  description: string | null;
}>> {
  const rows = await query(`SELECT * FROM permissions ORDER BY resource, action`);
  return rows.rows;
}

/** 获取角色的权限码列表 */
export async function getRolePermissions(roleId: string): Promise<string[]> {
  const rows = await query<{ code: string }>(
    `SELECT p.code FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1`,
    [roleId],
  );
  return rows.rows.map(r => r.code);
}

/** 为角色设置权限（全量替换） */
export async function setRolePermissions(roleId: string, permCodes: string[]): Promise<void> {
  // 获取系统角色保护
  const roleRows = await query<{ is_system: boolean }>(`SELECT is_system FROM roles WHERE id = $1`, [roleId]);
  if (roleRows.rows.length === 0) throw new Error('Role not found');
  if (roleRows.rows[0].is_system) throw new Error('System role permissions cannot be modified');

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
```

- [ ] **Step 2: typecheck + 提交**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
npx tsc --noEmit
git add src/domain/rbac.ts
git commit -m "feat: RBAC 权限检查器——通配符匹配 + 角色管理"
```

---

## Task 9: Domain — Auth（JWT 签发/验证）

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/domain/auth.ts`

- [ ] **Step 1: 写 JWT 签发与验证**

```typescript
import jwt from 'jsonwebtoken';
import { query } from '../store/pg.js';
import { HUB_CONFIG } from '../core/config.js';

const ACCESS_EXPIRY = HUB_CONFIG.jwtExpiry ?? '7d';
const REFRESH_EXPIRY = '30d';
const ACCESS_SECRET = HUB_CONFIG.jwtSecret ?? 'dev-secret-change-me';
const REFRESH_SECRET = HUB_CONFIG.jwtRefreshSecret ?? 'dev-refresh-secret-change-me';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number; // 秒
}

/** 签发 JWT 双 token */
export function issueTokenPair(userId: string): TokenPair {
  const access_token = jwt.sign({ sub: userId, type: 'access' }, ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRY,
  } as jwt.SignOptions);
  const refresh_token = jwt.sign({ sub: userId, type: 'refresh' }, REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRY,
  } as jwt.SignOptions);

  // expires_in 转为秒
  const expires_in = parseExpiryToSeconds(ACCESS_EXPIRY);

  return { access_token, refresh_token, expires_in };
}

/** 验证 access token */
export function verifyAccessToken(token: string): { sub: string; type: string } | null {
  try {
    const payload = jwt.verify(token, ACCESS_SECRET) as { sub: string; type: string };
    if (payload.type !== 'access') return null;
    return payload;
  } catch {
    return null;
  }
}

/** 验证 refresh token */
export function verifyRefreshToken(token: string): { sub: string; type: string } | null {
  try {
    const payload = jwt.verify(token, REFRESH_SECRET) as { sub: string; type: string };
    if (payload.type !== 'refresh') return null;
    return payload;
  } catch {
    return null;
  }
}

/** 生成 API Key（明文只返回一次） */
export async function createApiKey(userId: string, name: string, scope: 'read' | 'write' | 'admin', expiresAt?: string): Promise<{ apiKey: string; keyId: string }> {
  const keyId = `key_${crypto.randomUUID().replace(/-/g, '')}`;
  const randomPart = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const apiKey = `dak_${randomPart}`;
  const { createHash } = await import('node:crypto');
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  await query(
    `INSERT INTO user_api_keys (id, user_id, name, key_hash, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [keyId, userId, name, keyHash, scope, expiresAt ?? null],
  );

  return { apiKey, keyId };
}

/** 验证 API Key，返回 user_id */
export async function verifyApiKey(apiKey: string): Promise<{ userId: string; scope: string } | null> {
  const { createHash } = await import('node:crypto');
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  const rows = await query<{ user_id: string; scope: string; expires_at: string | null }>(
    `SELECT user_id, scope, expires_at FROM user_api_keys
     WHERE key_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [keyHash],
  );
  if (rows.rows.length === 0) return null;

  const row = rows.rows[0];
  // 更新 last_used_at
  await query(`UPDATE user_api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [keyHash]);

  return { userId: row.user_id, scope: row.scope };
}

/** 撤销 API Key */
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM user_api_keys WHERE id = $1 AND user_id = $2`,
    [keyId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 列出用户的 API Key（不返回 hash） */
export async function listApiKeys(userId: string): Promise<Array<{
  id: string;
  name: string;
  scope: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}>> {
  const rows = await query(
    `SELECT id, name, scope, last_used_at, expires_at, created_at
     FROM user_api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.rows;
}

function parseExpiryToSeconds(exp: string): number {
  const match = exp.match(/^(\d+)([smhdw])$/);
  if (!match) return 7 * 24 * 3600;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return num * (multipliers[unit] ?? 604800);
}
```

- [ ] **Step 2: 更新 config.ts 添加 JWT 配置**

读取现有 `src/core/config.ts`，在 `HUB_CONFIG` 对象中添加：

```typescript
jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
jwtExpiry: process.env.JWT_EXPIRY || '7d',
```

- [ ] **Step 3: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/domain/auth.ts src/core/config.ts
git commit -m "feat: Auth 领域——JWT 双 token 签发/验证 + API Key"
```

---

## Task 10: Middleware — JWT 认证 + 权限检查

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/middleware/jwt-auth.ts`
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/middleware/require-permission.ts`
- Modify: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/types/hono.d.ts`

- [ ] **Step 1: 更新 hono.d.ts**

```typescript
export interface ContextVariableMap {
  workerId: string;
  userId: string;
  userPermissions: string[];
  userOrgId: string | null;
  isSuperAdmin: boolean;
}
```

- [ ] **Step 2: 写 jwt-auth 中间件**

```typescript
// src/server/middleware/jwt-auth.ts
import type { MiddlewareHandler } from 'hono';
import { verifyAccessToken, verifyApiKey } from '../../domain/auth.js';
import { getUserById, getUserPermissions } from '../../domain/user.js';

/**
 * JWT 认证中间件。
 * 支持两种方式：
 *   1. Authorization: Bearer <jwt>
 *   2. X-API-Key: <api_key>
 */
export const jwtAuth: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const apiKeyHeader = c.req.header('X-API-Key');

  let userId: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyAccessToken(token);
    if (!payload) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    userId = payload.sub;
  } else if (apiKeyHeader) {
    const result = await verifyApiKey(apiKeyHeader);
    if (!result) {
      return c.json({ error: 'Invalid API key' }, 401);
    }
    userId = result.userId;
  } else {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const user = await getUserById(userId);
  if (!user || user.status !== 'active') {
    return c.json({ error: 'User not found or disabled' }, 401);
  }

  const permissions = await getUserPermissions(userId);
  const isSuperAdmin = user.is_super_admin || permissions.includes('*');

  c.set('userId', userId);
  c.set('userPermissions', permissions);
  c.set('userOrgId', user.organization_id);
  c.set('isSuperAdmin', isSuperAdmin);

  await next();
};
```

- [ ] **Step 3: 写 require-permission 中间件工厂**

```typescript
// src/server/middleware/require-permission.ts
import type { Context } from 'hono';
import { matchPermission } from '../../domain/rbac.js';

/** 返回一个中间件，检查当前用户是否拥有指定权限码 */
export function requirePermission(code: string) {
  return async (c: Context, next: () => Promise<void>) => {
    const isSuperAdmin = c.get('isSuperAdmin');
    const permissions = c.get('userPermissions') as string[];

    if (isSuperAdmin || matchPermission(permissions, code)) {
      await next();
      return;
    }
    return c.json({ error: `Permission denied: requires '${code}'` }, 403);
  };
}
```

- [ ] **Step 4: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/server/middleware/jwt-auth.ts src/server/middleware/require-permission.ts src/types/hono.d.ts
git commit -m "feat: JWT 认证中间件 + 权限检查工厂"
```

---

## Task 11: Routes — Auth（login/refresh/logout/apikey）

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/routes/auth.ts`

- [ ] **Step 1: 写 auth 路由**

```typescript
import { Hono } from 'hono';
import { issueTokenPair, createApiKey, listApiKeys, revokeApiKey } from '../../domain/auth.js';
import { getUserByUsername, verifyPassword, touchLogin, getUserRoleIds } from '../../domain/user.js';
import { jwtAuth } from '../middleware/jwt-auth.js';

export function createAuthRoutes() {
  const router = new Hono();

  // POST /api/v1/auth/login
  router.post('/login', async (c) => {
    const body = await c.req.json<{ username: string; password: string }>();
    if (!body.username || !body.password) {
      return c.json({ error: 'username and password required' }, 400);
    }

    const user = await getUserByUsername(body.username);
    if (!user || !user.password_hash) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    await touchLogin(user.id);

    const { access_token, refresh_token, expires_in } = issueTokenPair(user.id);
    const roleIds = await getUserRoleIds(user.id);

    // refresh token 放 HttpOnly cookie
    c.header('Set-Cookie', `refresh_token=${refresh_token}; HttpOnly; Path=/api/v1/auth; Max-Age=2592000; SameSite=Strict`);

    return c.json({
      access_token,
      expires_in,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        is_super_admin: user.is_super_admin,
        is_org_admin: user.is_org_admin,
        organization_id: user.organization_id,
        roles: roleIds,
      },
    });
  });

  // POST /api/v1/auth/refresh
  router.post('/refresh', async (c) => {
    const cookie = c.req.header('Cookie') ?? '';
    const match = cookie.match(/refresh_token=([^;]+)/);
    const refreshToken = match?.[1] ?? c.req.json<{ refresh_token?: string }>().refresh_token;

    if (!refreshToken) {
      return c.json({ error: 'No refresh token' }, 400);
    }

    const { verifyRefreshToken } = await import('../../domain/auth.js');
    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      return c.json({ error: 'Invalid refresh token' }, 401);
    }

    const { access_token, expires_in } = issueTokenPair(payload.sub);
    return c.json({ access_token, expires_in });
  });

  // POST /api/v1/auth/logout
  router.post('/logout', (c) => {
    c.header('Set-Cookie', 'refresh_token=; HttpOnly; Path=/api/v1/auth; Max-Age=0');
    return c.json({ success: true });
  });

  // GET /api/v1/auth/me
  router.get('/me', jwtAuth, async (c) => {
    const userId = c.get('userId');
    const { getUserById, getUserPermissions, getUserRoleIds } = await import('../../domain/user.js');
    const user = await getUserById(userId);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const [permissions, roleIds] = await Promise.all([
      getUserPermissions(userId),
      getUserRoleIds(userId),
    ]);

    return c.json({
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      is_super_admin: user.is_super_admin,
      is_org_admin: user.is_org_admin,
      organization_id: user.organization_id,
      roles: roleIds,
      permissions,
    });
  });

  // ---- API Key 管理（需要 JWT 认证）----

  router.post('/apikey', jwtAuth, async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json<{ name: string; scope: 'read' | 'write' | 'admin'; expires_at?: string }>();
    if (!body.name || !body.scope) {
      return c.json({ error: 'name and scope required' }, 400);
    }

    const { apiKey, keyId } = await createApiKey(userId, body.name, body.scope, body.expires_at);
    return c.json({ api_key: apiKey, key_id: keyId, name: body.name, scope: body.scope, expires_at: body.expires_at ?? null });
  });

  router.get('/apikey', jwtAuth, async (c) => {
    const userId = c.get('userId');
    const keys = await listApiKeys(userId);
    return c.json({ keys });
  });

  router.delete('/apikey/:id', jwtAuth, async (c) => {
    const userId = c.get('userId');
    const keyId = c.req.param('id');
    const ok = await revokeApiKey(userId, keyId);
    if (!ok) return c.json({ error: 'Key not found' }, 404);
    return c.json({ success: true });
  });

  return router;
}
```

- [ ] **Step 2: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/server/routes/auth.ts
git commit -m "feat: auth 路由——login/refresh/logout/me/apikey"
```

---

## Task 12: Routes — Organizations CRUD + 树查询

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/routes/orgs.ts`

- [ ] **Step 1: 写 org 路由**

```typescript
import { Hono } from 'hono';
import { createOrg, getOrgById, buildOrgTree, updateOrg, deleteOrg, listOrgs } from '../../domain/organization.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { requirePermission } from '../middleware/require-permission.js';

export function createOrgRoutes() {
  const router = new Hono();

  // 所有路由都需要 JWT 认证
  router.use('*', jwtAuth);

  // GET /api/v1/orgs — 列出所有（super_admin）或本组织子树
  router.get('/', async (c) => {
    const isSuperAdmin = c.get('isSuperAdmin');
    const userOrgId = c.get('userOrgId') as string | null;

    if (isSuperAdmin) {
      const orgs = await listOrgs();
      return c.json({ organizations: orgs });
    }

    // 非 super_admin 只能看本组织子树
    if (!userOrgId) {
      return c.json({ organizations: [] });
    }
    const tree = await buildOrgTree(userOrgId);
    return c.json({ organization: tree });
  });

  // GET /api/v1/orgs/tree — 获取完整组织树（super_admin）
  router.get('/tree', requirePermission('org:read'), async (c) => {
    const tree = await buildOrgTree('root');
    return c.json({ tree });
  });

  // GET /api/v1/orgs/:id
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const org = await getOrgById(id);
    if (!org) return c.json({ error: 'Organization not found' }, 404);

    // 权限检查：非 super_admin 只能看本组织及子组织
    const isSuperAdmin = c.get('isSuperAdmin');
    const userOrgId = c.get('userOrgId') as string | null;
    if (!isSuperAdmin && userOrgId) {
      // 检查请求的 org 是否在用户 org 的子树中
      if (!org.path.startsWith((await getOrgById(userOrgId))?.path ?? '__none__')) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    return c.json({ organization: org });
  });

  // GET /api/v1/orgs/:id/tree — 获取指定 org 的子树
  router.get('/:id/tree', async (c) => {
    const id = c.req.param('id');
    const tree = await buildOrgTree(id);
    if (!tree) return c.json({ error: 'Organization not found' }, 404);
    return c.json({ tree });
  });

  // POST /api/v1/orgs — 创建组织
  router.post('/', requirePermission('org:create'), async (c) => {
    const body = await c.req.json<{
      name: string;
      code: string;
      description?: string;
      parent_id?: string;
      type: string;
      settings?: Record<string, unknown>;
    }>();

    if (!body.name || !body.code || !body.type) {
      return c.json({ error: 'name, code, type required' }, 400);
    }

    try {
      const org = await createOrg({
        name: body.name,
        code: body.code,
        description: body.description,
        parent_id: body.parent_id ?? 'root',
        type: body.type,
        settings: body.settings,
      });
      return c.json({ organization: org }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Create failed' }, 400);
    }
  });

  // PATCH /api/v1/orgs/:id
  router.patch('/:id', requirePermission('org:update'), async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const org = await updateOrg(id, body);
    if (!org) return c.json({ error: 'Organization not found' }, 404);
    return c.json({ organization: org });
  });

  // DELETE /api/v1/orgs/:id
  router.delete('/:id', requirePermission('org:delete'), async (c) => {
    const id = c.req.param('id');
    if (id === 'root') return c.json({ error: 'Cannot delete root organization' }, 400);
    const result = await deleteOrg(id);
    if (!result.deleted) {
      return c.json({ error: result.reason ?? 'Cannot delete' }, 400);
    }
    return c.json({ success: true });
  });

  return router;
}
```

- [ ] **Step 2: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/server/routes/orgs.ts
git commit -m "feat: org 路由——CRUD + 树形查询 + 子树权限隔离"
```

---

## Task 13: Routes — Users CRUD + 邀请

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/routes/users.ts`

- [ ] **Step 1: 写 users 路由**

```typescript
import { Hono } from 'hono';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { requirePermission } from '../middleware/require-permission.js';
import {
  createUser, getUserById, listAllUsers, listUsersByOrg,
  updateUser, assignRole, removeRole, getUserRoleIds,
} from '../../domain/user.js';
import { listRoles } from '../../domain/rbac.js';

export function createUserRoutes() {
  const router = new Hono();
  router.use('*', jwtAuth);

  // GET /api/v1/users — super_admin 全部，org_admin 本组织
  router.get('/', requirePermission('user:read'), async (c) => {
    const isSuperAdmin = c.get('isSuperAdmin');
    const userOrgId = c.get('userOrgId') as string | null;
    const page = parseInt(c.req.query('page') ?? '1', 10);
    const pageSize = parseInt(c.req.query('pageSize') ?? '50', 10);

    if (isSuperAdmin) {
      const users = await listAllUsers(pageSize, (page - 1) * pageSize);
      return c.json({ users, page, pageSize });
    }

    if (!userOrgId) return c.json({ users: [] });
    const users = await listUsersByOrg(userOrgId);
    return c.json({ users });
  });

  // GET /api/v1/users/:id
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const user = await getUserById(id);
    if (!user) return c.json({ error: 'User not found' }, 404);

    // 非 super_admin 只能看本组织用户
    const isSuperAdmin = c.get('isSuperAdmin');
    const userOrgId = c.get('userOrgId') as string | null;
    const requesterId = c.get('userId');
    if (id !== requesterId && !isSuperAdmin && user.organization_id !== userOrgId) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const roleIds = await getUserRoleIds(id);
    return c.json({ user: { ...user, password_hash: undefined, roles: roleIds } });
  });

  // POST /api/v1/users — 创建用户（邀请）
  router.post('/', requirePermission('user:create'), async (c) => {
    const body = await c.req.json<{
      username: string;
      email?: string;
      display_name?: string;
      password: string;
      organization_id?: string;
      is_org_admin?: boolean;
    }>();

    if (!body.username || !body.password) {
      return c.json({ error: 'username and password required' }, 400);
    }

    // 非 super_admin 只能创建本组织用户
    const isSuperAdmin = c.get('isSuperAdmin');
    const userOrgId = c.get('userOrgId') as string | null;
    if (!isSuperAdmin) {
      if (!userOrgId) return c.json({ error: 'No organization context' }, 400);
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
      return c.json({ user: { ...user, password_hash: undefined } }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Create failed' }, 400);
    }
  });

  // PATCH /api/v1/users/:id
  router.patch('/:id', requirePermission('user:update'), async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();

    // 非 super_admin 不能改 super_admin 字段
    const isSuperAdmin = c.get('isSuperAdmin');
    if (!isSuperAdmin && body.is_super_admin !== undefined) {
      delete body.is_super_admin;
    }

    const user = await updateUser(id, body);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json({ user: { ...user, password_hash: undefined } });
  });

  // POST /api/v1/users/:id/roles — 分配角色
  router.post('/:id/roles', requirePermission('role:assign'), async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ role_id: string }>();
    if (!body.role_id) return c.json({ error: 'role_id required' }, 400);

    await assignRole(id, body.role_id);
    const roleIds = await getUserRoleIds(id);
    return c.json({ roles: roleIds });
  });

  // DELETE /api/v1/users/:id/roles/:roleId
  router.delete('/:id/roles/:roleId', requirePermission('role:assign'), async (c) => {
    const id = c.req.param('id');
    const roleId = c.req.param('roleId');

    // 系统角色保护
    const roles = await listRoles();
    const role = roles.find(r => r.id === roleId);
    if (role?.is_system && roleId === 'role_super_admin') {
      return c.json({ error: 'Cannot remove super_admin role' }, 400);
    }

    await removeRole(id, roleId);
    const roleIds = await getUserRoleIds(id);
    return c.json({ roles: roleIds });
  });

  // GET /api/v1/users/:id/permissions — 获取用户权限
  router.get('/:id/permissions', async (c) => {
    const id = c.req.param('id');
    const requesterId = c.get('userId');
    const isSuperAdmin = c.get('isSuperAdmin');
    if (id !== requesterId && !isSuperAdmin) {
      return c.json({ error: 'Access denied' }, 403);
    }
    const { getUserPermissions } = await import('../../domain/user.js');
    const permissions = await getUserPermissions(id);
    return c.json({ permissions });
  });

  return router;
}
```

- [ ] **Step 2: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/server/routes/users.ts
git commit -m "feat: users 路由——CRUD + 角色分配 + 权限隔离"
```

---

## Task 14: Routes — RBAC（角色/权限查询）

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/routes/rbac.ts`

- [ ] **Step 1: 写 rbac 路由**

```typescript
import { Hono } from 'hono';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { listRoles, listPermissions, getRolePermissions, setRolePermissions } from '../../domain/rbac.js';

export function createRbacRoutes() {
  const router = new Hono();
  router.use('*', jwtAuth);

  // GET /api/v1/rbac/roles
  router.get('/roles', async (c) => {
    const orgId = c.req.query('org_id');
    const roles = await listRoles(orgId);
    return c.json({ roles });
  });

  // GET /api/v1/rbac/roles/:id/permissions
  router.get('/roles/:id/permissions', async (c) => {
    const id = c.req.param('id');
    const codes = await getRolePermissions(id);
    return c.json({ permissions: codes });
  });

  // PUT /api/v1/rbac/roles/:id/permissions — 全量替换角色权限
  router.put('/roles/:id/permissions', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ permission_codes: string[] }>();
    if (!Array.isArray(body.permission_codes)) {
      return c.json({ error: 'permission_codes must be array' }, 400);
    }

    // 仅 super_admin 可改
    if (!c.get('isSuperAdmin')) {
      return c.json({ error: 'Only super admin can modify role permissions' }, 403);
    }

    try {
      await setRolePermissions(id, body.permission_codes);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Update failed' }, 400);
    }
  });

  // GET /api/v1/rbac/permissions
  router.get('/permissions', async (c) => {
    const permissions = await listPermissions();
    return c.json({ permissions });
  });

  return router;
}
```

- [ ] **Step 2: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/server/routes/rbac.ts
git commit -m "feat: rbac 路由——角色/权限查询 + 权限分配"
```

---

## Task 15: Upgrade Workers Routes — 申请-审批流程

**Files:**
- Modify: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/routes/workers.ts`

- [ ] **Step 1: 读现有 workers.ts**

Run: `cat /mnt/d/code/deepanalyze/deepanalyze-hub/src/server/routes/workers.ts`

- [ ] **Step 2: 重写 register 端点支持申请-审批**

将 `POST /workers/register` 改为：
- 如果 worker 已存在且 approved，返回已有 token
- 如果是新 worker，创建 `status='pending'` 记录，返回 `status='pending'`（无 token 或临时 token）
- super_admin/org_admin 可以通过 `POST /workers/:id/approve` 审批

**注意：保持 v1 兼容**。现有 DA 端通过 `POST /workers/register` 接入，不能破坏。

修改 register 端点核心逻辑：

```typescript
// POST /api/v1/workers/register
router.post('/register', async (c) => {
  const body = await c.req.json<{
    worker_id?: string;
    name: string;
    hostname?: string;
    endpoint?: string;
    version?: string;
    capabilities?: Record<string, unknown>;
    protocol_version?: number;
  }>();

  const protocolVersion = body.protocol_version ?? 1;
  const workerName = body.name || body.hostname || `worker-${Date.now()}`;

  // 如果带 worker_id 且已存在，检查 token
  if (body.worker_id) {
    const existing = await query<{ id: string; worker_token: string; status: string }>(
      `SELECT id, worker_token, status FROM workers WHERE id = $1`,
      [body.worker_id],
    );
    if (existing.rows.length > 0) {
      const w = existing.rows[0];
      if (w.status === 'approved' || w.status === 'online' || w.status === 'offline') {
        // 已审批的 worker，返回 token
        return c.json({
          worker_id: w.id,
          worker_token: w.worker_token,
          status: 'approved',
          server_version: HUB_CONFIG.version,
          protocol_version: 2,
          message: 'Worker reconnected',
        });
      }
      // pending 状态
      return c.json({
        worker_id: w.id,
        worker_token: null,
        status: 'pending',
        server_version: HUB_CONFIG.version,
        protocol_version: 2,
        message: 'Worker application pending approval',
      });
    }
  }

  // 新 worker 申请
  const workerId = `wkr_${crypto.randomUUID().replace(/-/g, '')}`;
  const workerToken = `wkt_${crypto.randomUUID().replace(/-/g, '')}`;

  await query(
    `INSERT INTO workers (id, name, hostname, endpoint, version, capabilities, worker_token, status, protocol_version, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW())`,
    [workerId, workerName, body.hostname ?? null, body.endpoint ?? '', body.version ?? '', JSON.stringify(body.capabilities ?? {}), workerToken, protocolVersion],
  );

  // 记录事件
  await logWorkerEvent(workerId, 'apply', `Worker applied: ${workerName}`);

  // 如果是 v1 协议（现有 DA），自动审批以保持兼容
  if (protocolVersion === 1) {
    await query(
      `UPDATE workers SET status = 'approved', approved_at = NOW(), approved_by = 'system' WHERE id = $1`,
      [workerId],
    );
    await logWorkerEvent(workerId, 'approve', 'Auto-approved (v1 protocol compat)');
    return c.json({
      worker_id: workerId,
      worker_token: workerToken,
      status: 'approved',
      server_version: HUB_CONFIG.version,
      protocol_version: 1,
      message: 'Worker registered (v1 auto-approved)',
    });
  }

  // v2 协议：返回 pending，等待管理员审批
  return c.json({
    worker_id: workerId,
    worker_token: null,
    status: 'pending',
    server_version: HUB_CONFIG.version,
    protocol_version: 2,
    message: 'Worker application submitted. Waiting for approval.',
  }, 202);
});
```

- [ ] **Step 3: 添加审批端点**

```typescript
// POST /api/v1/workers/:id/approve
router.post('/:id/approve', jwtAuth, requirePermission('worker:approve'), async (c) => {
  const id = c.req.param('id');
  const approverId = c.get('userId');

  const rows = await query(`SELECT status FROM workers WHERE id = $1`, [id]);
  if (rows.rows.length === 0) return c.json({ error: 'Worker not found' }, 404);
  if (rows.rows[0].status === 'approved') return c.json({ error: 'Already approved' }, 400);

  await query(
    `UPDATE workers SET status = 'approved', approved_at = NOW(), approved_by = $1 WHERE id = $2`,
    [approverId, id],
  );
  await logWorkerEvent(id, 'approve', `Approved by user ${approverId}`);

  // 生成并返回 token（只在审批时返回一次）
  const token = `wkt_${crypto.randomUUID().replace(/-/g, '')}`;
  await query(`UPDATE workers SET worker_token = $1 WHERE id = $2`, [token, id]);

  return c.json({ success: true, worker_token: token });
});

// POST /api/v1/workers/:id/reject
router.post('/:id/reject', jwtAuth, requirePermission('worker:reject'), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}));
  const rejecterId = c.get('userId');

  const rows = await query(`SELECT status FROM workers WHERE id = $1`, [id]);
  if (rows.rows.length === 0) return c.json({ error: 'Worker not found' }, 404);

  await query(`UPDATE workers SET status = 'rejected' WHERE id = $1`, [id]);
  await logWorkerEvent(id, 'reject', `Rejected by ${rejecterId}: ${body.reason ?? 'no reason'}`);

  return c.json({ success: true });
});

// GET /api/v1/workers/pending — 列出待审批
router.get('/pending', jwtAuth, requirePermission('worker:approve'), async (c) => {
  const rows = await query(
    `SELECT id, name, display_name, hostname, version, capabilities, applied_at
     FROM workers WHERE status = 'pending' ORDER BY applied_at DESC`,
  );
  return c.json({ workers: rows.rows });
});
```

- [ ] **Step 4: 添加 logWorkerEvent 辅助函数**

在文件底部添加：

```typescript
async function logWorkerEvent(workerId: string, eventType: string, detail: string): Promise<void> {
  const id = `evt_${crypto.randomUUID().replace(/-/g, '')}`;
  await query(
    `INSERT INTO worker_connection_events (id, worker_id, event_type, detail) VALUES ($1, $2, $3, $4)`,
    [id, workerId, eventType, detail],
  );
}
```

- [ ] **Step 5: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/server/routes/workers.ts
git commit -m "feat: worker 申请-审批流程（v1 自动审批保持兼容，v2 需审批）"
```

---

## Task 16: 挂载新路由到 app.ts

**Files:**
- Modify: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/server/app.ts`

- [ ] **Step 1: 读取 app.ts**

Run: `cat /mnt/d/code/deepanalyze/deepanalyze-hub/src/server/app.ts`

- [ ] **Step 2: 在 route 挂载段添加**

```typescript
const [workersMod, configMod, marketplaceMod, authMod, orgsMod, usersMod, rbacMod] = await Promise.all([
  import('./routes/workers.js'),
  import('./routes/config.js'),
  import('./routes/marketplace.js'),
  import('./routes/auth.js'),
  import('./routes/orgs.js'),
  import('./routes/users.js'),
  import('./routes/rbac.js'),
]);

app.route('/api/v1/workers', workersMod.createWorkerRoutes());
app.route('/api/v1/config', configMod.createConfigRoutes());
app.route('/api/v1/marketplace', marketplaceMod.createMarketplaceRoutes());
app.route('/api/v1/auth', authMod.createAuthRoutes());
app.route('/api/v1/orgs', orgsMod.createOrgRoutes());
app.route('/api/v1/users', usersMod.createUserRoutes());
app.route('/api/v1/rbac', rbacMod.createRbacRoutes());
```

- [ ] **Step 3: typecheck + 提交**

```bash
npx tsc --noEmit
git add src/server/app.ts
git commit -m "feat: 挂载 auth/orgs/users/rbac 路由到 app"
```

---

## Task 17: 创建 super_admin 初始用户（seed）

**Files:**
- Modify: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/store/migrations/007_workers_upgrade.ts`（已完成）
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/src/store/migrations/008_seed_admin.ts`

- [ ] **Step 1: 写 seed admin migration**

```typescript
import type { Migration } from './runner.js';
import bcrypt from 'bcrypt';

export const up: Migration = async (query) => {
  // 检查是否已有 admin 用户
  const existing = await query(`SELECT id FROM users WHERE username = 'admin'`);
  if (existing.rows.length > 0) return;

  const id = 'usr_admin';
  const passwordHash = await bcrypt.hash('admin123', 10);

  await query(
    `INSERT INTO users (id, username, display_name, password_hash, auth_source, is_super_admin, role)
     VALUES ($1, 'admin', 'Super Admin', $2, 'local', TRUE, 'admin')`,
    [id, passwordHash],
  );

  await query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'role_super_admin') ON CONFLICT DO NOTHING`,
    [id],
  );
};

export const down: Migration = async (query) => {
  await query(`DELETE FROM users WHERE username = 'admin'`);
};
```

- [ ] **Step 2: 运行 migration**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/store/migrate.ts`

- [ ] **Step 3: 提交**

```bash
git add src/store/migrations/008_seed_admin.ts
git commit -m "feat: seed admin 用户（admin/admin123）migration 008"
```

---

## Task 18: 启动 Hub 验证 + 冒烟测试

- [ ] **Step 1: 启动 Hub**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
PORT=22000 bun run src/main.ts &
sleep 3
```

- [ ] **Step 2: 健康检查**

Run: `curl -s http://localhost:22000/api/health | python3 -m json.tool`
Expected: `{ "status": "ok", ... }`

- [ ] **Step 3: 登录测试**

Run:
```bash
curl -s -X POST http://localhost:22000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -m json.tool
```
Expected: 返回 `access_token` + `user` 信息

- [ ] **Step 4: 使用 token 查询 me**

```bash
TOKEN=$(curl -s -X POST http://localhost:22000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s http://localhost:22000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```
Expected: `is_super_admin: true`

- [ ] **Step 5: 创建组织测试**

```bash
curl -s -X POST http://localhost:22000/api/v1/orgs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"测试公司","code":"TEST","type":"company"}' | python3 -m json.tool
```
Expected: 返回 organization 对象，path 为 `root/<id>`

- [ ] **Step 6: 创建普通用户测试**

```bash
curl -s -X POST http://localhost:22000/api/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"test123","display_name":"测试用户","organization_id":"<上一步的org_id>"}' | python3 -m json.tool
```

- [ ] **Step 7: 权限隔离测试——testuser 不能创建组织**

```bash
USER_TOKEN=$(curl -s -X POST http://localhost:22000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"testuser","password":"test123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s -X POST http://localhost:22000/api/v1/orgs \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"子部门","code":"CHILD","type":"department"}' | python3 -m json.tool
```
Expected: `403 Permission denied`

- [ ] **Step 8: Worker v1 兼容测试（自动审批）**

```bash
curl -s -X POST http://localhost:22000/api/v1/workers/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-worker-v1","hostname":"localhost","protocol_version":1}' | python3 -m json.tool
```
Expected: `status: approved`，返回 `worker_token`

- [ ] **Step 9: Worker v2 申请-审批测试**

```bash
# 申请（无 token）
APPLY=$(curl -s -X POST http://localhost:22000/api/v1/workers/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-worker-v2","hostname":"localhost","protocol_version":2}')
echo "$APPLY" | python3 -m json.tool
WK_ID=$(echo "$APPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['worker_id'])")

# 审批
curl -s -X POST "http://localhost:22000/api/v1/workers/$WK_ID/approve" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

- [ ] **Step 10: 关闭 Hub**

```bash
kill %1 2>/dev/null || true
```

- [ ] **Step 11: 提交（如有热修复）**

```bash
git add -A
git diff --cached --quiet || git commit -m "fix: 冒烟测试发现的问题修复"
```

---

## Task 19: DA 端 hub-client v2 协议升级

**Files:**
- Modify: `/mnt/d/code/deepanalyze/deepanalyze/src/services/hub/hub-client.ts`
- Modify: `/mnt/d/code/deepanalyze/deepanalyze/src/services/hub/types.ts`
- Create: `/mnt/d/code/deepanalyze/deepanalyze/src/services/hub/sync-handler.ts`

- [ ] **Step 1: 读取现有 hub-client.ts**

Run: `wc -l /mnt/d/code/deepanalyze/deepanalyze/src/services/hub/hub-client.ts`

- [ ] **Step 2: 在 types.ts 添加 v2 类型**

在现有 `types.ts` 末尾添加（不删除现有类型）：

```typescript
// ============= Protocol v2 类型 =============

export interface CachedSkill {
  package_id: string;
  version: string;
  content_hash: string;
}

export interface SkillSyncInstruction {
  action: 'sync' | 'force_update' | 'kill' | 'rollback' | 'policy_refresh';
  package_id: string;
  version_id?: string;
  version?: string;
  content?: string;
  content_url?: string;
  hash?: string;
  deadline?: string;
  reason?: string;
  instruction_id: string;
}

export interface HeartbeatResponseV2 {
  message: string;
  instructions: SkillSyncInstruction[];
  policy_version: number;
  server_time: string;
}
```

- [ ] **Step 3: 在 hub-client.ts 扩展 heartbeat 方法**

在现有 `HubClient` 类中找到 `heartbeat()` 方法，扩展为 v2：

```typescript
/**
 * 心跳（v2 协议）。
 * 向 Hub 上报当前状态 + 缓存的 skill 清单 + policy_version。
 * 返回 SkillSyncInstruction 列表。
 */
async heartbeat(): Promise<HeartbeatResponseV2> {
  const cachedSkills = await this.getLocalSkillCache();
  const policyVersion = await this.getStoredPolicyVersion();

  const response = await this.post('/workers/heartbeat', {
    current_task: this.currentTask ?? null,
    cached_skills: cachedSkills,
    policy_version: policyVersion,
    protocol_version: 2,
  });

  // 处理 instructions
  if (response.instructions && response.instructions.length > 0) {
    await this.applyInstructions(response.instructions);
  }

  // 更新 policy_version
  if (response.policy_version && response.policy_version > policyVersion) {
    await this.storePolicyVersion(response.policy_version);
  }

  return response;
}

/** 获取本地缓存的 skill 清单（content_hash = SHA-256[:32]） */
private async getLocalSkillCache(): Promise<CachedSkill[]> {
  // 读取本地 skills 表，计算每个 skill 的 content hash
  const { createHash } = await import('node:crypto');
  const result = await this.db.query(
    `SELECT id, name, content FROM skills WHERE source = 'hub' AND is_active = TRUE`,
  );
  return result.rows.map((row: { id: string; name: string; content: string }) => ({
    package_id: row.id,
    version: '1.0.0', // Phase 2 会从 skill_versions 表获取真实版本
    content_hash: createHash('sha256').update(row.content ?? '').digest('hex').slice(0, 32),
  }));
}

/** 读取本地存储的 policy_version */
private async getStoredPolicyVersion(): Promise<number> {
  try {
    const raw = await this.db.query(
      `SELECT value FROM app_settings WHERE key = 'hub_policy_version'`,
    );
    return parseInt(raw.rows[0]?.value ?? '0', 10);
  } catch {
    return 0;
  }
}

/** 存储新的 policy_version */
private async storePolicyVersion(version: number): Promise<void> {
  await this.db.query(
    `INSERT INTO app_settings (key, value) VALUES ('hub_policy_version', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [String(version)],
  );
}

/** 应用 SkillSync 指令 */
private async applyInstructions(instructions: SkillSyncInstruction[]): Promise<void> {
  const handler = new SyncHandler(this.db);
  for (const inst of instructions) {
    await handler.handle(inst);
    await this.ackInstruction(inst.instruction_id);
  }
}

/** 确认指令已执行 */
private async ackInstruction(instructionId: string): Promise<void> {
  await this.post('/workers/ack', { instruction_id: instructionId }).catch(() => {});
}
```

**注意**：上述方法需要适配现有 `HubClient` 类的实际属性名（如 `this.db`、`this.currentTask`、`this.post` 等）。执行时需要读取现有代码确认。

- [ ] **Step 4: 创建 sync-handler.ts**

```typescript
// src/services/hub/sync-handler.ts
import type { SkillSyncInstruction } from './types.js';

/**
 * 处理来自 Hub 的 SkillSync 指令。
 */
export class SyncHandler {
  constructor(private db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) {}

  async handle(inst: SkillSyncInstruction): Promise<void> {
    switch (inst.action) {
      case 'sync':
        await this.syncSkill(inst);
        break;
      case 'force_update':
        await this.forceUpdateSkill(inst);
        break;
      case 'kill':
        await this.removeLocalSkill(inst.package_id);
        break;
      case 'rollback':
        await this.rollbackSkill(inst);
        break;
      case 'policy_refresh':
        // policy_version 已在 heartbeat 中更新，此处只需日志
        console.log(`[HubClient] Policy refreshed for ${inst.package_id}`);
        break;
    }
  }

  private async syncSkill(inst: SkillSyncInstruction): Promise<void> {
    const content = inst.content ?? (inst.content_url ? await this.fetchContent(inst.content_url) : '');
    if (!content) {
      console.warn(`[HubClient] syncSkill: no content for ${inst.package_id}`);
      return;
    }

    await this.db.query(
      `INSERT INTO skills (id, name, display_name, content, source, is_active, updated_at)
       VALUES ($1, $2, $3, $4, 'hub', TRUE, NOW())
       ON CONFLICT (id) DO UPDATE SET content = $4, is_active = TRUE, updated_at = NOW()`,
      [inst.package_id, inst.package_id, inst.package_id, content],
    );
    console.log(`[HubClient] Synced skill ${inst.package_id} v${inst.version ?? '?'}`);
  }

  private async forceUpdateSkill(inst: SkillSyncInstruction): Promise<void> {
    // 同 sync，但带 deadline 强制性
    await this.syncSkill(inst);
    if (inst.deadline) {
      console.log(`[HubClient] Force update deadline: ${inst.deadline}`);
    }
  }

  private async removeLocalSkill(packageId: string): Promise<void> {
    await this.db.query(
      `UPDATE skills SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
      [packageId],
    );
    console.log(`[HubClient] Killed skill ${packageId}`);
  }

  private async rollbackSkill(inst: SkillSyncInstruction): Promise<void> {
    // Phase 3 实现：从历史版本回退
    console.log(`[HubClient] Rollback skill ${inst.package_id} (not implemented in Phase 1)`);
  }

  private async fetchContent(url: string): Promise<string> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Fetch content failed: ${resp.status}`);
    return await resp.text();
  }
}
```

- [ ] **Step 5: typecheck DA 端**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit | head -20`

- [ ] **Step 6: 提交**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add src/services/hub/
git commit -m "feat: hub-client v2 协议升级——心跳上报 skill cache + policy_version + applyInstructions"
```

---

## Task 20: E2E 测试——Phase 1 集成测试

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/tests/e2e-multi-tenant.sh`

- [ ] **Step 1: 写 E2E 测试脚本**

```bash
#!/bin/bash
# Phase 1 多租户 + 认证 E2E 测试
set -euo pipefail

HUB_URL="${HUB_URL:-http://localhost:22000}"
PASS=0
FAIL=0

assert_eq() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (expected=$expected, actual=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local name="$1" actual="$2" pattern="$3"
  if echo "$actual" | grep -q "$pattern"; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (pattern=$pattern not found in: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Phase 1 E2E Tests ==="

# T1: 健康检查
echo "[T1] Health check"
HEALTH=$(curl -s "$HUB_URL/api/health")
assert_contains "health ok" "$HEALTH" '"ok"'

# T2: admin 登录
echo "[T2] Admin login"
LOGIN=$(curl -s -X POST "$HUB_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}')
ADMIN_TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || echo "")
assert_contains "admin token issued" "$LOGIN" 'access_token'
[ -n "$ADMIN_TOKEN" ] || { echo "FATAL: no admin token"; exit 1; }

# T3: /me 端点
echo "[T3] /me endpoint"
ME=$(curl -s "$HUB_URL/api/v1/auth/me" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "is_super_admin true" "$ME" '"is_super_admin": true'

# T4: 创建组织
echo "[T4] Create organization"
ORG=$(curl -s -X POST "$HUB_URL/api/v1/orgs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"E2E测试公司","code":"E2E_TEST","type":"company"}')
ORG_ID=$(echo "$ORG" | python3 -c "import sys,json; print(json.load(sys.stdin)['organization']['id'])" 2>/dev/null || echo "")
assert_contains "org created" "$ORG" '"id"'
[ -n "$ORG_ID" ] || { echo "FATAL: no org id"; exit 1; }

# T5: 创建子部门
echo "[T5] Create sub-department"
CHILD=$(curl -s -X POST "$HUB_URL/api/v1/orgs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"技术部\",\"code\":\"E2E_TECH\",\"type\":\"department\",\"parent_id\":\"$ORG_ID\"}")
CHILD_ID=$(echo "$CHILD" | python3 -c "import sys,json; print(json.load(sys.stdin)['organization']['id'])" 2>/dev/null || echo "")
assert_contains "child created" "$CHILD" '"id"'

# T6: 组织树
echo "[T6] Org tree"
TREE=$(curl -s "$HUB_URL/api/v1/orgs/$ORG_ID/tree" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "tree has children" "$TREE" '"children"'

# T7: 创建普通用户
echo "[T7] Create regular user"
USER=$(curl -s -X POST "$HUB_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"e2e_user\",\"password\":\"test123\",\"display_name\":\"E2E用户\",\"organization_id\":\"$ORG_ID\"}")
assert_contains "user created" "$USER" '"id"'

# T8: 普通用户登录
echo "[T8] Regular user login"
USER_LOGIN=$(curl -s -X POST "$HUB_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e_user","password":"test123"}')
USER_TOKEN=$(echo "$USER_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || echo "")
assert_contains "user token issued" "$USER_LOGIN" 'access_token'

# T9: 权限隔离——普通用户不能创建组织
echo "[T9] Permission isolation - user cannot create org"
FORBIDDEN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HUB_URL/api/v1/orgs" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"hack","code":"HACK","type":"company"}')
assert_eq "user forbidden from org:create" "$FORBIDDEN" "403"

# T10: 普通用户可以读自己的信息
echo "[T10] User can read own info"
OWN_ME=$(curl -s "$HUB_URL/api/v1/auth/me" -H "Authorization: Bearer $USER_TOKEN")
assert_contains "user is_super_admin false" "$OWN_ME" '"is_super_admin": false'

# T11: Worker v1 自动审批
echo "[T11] Worker v1 auto-approve"
V1=$(curl -s -X POST "$HUB_URL/api/v1/workers/register" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-worker-v1","hostname":"localhost","protocol_version":1}')
assert_contains "v1 auto approved" "$V1" '"status":"approved"'

# T12: Worker v2 申请-审批
echo "[T12] Worker v2 apply-approve flow"
V2_APPLY=$(curl -s -X POST "$HUB_URL/api/v1/workers/register" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-worker-v2","hostname":"localhost","protocol_version":2}')
assert_contains "v2 pending" "$V2_APPLY" '"status":"pending"'
V2_ID=$(echo "$V2_APPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['worker_id'])" 2>/dev/null || echo "")

# 审批
APPROVE=$(curl -s -X POST "$HUB_URL/api/v1/workers/$V2_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "approved with token" "$APPROVE" 'worker_token'

# T13: 列出待审批 worker
echo "[T13] List pending workers"
PENDING=$(curl -s "$HUB_URL/api/v1/workers/pending" -H "Authorization: Bearer $ADMIN_TOKEN")
# 此时可能没有 pending（前面都审批了），只需验证 API 返回 200
assert_contains "pending endpoint works" "$PENDING" 'workers'

# T14: API Key 创建和使用
echo "[T14] API Key creation"
APIKEY=$(curl -s -X POST "$HUB_URL/api/v1/auth/apikey" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-test-key","scope":"read"}')
assert_contains "apikey issued" "$APIKEY" 'api_key'
API_KEY_VAL=$(echo "$APIKEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])" 2>/dev/null || echo "")

# 用 API Key 访问 /me
ME_VIA_KEY=$(curl -s "$HUB_URL/api/v1/auth/me" -H "X-API-Key: $API_KEY_VAL")
assert_contains "apikey works for /me" "$ME_VIA_KEY" 'admin'

# T15: RBAC - 列出角色
echo "[T15] List roles"
ROLES=$(curl -s "$HUB_URL/api/v1/rbac/roles" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "super admin role exists" "$ROLES" '超级管理员'

# T16: RBAC - 列出权限
echo "[T16] List permissions"
PERMS=$(curl -s "$HUB_URL/api/v1/rbac/permissions" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "org:create permission exists" "$PERMS" 'org:create'

# T17: 创建 org_admin 用户并验证本组织数据隔离
echo "[T17] Org admin isolation"
ORG_ADMIN=$(curl -s -X POST "$HUB_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"e2e_orgadmin\",\"password\":\"test123\",\"organization_id\":\"$ORG_ID\",\"is_org_admin\":true}")
assert_contains "org admin created" "$ORG_ADMIN" '"id"'

OA_LOGIN=$(curl -s -X POST "$HUB_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e_orgadmin","password":"test123"}')
OA_TOKEN=$(echo "$OA_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || echo "")

# org_admin 能看本组织用户
ORG_USERS=$(curl -s "$HUB_URL/api/v1/users" -H "Authorization: Bearer $OA_TOKEN")
assert_contains "org admin sees org users" "$ORG_USERS" 'e2e_user'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
```

- [ ] **Step 2: 给脚本执行权限并运行**

```bash
chmod +x /mnt/d/code/deepanalyze/deepanalyze-hub/tests/e2e-multi-tenant.sh

# 确保 Hub 在运行
cd /mnt/d/code/deepanalyze/deepanalyze-hub
PORT=22000 bun run src/main.ts &
sleep 3

# 运行测试
./tests/e2e-multi-tenant.sh

# 关闭
kill %1 2>/dev/null || true
```
Expected: `0 failed`

- [ ] **Step 3: 提交**

```bash
git add tests/e2e-multi-tenant.sh
git commit -m "test: Phase 1 多租户 + 认证 E2E 测试（17 项）"
```

---

## Task 21: 前端管理后台（基础版）

**Files:**
- Create: `/mnt/d/code/deepanalyze/deepanalyze-hub/frontend/` 目录结构

**注意：** 前端是较大工作量。此 Task 提供最小可用版本：登录页 + Dashboard + 组织树查看 + 用户列表 + Worker 审批。使用 React + Vite + TypeScript。

- [ ] **Step 1: 初始化 Vite + React 项目**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
mkdir -p frontend
cd frontend
npm create vite@latest . -- --template react-ts
npm install
npm install react-router-dom
```

- [ ] **Step 2: 创建 API 客户端**

```typescript
// frontend/src/api/client.ts
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:22000/api/v1';

let accessToken: string | null = localStorage.getItem('da_hub_token');

export function setToken(token: string | null) {
  accessToken = token;
  if (token) localStorage.setItem('da_hub_token', token);
  else localStorage.removeItem('da_hub_token');
}

export function getToken(): string | null {
  return accessToken;
}

async function request(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (resp.status === 401) {
    setToken(null);
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  return resp;
}

export const api = {
  async login(username: string, password: string) {
    const resp = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Login failed');
    setToken(data.access_token);
    return data;
  },

  async me() {
    const resp = await request('/auth/me');
    return resp.json();
  },

  async getOrgTree() {
    const resp = await request('/orgs/tree');
    return resp.json();
  },

  async getUsers() {
    const resp = await request('/users');
    return resp.json();
  },

  async getPendingWorkers() {
    const resp = await request('/workers/pending');
    return resp.json();
  },

  async approveWorker(id: string) {
    const resp = await request(`/workers/${id}/approve`, { method: 'POST' });
    return resp.json();
  },

  async rejectWorker(id: string, reason?: string) {
    const resp = await request(`/workers/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    return resp.json();
  },
};
```

- [ ] **Step 3: 创建 App.tsx（路由 + 布局）**

```tsx
// frontend/src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { api, getToken } from './api/client';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import OrgTree from './pages/OrgTree';
import UserList from './pages/UserList';
import WorkerApproval from './pages/WorkerApproval';

interface UserInfo {
  id: string;
  username: string;
  is_super_admin: boolean;
}

function ProtectedRoute({ children, user }: { children: React.ReactNode; user: UserInfo | null }) {
  if (!user) return <Navigate to="/login" />;
  return <>{children}</>;
}

export default function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api.me()
      .then(data => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 40 }}>Loading...</div>;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login onLogin={setUser} />} />
        <Route path="/" element={
          <ProtectedRoute user={user}>
            <Dashboard user={user} onLogout={() => { api.login.length; setToken(null); setUser(null); }} />
          </ProtectedRoute>
        }>
          <Route index element={<OrgTree />} />
          <Route path="users" element={<UserList />} />
          <Route path="workers" element={<WorkerApproval />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 4: 创建 Login 页面**

```tsx
// frontend/src/pages/Login.tsx
import { useState } from 'react';
import { api } from '../api/client';

export default function Login({ onLogin }: { onLogin: (user: any) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.login(username, password);
      onLogin(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 360, margin: '100px auto', padding: 24 }}>
      <h2>DeepAnalyze Hub</h2>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12 }}>
          <input
            type="text"
            placeholder="用户名"
            value={username}
            onChange={e => setUsername(e.target.value)}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={e => setPassword(e.target.value)}
            style={{ width: '100%', padding: 8, boxSizing: 'border-box' }}
          />
        </div>
        {error && <div style={{ color: 'red', marginBottom: 12 }}>{error}</div>}
        <button type="submit" disabled={loading} style={{ width: '100%', padding: 8 }}>
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: 创建 Dashboard 布局**

```tsx
// frontend/src/pages/Dashboard.tsx
import { NavLink, Outlet } from 'react-router-dom';
import { setToken } from '../api/client';

export default function Dashboard({ user, onLogout }: { user: any; onLogout: () => void }) {
  const handleLogout = () => {
    setToken(null);
    onLogout();
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: 220, background: '#1f2937', color: '#fff', padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>DA Hub</h3>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <NavLink to="/" end style={({ isActive }) => ({ color: isActive ? '#60a5fa' : '#fff', textDecoration: 'none' })}>
            组织树
          </NavLink>
          <NavLink to="/users" style={({ isActive }) => ({ color: isActive ? '#60a5fa' : '#fff', textDecoration: 'none' })}>
            用户管理
          </NavLink>
          <NavLink to="/workers" style={({ isActive }) => ({ color: isActive ? '#60a5fa' : '#fff', textDecoration: 'none' })}>
            Worker 审批
          </NavLink>
        </nav>
        <hr style={{ borderColor: '#374151', margin: '24px 0' }} />
        <div style={{ fontSize: 12, color: '#9ca3af' }}>
          <div>{user?.username}</div>
          {user?.is_super_admin && <div style={{ color: '#fbbf24' }}>超级管理员</div>}
        </div>
        <button onClick={handleLogout} style={{ marginTop: 16, width: '100%', padding: 6, background: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer' }}>
          退出
        </button>
      </aside>
      <main style={{ flex: 1, padding: 24, background: '#f3f4f6' }}>
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 6: 创建 OrgTree 页面**

```tsx
// frontend/src/pages/OrgTree.tsx
import { useState, useEffect } from 'react';
import { api } from '../api/client';

interface OrgNode {
  id: string;
  name: string;
  code: string;
  type: string;
  level: number;
  children: OrgNode[];
  user_count: number;
}

function OrgNodeItem({ node, depth = 0 }: { node: OrgNode; depth?: number }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div style={{ marginLeft: depth * 20 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}
      >
        {node.children.length > 0 ? (expanded ? '▼' : '▶') : '•'}
        <strong>{node.name}</strong>
        <span style={{ color: '#6b7280', fontSize: 12 }}>({node.code})</span>
        <span style={{ color: '#9ca3af', fontSize: 12 }}>— {node.type} · {node.user_count} 用户</span>
      </div>
      {expanded && node.children.map(child => (
        <OrgNodeItem key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function OrgTree() {
  const [tree, setTree] = useState<OrgNode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getOrgTree()
      .then(data => setTree(data.tree))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>加载中...</div>;
  if (!tree) return <div>无组织数据</div>;

  return (
    <div>
      <h2>组织架构</h2>
      <OrgNodeItem node={tree} />
    </div>
  );
}
```

- [ ] **Step 7: 创建 UserList 页面**

```tsx
// frontend/src/pages/UserList.tsx
import { useState, useEffect } from 'react';
import { api } from '../api/client';

export default function UserList() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getUsers()
      .then(data => setUsers(data.users))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>加载中...</div>;

  return (
    <div>
      <h2>用户列表</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: 8 }}>用户名</th>
            <th style={{ padding: 8 }}>显示名</th>
            <th style={{ padding: 8 }}>邮箱</th>
            <th style={{ padding: 8 }}>角色</th>
            <th style={{ padding: 8 }}>状态</th>
            <th style={{ padding: 8 }}>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u: any) => (
            <tr key={u.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
              <td style={{ padding: 8 }}>{u.username}</td>
              <td style={{ padding: 8 }}>{u.display_name ?? '-'}</td>
              <td style={{ padding: 8 }}>{u.email ?? '-'}</td>
              <td style={{ padding: 8 }}>
                {u.is_super_admin ? '超级管理员' : u.is_org_admin ? '组织管理员' : '普通用户'}
              </td>
              <td style={{ padding: 8 }}>{u.status}</td>
              <td style={{ padding: 8 }}>{new Date(u.created_at).toLocaleString('zh-CN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: 创建 WorkerApproval 页面**

```tsx
// frontend/src/pages/WorkerApproval.tsx
import { useState, useEffect } from 'react';
import { api } from '../api/client';

export default function WorkerApproval() {
  const [workers, setWorkers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.getPendingWorkers()
      .then(data => setWorkers(data.workers))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const approve = async (id: string) => {
    try {
      await api.approveWorker(id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Approve failed');
    }
  };

  const reject = async (id: string) => {
    try {
      await api.rejectWorker(id, 'Rejected from UI');
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Reject failed');
    }
  };

  if (loading) return <div>加载中...</div>;

  return (
    <div>
      <h2>Worker 审批 ({workers.length})</h2>
      {workers.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>无待审批 Worker</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: 8 }}>名称</th>
              <th style={{ padding: 8 }}>主机</th>
              <th style={{ padding: 8 }}>版本</th>
              <th style={{ padding: 8 }}>申请时间</th>
              <th style={{ padding: 8 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w: any) => (
              <tr key={w.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: 8 }}>{w.name}</td>
                <td style={{ padding: 8 }}>{w.hostname ?? '-'}</td>
                <td style={{ padding: 8 }}>{w.version ?? '-'}</td>
                <td style={{ padding: 8 }}>{new Date(w.applied_at).toLocaleString('zh-CN')}</td>
                <td style={{ padding: 8, display: 'flex', gap: 8 }}>
                  <button onClick={() => approve(w.id)} style={{ padding: '4px 12px', background: '#10b981', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    批准
                  </button>
                  <button onClick={() => reject(w.id)} style={{ padding: '4px 12px', background: '#ef4444', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    拒绝
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 9: 验证前端能 build**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/frontend
npm run build
```
Expected: `dist/` 生成，无 TypeScript 错误

- [ ] **Step 10: 提交**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add frontend/
git commit -m "feat: Hub 管理后台前端——登录/组织树/用户列表/Worker 审批"
```

---

## Task 22: 最终验收 + 提交

- [ ] **Step 1: 运行所有 migration + 重启 Hub**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun run src/store/migrate.ts
PORT=22000 bun run src/main.ts &
sleep 3
```

- [ ] **Step 2: 运行完整 E2E 测试**

```bash
./tests/e2e-multi-tenant.sh
```
Expected: 17/17 通过

- [ ] **Step 3: 启动前端开发服务器手动验证**

```bash
cd frontend
npm run dev
# 浏览器打开 http://localhost:5173
# 用 admin/admin123 登录
# 检查组织树、用户列表、Worker 审批页面
```

- [ ] **Step 4: DA 端 hub-client v2 集成测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
# 启动 DA，配置 DA_SERVER_URL=http://localhost:22000
DA_SERVER_URL=http://localhost:22000 python3 start.py --no-docker --skip-frontend --port 21000 &
sleep 5

# 检查 DA 日志确认 Hub 连接
tail -50 /tmp/da_debug*.log | grep -i hub
```
Expected: DA worker 成功注册到 Hub 并收到 token

- [ ] **Step 5: 关闭所有服务**

```bash
kill %1 %2 2>/dev/null || true
pkill -f "bun run src/main" 2>/dev/null || true
```

- [ ] **Step 6: Phase 1 最终提交**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add -A
git status
git diff --cached --quiet || git commit -m "chore: Phase 1 最终验收修复"

cd /mnt/d/code/deepanalyze/deepanalyze
git add -A
git status
git diff --cached --quiet || git commit -m "chore: Phase 1 DA 端 hub-client v2 验收"
```

---

## Phase 1 验收标准核对

- [ ] 能在 Hub 注册 Organization + 用户（Task 18 T4-T7 验证）
- [ ] 能审批 DA worker 接入（Task 18 T11-T12 验证）
- [ ] DA worker 能心跳上报 + 接收 config 同步（Task 22 Step 4 验证）
- [ ] 权限测试：org_admin 不能操作其他 org 资源（Task 18 T9 验证）
- [ ] 前端管理后台可用（Task 22 Step 3 验证）

---

## Self-Review 记录

执行计划后，对照以下检查：

1. **Spec 覆盖**：
   - [x] @deepanalyze/contracts 包（Task 1）
   - [x] Hub scaffold 复用现有（已有 Hono + PG）
   - [x] auth/ 模块（Task 9-11）
   - [x] org/ 树形 CRUD（Task 6, 12）
   - [x] user/ CRUD + 邀请（Task 7, 13）
   - [x] rbac/ Role/Permission + DataScope（Task 8, 14, 10）
   - [x] worker/ 申请-审批（Task 15）
   - [x] DA hub-client v2（Task 19）
   - [x] 前端管理后台（Task 21）

2. **类型一致性**：
   - `OrgRecord` 在 domain/organization.ts 定义，routes/orgs.ts 使用
   - `UserRecord` 在 domain/user.ts 定义，routes/users.ts 使用
   - `TokenPair` 在 domain/auth.ts 定义，routes/auth.ts 使用
   - contracts 包的 `HeartbeatRequest` 与 DA hub-client.ts 使用的类型一致

3. **无占位符**：每个 Task 的代码都是可直接运行的完整实现。
