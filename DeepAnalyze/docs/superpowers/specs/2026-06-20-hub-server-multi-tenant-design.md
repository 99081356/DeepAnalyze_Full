# DeepAnalyze Hub Server 多租户融合设计

- **日期**：2026-06-20
- **状态**：设计已确认，待编写实施计划
- **作者**：leotangcw + Claude
- **相关项目**：
  - DeepAnalyze（DA）本体：`https://github.com/leotangcw/DeepAnalyze`
  - DAclaw（参考来源）：`refcode/DAclaw/`
  - 新建 Hub Server 仓库：`deepanalyze-hub`（待创建）

---

## 1. 背景与目标

### 1.1 当前现状

**DA（DeepAnalyze）**：
- 完整的单租户通用 Agent 平台（个人用户可独立安装使用）
- 已有 Hub Worker-Client 协议（`src/services/hub/hub-client.ts`），但 **Server 端不在本仓库**
- 本地 skill 系统完整（`agent_skills` 表 + source 追踪 + skill_invoke）
- Plugin 系统完整（双轨制：文件 + DB）
- Agent Team / Workflow 完整（5 模式 + 8 模板）
- **认证授权几乎为零**：users 表存在但未使用，无登录、无 API 认证、无审计
- **多租户概念完全缺失**

**DAclaw（PioneClaw）**：
- 完整的多租户 + skill 审核机制（Python FastAPI + Vue）
- 树形 Organization（company/department/team）+ RBAC + DataScope + DynamicDataRule
- SkillHub 企业级：SkillPackage + SkillVersion 状态机（draft→internal_test→canary→published→deprecated→rolled_back）
- PublishGate 4 维评估（redflag + structure + LLM + benchmark）
- 跨组织 SkillSharing 双边审批
- Runner 同步：心跳驱动 + 持久化指令队列 + Kill Switch + 强制推送
- Security Gateway 独立服务（输入/输出/工具三层过滤）
- 完整认证：local + LDAP + OIDC + MFA + API Key

### 1.2 核心约束

用户的核心诉求：
1. **DA 保持独立单用户可用**——不破坏 DA 当前作为独立软件的设计
2. **企业多租户能力通过 Hub Server 实现**——不把 DA 改成多租户系统
3. **DA 作为 client/worker**——一个租户 = 一个独立 DA 客户端实例
4. **Hub Server 承担所有多租户能力**——鉴权/审核/分享/资源管理都在 Hub 端
5. **参考 DAclaw 的机制**——引入或重建一套（不能直接移植 Python 代码，技术栈不同）
6. **与前期 Hub 系统融合**——在现有 Hub Worker 协议基础上扩展

### 1.3 目标

设计一套**控制平面 / 数据平面分离**的架构：

- **Hub Server（控制平面）**：独立 TypeScript 项目，承担所有多租户能力
- **DA Client（数据平面）**：保持现有 DA 本体不变，接入 Hub 时变身 worker
- **协议扩展**：在现有 Hub Worker 协议基础上增量扩展，DA 端改动最小化

---

## 2. 设计原则

### 2.1 DA 零侵入

DA 主仓库的所有 Hub 相关代码集中在：
- `src/services/hub/hub-client.ts`（现有，扩展）
- `src/services/hub/worker-identity.ts`（现有，保留）
- `src/server/routes/hub.ts`（现有，扩展）
- `src/services/hub/sync-handler.ts`（新增，处理 skill 同步指令）

新增改动量预估：~250 行代码。**个人用户场景完全无感**（不配置 `DA_SERVER_URL` 时 Hub 模块不激活）。

### 2.2 控制平面 / 数据平面分离

```
┌─────────────────────────────────────────────────────┐
│  Hub Server（控制平面）                              │
│  ─ Organization + RBAC + 审计                        │
│  ─ Skill/Plugin/Team/Config 审核与市场              │
│  ─ Worker 注册/鉴权/指令下发                         │
│  ─ 跨组织 Sharing + Security Gateway                 │
└────────────────────┬────────────────────────────────┘
                     │ HTTPS + JWT/Worker Token
                     │ (扩展现有 Hub Worker 协议)
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ DAWorker│  │ DAWorker│  │ DAWorker│
   │ (tenant │  │ (tenant │  │ (tenant │
   │    A)   │  │    B)   │  │    C)   │
   │ 独立 DA │  │ 独立 DA │  │ 独立 DA │
   └─────────┘  └─────────┘  └─────────┘
```

### 2.3 增量协议扩展

保留现有 Hub Worker 协议端点（register/heartbeat/config 同步），向后兼容：
- 现有端点保留，新增能力通过字段扩展（不破坏 v1 协议）
- 引入 `protocol_version` 字段，DA 端检测版本降级协商
- v1 兼容期：6 个月（允许旧版 DA worker 渐进升级）

### 2.4 领域隔离（Hexagonal Architecture）

Hub Server 内部采用六边形架构：
- **domain 层**：领域实体 + 仓库接口（无 IO 依赖）
- **modules 层**：业务模块（依赖 domain）
- **infra 层**：适配器（实现 domain 接口，如 PG / LDAP / OIDC）
- **api 层**：HTTP routes（Fastify）

优势：解耦清晰、易测试、可替换适配器（如换 IdP、换 DB）。

---

## 3. 整体架构

### 3.1 三个仓库

| 仓库 | 职责 | 关系 |
|------|------|------|
| `DeepAnalyze`（现有） | 单租户完整 Agent 平台 | 接入 Hub 时启用 worker 模式；个人使用零感知 |
| `deepanalyze-hub`（新建） | 多租户控制平面 | 通过 `@deepanalyze/contracts` 与 DA 共享协议类型 |
| `@deepanalyze/contracts`（新建 npm 包） | 协议类型定义 | DA 和 Hub 双向依赖，无循环依赖 |

### 3.2 Hub Server 内部模块

```
deepanalyze-hub/
├── src/
│   ├── domain/                  # 领域实体 + 仓库接口（无 IO）
│   │   ├── org.ts               # Organization 树
│   │   ├── user.ts              # User + Role
│   │   ├── skill.ts             # SkillPackage + Version
│   │   ├── plugin.ts
│   │   ├── worker.ts
│   │   └── ...
│   ├── modules/                 # 业务模块
│   │   ├── auth/                # local + LDAP + OIDC + MFA + APIKey
│   │   ├── org/                 # 树形 Organization + RBAC
│   │   ├── skill/               # SkillHub: 版本状态机 + PublishGate
│   │   ├── plugin/
│   │   ├── team/
│   │   ├── config/
│   │   ├── worker/              # 注册/心跳/指令下发
│   │   ├── sharing/             # 跨组织 SkillSharing
│   │   └── security/            # RedFlagScanner + Security Gateway
│   ├── infra/                   # 适配器
│   │   ├── pg/                  # PostgreSQL 仓库实现
│   │   ├── ldap/
│   │   ├── oidc/
│   │   └── security-gateway/    # 内嵌 Security Gateway
│   ├── api/                     # HTTP routes（Fastify）
│   └── main.ts
├── contracts/                   # @deepanalyze/contracts 源码
├── security-rules/              # RedFlag + Gateway 规则文件（支持热重载）
└── docker-compose.yml           # Hub + PG
```

### 3.3 关键设计原则

1. **DA 零侵入**：所有 Hub 相关代码集中在 `src/services/hub/`，新增指令处理在此扩展
2. **协议版本化**：Hub Worker 协议引入 `protocol_version`，DA 端检测版本降级兼容
3. **领域隔离**：domain 层不依赖任何 IO，所有外部访问通过 infra 适配器注入

---

## 4. 数据模型

**通用约定**：
- 所有 `UUID PRIMARY KEY` 字段默认值为 `gen_random_uuid()`（PostgreSQL 13+ 内置）
- 所有时间戳使用 `TIMESTAMPTZ`，统一 UTC 存储
- 所有 `JSONB` 字段 NOT NULL DEFAULT '{}'/[]'，避免 NULL 歧义
- `trust_level` 在 `skills` 和 `skill_packages` 表都有，关系为：`skill_packages.trust_level` 是包级别（影响该包所有版本的默认信任度）；`skill_versions` 不重复定义，跟随包级。`skills` 表的 `trust_level` 是为兼容单文件 skill 直接发布场景（不走 SkillPackage 流程）

### 4.1 租户与身份

#### 4.1.1 树形 Organization（参考 DAclaw organization.py:24-103）

```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  description TEXT,
  parent_id UUID NULL REFERENCES organizations(id),
  level INT NOT NULL,                -- 1=company, 2=department, 3=team
  path TEXT NOT NULL,                -- "uuid1/uuid2/uuid3" 便于子树查询
  type TEXT NOT NULL,                -- company/department/team
  manager_id UUID NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active',
  model_config_ids JSONB,            -- 分配的 AI 模型配置 ID 列表
  settings JSONB,                    -- 组织级设置（输出语言、配额等）
  meta_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_org_parent ON organizations(parent_id);
CREATE INDEX idx_org_path ON organizations USING gin(to_tsvector('simple', path));
```

#### 4.1.2 User（参考 DAclaw models.py:87-157 + 适配 Worker 概念）

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NULL,           -- local 认证可空（OIDC/LDAP 用户）
  auth_source TEXT NOT NULL,         -- local/ldap/oidc
  oidc_subject TEXT NULL,            -- OIDC sub
  ldap_dn TEXT NULL,                 -- LDAP distinguished name
  totp_secret TEXT NULL,             -- MFA encrypted
  backup_codes JSONB NULL,           -- MFA 备份码（哈希存储）
  is_super_admin BOOL NOT NULL DEFAULT FALSE,
  is_org_admin BOOL NOT NULL DEFAULT FALSE,
  organization_id UUID NULL REFERENCES organizations(id),
  default_worker_id UUID NULL REFERENCES workers(id),
  status TEXT NOT NULL DEFAULT 'active', -- active/disabled/locked
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_org ON users(organization_id);
```

#### 4.1.3 RBAC 三件套

```sql
CREATE TABLE roles (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  org_id UUID NULL REFERENCES organizations(id),  -- NULL=系统级角色
  description TEXT,
  is_system BOOL NOT NULL DEFAULT FALSE,           -- 系统预置角色不可删
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, org_id)
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,          -- "skill:create" 格式
  resource TEXT NOT NULL,             -- skill/user/role/org/worker...
  action TEXT NOT NULL,               -- create/read/update/delete/*
  type TEXT NOT NULL,                 -- menu/system/app/api
  parent_id UUID NULL REFERENCES permissions(id),
  description TEXT
);

CREATE TABLE user_roles (
  user_id UUID REFERENCES users(id),
  role_id UUID REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_permissions (
  role_id UUID REFERENCES roles(id),
  permission_id UUID REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

-- 用户组（继承角色权限）
CREATE TABLE user_groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  org_id UUID NULL REFERENCES organizations(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE user_group_members (
  group_id UUID REFERENCES user_groups(id),
  user_id UUID REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE user_group_roles (
  group_id UUID REFERENCES user_groups(id),
  role_id UUID REFERENCES roles(id),
  PRIMARY KEY (group_id, role_id)
);
```

### 4.2 Worker（替代 DAclaw Runner 概念）

```sql
CREATE TABLE workers (
  id UUID PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL,              -- pending/approved/rejected/offline/online
  host TEXT,
  port INT,
  worker_token_hash TEXT NOT NULL,   -- SHA-256 hash（不存明文）
  capabilities JSONB,                -- CPU/MEM/GPU/OS/DA版本
  version TEXT,
  platform TEXT,
  last_heartbeat TIMESTAMPTZ NULL,
  current_task TEXT,
  total_tasks INT NOT NULL DEFAULT 0,
  success_tasks INT NOT NULL DEFAULT 0,
  failed_tasks INT NOT NULL DEFAULT 0,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ NULL,
  approved_by UUID NULL REFERENCES users(id),
  user_id UUID NULL REFERENCES users(id),  -- 归属用户（间接关联 org）
  token_rotated_at TIMESTAMPTZ NULL,
  token_expires_at TIMESTAMPTZ NULL,  -- 旧 token 24h 过渡期
  diagnostics JSONB,
  protocol_version INT NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_worker_user ON workers(user_id);
CREATE INDEX idx_worker_status ON workers(status);

CREATE TABLE worker_connection_events (
  id UUID PRIMARY KEY,
  worker_id UUID NOT NULL REFERENCES workers(id),
  event_type TEXT NOT NULL,         -- online/offline/disconnect/token_rotate/heartbeat_fail
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wce_worker ON worker_connection_events(worker_id, created_at DESC);
```

### 4.3 Skill 企业级管理

#### 4.3.1 基础 skills 表（兼容 DA 现有 agent_skills schema 的超集）

```sql
CREATE TABLE skills (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'custom',
  scope TEXT NOT NULL DEFAULT 'user',     -- system/org/user
  organization_id UUID NULL REFERENCES organizations(id),
  creator_id UUID NULL REFERENCES users(id),
  is_active BOOL NOT NULL DEFAULT TRUE,
  is_public BOOL NOT NULL DEFAULT TRUE,
  trust_level TEXT NOT NULL DEFAULT 'community', -- certified/verified/community
  triggers TEXT[],
  tags TEXT[],
  content TEXT,                           -- SKILL.md 内容
  config JSONB,
  dependencies JSONB,
  paths JSONB,
  source TEXT NOT NULL DEFAULT 'manual',  -- builtin/plugin/manual/hub
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, source)
);
CREATE INDEX idx_skill_org ON skills(organization_id);
CREATE INDEX idx_skill_scope ON skills(scope, organization_id);
```

#### 4.3.2 SkillPackage：企业级管理单元（参考 DAclaw models.py:1062-1112）

```sql
CREATE TABLE skill_packages (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  org_id UUID NULL REFERENCES organizations(id),
  display_name TEXT NOT NULL DEFAULT '',
  description TEXT,
  author_id UUID NULL REFERENCES users(id),
  scope TEXT NOT NULL DEFAULT 'user',
  category TEXT NOT NULL DEFAULT 'custom',
  tags JSONB NOT NULL DEFAULT '[]',
  icon TEXT,
  stats JSONB NOT NULL DEFAULT '{}',      -- 下载/订阅/评分聚合
  trust_level TEXT NOT NULL DEFAULT 'community',
  active_version_id UUID NULL,            -- FK 在 skill_versions 定义后添加
  overrides JSONB NOT NULL DEFAULT '[]',
  rollout_strategy JSONB NOT NULL DEFAULT '{}', -- 灰度策略
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, org_id)
);
CREATE INDEX idx_pkg_org ON skill_packages(org_id, scope);
```

#### 4.3.3 SkillVersion：不可变版本（参考 DAclaw models.py:1114-1146）

```sql
CREATE TABLE skill_versions (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES skill_packages(id),
  version TEXT NOT NULL,                  -- semver "1.0.0"
  content TEXT,                           -- SKILL.md 内容快照
  when_to_use TEXT,
  paths JSONB NOT NULL DEFAULT '[]',
  allowed_tools JSONB NOT NULL DEFAULT '[]',
  data_classification TEXT NOT NULL DEFAULT 'public', -- public/internal/secret/confidential
  hooks JSONB NOT NULL DEFAULT '{}',
  test_cases JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',   -- draft/internal_test/canary/published/deprecated/rolled_back
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(package_id, version)
);
CREATE INDEX idx_version_pkg ON skill_versions(package_id, status);

-- 添加 skill_packages.active_version_id FK 约束（延迟添加以避免循环）
ALTER TABLE skill_packages
  ADD CONSTRAINT fk_pkg_active_version
  FOREIGN KEY (active_version_id) REFERENCES skill_versions(id) ON DELETE SET NULL;
```

#### 4.3.4 订阅、策略、审计、使用日志（参考 DAclaw Phase 1-3）

```sql
CREATE TABLE skill_subscriptions (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES skill_packages(id),
  subscriber_type TEXT NOT NULL,          -- user/worker/org
  subscriber_id UUID NOT NULL,
  is_forced BOOL NOT NULL DEFAULT FALSE,
  pinned BOOL NOT NULL DEFAULT FALSE,
  auto_update BOOL NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'market',  -- market/org_share/direct_link/force_push
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(package_id, subscriber_type, subscriber_id)
);
CREATE INDEX idx_sub_subscriber ON skill_subscriptions(subscriber_type, subscriber_id);

CREATE TABLE skill_policy_rules (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES skill_packages(id),
  org_id UUID NULL REFERENCES organizations(id), -- NULL=全局规则
  rule_type TEXT NOT NULL,               -- kill_switch/cross_org_requirement/deprecated_deadline/max_active_skills
  priority INT NOT NULL DEFAULT 100,     -- 数字越小优先级越高
  is_enabled BOOL NOT NULL DEFAULT TRUE,
  params JSONB NOT NULL DEFAULT '{}',
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_policy_pkg ON skill_policy_rules(package_id, is_enabled);

-- 不可篡改审计日志：DB 角色分离，仅授予 INSERT + SELECT 权限
CREATE TABLE skill_audit_logs (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL,
  version_id UUID NULL,
  action TEXT NOT NULL,                  -- publish/canary/rollback/kill_switch/share_initiated/share_approved/share_revoked/force_assign/trust_upgrade/...
  actor_id UUID NULL REFERENCES users(id),
  org_id UUID NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ NULL           -- 180 天后归档到冷存储
);
CREATE INDEX idx_audit_pkg ON skill_audit_logs(package_id, created_at DESC);
CREATE INDEX idx_audit_org ON skill_audit_logs(org_id, created_at DESC);

CREATE TABLE skill_usage_logs (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL,
  version_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  user_id UUID NULL,
  executor_type TEXT NOT NULL,           -- main_agent/sub_agent/workflow
  status TEXT NOT NULL,                  -- success/failure/timeout
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_usage_pkg ON skill_usage_logs(package_id, created_at DESC);

CREATE TABLE skill_sharings (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES skill_packages(id),
  source_org_id UUID NOT NULL REFERENCES organizations(id),
  target_org_id UUID NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected/revoked
  initiated_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID NULL REFERENCES users(id),
  restrictions JSONB NOT NULL DEFAULT '{}', -- {max_users, expires_at, data_classification_max}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ NULL,
  UNIQUE(package_id, source_org_id, target_org_id)
);

CREATE TABLE skill_sync_queue (
  id UUID PRIMARY KEY,
  worker_id UUID NOT NULL REFERENCES workers(id),
  package_id UUID NOT NULL,
  version_id UUID NULL,
  action TEXT NOT NULL,                  -- sync/force_update/kill/rollback/policy_refresh
  content_hash TEXT NULL,
  deadline TIMESTAMPTZ NULL,
  reason TEXT,
  actor_id UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ NULL          -- worker ack 后填充
);
CREATE INDEX idx_queue_worker_pending ON skill_sync_queue(worker_id)
  WHERE delivered_at IS NULL;
```

### 4.4 Plugin / Team / Config 资源表

```sql
CREATE TABLE plugin_packages (
  id UUID PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT,
  description TEXT,
  org_id UUID NULL,
  author_id UUID NULL REFERENCES users(id),
  scope TEXT NOT NULL DEFAULT 'user',
  category TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  readme TEXT,
  active_version_id UUID NULL,
  stats JSONB NOT NULL DEFAULT '{}',
  trust_level TEXT NOT NULL DEFAULT 'community',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE plugin_versions (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES plugin_packages(id),
  version TEXT NOT NULL,
  archive_url TEXT NOT NULL,             -- tar.gz 下载地址
  archive_hash TEXT NOT NULL,            -- SHA-256
  manifest JSONB NOT NULL,               -- plugin.json 内容
  changelog TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- 同 skill 版本状态机
  created_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(package_id, version)
);

CREATE TABLE team_templates (
  id UUID PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  org_id UUID NULL,
  author_id UUID NULL REFERENCES users(id),
  scope TEXT NOT NULL DEFAULT 'user',
  mode TEXT NOT NULL,                    -- pipeline/graph/council/parallel/single
  members JSONB NOT NULL,                -- 序列化的 TeamMember[]
  description TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  stats JSONB NOT NULL DEFAULT '{}',
  is_active BOOL NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE config_versions (
  id UUID PRIMARY KEY,
  org_id UUID NULL,                       -- NULL=全局推荐配置
  scope TEXT NOT NULL,                   -- system/org/user
  config_type TEXT NOT NULL,             -- providers/agent_settings/hooks/docling
  content JSONB NOT NULL,
  version TEXT NOT NULL,                 -- semver
  author_id UUID NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft',  -- draft/published/deprecated
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.5 审批表（Approval）

```sql
CREATE TABLE approvals (
  id UUID PRIMARY KEY,
  approval_type TEXT NOT NULL,           -- skill_to_org/skill_to_system/skill_subscribe/skill_sharing/plugin_publish/...
  resource_type TEXT NOT NULL,           -- skill/skill_package/skill_subscription/skill_sharing/plugin
  resource_id TEXT NOT NULL,
  target_scope TEXT,                     -- org/system
  requester_id UUID NOT NULL REFERENCES users(id),
  reviewer_id UUID NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected/cancelled
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ NULL
);
CREATE INDEX idx_approval_status ON approvals(status, resource_type);
```

### 4.6 数据隔离机制（参考 DAclaw data_permissions.py:124-148）

每个查询通过 `DataScope` 强制过滤：

```typescript
interface DataScope {
  scope: 'system' | 'org' | 'user';
  userId: string;
  orgId: string | null;
  isSuperAdmin: boolean;
}

class DataScope {
  apply<T>(query: SelectQueryBuilder<T>, opts: {
    creatorCol: string;
    orgCol?: string;
    assigneeCol?: string;
  }): SelectQueryBuilder<T> {
    if (this.isSuperAdmin || this.scope === 'system') return query;
    const conds = [query.col(opts.creatorCol).eq(this.userId)];
    if (opts.assigneeCol) conds.push(query.col(opts.assigneeCol).eq(this.userId));
    if (this.scope === 'org' && this.orgId && opts.orgCol) {
      conds.push(query.col(opts.orgCol).eq(this.orgId));
    }
    return query.whereOr(...conds);
  }
}
```

**关键设计**：不在中间件层全局过滤（避免误判公开资源），而是在 repo 层注入 + 保留 `can_access_resource()` 用于资源级权限检查。

---

## 5. 认证授权体系

### 5.1 认证流程

```
登录请求 → AuthMiddleware
  ├─ 本地账号 → bcrypt.verify(password_hash)
  ├─ LDAP     → ldap.authenticate(dn, password) + 本地同步
  └─ OIDC     → redirect to IdP → callback → exchange code → userinfo

认证成功后 → 检查 MFA
  ├─ 未启用 → 签发 JWT
  └─ 已启用 → 校验 TOTP（Google Authenticator）
              ├─ 验证通过 → 签发 JWT
              └─ 备份码 → 校验备份码（一次性，使用后作废）

JWT 签发：
  Access Token  (7天,  body: { sub: user_id, type: 'access' })
  Refresh Token (30天, HttpOnly Cookie: { sub: user_id, type: 'refresh' })
```

### 5.2 API Key 认证

粗粒度 scope（`read|write|admin`）→ 映射到具体权限码。API Key 在 `user_api_keys` 表存储 SHA-256 哈希。

### 5.3 Worker Token

长期 Bearer Token，scope 限定为 worker 通信端点（register/heartbeat/marketplace/ack）。支持轮换（旧 token 24h 过渡期）。

### 5.4 RBAC 权限矩阵

```
超级管理员 (super_admin)
    ↓ 全系统所有权限 + 跨组织操作
组织管理员 (org_admin)
    ↓ 本组织管理权限（审批 skill、邀请用户、绑定 worker）
普通用户 (user)
    ↓ 私有资源全控、组织资源读 + 订阅、系统资源只读
```

权限码格式：`{resource}:{action}`，示例：`skill:create`、`worker:approve`、`org:user:list`。通配符：`skill:*` 匹配所有 skill 操作；`*` 匹配所有。

### 5.5 关键权限矩阵

| 操作 | super_admin | org_admin | user |
|------|:-----------:|:---------:|:----:|
| 上传 skill 到 user scope | ✓ | ✓ | ✓ |
| 发布到 org scope | ✓ | ✓（本组织） | 需审批 |
| 发布到 system scope | ✓ | ✗ | ✗ |
| 审批 skill 版本 | ✓ | ✓（本组织） | ✗ |
| Kill Switch | ✓ | ✗ | ✗ |
| 强制推送 skill 到 worker | ✓ | ✓ | ✗ |
| 跨组织发起共享 | ✓ | ✓（本组织发起） | ✗ |
| 审批跨组织共享 | ✓ | ✓（目标组织） | ✗ |
| 绑定 worker 到用户 | ✓ | ✓ | ✗ |

---

## 6. Skill 审核工作流

### 6.1 版本状态机

```
       create
      ──────► [DRAFT]
                │
                │ start_test
                ▼
            [INTERNAL_TEST]    ← 可回退到 draft
                │
                │ start_canary
                ▼
              [CANARY]          ← 可回退到 internal_test
                │
                │ publish（org/system 需 Approval 通过）
                ▼
            [PUBLISHED]
                │           │
                │ deprecate │ rollback
                ▼           ▼
          [DEPRECATED]   [ROLLED_BACK]
```

**关键规则**：
- 仅 `draft` 状态可编辑内容（其他状态不可变）
- `publish` 到 `org`/`system` scope **必须先通过 Approval**
- `published` 是唯一可被订阅的状态；`canary` 可被指定灰度 worker 订阅
- 状态转换全部记录到 `skill_audit_logs`

### 6.2 状态转换 API

| 端点 | 当前状态 → 目标状态 | 权限要求 |
|------|---------------------|---------|
| `POST /skills/packages/{pkg_id}/versions/{ver_id}/start-test` | draft → internal_test | 创建者或 admin |
| `POST /skills/packages/{pkg_id}/versions/{ver_id}/canary` | draft/internal_test → canary | admin |
| `POST /skills/packages/{pkg_id}/versions/{ver_id}/publish` | draft/internal_test/canary → published | admin + Approval（org/system scope） |
| `POST /skills/packages/{pkg_id}/versions/{ver_id}/deprecate` | published/canary → deprecated | admin |
| `POST /skills/packages/{pkg_id}/versions/{ver_id}/rollback` | published/canary/deprecated → rolled_back | admin |

### 6.3 PublishGate 4 维评估（发布前阻断）

```typescript
async function evaluateForPublish(version: SkillVersion): Promise<EvalResult> {
  const checks = await Promise.all([
    redflagScan(version.content),       // 权重 30%：14 条安全红线
    validateStructure(version.content), // 权重 15%：YAML frontmatter + 必填字段
    llmEvaluate(version.content),       // 权重 25%：LLM 评估可读性/完整性/实用性
    runBenchmark(version.test_cases),   // 权重 30%：测试用例执行
  ]);
  const overall = weightedSum(checks);   // 0-100
  return {
    overall,
    blocked: overall < 60 || checks.redflag.criticalCount > 0,
    details: checks,
  };
}
```

**RedFlag 14 条规则**（参考 DAclaw redflag_scanner.py:60-249）：
- RF01 (CRITICAL): curl/wget 管道到 shell
- RF02 (HIGH): 向外部服务器发送数据
- RF03 (CRITICAL): 硬编码凭证/Token/API Key
- RF04 (CRITICAL): 读取敏感系统路径（~/.ssh/、~/.aws/）
- RF05 (CRITICAL): 主动读取 Agent 身份/记忆文件
- RF06 (CRITICAL): Base64 解码/编码
- RF07 (CRITICAL): 动态代码执行（eval/exec/system）
- RF08 (CRITICAL): 提权操作
- RF09 (HIGH): 安装未声明的第三方软件包
- RF10 (HIGH): 使用 IP 地址发起网络调用
- RF11 (CRITICAL): 混淆/编码混淆代码
- RF12 (CRITICAL): 提取浏览器 Cookie/Session
- RF13 (CRITICAL): 直接引用凭证文件名
- RF14 (HIGH): 递归/强制删除操作

**阻断策略**：
- `scope=user`：评估运行但**不阻断**（仅提示风险）
- `scope=org/system`：评估必须通过（overall ≥ 60 且 redflag 无 CRITICAL）
- `trust_level=certified`：test_cases 必须 100% 通过

### 6.4 Kill Switch（紧急禁用）

```
POST /api/skills/{package_id}/kill-switch  (仅 super_admin)
  ↓
插入 skill_policy_rules (rule_type='kill_switch', priority=0)
  ↓
下次心跳时所有 worker 收到 kill 指令
  ↓
worker 本地删除该 skill 缓存
  ↓
记录到 skill_audit_logs (action='kill_switch')
```

幂等：已存在 kill_switch 规则则不重复插入。

### 6.5 不可篡改审计日志

- DB 层：Hub DB 用户角色分离，`skill_audit_logs` 表仅授予 `INSERT` + `SELECT` 权限
- ORM 不暴露 update/delete 方法（repository 只提供 `log()` 和 `query()`）
- 180 天后自动归档到冷存储（保留 7 年，满足合规要求）
- 关键 action：`publish/canary/rollback/kill_switch/trust_upgrade/share_initiated/share_approved/share_revoked/force_assign`

---

## 7. Worker 协议扩展

### 7.1 端点对比

| 现有端点 | 保留 | 新增能力 |
|---------|------|---------|
| `POST /api/v1/workers/register` | ✓ | 返回 `protocol_version` + `worker_scope`（worker 可访问的资源范围：org_id 或 null） |
| `POST /api/v1/workers/heartbeat` | ✓ | **请求**新增 `cached_skills[]` + `policy_version`；**响应**新增 `instructions[]` |
| `GET /api/v1/config/recommended` | ✓ | 增加 `?scope=org\|user` 参数 |
| `GET /api/v1/marketplace/skills` | ✓ | 增加 `?include_shared=true` 包含跨组织共享 |
| `POST /api/v1/marketplace/skills/submit` | ✓ | 返回完整 `submissionId + status + reviewDeadline` |
| — | 新增 | `GET /api/v1/workers/{id}/skills/manifest`（worker 启动时拉取期望技能清单） |
| — | 新增 | `POST /api/v1/workers/{id}/skills/ack`（worker 确认指令已执行） |
| — | 新增 | `POST /api/v1/workers/{id}/usage/report`（异步上报 skill 使用日志） |

**`policy_version` 维护机制**（Hub 端）：
- Hub 维护一个全局单调递增的 `policy_version` 计数器（存储在 settings 表或单独的 `policy_meta` 表）
- 任何 skill 策略变更（kill_switch、subscription 变更、版本发布）触发 `policy_version++`
- Worker 上报旧版 `policy_version` 时，Hub 在心跳响应中下发 `policy_refresh` 指令 + 最新 `policy_version`
- Worker 收到后更新本地存储，下次心跳携带新版本号

### 7.2 心跳协议升级

```typescript
// @deepanalyze/contracts
interface HeartbeatRequest {
  current_task?: string;
  capabilities?: Record<string, unknown>;
  cached_skills?: Array<{
    package_id: string;
    version: string;
    content_hash: string;            // SHA-256[:32]
  }>;
  policy_version?: number;
  protocol_version: number;          // 降级兼容
}

interface HeartbeatResponse {
  message: string;
  instructions: SkillSyncInstruction[];
  policy_version: number;
  config_diff?: ConfigDiff;
}

interface SkillSyncInstruction {
  action: 'sync' | 'force_update' | 'kill' | 'rollback' | 'policy_refresh';
  package_id: string;
  version_id?: string;
  version?: string;
  content?: string;                  // 小文件直接传
  content_url?: string;              // 大文件 URL（worker 自行下载）
  hash?: string;
  deadline?: string;                 // ISO 时间，仅 force_update
  reason?: string;
  instruction_id: string;            // 用于 ack
}
```

### 7.3 SkillSyncService 流程（参考 DAclaw sync_service.py:62-135）

```
心跳到达 →
  ├─ 更新 worker.last_heartbeat, status=online
  ├─ SkillSyncService.generate_instructions(worker_id, cached_skills, policy_version):
  │    1. 计算 expected_skills = user 订阅 + org 强制分配 + system 全局
  │    2. 对比 cached_skills 与 expected
  │    3. 缺失/版本不一致/hash 不一致 → 生成 sync 指令
  │    4. 缓存了不该有的（kill_switch 命中）→ kill 指令
  │    5. 读取 skill_sync_queue 持久化的强制指令 → force_update
  │    6. policy_version 变更 → policy_refresh
  └─ 返回 instructions[]（去重 + 按 priority 排序）
```

**期望技能来源**（`_get_expected_skills`）：
1. 用户订阅（`subscriber_type='user'`, `subscriber_id=user_id`）
2. 组织强制分配（`subscriber_type='org'`, `is_forced=true`）
3. 全局 system skill（`scope='system'` 且未 Kill）

Kill Switch 检查：被禁用的技能不包含在 expected 列表中，且若 worker 缓存了则下发 kill。

### 7.4 DA 端改造范围（最小化）

`src/services/hub/hub-client.ts` 扩展：

```typescript
class HubClient {
  // 现有方法保留...

  async heartbeat(): Promise<HeartbeatResponse> {
    const cachedSkills = await this.getLocalSkillCache();
    const policyVersion = await this.getStoredPolicyVersion();
    return this.post('/workers/heartbeat', {
      ...basicHeartbeat,
      cached_skills: cachedSkills,
      policy_version: policyVersion,
      protocol_version: 2,
    });
  }

  private async applyInstructions(insts: SkillSyncInstruction[]): Promise<void> {
    for (const inst of insts) {
      switch (inst.action) {
        case 'sync': await this.syncSkill(inst); break;
        case 'kill': await this.removeLocalSkill(inst.package_id); break;
        case 'force_update': await this.forceUpdateSkill(inst); break;
        case 'rollback': await this.rollbackSkill(inst); break;
        case 'policy_refresh': await this.refreshPolicy(); break;
      }
      await this.ackInstruction(inst.instruction_id);
    }
  }
}
```

**DA 端预估改动量**：~250 行代码（hub-client.ts 扩展 + 新增 `src/services/hub/sync-handler.ts`）。

---

## 8. 跨组织 SkillSharing

### 8.1 双边审批流程

```
Org A 管理员                    Hub                     Org B 管理员
     │                          │                            │
     │ POST /sharings           │                            │
     │ {package_id, target_org} │                            │
     ├─────────────────────────►│                            │
     │                          │ 创建 skill_sharings        │
     │                          │ (status='pending')         │
     │                          │ 通知 Org B 管理员           │
     │                          ├───────────────────────────►│
     │                          │                            │
     │                          │ POST /sharings/{id}/approve│
     │                          │ ◄─────────────────────────┤
     │                          │                            │
     │                          │ if approve:                │
     │                          │   - 自动创建 Org B 订阅     │
     │                          │     (source='org_share')   │
     │                          │   - 在 Org B 市场可见       │
     │                          │   - status='approved'      │
     │                          │ 记录审计日志                │
     │                          │                            │
     │ 200 OK + sharing_id      │                            │
     │ ◄────────────────────────┤                            │
```

### 8.2 限制机制（restrictions JSONB 字段）

- `max_users`: 最多订阅人数
- `expires_at`: 共享到期时间
- `data_classification_max`: 允许的最高数据密级（public/internal/secret/confidential）

### 8.3 撤销机制

发起方或 super_admin 可 `DELETE /sharings/{id}`：
1. 自动删除目标 org 的所有非强制订阅
2. 下发 kill 指令给相关 worker
3. 记录审计日志（`action='share_revoked'`）

---

## 9. Security Gateway

### 9.1 部署决策：内嵌 Hub Server 进程

简化部署（企业用户无需运行独立 Security Gateway 服务）。Hub Server 启动时初始化 SecurityGateway 实例。

### 9.2 引擎架构

```typescript
class SecurityGateway {
  constructor(
    private wordEngine: TrieWordEngine,        // Trie 树多模式匹配
    private regexEngine: CompiledRegexEngine,  // 预编译正则
    private modelEngine: LocalModelEngine,     // 5 类攻击模式
    private decisionEngine: DecisionEngine,
  ) {}

  async filterInput(text: string, ctx: Context): Promise<FilterResult>
  async filterOutput(text: string, ctx: Context): Promise<FilterResult>
  async checkTool(toolName: string, args: unknown, ctx: Context): Promise<FilterResult>
}
```

**引擎分工**：
- **WordEngine**：Trie 树，三级分类（敏感词/风险词/放通词）
- **RegexEngine**：预编译正则，覆盖身份证 / 手机号 / 银行卡 / 内网 IP + 自动脱敏
- **ModelEngine**：本地规则（5类攻击模式），可选 LLM HTTP 增强
- **DecisionEngine**：severity 1-2 → SANITIZE / 3 → APPROVE（转人工） / 4+ → BLOCK

### 9.3 三层集成点

```typescript
// Hub Server 主应用
app.addHook('preHandler', async (req) => {
  // 1. 输入过滤
  const result = await gateway.filterInput(req.body, req.context);
  if (result.action === 'block') throw new HttpError(400, result.reason);
  if (result.action === 'sanitize') req.body = result.sanitized;
});

app.addHook('onSend', async (req, reply, payload) => {
  // 2. 输出过滤
  const result = await gateway.filterOutput(payload, req.context);
  if (result.action === 'block') return '[blocked]';
  return result.sanitized ?? payload;
});

// 3. 工具检查：在 skill 执行前（worker 端实现，Hub 提供规则下发）
```

### 9.4 配置

- `SECURITY_GATEWAY_ENABLED=true`
- `SECURITY_GATEWAY_TIMEOUT=5000ms`
- `FAIL_OPEN=true`（异常时放行，避免单点故障）
- 规则文件位于 `hub-server/security-rules/`，支持热重载

### 9.5 与 Skill 审核的关系

| 维度 | Security Gateway | RedFlagScanner + PublishGate |
|------|-----------------|------------------------------|
| 时机 | 运行时（实时） | 发布前（离线） |
| 对象 | 所有输入/输出/工具调用 | Skill 文件内容 |
| 位置 | Hub 内嵌服务 | 主后端内 |
| 集成 | HTTP 钩子 | 直接函数调用 |

---

## 10. 实施阶段

### 10.1 Phase 1：基础多租户 + 认证

**交付物**：
1. `@deepanalyze/contracts` 包：协议类型 + schema
2. `deepanalyze-hub` 仓库脚手架：Fastify + TypeORM + Bun + PostgreSQL 迁移
3. 模块：
   - `auth/`：本地账号密码 + JWT 双 Token + API Key + 中间件
   - `org/`：树形 Organization CRUD + 树查询 + path 维护
   - `user/`：用户 CRUD + 邀请加入组织
   - `rbac/`：Role/Permission 树 + PermissionChecker + DataScope
   - `worker/`：申请-审批流程 + 心跳 + 基本状态
4. DA 端：升级 `hub-client.ts` 到 protocol v2（保留 v1 兼容）
5. 前端：Hub 管理后台（登录/组织树/用户管理/Worker 审批）

**Phase 1 验收标准**：
- 能在 Hub 注册 Organization + 用户
- 能审批 DA worker 接入
- DA worker 能心跳上报 + 接收 config 同步
- 权限测试：org_admin 不能操作其他 org 资源

### 10.2 Phase 2：Skill 市场基础

**交付物**：
1. 模块：
   - `skill/`：基础 Skill CRUD（不含版本状态机）+ scope 过滤
   - `plugin/`：Plugin 包上传 + 版本归档
   - `team/`：Team 模板市场
   - `config/`：配置版本管理
   - `market/`：浏览/搜索/订阅
2. Worker 同步：
   - SkillSyncService 基础版（仅 sync 指令，无 Kill Switch / force_update）
   - DA 端：实现 applyInstructions 处理 sync 指令
3. 前端：市场浏览页 + 订阅 UI + 我的技能页

**Phase 2 验收标准**：
- 上传 skill 到 org scope → 同组织 worker 心跳后自动拉取
- 取消订阅 → worker 下次心跳删除本地 skill
- Plugin 包完整上传 + tar.gz 下载

### 10.3 Phase 3：完整审核工作流

**交付物**：
1. SkillVersion 状态机（6 状态 + 合法转换）
2. Approval 审批工作流（org/system scope 发布前必须审批）
3. PublishGate 4 维评估（RedFlagScanner + 结构校验 + LLM 评估 + Benchmark）
4. Kill Switch + 强制推送 + 持久化指令队列
5. SkillAuditLog 不可篡改审计（DB 角色分离 + ORM 限制）
6. 灰度发布（canary worker 子集）

**Phase 3 验收标准**：
- 含 CRITICAL redflag 的 skill 无法发布到 org scope
- 审批通过前 publish 请求被拒绝
- Kill Switch 后所有相关 worker 30 秒内删除 skill
- 审计日志无法通过 ORM update/delete

### 10.4 Phase 4：跨组织 + Security Gateway + 企业认证

**交付物**：
1. SkillSharing 双边审批流程 + 自动订阅 + 撤销
2. Security Gateway 内嵌：输入/输出/工具三层过滤
3. LDAP + OIDC + MFA 适配器
4. skill_usage_logs 异步上报 + 统计

**Phase 4 验收标准**：
- 跨组织发起共享 → 对方审批 → 双方 worker 都能拉取
- 撤销共享 → 对方 worker 收到 kill 指令
- 含敏感词的请求被 Gateway 拦截
- OIDC 登录可用（如 GitHub OAuth）

---

## 11. 测试策略

### 11.1 分层测试金字塔

```
        E2E (Playwright)         少量关键流程：登录→上传→审批→worker 同步
            ▲
       集成测试 (API + PG)        中量：每个 API 端点 + 权限矩阵
            ▲
       单元测试 (domain + 模块)   大量：状态机转换、PublishGate、Security 规则
```

### 11.2 关键测试用例（每 Phase 必须覆盖）

- **多租户隔离**：A 组织用户不能读写 B 组织资源（数据层 + API 层双重验证）
- **权限矩阵**：所有 `permission_code × role` 组合
- **状态机**：所有合法/非法状态转换
- **Worker 同步**：网络中断恢复、policy_version 漂移、并发心跳
- **Kill Switch 时效性**（30s SLA）
- **PublishGate 一致性**：相同输入应产生相同评分（LLM 评估除外）

### 11.3 CI 策略

- **PR 触发**：单元 + 集成测试
- **主分支合并**：触发 E2E + 性能基准
- **发布前**：完整回归 + 安全扫描

---

## 12. 风险与缓解

| 风险 | 概率 | 缓解策略 |
|------|:---:|---------|
| DA 端协议升级导致旧 worker 无法接入 | 中 | 保留 protocol v1 兼容 6 个月；DA 启动时降级协商 |
| LLM 评估（PublishGate 25%）不稳定 | 高 | 评估结果可重试；不通过时引导人工审核 |
| Worker 同步指令丢失（网络抖动） | 中 | 持久化 `skill_sync_queue`；心跳幂等；worker 主动 ack |
| Security Gateway 误拦截正常请求 | 中 | `fail_open=true`；规则版本化；可配置白名单 |
| 跨组织 Sharing 滥用（如泄密） | 低 | `restrictions` 字段限制 + 审计日志 + super_admin 可撤销 |
| Hub DB 单点故障 | 中 | Phase 4 后支持 PG 主从；备份策略；降级模式（worker 用本地缓存） |
| 三个仓库版本协调 | 中 | `@deepanalyze/contracts` 使用 semver；DA/Hub peerDependency 锁版本 |

---

## 13. 附录

### 13.1 DAclaw 参考代码路径

| 机制 | DAclaw 路径 | 本设计对应章节 |
|------|------------|--------------|
| Organization 树 | `backend/app/models/organization.py:24-103` | §4.1.1 |
| User + RBAC | `backend/app/models/models.py:87-157` | §4.1.2, §4.1.3 |
| DataScope | `backend/app/core/data_permissions.py:124-148` | §4.6 |
| PermissionChecker | `backend/app/core/permissions.py:67-104` | §5.4 |
| Runner 注册/心跳 | `backend/app/api/runners.py:354-530` | §7 |
| SkillPackage + Version | `backend/app/models/models.py:1062-1146` | §4.3.2, §4.3.3 |
| PublishGate | `backend/app/services/skill_eval/publish_gate.py:50-379` | §6.3 |
| RedFlagScanner | `backend/app/services/skill_eval/redflag_scanner.py:60-249` | §6.3 |
| SkillSharing | `backend/app/models/models.py:1309-1374` | §8 |
| SkillSyncService | `backend/app/modules/skillhub/sync_service.py:34-508` | §7.3 |
| Kill Switch | `backend/app/modules/skillhub/sync_service.py:409-451` | §6.4 |
| Security Gateway | `security-gateway/` (整个目录) | §9 |

### 13.2 DA 现有代码路径

| 机制 | DA 路径 | 改造范围 |
|------|---------|---------|
| Hub Worker 协议 | `src/services/hub/hub-client.ts:1-452` | 扩展（新增 skill 下发处理） |
| Worker 类型 | `src/services/hub/types.ts:1-230` | 扩展（新增 HeartbeatRequest/Response 字段） |
| Worker 身份 | `src/services/hub/worker-identity.ts:1-96` | 保留 |
| Hub 路由 | `src/server/routes/hub.ts:1-232` | 扩展（新增 sync 相关端点） |
| agent_skills 表 | `src/store/pg-migrations/012,014,020,022` | 不动（DA 本地表） |
| skill_invoke 工具 | `src/services/agent/tool-setup.ts:2056-2143` | 不动 |

### 13.3 待决策事项（无）

所有关键决策已在 brainstorming 阶段确认：
- ✅ 技术栈：TypeScript + Bun + PostgreSQL
- ✅ 资源范围：Skill + Plugin + Team + Config
- ✅ 审核工作流：完整企业级（6 状态机 + PublishGate 4 维 + SkillSharing + Kill Switch + AuditLog）
- ✅ 认证体系：完整企业级（local + API Key + LDAP + OIDC + MFA）
- ✅ Security Gateway：完整移植（输入/输出/工具三层过滤）
- ✅ 部署形态：独立 npm 包 + Docker
- ✅ 实施路径：一次性完整设计 + 分阶段实施
- ✅ 架构方案：独立 Hub 项目 + 增量协议扩展 + 树形 Organization

---

## 14. 下一步

本设计文档完成后，进入实施计划阶段（writing-plans skill）：
1. 创建 Phase 1 详细实施计划（基础多租户 + 认证）
2. 计划经用户审核通过后开始实施
3. Phase 1 完成后再创建 Phase 2 计划（避免过度规划）

**不一次性规划所有 4 个 Phase**——后续 Phase 的细节会受前面 Phase 实施结果影响，过早规划容易返工。
