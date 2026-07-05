# DA Server + Worker 分布式架构 — 实施计划

> **版本**: v1.0
> **日期**: 2026-05-19
> **关联设计文档**: `docs/superpowers/specs/2026-05-19-server-worker-architecture-design.md`

---

## 实施概述

分 5 个阶段实施，先 Worker 端（现有项目改造），后 Server 端（独立新项目）。

**Worker 端原则**：所有新增代码在 `src/services/hub/` 目录下，对现有核心系统零改动。

---

## 阶段 1：Worker 端核心通信层

**目标**：Worker 能连接 Server、注册、心跳、手动配置同步。

### Step 1.1：创建类型定义

**新建**: `src/services/hub/types.ts`（~150 行）

包含：
- `DaRunMode` 类型
- `WorkerConfig` 接口
- `HubSyncState` 接口
- `WorkerRegisterRequest/Response` 接口
- `WorkerCapabilities` 接口
- `HeartbeatRequest/Response` 接口
- `WorkerNotification` 接口
- `RecommendedConfig` 接口
- `ConfigVersionInfo` 接口
- `MarketplaceSkill` 接口
- `SkillPackage` 接口
- `SkillSubmitRequest/Response` 接口
- `WorkerLocalStatus` 接口

- [ ] 创建 `src/services/hub/types.ts`

### Step 1.2：创建 Worker 身份管理

**新建**: `src/services/hub/worker-identity.ts`（~100 行）

```typescript
/** 生成或读取 Worker ID，持久化到 dataDir/.worker-id */
export function getOrCreateWorkerId(dataDir: string): string;

/** 采集 Worker 能力信息（CPU/内存/GPU/OS） */
export function collectWorkerCapabilities(): WorkerCapabilities;

/** 采集 Worker 运行状态（活跃会话/任务/资源使用） */
export function collectWorkerStatus(): WorkerLocalStatus;
```

- [ ] 创建 `src/services/hub/worker-identity.ts`

### Step 1.3：创建 HubClient 核心

**新建**: `src/services/hub/hub-client.ts`（~400 行）

核心方法：

```
连接管理:
  constructor(config: WorkerConfig)
  async register(): Promise<WorkerRegisterResponse | null>
  startHeartbeat(intervalMs?: number): void
  stopHeartbeat(): void
  getSyncState(): HubSyncState

配置同步:
  async fetchRecommendedConfig(): Promise<RecommendedConfig | null>
  async fetchConfigVersion(): Promise<ConfigVersionInfo | null>
  async applyRecommendedConfig(config: RecommendedConfig): Promise<void>
```

**关键实现要点**：

1. **register()** — POST 到 Server 的 `/api/v1/workers/register`，失败返回 null
2. **startHeartbeat()** — setInterval 30 秒，try/catch 包裹，失败只更新 syncState
3. **fetchRecommendedConfig()** — GET Server 配置，失败返回 null
4. **applyRecommendedConfig()** — 调用现有 repos 接口写入 settings 表 + bumpConfigVersion()
   - `repos.settings.saveProviderSettings(config.providers)` — Provider 配置
   - `repos.settings.set("agent_settings", JSON.stringify(config.agentSettings))` — Agent 设置
   - `repos.settings.set("docling_config", JSON.stringify(config.doclingConfig))` — Docling 配置
   - `repos.settings.set("enhanced_models", JSON.stringify(config.enhancedModels))` — 增强模型
   - `repos.settings.set("agent_hooks", JSON.stringify(config.hooks))` — Hooks
   - `bumpConfigVersion()` — 触发 ModelRouter 热更新

**复用的现有代码**：
- `src/store/repos/settings.ts` — `saveProviderSettings()`, `set()`
- `src/models/router.ts` — `bumpConfigVersion()`
- `src/store/repos/index.ts` — `getRepos()` 获取 repo 单例

- [ ] 创建 `src/services/hub/hub-client.ts`

### Step 1.4：修改配置入口

**修改**: `src/core/config.ts`（+15 行）

```typescript
export const DEEPANALYZE_CONFIG = {
  // ... 现有字段不变
  runMode: (process.env.DA_SERVER_URL ? "worker" : "standalone") as "standalone" | "worker",
  serverUrl: process.env.DA_SERVER_URL || "",
  workerId: process.env.DA_WORKER_ID || "auto",
  workerToken: process.env.DA_WORKER_TOKEN || "",
};
```

- [ ] 修改 `src/core/config.ts`

### Step 1.5：修改启动流程

**修改**: `src/main.ts`（+30 行）

在现有启动流程末尾新增：

```typescript
// Worker mode initialization (仅当 DA_SERVER_URL 设置时)
if (DEEPANALYZE_CONFIG.runMode === "worker") {
  const { HubClient } = await import("./services/hub/hub-client.js");
  const { getOrCreateWorkerId } = await import("./services/hub/worker-identity.js");

  const workerId = getOrCreateWorkerId(DEEPANALYZE_CONFIG.dataDir);
  const hubClient = new HubClient({
    runMode: "worker",
    serverUrl: DEEPANALYZE_CONFIG.serverUrl,
    workerId,
    workerToken: DEEPANALYZE_CONFIG.workerToken,
  });

  // 尝试注册（失败不阻塞启动）
  const regResult = await hubClient.register();
  if (regResult) {
    console.log(`[Hub] Registered with server, workerId: ${workerId}`);
    hubClient.startHeartbeat(30000);
  } else {
    console.log(`[Hub] Server unreachable, running in standalone mode`);
  }

  // 保存到全局
  globalThis.__hubClient = hubClient;
}
```

- [ ] 修改 `src/main.ts`

### Step 1.6：创建 Hub API 路由

**新建**: `src/server/routes/hub.ts`（~200 行，阶段 1 只包含配置同步和状态路由）

```typescript
// 手动触发配置同步
POST /api/hub/sync-config

// 获取同步状态
GET /api/hub/sync-state

// Worker 状态（Server 调用）
GET /api/worker/status
GET /api/worker/version
GET /api/worker/capabilities
```

**实现要点**：
- 从 `globalThis.__hubClient` 获取 HubClient 实例
- 未初始化时返回 503
- sync-config 调用 HubClient.fetchRecommendedConfig() + applyRecommendedConfig()
- sync-state 直接返回 HubClient.getSyncState()

- [ ] 创建 `src/server/routes/hub.ts`

### Step 1.7：注册 Hub 路由

**修改**: `src/server/app.ts`（+10 行）

在现有路由注册区域新增：

```typescript
// Hub routes (worker mode only)
if (DEEPANALYZE_CONFIG.runMode === "worker") {
  const { createHubRoutes, createWorkerRoutes } = await import("./routes/hub.js");
  app.route("/api/hub", createHubRoutes());
  app.route("/api/worker", createWorkerRoutes());
}
```

- [ ] 修改 `src/server/app.ts`

### Step 1.8：环境变量文档

**修改**: `.env.example`（+10 行）

新增：
```
# Server connection (leave empty for standalone mode)
DA_SERVER_URL=
DA_WORKER_ID=auto
DA_WORKER_TOKEN=
```

- [ ] 修改 `.env.example`

### 阶段 1 验证

```
1. 不设 DA_SERVER_URL → npx tsc --noEmit 通过 → 启动正常 → 无 Hub 日志
2. DA_SERVER_URL="https://httpbin.org/status/404" → 启动正常 → Hub 日志显示注册失败
3. DA_SERVER_URL="https://real-server" → 启动正常 → Hub 注册成功 → 心跳日志
4. POST /api/hub/sync-config → 返回正确状态
5. GET /api/hub/sync-state → 返回 HubSyncState
```

---

## 阶段 2：Worker 端资源市场

**目标**：Worker 能浏览、安装、发布市场技能。

### Step 2.1：HubClient 增加市场方法

**修改**: `src/services/hub/hub-client.ts`（+150 行）

新增方法：

```typescript
// 市场技能
async listMarketplaceSkills(page?: number, search?: string): Promise<{items: MarketplaceSkill[], total: number} | null>;
async getMarketplaceSkill(slug: string): Promise<MarketplaceSkillDetail | null>;
async downloadMarketplaceSkill(slug: string): Promise<{installed: boolean; skillId: string} | null>;
async submitSkillToMarket(skillId: string): Promise<SkillSubmitResponse | null>;

// 市场插件
async listMarketplacePlugins(page?: number): Promise<{items: any[], total: number} | null>;
async downloadMarketplacePlugin(slug: string): Promise<{installed: boolean} | null>;
async submitPluginToMarket(pluginId: string): Promise<SkillSubmitResponse | null>;
```

**技能安装关键逻辑**（downloadMarketplaceSkill）：

```typescript
async downloadMarketplaceSkill(slug: string) {
  // 1. 从 Server 下载
  const skill = await this.httpGet(`/api/v1/marketplace/skills/${slug}/download`);
  if (!skill) return null;

  // 2. 兼容性检查
  if (skill.compatibility?.minVersion) {
    const currentVersion = DEEPANALYZE_CONFIG.version;
    if (semverLt(currentVersion, skill.compatibility.minVersion)) {
      return { installed: false, skillId: "" }; // 版本不兼容
    }
  }

  // 3. 写入本地 agent_skills 表
  const repos = await getRepos();
  const newSkill = await repos.agentSkill.create({
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt,
    tools: skill.tools,
    modelRole: skill.modelRole,
    source: "hub",
    hubSlug: skill.slug,
    hubUrl: `${this.config.serverUrl}/api/v1/marketplace/skills/${skill.slug}`,
  });

  return { installed: true, skillId: newSkill.id };
}
```

**复用的现有代码**：
- `src/store/repos/agent-skill.ts` — `create()` 方法
- `src/store/repos/index.ts` — `getRepos()` 获取 repo

- [ ] 修改 `src/services/hub/hub-client.ts`

### Step 2.2：Hub 路由增加市场端点

**修改**: `src/server/routes/hub.ts`（+200 行）

新增路由：

```
GET  /api/hub/marketplace/skills?page=1&search=&tag=
GET  /api/hub/marketplace/skills/:slug
POST /api/hub/marketplace/install/:slug
POST /api/hub/marketplace/publish/:skillId
GET  /api/hub/marketplace/plugins?page=1&search=
POST /api/hub/marketplace/install-plugin/:slug
POST /api/hub/marketplace/publish-plugin/:pluginId
```

- [ ] 修改 `src/server/routes/hub.ts`

### 阶段 2 验证

```
1. Server 不可达 → GET /api/hub/marketplace/skills → 返回空列表
2. Server 有数据 → GET /api/hub/marketplace/skills → 返回技能列表
3. POST /api/hub/marketplace/install/:slug → agent_skills 表新增记录，source="hub"
4. POST /api/hub/marketplace/publish/:skillId → Server 收到提交
```

---

## 阶段 3：前端适配

**目标**：Worker 前端增加 Server 连接状态和资源市场入口。

### Step 3.1：Zustand Store — Hub 状态管理

**新建/修改**: `frontend/src/store/hub.ts`（~150 行）

```typescript
interface HubStore {
  syncState: HubSyncState | null;
  marketplaceSkills: MarketplaceSkill[];
  loading: boolean;

  fetchSyncState(): Promise<void>;
  syncConfig(): Promise<void>;
  fetchMarketplaceSkills(page?: number, search?: string): Promise<void>;
  installSkill(slug: string): Promise<void>;
  publishSkill(skillId: string): Promise<void>;
}
```

- [ ] 创建 `frontend/src/store/hub.ts`

### Step 3.2：设置页 — 服务器连接区域

**修改**: `frontend/src/components/Settings/` 相关组件（+200 行）

在设置页面新增"服务器连接"区域（仅 worker 模式显示）：

```
┌─────────────────────────────────────────┐
│  服务器连接                               │
│                                          │
│  状态: 🟢 已连接  (最后一次心跳: 3秒前)    │
│  Worker ID: w-abc123                     │
│  配置版本: 20260519-001                   │
│  上次同步: 2026-05-19 14:30              │
│                                          │
│  [从服务器同步配置]  [检查更新]            │
│                                          │
│  注意: 同步将覆盖当前的 Provider 配置、    │
│  Agent 设置和 Docling 配置。              │
└─────────────────────────────────────────┘
```

- [ ] 修改设置页组件

### Step 3.3：侧边栏 — 资源市场入口

**新建**: `frontend/src/components/Marketplace/` 目录（+300 行）

新增"资源市场"入口（仅 worker 模式显示）：

```
侧边栏:
  知识库
  会话
  资源市场 ← 新增（仅 worker 模式）
    ├── 技能市场
    │   ├── 列表（搜索、标签筛选、排序）
    │   ├── 详情页（名称、描述、prompt、兼容性、评分）
    │   └── 安装按钮
    └── 我的提交
        ├── 已发布
        ├── 待审核
        └── 已拒绝
```

本地技能详情页增加"发布到市场"按钮（仅 worker 模式显示）。

- [ ] 创建市场浏览组件
- [ ] 创建技能详情组件
- [ ] 创建安装/发布组件

### Step 3.4：API Client 扩展

**修改**: `frontend/src/api/client.ts`（+50 行）

新增 Hub API 调用：

```typescript
export const hubApi = {
  getSyncState: () => fetchJSON('/api/hub/sync-state'),
  syncConfig: () => fetchJSON('/api/hub/sync-config', { method: 'POST' }),
  listSkills: (page, search) => fetchJSON(`/api/hub/marketplace/skills?page=${page}&search=${search}`),
  getSkill: (slug) => fetchJSON(`/api/hub/marketplace/skills/${slug}`),
  installSkill: (slug) => fetchJSON(`/api/hub/marketplace/install/${slug}`, { method: 'POST' }),
  publishSkill: (skillId) => fetchJSON(`/api/hub/marketplace/publish/${skillId}`, { method: 'POST' }),
};
```

- [ ] 修改 `frontend/src/api/client.ts`

### 阶段 3 验证

```
1. standalone 模式 → 无 Hub UI 元素显示
2. worker 模式 → 设置页显示"服务器连接"区域
3. worker 模式 → 侧边栏显示"资源市场"入口
4. 点击"同步配置" → 配置更新成功
5. 浏览市场 → 列表显示
6. 安装技能 → 本地技能列表更新
```

---

## 阶段 4：Server 端独立开发

**目标**：在 `D:\code\deepanalyze\deepanalyze-hub` 新建完整 Server 项目。

### Step 4.1：项目骨架

- [ ] 创建项目目录 `D:\code\deepanalyze\deepanalyze-hub`
- [ ] 初始化 `package.json`（Bun + Hono + TypeScript）
- [ ] 创建 `tsconfig.json`
- [ ] 创建 `src/main.ts` 入口
- [ ] 创建 `src/core/config.ts` 配置
- [ ] 创建 `src/server/app.ts` Hono 应用
- [ ] 创建 `docker-compose.yml`（独立 PG + Server）
- [ ] 创建 `Dockerfile`

### Step 4.2：数据库

- [ ] 创建 `src/store/pg.ts` PG 连接池
- [ ] 创建 `src/store/migrations/001_init.ts` 完整 Schema
- [ ] 创建所有 repo 文件（user, worker, config, marketplace-skill, marketplace-plugin, audit-log）

### Step 4.3：认证系统

- [ ] 创建 `src/services/sso-adapter.ts` — OAuth 2.0 适配器
- [ ] 创建 `src/server/middleware/auth.ts` — JWT 签发/验证
- [ ] 创建 `src/server/middleware/worker-auth.ts` — Worker token 验证
- [ ] 创建 `src/server/routes/auth.ts` — OAuth 回调路由

### Step 4.4：核心业务

- [ ] 创建 `src/services/worker-registry.ts` — Worker 注册 + 心跳管理
- [ ] 创建 `src/services/config-manager.ts` — 配置版本管理
- [ ] 创建 `src/services/marketplace-service.ts` — 市场业务逻辑
- [ ] 创建 `src/services/review-service.ts` — 技能审核流程
- [ ] 创建 `src/services/user-manager.ts` — 用户生命周期

### Step 4.5：API 路由

- [ ] 创建 `src/server/routes/users.ts`
- [ ] 创建 `src/server/routes/workers.ts`
- [ ] 创建 `src/server/routes/config.ts`
- [ ] 创建 `src/server/routes/marketplace.ts`
- [ ] 创建 `src/server/routes/admin.ts`

### Step 4.6：管理前端

- [ ] 初始化 `frontend/` React 项目
- [ ] 创建 Layout + 路由
- [ ] 创建 Dashboard 页面
- [ ] 创建 Users 管理页面
- [ ] 创建 Workers 管理页面
- [ ] 创建 Config 管理页面
- [ ] 创建 Marketplace 审核页面
- [ ] 创建 AuditLog 页面

### 阶段 4 验证

```
1. docker compose up → Server 启动成功
2. 管理面板可访问
3. 用户注册/登录可用（OAuth 回调）
4. Worker 注册成功
5. 心跳正常上报
6. 配置 CRUD 正常
7. 技能提交 → 审核 → 发布流程正常
```

---

## 阶段 5：端到端联调

**目标**：Worker + Server 联调，验证完整流程。

### Step 5.1：基础连接

- [ ] Worker 启动 → Server 收到注册
- [ ] 心跳正常上报（Server 面板可见）
- [ ] Server 停止 → Worker 继续运行（standalone 降级）
- [ ] Server 恢复 → Worker 心跳自动恢复

### Step 5.2：配置同步

- [ ] Server 端创建推荐配置
- [ ] Worker 前端显示"有新配置可用"
- [ ] Worker 点击"同步配置" → 配置写入 settings 表
- [ ] Worker 的 ModelRouter 自动使用新配置（验证 LLM 调用正常）
- [ ] Worker 手动修改配置 → 不被 Server 覆盖（只有再次点击同步才会覆盖）

### Step 5.3：资源市场

- [ ] Worker A 发布技能到市场
- [ ] Server 管理面板审核批准
- [ ] Worker B 浏览市场 → 看到该技能
- [ ] Worker B 安装技能 → agent_skills 表有新记录
- [ ] Worker B 使用该技能成功

### Step 5.4：安全验证

- [ ] 未认证请求被拒绝
- [ ] Worker token 过期后无法调用 Server API
- [ ] 非 admin 用户无法访问管理接口
- [ ] Worker 的 /api/worker/* 只接受 Server 签发的 token

### Step 5.5：回归验证

- [ ] Worker standalone 模式完全不受影响
- [ ] `npx tsc --noEmit` 无新增错误
- [ ] 现有 E2E 测试全部通过

---

## 文件修改总览

### Worker 端（现有项目）

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/services/hub/types.ts` | **新建** | ~150 |
| `src/services/hub/hub-client.ts` | **新建** | ~400 |
| `src/services/hub/worker-identity.ts` | **新建** | ~100 |
| `src/server/routes/hub.ts` | **新建** | ~400 |
| `src/core/config.ts` | 修改 +15 | |
| `src/main.ts` | 修改 +30 | |
| `src/server/app.ts` | 修改 +10 | |
| `frontend/src/store/hub.ts` | **新建** | ~150 |
| `frontend/src/api/client.ts` | 修改 +50 | |
| `frontend/src/components/Settings/` | 修改 +200 | |
| `frontend/src/components/Marketplace/` | **新建** | ~300 |
| `.env.example` | 修改 +10 | |
| **Worker 端总计** | | **~1815 行** |

### Server 端（独立新项目）

| 模块 | 预估行数 |
|------|---------|
| 核心框架（main, config, app） | ~300 |
| 数据库（pg, migrations, repos） | ~1500 |
| 认证系统（OAuth, JWT） | ~500 |
| 业务服务（worker, config, marketplace, review, user） | ~2000 |
| API 路由 | ~1500 |
| 管理前端 | ~4000 |
| Docker 配置 | ~100 |
| **Server 端总计** | **~9900 行** |
