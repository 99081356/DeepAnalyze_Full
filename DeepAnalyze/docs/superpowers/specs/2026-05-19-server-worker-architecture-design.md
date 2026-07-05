# DA Server + Worker 分布式架构设计文档

> **版本**: v1.0
> **日期**: 2026-05-19
> **状态**: 设计中

---

## 一、背景与目标

### 1.1 当前现状

DeepAnalyze 当前是一个单机单用户系统：
- **零认证中间件**：所有 API 完全开放，`users` 表存在但从未使用
- **全局单例架构**：AgentRunner、ToolRegistry、ModelRouter、ProcessingQueue 等全部是单例
- **无用户隔离**：sessions、KB、settings 全局共享，`owner_id` 字段存在但默认 `"default-user"` 且从未用于过滤
- **单实例部署**：无集群/分布式概念

### 1.2 改造目标

将 DA 改造为 **Server 端（中心服务）+ Worker 端（DA 实例）** 两级架构：

| 能力 | 描述 |
|------|------|
| 多用户隔离 | 每个 Worker 实例服务一个或一组用户，数据天然隔离 |
| 统一鉴权 | Server 端对接第三方 OAuth 2.0 认证，用户登录后路由到专属 Worker |
| 配置推荐 | Server 端维护推荐模型配置，Worker 可按需一键同步 |
| 资源市场 | 用户自研技能/插件可上传到 Server，审核后共享给所有 Worker |
| Worker 独立性 | Worker 拥有最大自由度，Server 宕机不影响 Worker 运行 |
| 灵活部署 | Worker 支持容器/VM/物理机/单机部署 |

### 1.3 核心设计原则

1. **Worker 端拥有最大自由度** — 收到 Server 配置后可自主修改，不强制同步
2. **配置同步为手动触发**（按钮），非自动推送
3. **心跳仅用于状态感知**，不做强绑定 — Server 宕机不影响 Worker 运行
4. **Worker 支持长时间任务**，不受 Server 连接状态影响
5. **Server 端定位**：鉴权登录 + 资源分发共享中心 + 管理监控
6. **渐进式改造**：Worker 端改动最小，Server 端全新开发

---

## 二、架构总览

```
                    ┌────────────────────────────────────────────┐
                    │      Server 端 (deepanalyze-hub)           │
                    │                                            │
                    │  ┌──────────────────────────────────────┐  │
                    │  │  用户鉴权 (OAuth 2.0 对接)            │  │
                    │  │  用户管理 (CRUD + 生命周期)            │  │
                    │  │  Worker 注册表 + 状态面板              │  │
                    │  │  配置管理 (推荐配置下发)               │  │
                    │  │  资源市场 (技能/插件浏览/审核/发布)     │  │
                    │  │  管理面板 (全局监控)                   │  │
                    │  └──────────────────────────────────────┘  │
                    │                                            │
                    │  独立 PostgreSQL     管理端前端 (React)      │
                    └────────────────────┬───────────────────────┘
                                         │
                              HTTPS REST API
                              (松耦合，非实时)
                                         │
               ┌─────────────────────────┼─────────────────────────┐
               │                         │                          │
        ┌──────▼──────┐          ┌───────▼──────┐          ┌───────▼──────┐
        │  Worker 1   │          │  Worker 2    │          │  Worker N    │
        │ (DA 实例)   │          │ (DA 实例)    │          │ (DA 实例)    │
        │             │          │              │          │              │
        │ 容器/VM/    │          │ 容器/VM/     │          │ 物理机/      │
        │ 物理机      │          │ 物理机       │          │ 单机部署     │
        └─────────────┘          └──────────────┘          └──────────────┘
        每个 Worker:
        - 独立 PostgreSQL
        - 独立 dataDir
        - 独立 Agent 系统
        - 可完全离线运行
        - 按需连接 Server
```

### 2.1 Server 端职责

| 职责 | 说明 |
|------|------|
| 用户鉴权 | 对接第三方 OAuth 2.0，签发 JWT，验证用户身份 |
| 用户管理 | CRUD + 生命周期管理（创建 → 分配 Worker → 删除清理） |
| Worker 注册 | Worker 启动时注册到 Server，维护在线状态 |
| 配置管理 | 维护全局推荐配置（LLM provider、Agent 参数等），按需下发 |
| 资源市场 | 技能/插件的提交、审核、发布、下载、评分 |
| 管理面板 | 全局监控：Worker 状态、用户活跃度、资源使用 |
| 流量路由（可选） | 将已登录用户路由到其专属 Worker |

### 2.2 Worker 端职责

| 职责 | 说明 |
|------|------|
| DA 核心功能 | 完整的知识库、Agent、会话能力（不因连接 Server 而受限） |
| 独立运行 | Server 不可达时完全自主运行（standalone 降级） |
| 心跳上报 | 每 30 秒向 Server 上报状态（失败不影响本地运行） |
| 配置同步 | 用户点击"同步配置"按钮时从 Server 拉取推荐配置 |
| 市场交互 | 浏览/安装/发布技能和插件 |

### 2.3 通信模式

- **全部采用 Worker 主动调用 Server（Pull 模式）**
- Server 不主动推送任何信息
- 心跳响应中可携带 `pendingNotifications`（通知 Worker 有新配置等）
- Worker 看到通知后由用户决定是否同步

---

## 三、Worker 端运行模式设计

### 3.1 模式切换

```bash
# standalone 模式（默认，与当前行为完全一致）
# 不设置 DA_SERVER_URL

# worker 模式（连接 Server）
DA_SERVER_URL=https://hub.example.com
DA_WORKER_ID=auto                    # auto = 自动生成并持久化
DA_WORKER_TOKEN=xxx                  # Server 签发的认证令牌
```

### 3.2 模式行为对比

| 特性 | standalone | worker |
|------|-----------|--------|
| Server 连接 | 不连接 | 心跳 + 按需 API |
| 配置来源 | 本地 YAML / Settings UI | 本地 + Server 推荐配置（手动同步） |
| 用户认证 | 无 | JWT 验证（Server 签发） |
| 市场功能 | 不可用 | 可浏览/安装/发布 |
| Server 宕机影响 | 无 | 无（自动降级为 standalone） |
| 前端差异 | 无 Hub 相关 UI | 设置页显示"服务器连接"区域 + 市场入口 |

### 3.3 降级策略

```
Worker 启动 → 尝试连接 Server
  ├── 成功 → worker 模式（心跳 + 状态面板可用）
  ├── 失败 → 自动降级为 standalone，不抛异常，不阻塞启动
  └── 运行中 Server 断连 → 标记 serverReachable=false，继续本地运行
      └── Server 恢复 → 下次心跳成功自动恢复 worker 模式
```

---

## 四、Server ↔ Worker 通信协议

### 4.1 Worker → Server API

所有 API 都是 Worker 主动调用 Server（pull 模式），Server 不主动推送。

#### 认证

```
POST /api/v1/workers/register
  Request:  WorkerRegisterRequest
  Response: WorkerRegisterResponse | 401

POST /api/v1/workers/heartbeat
  Request:  HeartbeatRequest
  Response: HeartbeatResponse
```

#### 配置

```
GET  /api/v1/config/recommended
  Response: RecommendedConfig | 204 (无配置)

GET  /api/v1/config/versions
  Response: ConfigVersionInfo | 204
```

#### 资源市场

```
GET  /api/v1/marketplace/skills?page=1&pageSize=20&search=&tag=
  Response: { items: MarketplaceSkill[], total: number }

GET  /api/v1/marketplace/skills/:slug
  Response: MarketplaceSkillDetail

GET  /api/v1/marketplace/skills/:slug/download
  Response: SkillPackage

GET  /api/v1/marketplace/skills/:slug/versions
  Response: SkillVersion[]

POST /api/v1/marketplace/skills/submit
  Request:  SkillSubmitRequest
  Response: SkillSubmitResponse

GET  /api/v1/marketplace/plugins?page=1&pageSize=20&search=
  Response: { items: MarketplacePlugin[], total: number }

GET  /api/v1/marketplace/plugins/:slug
  Response: MarketplacePluginDetail

GET  /api/v1/marketplace/plugins/:slug/download
  Response: PluginPackage

POST /api/v1/marketplace/plugins/submit
  Request:  PluginSubmitRequest
  Response: PluginSubmitResponse
```

### 4.2 Server → Worker API（Worker 暴露的只读状态接口）

Server 可调用以下接口查看 Worker 状态。**Server 无法控制 Worker 行为**。

```
GET  /api/worker/status          → WorkerLocalStatus
GET  /api/worker/version         → { version: string, daVersion: string }
GET  /api/worker/capabilities    → WorkerCapabilities
```

---

## 五、数据类型定义

### 5.1 Worker 注册

```typescript
interface WorkerRegisterRequest {
  workerId: string;
  hostname: string;
  version: string;               // DA 版本号 "0.20.0"
  endpoint: string;              // Worker 的外部访问地址
  capabilities: WorkerCapabilities;
}

interface WorkerCapabilities {
  cpuCores: number;
  memoryGB: number;
  gpuAvailable: boolean;
  os: string;
  daVersion: string;
  runMode: "standalone" | "docker" | "vm";
}

interface WorkerRegisterResponse {
  workerId: string;
  workerToken: string;           // 后续 API 调用的认证令牌（JWT）
  serverPublicKey: string;       // JWT 验证公钥（PEM 格式）
  serverVersion: string;
}
```

### 5.2 心跳

```typescript
interface HeartbeatRequest {
  workerId: string;
  status: "online" | "busy" | "idle";
  activeSessions: number;
  activeTasks: number;
  resourceUsage: {
    cpuPercent: number;
    memoryUsedGB: number;
    memoryTotalGB: number;
    diskUsedGB: number;
    diskTotalGB: number;
  };
  uptime: number;                // 秒
}

interface HeartbeatResponse {
  acknowledged: boolean;
  serverTime: string;
  pendingNotifications?: WorkerNotification[];
}

interface WorkerNotification {
  type: "config_updated" | "skill_approved" | "skill_rejected" | "system_notice";
  message: string;
  timestamp: string;
}
```

### 5.3 配置同步

```typescript
/**
 * Server 推荐配置的完整结构。
 * 复用 Worker 端已有的 ProviderConfig / ProviderDefaults 接口，
 * 参考 src/store/repos/interfaces.ts L758-800。
 */
interface RecommendedConfig {
  version: string;               // 配置版本号 "20260519-001"
  updatedAt: string;

  /** LLM Provider 配置 — 复用 Worker 端 ProviderSettings 结构 */
  providers: {
    providers: ProviderConfig[]; // id, name, type, endpoint, apiKey, model, enabled...
    defaults: ProviderDefaults;  // main, summarizer, embedding, vlm, tts...
  };

  /** Agent 运行参数 */
  agentSettings?: Record<string, unknown>;

  /** Docling 文档处理配置 */
  doclingConfig?: Record<string, unknown>;

  /** 增强模型配置 */
  enhancedModels?: unknown[];

  /** Agent Hooks */
  hooks?: unknown[];
}

interface ConfigVersionInfo {
  latestVersion: string;
  updatedAt: string;
  description?: string;
}
```

### 5.4 资源市场

```typescript
/** 市场技能列表项（浏览用） */
interface MarketplaceSkill {
  slug: string;
  name: string;
  description: string;
  author: { userId: string; name: string };
  version: string;
  tags: string[];
  downloadCount: number;
  ratingAvg: number;
  reviewCount: number;
  publishedAt: string;
  compatibility: {
    minVersion: string;
    requiredTools?: string[];
    requiredProviders?: string[];
  };
}

/** 技能详情（包含完整信息） */
interface MarketplaceSkillDetail extends MarketplaceSkill {
  prompt: string;                // 技能提示词（仅详情页展示）
  tools: string[];
  modelRole: string;
  antiHallucinationLevel?: string;
  testScenarios?: Record<string, unknown>[];
  versions: SkillVersion[];
}

/** 技能安装包（下载时返回的完整包） */
interface SkillPackage {
  slug: string;
  name: string;
  version: string;
  description: string;
  prompt: string;                // 完整 Markdown 提示词
  tools: string[];
  modelRole: string;
  antiHallucinationLevel?: string;
  tags: string[];
  compatibility: {
    minVersion: string;
    requiredTools?: string[];
    requiredProviders?: string[];
  };
}

/** 技能版本信息 */
interface SkillVersion {
  version: string;
  changeType: "create" | "update" | "patch";
  changeSummary?: string;
  createdAt: string;
}

/** 技能提交请求（Worker → Server） */
interface SkillSubmitRequest {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  modelRole: string;
  tags: string[];
  submitterNotes?: string;
}

interface SkillSubmitResponse {
  submissionId: string;
  status: "submitted";
  message: string;
}
```

### 5.5 Worker 端新增类型

```typescript
/** Worker 运行模式 */
export type DaRunMode = "standalone" | "worker";

/** Worker 配置（从环境变量读取） */
export interface WorkerConfig {
  runMode: DaRunMode;
  serverUrl: string;
  workerId: string;
  workerToken: string;
}

/** Server 同步状态（前端查询用） */
export interface HubSyncState {
  lastHeartbeat: string | null;
  lastConfigSync: string | null;
  configVersionCached: string | null;
  serverReachable: boolean;
  pendingNotifications: WorkerNotification[];
  registeredWorkerId: string | null;
}

/** Worker 本地状态（Server 查询用） */
export interface WorkerLocalStatus {
  workerId: string;
  version: string;
  uptime: number;
  status: "online" | "busy" | "idle";
  activeSessions: number;
  activeTasks: number;
  resourceUsage: {
    cpuPercent: number;
    memoryUsedGB: number;
    memoryTotalGB: number;
    diskUsedGB: number;
    diskTotalGB: number;
  };
  hubConnected: boolean;
  lastHubContact: string | null;
}
```

---

## 六、Worker 端改造设计

### 6.1 新增文件清单

| 文件路径 | 说明 | 预估行数 |
|----------|------|---------|
| `src/services/hub/types.ts` | 所有 Server 通信相关的 TypeScript 类型定义 | ~150 |
| `src/services/hub/hub-client.ts` | Server 通信客户端（注册/心跳/配置/市场） | ~400 |
| `src/services/hub/worker-identity.ts` | Worker ID 管理 + 能力采集 + 状态报告 | ~100 |
| `src/server/routes/hub.ts` | Worker 端 Hub API 路由 | ~400 |

### 6.2 HubClient 核心设计

```typescript
export class HubClient {
  private config: WorkerConfig;
  private syncState: HubSyncState;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: WorkerConfig);

  // ─── 连接管理 ───

  /**
   * 向 Server 注册。
   * 失败返回 null（不抛异常），Worker 降级为 standalone 模式。
   */
  async register(): Promise<WorkerRegisterResponse | null>;

  /**
   * 启动心跳（30 秒间隔）。
   * 失败只标记 serverReachable=false，不影响 Worker 运行。
   * 成功时自动恢复 serverReachable=true。
   */
  startHeartbeat(intervalMs?: number): void;

  /** 停止心跳（进程退出时调用） */
  stopHeartbeat(): void;

  /** 获取当前同步状态（前端轮询用） */
  getSyncState(): HubSyncState;

  // ─── 配置同步 ───

  /**
   * 从 Server 获取推荐配置（手动触发）。
   * 返回 null = Server 不可达或 Server 无推荐配置。
   */
  async fetchRecommendedConfig(): Promise<RecommendedConfig | null>;

  /**
   * 轻量级检查配置是否有更新（只返回版本号，不下载完整配置）。
   * 前端可用此接口显示"有新配置可用"提示。
   */
  async fetchConfigVersion(): Promise<ConfigVersionInfo | null>;

  /**
   * 将推荐配置写入本地 settings 表，触发 ModelRouter 热更新。
   * 内部调用：
   *   1. repos.settings.saveProviderSettings(config.providers)
   *   2. repos.settings.set("agent_settings", JSON.stringify(config.agentSettings))
   *   3. 其他 settings 同理
   *   4. bumpConfigVersion() — 触发 ModelRouter 重新加载
   */
  async applyRecommendedConfig(config: RecommendedConfig): Promise<void>;

  // ─── 资源市场 ───

  /** 浏览市场技能列表 */
  async listMarketplaceSkills(page?: number, search?: string):
    Promise<{ items: MarketplaceSkill[]; total: number } | null>;

  /** 获取技能详情 */
  async getMarketplaceSkill(slug: string): Promise<MarketplaceSkillDetail | null>;

  /** 下载并安装技能到本地 agent_skills 表 */
  async downloadMarketplaceSkill(slug: string): Promise<{ installed: boolean; skillId: string } | null>;
  // 安装逻辑：
  //   1. GET /api/v1/marketplace/skills/:slug/download → SkillPackage
  //   2. 检查兼容性（minVersion, requiredTools）
  //   3. repos.agentSkill.create({
  //        name: skill.name,
  //        prompt: skill.prompt,
  //        tools: skill.tools,
  //        source: "hub",
  //        hubSlug: skill.slug,
  //        hubUrl: `${serverUrl}/api/v1/marketplace/skills/${skill.slug}`,
  //      })
  //   4. 返回安装结果

  /** 将本地技能发布到市场 */
  async submitSkillToMarket(skillId: string): Promise<SkillSubmitResponse | null>;
  // 发布逻辑：
  //   1. repos.agentSkill.get(skillId) → 本地技能
  //   2. 打包为 SkillSubmitRequest
  //   3. POST /api/v1/marketplace/skills/submit
  //   4. 返回提交结果

  /** 浏览市场插件列表 */
  async listMarketplacePlugins(page?: number): Promise<{ items: any[]; total: number } | null>;

  /** 下载并安装插件 */
  async downloadMarketplacePlugin(slug: string): Promise<{ installed: boolean } | null>;

  /** 发布插件到市场 */
  async submitPluginToMarket(pluginId: string): Promise<SkillSubmitResponse | null>;

  // ─── Worker 状态 ───

  /** 采集本地状态（CPU/内存/活跃任务/版本等） */
  getLocalStatus(): WorkerLocalStatus;
}
```

### 6.3 修改文件清单

| 文件路径 | 改动内容 | 行数 |
|----------|---------|------|
| `src/core/config.ts` | 新增 `runMode`, `serverUrl`, `workerId`, `workerToken` 字段 | +15 |
| `src/main.ts` | Worker 模式初始化（注册 HubClient，启动心跳） | +30 |
| `src/server/app.ts` | 注册 `/api/hub/*` 和 `/api/worker/*` 路由（仅 worker 模式） | +10 |
| 前端设置页 | 新增"服务器连接"区域（状态 + 同步按钮） | ~200 |
| 前端侧边栏 | 新增"资源市场"入口（仅 worker 模式显示） | ~300 |

### 6.4 Worker 端 hub.ts API 路由设计

```typescript
// ─── 前端调用的 API ───

// 手动触发配置同步（"从服务器同步配置"按钮）
POST /api/hub/sync-config
  → HubClient.fetchRecommendedConfig()
  → HubClient.applyRecommendedConfig()
  → Response: { success: boolean; configVersion?: string; error?: string }

// 获取同步状态（前端轮询或页面加载时）
GET /api/hub/sync-state
  → Response: HubSyncState

// 浏览市场技能
GET /api/hub/marketplace/skills?page=1&search=&tag=
  → HubClient.listMarketplaceSkills()
  → Response: { items: MarketplaceSkill[]; total: number }

// 技能详情
GET /api/hub/marketplace/skills/:slug
  → HubClient.getMarketplaceSkill(slug)

// 从市场安装技能
POST /api/hub/marketplace/install/:slug
  → HubClient.downloadMarketplaceSkill(slug)
  → Response: { installed: boolean; skillId: string }

// 发布本地技能到市场
POST /api/hub/marketplace/publish/:skillId
  → HubClient.submitSkillToMarket(skillId)
  → Response: SkillSubmitResponse

// 浏览市场插件
GET /api/hub/marketplace/plugins?page=1&search=

// 安装插件
POST /api/hub/marketplace/install-plugin/:slug

// 发布插件
POST /api/hub/marketplace/publish-plugin/:pluginId

// ─── Server 调用的 API（Worker 暴露的只读接口） ───

GET /api/worker/status
  → Response: WorkerLocalStatus

GET /api/worker/version
  → Response: { version: string; daVersion: string }

GET /api/worker/capabilities
  → Response: WorkerCapabilities
```

### 6.5 不修改的文件（零改动）

| 组件 | 关键文件 | 不改原因 |
|------|---------|---------|
| Agent 系统 | `agent-runner.ts`, `orchestrator.ts` | Worker 内部照常运行 |
| 工具系统 | `tool-setup.ts` | 新增 Hub API 路由不影响工具逻辑 |
| Session 架构 | `session-paths.ts` 等 | Session 级文件目录不变 |
| 知识库系统 | `knowledge.ts`, `wiki/*` | KB 系统完全独立 |
| 文档处理 | `processing-queue.ts` | 处理管线不变 |
| 数据库 | `pg-migrations/*` | Worker DB schema 不变 |
| ModelRouter | `router.ts` | 复用现有 `bumpConfigVersion()` 热更新 |
| Settings 系统 | `settings.ts` (repos) | 复用现有 `saveProviderSettings()` 等 |

---

## 七、Server 端设计（deepanalyze-hub）

### 7.1 技术栈

```
语言/运行时:  TypeScript + Bun（与 Worker 保持一致）
Web 框架:     Hono（与 Worker 保持一致）
数据库:       独立 PostgreSQL 实例
前端:         React + Tailwind CSS + Zustand
部署:         Docker 容器
```

### 7.2 项目目录结构

```
D:\code\deepanalyze\deepanalyze-hub\
├── package.json
├── tsconfig.json
├── .env.example
├── config/
│   └── default.yaml                  # Server 默认配置
├── src/
│   ├── main.ts                       # 入口
│   ├── core/
│   │   └── config.ts                 # Server 配置
│   ├── server/
│   │   ├── app.ts                    # Hono app
│   │   ├── middleware/
│   │   │   ├── auth.ts               # JWT 签发/验证 + OAuth 2.0 回调
│   │   │   └── worker-auth.ts        # Worker token 验证中间件
│   │   └── routes/
│   │       ├── auth.ts               # /api/v1/auth/*      OAuth 2.0 回调
│   │       ├── users.ts              # /api/v1/users/*     用户管理
│   │       ├── workers.ts            # /api/v1/workers/*   Worker 注册/心跳
│   │       ├── config.ts             # /api/v1/config/*    配置管理
│   │       ├── marketplace.ts        # /api/v1/marketplace/* 资源市场
│   │       ├── admin.ts              # /api/v1/admin/*     管理面板
│   │       └── proxy.ts              # /api/v1/proxy/*     用户流量代理（可选）
│   ├── services/
│   │   ├── user-manager.ts           # 用户生命周期管理
│   │   ├── worker-registry.ts        # Worker 注册表 + 心跳管理
│   │   ├── config-manager.ts         # 配置版本管理
│   │   ├── marketplace-service.ts    # 市场业务逻辑
│   │   ├── review-service.ts         # 技能审核流程
│   │   └── sso-adapter.ts            # OAuth 2.0 适配器
│   ├── store/
│   │   ├── pg.ts                     # PostgreSQL 连接
│   │   ├── migrations/
│   │   │   └── 001_init.ts           # 初始化 Schema
│   │   └── repos/
│   │       ├── user.ts
│   │       ├── worker.ts
│   │       ├── config.ts
│   │       ├── marketplace-skill.ts
│   │       ├── marketplace-plugin.ts
│   │       └── audit-log.ts
│   └── types/
│       └── index.ts                  # 共享类型定义
├── frontend/
│   ├── package.json
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx             # 登录页（跳转 OAuth）
│   │   │   ├── Dashboard.tsx         # 系统概览面板
│   │   │   ├── Users.tsx             # 用户管理
│   │   │   ├── Workers.tsx           # Worker 状态管理
│   │   │   ├── Config.tsx            # 推荐配置管理
│   │   │   ├── Marketplace.tsx       # 资源市场审核管理
│   │   │   └── AuditLog.tsx          # 审计日志
│   │   ├── components/
│   │   │   ├── Layout.tsx
│   │   │   ├── WorkerStatusCard.tsx
│   │   │   ├── SkillReviewPanel.tsx
│   │   │   └── ...
│   │   └── api/
│   │       └── client.ts
│   └── index.html
├── docker-compose.yml
└── Dockerfile
```

### 7.3 Server 端数据库 Schema

```sql
-- ============================================================
-- 用户表
-- ============================================================
CREATE TABLE users (
  id TEXT PRIMARY KEY,                     -- UUID
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('admin', 'user')),
  sso_id TEXT,                             -- 第三方 OAuth 用户标识
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  assigned_worker_id TEXT,                 -- 分配到的 Worker（可选）
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_sso_id ON users(sso_id);
CREATE INDEX idx_users_status ON users(status);

-- ============================================================
-- Worker 注册表
-- ============================================================
CREATE TABLE workers (
  id TEXT PRIMARY KEY,                     -- Worker 自生成的 UUID
  hostname TEXT NOT NULL,
  endpoint TEXT NOT NULL,                  -- Worker 外部访问地址
  version TEXT NOT NULL,                   -- DA 版本号
  capabilities JSONB,                      -- { cpuCores, memoryGB, gpuAvailable, os, ... }
  status TEXT NOT NULL DEFAULT 'online'
    CHECK (status IN ('online', 'offline', 'draining')),
  last_heartbeat TIMESTAMPTZ,
  active_sessions INT DEFAULT 0,
  active_tasks INT DEFAULT 0,
  resource_usage JSONB,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 心跳超时检测：超过 90 秒无心跳标记为 offline
-- 由定时任务执行，不需要数据库触发器

-- ============================================================
-- 配置版本表
-- ============================================================
CREATE TABLE config_versions (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,            -- "20260519-001"
  scope TEXT NOT NULL DEFAULT 'global',    -- 'global' | 'worker:{id}'
  config_data JSONB NOT NULL,              -- 完整配置快照
  description TEXT,                        -- "更新了 MiniMax 模型配置"
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_config_scope ON config_versions(scope);

-- ============================================================
-- 市场技能表
-- ============================================================
CREATE TABLE marketplace_skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  prompt TEXT NOT NULL,                    -- 完整技能 Markdown 提示词
  tools TEXT[] DEFAULT '{"*"}',
  model_role TEXT DEFAULT 'main',
  anti_hallucination_level TEXT,
  tags TEXT[],
  version TEXT NOT NULL,
  author_id TEXT REFERENCES users(id),
  submitter_id TEXT REFERENCES users(id),
  download_count INT DEFAULT 0,
  rating_avg NUMERIC(3,2) DEFAULT 0,
  review_count INT DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected', 'deprecated')),
  reviewer_id TEXT REFERENCES users(id),
  review_notes TEXT,
  published_at TIMESTAMPTZ,
  compatibility JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_skills_status ON marketplace_skills(review_status);
CREATE INDEX idx_skills_tags ON marketplace_skills USING GIN(tags);

-- ============================================================
-- 市场插件表
-- ============================================================
CREATE TABLE marketplace_plugins (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  manifest JSONB NOT NULL,                 -- 完整 plugin manifest
  version TEXT NOT NULL,
  author_id TEXT REFERENCES users(id),
  submitter_id TEXT REFERENCES users(id),
  download_count INT DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected', 'deprecated')),
  reviewer_id TEXT REFERENCES users(id),
  review_notes TEXT,
  published_at TIMESTAMPTZ,
  compatibility JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 技能评分/评论
-- ============================================================
CREATE TABLE skill_reviews (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES marketplace_skills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(skill_id, user_id)
);

-- ============================================================
-- 审计日志
-- ============================================================
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,                        -- 'worker' | 'skill' | 'plugin' | 'user' | 'config'
  target_id TEXT,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ============================================================
-- OAuth 会话表
-- ============================================================
CREATE TABLE oauth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  access_token TEXT NOT NULL UNIQUE,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_token ON oauth_sessions(access_token);
```

### 7.4 Server 端 API 设计

#### 认证相关

```
# OAuth 2.0 授权码流程
GET  /api/v1/auth/login               → 重定向到第三方 OAuth 授权页
GET  /api/v1/auth/callback             → OAuth 回调，交换 token，创建/查找用户，签发 JWT
POST /api/v1/auth/refresh              → 刷新 JWT token
POST /api/v1/auth/logout               → 注销
GET  /api/v1/auth/me                   → 获取当前用户信息
```

#### 用户管理（管理员）

```
GET    /api/v1/users                    → 列表（分页、搜索、筛选）
POST   /api/v1/users                    → 创建用户
GET    /api/v1/users/:id                → 用户详情
PUT    /api/v1/users/:id                → 更新用户
DELETE /api/v1/users/:id                → 删除用户（软删除）
```

#### Worker 管理

```
POST /api/v1/workers/register           → Worker 注册
POST /api/v1/workers/heartbeat          → 心跳上报
GET  /api/v1/workers                    → Worker 列表（管理面板）
GET  /api/v1/workers/:id                → Worker 详情
PUT  /api/v1/workers/:id/status         → 更新 Worker 状态（管理员操作，如标记 draining）
```

#### 配置管理

```
GET  /api/v1/config/recommended         → 获取最新推荐配置（Worker 调用）
GET  /api/v1/config/versions            → 配置版本列表
GET  /api/v1/config/versions/:version   → 特定版本的配置快照
PUT  /api/v1/config/recommended         → 更新推荐配置（管理员）
```

#### 资源市场

```
# 公开接口（已认证的 Worker 可调用）
GET  /api/v1/marketplace/skills                    → 技能列表
GET  /api/v1/marketplace/skills/:slug              → 技能详情
GET  /api/v1/marketplace/skills/:slug/download      → 下载技能包
GET  /api/v1/marketplace/skills/:slug/versions      → 版本历史
POST /api/v1/marketplace/skills/submit             → 提交技能
GET  /api/v1/marketplace/plugins                   → 插件列表
GET  /api/v1/marketplace/plugins/:slug             → 插件详情
GET  /api/v1/marketplace/plugins/:slug/download     → 下载插件包
POST /api/v1/marketplace/plugins/submit            → 提交插件
POST /api/v1/marketplace/skills/:slug/rate         → 评分

# 管理接口（管理员）
GET  /api/v1/admin/marketplace/pending             → 待审核列表
PUT  /api/v1/admin/marketplace/skills/:id/review   → 审核（批准/拒绝）
PUT  /api/v1/admin/marketplace/skills/:id/deprecate → 标记废弃
```

### 7.5 Server 端管理前端设计

#### 页面结构

```
/login        → OAuth 跳转页
/dashboard    → 系统概览
  ┌──────────────────────────────────────────────┐
  │  在线 Workers: 3/5    活跃用户: 12    技能数: 45  │
  │  ┌────────────┐ ┌────────────┐ ┌───────────┐ │
  │  │ Worker 分布 │ │ 最近活动    │ │ 系统健康   │ │
  │  │ 饼图       │ │ 时间线     │ │ 指示器     │ │
  │  └────────────┘ └────────────┘ └───────────┘ │
  └──────────────────────────────────────────────┘

/users        → 用户管理
  ├── 用户列表（搜索、筛选、排序）
  ├── 创建用户（用户名、邮箱、分配 Worker）
  └── 用户详情（登录历史、分配的 Worker、状态）

/workers      → Worker 管理
  ├── Worker 列表（状态、版本、资源使用、活跃用户数）
  ├── Worker 详情（心跳历史、资源曲线、活跃会话）
  └── 操作：标记 draining、强制 offline

/config       → 配置管理
  ├── 当前推荐配置编辑器
  ├── 配置版本历史
  ├── 新建配置版本（完整 Provider/Defaults/Settings 编辑）
  └── 预览：将配置 JSON 与 Worker 当前配置对比

/marketplace  → 资源市场管理
  ├── 已发布技能列表（浏览、搜索、分类）
  ├── 待审核列表（审核批准/拒绝）
  ├── 技能详情（查看完整 prompt、兼容性、下载量）
  └── 发布/废弃/编辑

/audit        → 审计日志
  └── 操作日志（谁在什么时间做了什么）
```

---

## 八、配置同步流程详解

### 8.1 Worker 端已有的配置热更新机制

Worker 端已有完整的配置热更新能力（无需重启）：

1. **`ModelRouter.configVersion`** — 模块级全局计数器，配置变更时递增
2. **`bumpConfigVersion()`** — 由 Settings API 调用触发
3. **`ModelRouter.ensureCurrent()`** — 每次 LLM 调用前检查，版本落后则重新加载
4. **`repos.settings.saveProviderSettings()`** — 将 providers 写入 DB
5. **`repos.settings.set(key, value)`** — 通用 settings 写入

配置同步只需调用这些已有接口即可，**零新增基础设施**。

### 8.2 同步流程

```
用户在 Worker 前端点击"从服务器同步配置"按钮
  │
  ├── POST /api/hub/sync-config
  │     │
  │     ├── HubClient.fetchRecommendedConfig()
  │     │     → GET https://server/api/v1/config/recommended
  │     │     → 返回 RecommendedConfig 或 null
  │     │
  │     ├── 如果返回 null（Server 不可达或无配置）
  │     │     → 返回 { success: false, error: "Server 不可达" }
  │     │
  │     ├── HubClient.applyRecommendedConfig(config)
  │     │     ├── repos.settings.saveProviderSettings(config.providers)
  │     │     ├── config.agentSettings → repos.settings.set("agent_settings", ...)
  │     │     ├── config.doclingConfig → repos.settings.set("docling_config", ...)
  │     │     ├── config.enhancedModels → repos.settings.set("enhanced_models", ...)
  │     │     ├── config.hooks → repos.settings.set("agent_hooks", ...)
  │     │     └── bumpConfigVersion()  // 触发 ModelRouter 重新加载
  │     │
  │     └── 返回 { success: true, configVersion: "20260519-001" }
  │
  └── 前端显示"配置已同步"，更新同步时间和版本号
```

### 8.3 配置版本检查（轻量级）

Worker 前端可定时检查是否有新配置可用：

```
GET /api/hub/sync-state
  → HubSyncState 中包含 configVersionCached 和 serverReachable

GET /api/v1/config/versions (Server)
  → ConfigVersionInfo { latestVersion, updatedAt, description }

前端对比: cached version < latest version → 显示"有新配置可用"徽章
```

---

## 九、技能市场交互流程

### 9.1 技能安装流程

```
Worker 用户在"资源市场"浏览技能列表
  │
  ├── GET /api/hub/marketplace/skills?page=1&search=deep-research
  │     → HubClient.listMarketplaceSkills()
  │     → GET https://server/api/v1/marketplace/skills?...
  │     → 返回技能列表（名称、描述、作者、评分、下载量）
  │
  ├── 用户点击某个技能查看详情
  │     → GET /api/hub/marketplace/skills/deep-research-v2
  │     → 返回完整详情（含 prompt 内容、兼容性要求）
  │
  ├── 用户点击"安装"
  │     → POST /api/hub/marketplace/install/deep-research-v2
  │     → HubClient.downloadMarketplaceSkill("deep-research-v2")
  │         ├── GET https://server/api/v1/marketplace/skills/deep-research-v2/download
  │         ├── 检查兼容性（minVersion <= 当前 DA 版本）
  │         ├── repos.agentSkill.create({
  │         │     name: skill.name,
  │         │     prompt: skill.prompt,
  │         │     tools: skill.tools,
  │         │     source: "hub",
  │         │     hubSlug: "deep-research-v2",
  │         │     hubUrl: "https://server/api/v1/marketplace/skills/deep-research-v2",
  │         │   })
  │         └── 返回 { installed: true, skillId: "..." }
  │
  └── 安装完成，技能出现在本地技能列表中，可立即使用
```

### 9.2 技能发布流程

```
Worker 用户在本地创建了一个好用的技能
  │
  ├── 在本地技能详情页点击"发布到市场"
  │     → POST /api/hub/marketplace/publish/:skillId
  │     → HubClient.submitSkillToMarket(skillId)
  │         ├── repos.agentSkill.get(skillId) → 本地技能数据
  │         ├── 打包为 SkillSubmitRequest {
  │         │     name, description, prompt, tools, modelRole, tags,
  │         │     submitterNotes: "用户备注"
  │         │   }
  │         ├── POST https://server/api/v1/marketplace/skills/submit
  │         └── 返回 { submissionId, status: "submitted" }
  │
  ├── Server 端收到提交
  │     ├── 创建 marketplace_skills 记录，review_status = "pending"
  │     └── 通知管理员有新提交（管理面板显示）
  │
  ├── 管理员在 Server 管理面板审核
  │     ├── 查看技能 prompt、tools、兼容性
  │     ├── 可选：在测试 Worker 上试运行
  │     ├── 批准 → review_status = "approved", published_at = now()
  │     └── 拒绝 → review_status = "rejected", review_notes = "原因"
  │
  └── 批准后，所有 Worker 在下次浏览市场时可见该技能
      （Worker 的下一个心跳会收到 config_updated 通知）
```

---

## 十、安全设计

### 10.1 Worker → Server 认证

```
Worker 注册:
  POST /api/v1/workers/register
  → Server 验证请求来源（IP 白名单或预共享密钥）
  → 签发 workerToken（JWT，含 workerId，有效期 30 天）
  → 后续所有 API 调用携带 Authorization: Bearer {workerToken}

Worker 心跳:
  POST /api/v1/workers/heartbeat
  → 验证 workerToken 有效性
  → 更新 last_heartbeat 时间戳
```

### 10.2 用户认证（OAuth 2.0）

```
用户登录:
  1. 浏览器访问 Worker → Worker 检测无有效 session
  2. 重定向到 Server: GET /api/v1/auth/login
  3. Server 重定向到第三方 OAuth 授权页
  4. 用户授权后，第三方回调到 Server: /api/v1/auth/callback?code=xxx
  5. Server 用 code 换取 access_token，获取用户信息
  6. Server 创建/查找用户，签发 JWT（含 userId, role, assignedWorkerId）
  7. Server 重定向回 Worker: /auth/callback?token=xxx
  8. Worker 验证 JWT（用 Server 的公钥），建立本地 session
```

### 10.3 API 安全

```
Worker 端 API 安全:
  /api/hub/*     → 需要用户已登录（session cookie）+ worker 模式
  /api/worker/*  → 需要调用方携带有效的 Server 签发 token

Server 端 API 安全:
  /api/v1/workers/*  → 需要 Worker Bearer token
  /api/v1/auth/*     → 公开（OAuth 流程）
  /api/v1/users/*    → 需要 admin 角色
  /api/v1/config/*   → GET 公开（Worker 可读），PUT 需要 admin
  /api/v1/marketplace/* → GET 公开，POST 需要认证，审核需要 admin
  /api/v1/admin/*    → 需要 admin 角色
```

---

## 十一、错误处理与降级策略

### 11.1 Worker 端降级

```
场景                              行为
─────────────────────────────────────────────────────────
Server 启动时不可达               自动降级为 standalone，不阻塞启动
Server 运行中不可达               标记 serverReachable=false，继续运行
心跳连续失败                      只标记状态，不重试，不报错
配置同步失败                      返回错误信息给前端，不覆盖本地配置
市场浏览失败                      返回空列表 + "Server 不可达"提示
技能安装中断                      不写入 agent_skills，返回错误
JWT 验证失败                      如果 Worker 在 worker 模式且有活跃 session，
                                  允许继续使用（宽限期 24h）
```

### 11.2 Server 端错误处理

```
场景                              行为
─────────────────────────────────────────────────────────
Worker 心跳超时（90秒）           标记 Worker 为 offline
Worker 重复注册                   更新 endpoint 和 capabilities，不创建新记录
配置版本冲突                      采用最后写入者胜策略（管理员操作，不会并发）
技能提交重复 slug                 拒绝，返回已有技能信息
```

---

## 十二、Worker 端代码总量估算

| 文件 | 类型 | 行数 |
|------|------|------|
| `src/services/hub/types.ts` | 新增 | ~150 |
| `src/services/hub/hub-client.ts` | 新增 | ~400 |
| `src/services/hub/worker-identity.ts` | 新增 | ~100 |
| `src/server/routes/hub.ts` | 新增 | ~400 |
| `src/core/config.ts` | 修改 | +15 |
| `src/main.ts` | 修改 | +30 |
| `src/server/app.ts` | 修改 | +10 |
| 前端（设置页+市场页） | 修改 | ~500 |
| **Worker 端总计** | | **~1605 行** |

Server 端预估代码量：~8000-12000 行（全新项目）
