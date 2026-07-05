# AIE 功能迁移实施计划

> 日期: 2026-04-12
> 状态: 待审核
> 关联设计文档: `specs/2026-04-12-aie-migration-design.md`

---

## 总览

本计划分为 4 个阶段，按依赖关系排序。每个阶段包含多个任务，每个任务标注影响的文件。

```
Phase 1: UI 布局重构 + 面板系统
    ↓
Phase 2: 模型配置升级
    ↓
Phase 3: 定时任务系统
    ↓
Phase 4: 通信渠道系统
```

---

## Phase 1: UI 布局重构 + 面板系统

**目标**: 将功能型入口统一移至右上角 Header，建立内容感知的右侧面板系统。

### Task 1.1: 扩展 UI Store — 面板类型系统

**文件**: `frontend/src/store/ui.ts`

**改动**:
1. 新增 `PanelContentType` 类型:
   ```typescript
   export type PanelContentType = 'sessions' | 'skills' | 'plugins' | 'cron' | 'settings'
   ```
2. 修改 `UIState`:
   - 将 `rightPanelContent: string | null` 改为 `rightPanelContentType: PanelContentType | null`
   - 修改 `openRightPanel(content: string)` 为 `openRightPanel(type: PanelContentType)`
3. 修改 `ViewId` 去掉 `'plugins' | 'settings'`:
   ```typescript
   export type ViewId = 'chat' | 'knowledge' | 'reports' | 'tasks'
   ```
4. 保持 `closeRightPanel` 不变

### Task 1.2: 重构 RightPanel — 内容感知面板

**文件**: `frontend/src/components/layout/RightPanel.tsx`

**改动**:
1. 导入所有面板内容组件（懒加载）:
   - `SessionsPanel` (从现有 Sidebar 会话逻辑提取)
   - `SkillBrowser` (复用现有)
   - `PluginManager` (复用现有)
   - `CronManager` (Phase 3 实现)
   - `SettingsContent` (Phase 2 实现)
2. 根据 `rightPanelContentType` 渲染对应组件
3. 面板宽度根据类型变化:
   ```typescript
   const PANEL_WIDTHS: Record<PanelContentType, number> = {
     sessions: 480,
     skills: 480,
     plugins: 480,
     cron: 560,
     settings: 640,
   }
   ```
4. 每种类型对应不同标题:
   ```typescript
   const PANEL_TITLES: Record<PanelContentType, string> = {
     sessions: '会话历史',
     skills: '技能库',
     plugins: '插件管理',
     cron: '定时任务',
     settings: '设置',
   }
   ```
5. 面板添加拖拽调整宽度功能（可选，参考 AIE）

### Task 1.3: 重构 Header — 添加功能按钮组

**文件**: `frontend/src/components/layout/Header.tsx`

**改动**:
1. 新增图标导入: `History`, `Zap`, `Puzzle`, `Clock`, `Settings`
2. 定义按钮配置:
   ```typescript
   const headerActions = [
     { id: 'sessions', icon: History, title: '会话历史' },
     { id: 'skills', icon: Zap, title: '技能库' },
     { id: 'plugins', icon: Puzzle, title: '插件管理' },
     { id: 'cron', icon: Clock, title: '定时任务' },
     { id: 'settings', icon: Settings, title: '设置' },
   ]
   ```
3. 右侧按钮区域重构为:
   ```
   [模型状态点] [会话] [技能] [插件] [定时] [设置] | [主题]
   ```
   使用分隔线 `|` 分隔功能按钮和主题切换
4. 每个按钮点击 → `useUIStore.getState().openRightPanel(type)`
5. 当前打开的面板按钮显示高亮状态
6. 移除模型状态文字，只保留小圆点（节省空间）

### Task 1.4: 简化 Sidebar — 移除底部导航

**文件**: `frontend/src/components/layout/Sidebar.tsx`

**改动**:
1. 删除 `bottomNavItems` 数组
2. 删除底部 `<nav>` 区域（border-top 部分）
3. 保留主视图导航: Chat, Knowledge, Reports, Tasks
4. 保持会话历史列表在侧边栏中（快捷访问）

### Task 1.5: 调整 ViewRouter

**文件**: `frontend/src/App.tsx`

**改动**:
1. 从 ViewRouter 中移除 `plugins` 和 `settings` case
2. 只保留: `chat`, `knowledge`, `reports`, `tasks`
3. 默认 fallback 改为 `chat`
4. 移除 `PluginManager` 和 `SettingsPanel` 的 lazy import（它们现在在 RightPanel 中）

### Task 1.6: 调整 AppLayout

**文件**: `frontend/src/components/layout/AppLayout.tsx`

**改动**:
1. RightPanel 不再需要 children，改为自包含
2. 如果 RightPanel 已经内部渲染内容，AppLayout 中可以简化

### Task 1.7: 更新 types/index.ts

**文件**: `frontend/src/types/index.ts`

**改动**:
1. 更新 `TabId` 去掉 `'settings'`
2. 更新 `RightPanelId` 改为使用 `PanelContentType`
3. 确保类型一致性

### Task 1.8: 提取会话面板组件

**新增文件**: `frontend/src/components/sessions/SessionsPanel.tsx`

**说明**: 从 Sidebar 中提取会话历史列表逻辑，封装为独立组件，在 RightPanel 的 sessions 模式中使用。Sidebar 中保持简化版的最近会话快捷列表。

---

## Phase 2: 模型配置升级

**目标**: 将设置页改造为带二级导航的综合面板，模型配置支持主模型/辅助模型/嵌入模型/增强模型。

### Task 2.1: 扩展类型定义

**文件**: `frontend/src/types/index.ts`

**改动**:
1. 新增 `ModelRoleConfig` 接口
2. 新增 `EnhancedModelEntry` 接口
3. 新增 `ModelConfig` 接口
4. 扩展 `ProviderDefaults`:
   ```typescript
   interface ProviderDefaults {
     main: string
     summarizer: string    // UI 显示为"辅助模型"
     embedding: string
     vlm: string
   }
   ```
5. 新增 `EnhancedModelType` 联合类型

### Task 2.2: 创建设置面板内容组件

**新增文件**: `frontend/src/components/settings/SettingsContent.tsx`

**说明**: 带二级左侧导航的设置面板内容，在 RightPanel 的 `settings` 模式中渲染。

**结构**:
```
┌──────────────┬──────────────────────────────────┐
│              │                                  │
│  模型        │     对应 Tab 的内容区域            │
│  渠道        │                                  │
│  定时任务    │                                  │
│  通用        │                                  │
│              │                                  │
└──────────────┴──────────────────────────────────┘
```

**实现**:
- 左侧导航: 64px 宽（折叠）/ 120px 宽（展开）
- 4 个 Tab: 模型配置、通信渠道、定时任务、通用设置
- 各 Tab 内容在对应 Task 中实现

### Task 2.3: 创建 ModelsPanel (4-tab 容器)

**新增文件**: `frontend/src/components/settings/ModelsPanel.tsx`

**实现**:
- 4 个子 Tab: 主模型 / 辅助模型 / 嵌入模型 / 增强模型
- Tab 切换使用 underline 风格（与当前 SettingsPanel 风格一致）
- 加载 Provider 列表供子组件使用

### Task 2.4: 创建 ModelConfigCard (可复用组件)

**新增文件**: `frontend/src/components/settings/ModelConfigCard.tsx`

**Props**:
```typescript
interface ModelConfigCardProps {
  title: string
  description?: string
  providerId: string
  model: string
  temperature: number
  maxTokens: number
  enabled: boolean
  showEnable?: boolean
  maxTokensLimit?: number
  providers: ProviderConfig[]
  onConfigChange: (config: ModelCardConfig) => void
  onTest: () => void
  testing?: boolean
  testResult?: { success: boolean; message: string } | null
}
```

**包含**:
- Provider 选择下拉
- 模型名称输入
- 温度滑块 (0-2)
- 最大 Tokens 滑块
- 启用开关（可选）
- 测试连接按钮
- 高级参数折叠区

### Task 2.5: 创建 MainModelConfig

**新增文件**: `frontend/src/components/settings/MainModelConfig.tsx`

**实现**:
- 使用 `ModelConfigCard`
- 额外: 最大迭代滑块 (1-9999)
- 不显示启用开关（主模型始终启用）
- maxTokensLimit: 128000
- 读写 `ProviderDefaults.main`

### Task 2.6: 创建 SubModelConfig

**新增文件**: `frontend/src/components/settings/SubModelConfig.tsx`

**实现**:
- 使用 `ModelConfigCard`
- 显示启用开关（默认关闭）
- 额外: 最大并发滑块 (1-10)
- maxTokensLimit: 8192
- 读写 `ProviderDefaults.summarizer`

### Task 2.7: 创建 EmbeddingModelConfig

**新增文件**: `frontend/src/components/settings/EmbeddingModelConfig.tsx`

**实现**:
- 复用当前嵌入模型配置逻辑
- 卡片式布局
- 选择 Provider → 设置嵌入模型名 → 测试
- 读写 `ProviderDefaults.embedding`

### Task 2.8: 创建 EnhancedModelsConfig

**新增文件**: `frontend/src/components/settings/EnhancedModelsConfig.tsx`

**实现**:
- 按模型类型过滤的标签栏 (multimodal/image_gen/video_gen/...)
- 模型列表 (卡片式)
- 新增/编辑/删除模型
- 每个模型: Provider + 模型名 + 描述 + 能力标签 + 优先级 + 启用开关
- 编辑使用 Modal 弹窗

### Task 2.9: 重构现有 SettingsPanel

**文件**: `frontend/src/components/settings/SettingsPanel.tsx`

**改动**:
- 将通用设置 (主题、Agent 参数、关于) 整合为新的 `GeneralPanel` 组件
- 旧 SettingsPanel 中的模型配置逻辑迁移到新的 ModelsPanel 组件
- 旧 SettingsPanel 可以删除或改造为 `GeneralPanel`

### Task 2.10: 扩展后端 Settings API

**文件**: `src/server/routes/settings.ts`, `src/store/settings.ts`

**改动**:
1. `SettingsStore` 新增方法:
   - `getEnhancedModels(): EnhancedModelEntry[]`
   - `saveEnhancedModels(models: EnhancedModelEntry[]): void`
   - `getModelConfig(): ModelConfig`
   - `saveModelConfig(config: ModelConfig): void`
2. 路由新增:
   - `GET /api/settings/enhanced-models` — 获取增强模型列表
   - `PUT /api/settings/enhanced-models` — 保存增强模型列表
   - `GET /api/settings/model-config` — 获取完整模型配置
   - `PUT /api/settings/model-config` — 保存完整模型配置

### Task 2.11: 扩展 ModelRouter

**文件**: `src/models/router.ts`

**改动**:
1. 新增 `getEnhancedModel(modelType: string): ModelProvider | null`
2. 新增 `listEnhancedModels(): EnhancedModelEntry[]`
3. `reload()` 方法增加加载增强模型配置的逻辑
4. 扩展 `dbDefaults` 支持增强模型默认值

### Task 2.12: 扩展 API Client

**文件**: `frontend/src/api/client.ts`

**新增方法**:
```typescript
getEnhancedModels(): Promise<EnhancedModelEntry[]>
saveEnhancedModels(models: EnhancedModelEntry[]): Promise<void>
getModelConfig(): Promise<ModelConfig>
saveModelConfig(config: ModelConfig): Promise<void>
```

---

## Phase 3: 定时任务系统

**目标**: 实现完整的定时任务管理，包括后端调度器和前端管理界面。

### Task 3.1: 数据库迁移 — cron_jobs 表

**新增文件**: `src/store/migrations/006_cron_jobs.ts`

**实现**:
```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  message TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  channel TEXT,
  chat_id TEXT,
  deliver_response INTEGER DEFAULT 0,
  last_run TEXT,
  next_run TEXT,
  last_status TEXT,
  last_error TEXT,
  run_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX idx_cron_jobs_next_run ON cron_jobs(next_run);
```

**修改文件**: `src/store/database.ts` — 注册 006 迁移

### Task 3.2: 后端 Cron 类型定义

**新增文件**: `src/services/cron/types.ts`

**定义**:
```typescript
interface CronJob {
  id: string
  name: string
  schedule: string
  message: string
  enabled: boolean
  channel: string | null
  chatId: string | null
  deliverResponse: boolean
  lastRun: string | null
  nextRun: string | null
  lastStatus: string | null
  lastError: string | null
  runCount: number
  errorCount: number
  createdAt: string
  updatedAt: string
}

interface CreateCronJobRequest {
  name: string
  schedule: string
  message: string
  enabled?: boolean
  channel?: string | null
  chatId?: string | null
  deliverResponse?: boolean
}

interface UpdateCronJobRequest extends Partial<CreateCronJobRequest> {}

interface CronJobDetail extends CronJob {
  lastResponse: string | null
}
```

### Task 3.3: 后端 CronService — CRUD 服务

**新增文件**: `src/services/cron/service.ts`

**实现**:
- 依赖 `DB` (better-sqlite3) 直接操作 `cron_jobs` 表
- 使用 `cron-parser` 库解析和验证 cron 表达式
- `calculateNextRun()` 计算下次执行时间
- CRUD 操作使用 prepared statements
- 执行操作触发 Agent 系统的 `chat` 接口

### Task 3.4: 后端 CronScheduler — 调度器

**新增文件**: `src/services/cron/scheduler.ts`

**实现**:
- 单例模式，懒初始化
- `start()`: 启动 1 分钟间隔的检查循环
- 每次检查: 查询 `next_run <= now AND enabled = true` 的任务
- 并发控制: 最多 3 个同时执行
- 任务执行: 调用 Agent 系统发送 message
- 执行完成后更新 `run_count`, `last_status`, `last_run`, `next_run`
- 失败时更新 `error_count`, `last_error`
- 超时控制: 300 秒
- 手动执行: `executeJob(id)` 不受 cron 调度影响

### Task 3.5: 后端 Cron API 路由

**新增文件**: `src/server/routes/cron.ts`

**路由**:
- `GET /api/cron/jobs` — 列出所有任务
- `GET /api/cron/jobs/:id` — 获取任务详情
- `POST /api/cron/jobs` — 创建任务
- `PUT /api/cron/jobs/:id` — 更新任务
- `DELETE /api/cron/jobs/:id` — 删除任务
- `POST /api/cron/jobs/:id/run` — 手动执行
- `POST /api/cron/validate` — 验证 cron 表达式

### Task 3.6: 挂载 Cron 路由

**文件**: `src/server/app.ts`

**改动**:
- 新增 `/api/cron/*` 路由，使用与 plugins/agents 相同的懒初始化模式
- 导入 `createCronRoutes`

### Task 3.7: 前端 Cron 类型定义

**新增文件**: `frontend/src/types/cron.ts`

**定义**: `CronJob`, `CreateCronJobRequest`, `UpdateCronJobRequest`, `CronJobDetail`

### Task 3.8: 前端 Cron Store

**新增文件**: `frontend/src/store/cron.ts`

**实现**:
```typescript
interface CronState {
  jobs: CronJob[]
  loading: boolean
  error: string | null
  loadJobs(): Promise<void>
  createJob(data: CreateCronJobRequest): Promise<string>
  updateJob(id: string, data: UpdateCronJobRequest): Promise<void>
  deleteJob(id: string): Promise<void>
  executeJob(id: string): Promise<void>
  toggleJob(id: string, enabled: boolean): Promise<void>
}
```

### Task 3.9: 前端 API Client — Cron 方法

**文件**: `frontend/src/api/client.ts`

**新增**:
- `listCronJobs()`, `getCronJob(id)`, `createCronJob(data)`
- `updateCronJob(id, data)`, `deleteCronJob(id)`
- `executeCronJob(id)`, `validateCron(schedule)`

### Task 3.10: 前端 CronBuilder 组件

**新增文件**: `frontend/src/components/cron/CronBuilder.tsx`

**实现**:
- 双模式切换: 简易 / 高级
- 简易模式: 频率选择 + 参数配置
  - 每分钟: 间隔选择 (1/2/3/5/10/15/20/30)
  - 每小时: 第几分钟 (0-59)
  - 每天: 几点几分
  - 每周: 星期几 + 几点几分
  - 每月: 几号 + 几点几分
- 高级模式: 直接输入 cron 表达式 (5 段)
- 预设快捷按钮: 每5分钟、每小时、每天9点、每周一9点、每月1号
- 人类可读描述显示
- 验证错误提示

### Task 3.11: 前端 JobEditor 组件

**新增文件**: `frontend/src/components/cron/JobEditor.tsx`

**实现**:
- Modal 弹窗表单
- 字段: 名称、调度(CronBuilder)、消息(textarea)、投递渠道(可选)、启用开关
- 表单验证
- 创建/编辑双模式

### Task 3.12: 前端 JobCard 组件

**新增文件**: `frontend/src/components/cron/JobCard.tsx`

**实现**:
- 卡片展示: 名称、cron 表达式 badge、描述、执行统计
- 上次/下次执行时间
- 操作按钮: 执行、编辑、删除、启用/禁用开关
- 可展开详情: 上次执行结果、错误信息

### Task 3.13: 前端 CronManager 主面板

**新增文件**: `frontend/src/components/cron/CronManager.tsx`

**实现**:
- 顶部统计栏 + 创建按钮
- 任务列表 (使用 JobCard)
- 空状态、加载状态、错误状态
- 嵌入 JobEditor Modal

### Task 3.14: 集成 CronManager 到设置面板

**文件**: `frontend/src/components/settings/SettingsContent.tsx`

**改动**:
- 在设置面板的"定时任务"Tab 中渲染 `CronManager`
- 或者直接在 RightPanel 的 `cron` 类型中渲染 `CronManager`（需要确认入口位置）

**决策**: 定时任务同时有两个入口:
1. Header 直接点击定时任务按钮 → RightPanel 显示 CronManager
2. 设置面板内的定时任务 Tab → 同样显示 CronManager

两种方式复用同一个 `CronManager` 组件。

---

## Phase 4: 通信渠道系统

**目标**: 实现 6 种通信渠道的管理界面和后端服务。

### Task 4.1: 后端渠道类型定义

**新增文件**: `src/services/channels/types.ts`

**定义**:
```typescript
interface ChannelConfig {
  enabled: boolean
  [key: string]: unknown  // 各渠道特有字段
}

interface FeishuConfig extends ChannelConfig {
  app_id: string
  app_secret: string
  verification_token?: string
  encrypt_key?: string
  allow_from?: string[]
}

// DingTalkConfig, WeChatConfig, QQConfig, TelegramConfig, DiscordConfig 类似

interface ChannelInfo {
  id: string
  name: string
  description: string
  icon: string
  enabled: boolean
  configured: boolean
  running: boolean
}

interface ChannelStatus {
  enabled: boolean
  running: boolean
  displayName: string
}
```

### Task 4.2: 后端 ChannelBase 接口

**新增文件**: `src/services/channels/channel-base.ts`

**定义**:
```typescript
interface IChannel {
  readonly channelId: string
  readonly name: string

  start(): Promise<void>
  stop(): Promise<void>
  testConnection(): Promise<{ success: boolean; message: string }>
  sendMessage(chatId: string, message: string): Promise<void>
  isRunning(): boolean
}
```

### Task 4.3: 后端 ChannelManager

**新增文件**: `src/services/channels/channel-manager.ts`

**实现**:
- 管理所有渠道实例的生命周期
- 配置从 `settings` 表的 `channels` 键加载
- 各渠道实例懒创建
- `testConnection` 支持传入临时配置（不保存）
- 配置更新时自动重启相关渠道

### Task 4.4: 后端各渠道实现

**新增文件**:
- `src/services/channels/feishu.ts`
- `src/services/channels/dingtalk.ts`
- `src/services/channels/wechat.ts`
- `src/services/channels/qq.ts`
- `src/services/channels/telegram.ts`
- `src/services/channels/discord.ts`

**实现策略**:
- 第一版: 骨架实现 + testConnection
  - `start()` / `stop()` 返回成功
  - `testConnection()` 验证配置有效性（调用平台 API 验证 token）
  - `sendMessage()` 返回 not-implemented
- 后续迭代: 逐步实现消息收发、webhook 等

**飞书 testConnection**:
```typescript
async testConnection() {
  // POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
  // body: { app_id, app_secret }
  // 验证返回的 tenant_access_token
}
```

**钉钉 testConnection**:
```typescript
async testConnection() {
  // POST https://api.dingtalk.com/v1.0/oauth2/accessToken
  // body: { appKey: client_id, appSecret: client_secret }
}
```

**Telegram testConnection**:
```typescript
async testConnection() {
  // GET https://api.telegram.org/bot{token}/getMe
}
```

**Discord testConnection**:
```typescript
async testConnection() {
  // GET https://discord.com/api/v10/users/@me
  // Authorization: Bot {token}
}
```

### Task 4.5: 后端 Channels API 路由

**新增文件**: `src/server/routes/channels.ts`

**路由**:
- `GET /api/channels/list` — 列出所有渠道（脱敏）
- `GET /api/channels/:id/config` — 获取完整配置
- `POST /api/channels/update` — 更新配置
- `POST /api/channels/test` — 测试连接
- `POST /api/channels/:id/start` — 启动渠道
- `POST /api/channels/:id/stop` — 停止渠道
- `GET /api/channels/status` — 运行状态

### Task 4.6: 挂载 Channels 路由

**文件**: `src/server/app.ts`

**改动**:
- 新增 `/api/channels/*` 路由，使用懒初始化模式

### Task 4.7: 前端渠道类型定义

**新增文件**: `frontend/src/types/channels.ts`

### Task 4.8: 前端 Channels Store

**新增文件**: `frontend/src/store/channels.ts`

**实现**:
```typescript
interface ChannelsState {
  channels: Record<string, ChannelConfig>
  status: Record<string, ChannelStatus>
  loading: boolean
  error: string | null
  fetchChannels(): Promise<void>
  fetchStatus(): Promise<void>
  updateConfig(id: string, config: ChannelConfig): Promise<void>
  testChannel(id: string, config?: ChannelConfig): Promise<TestResult>
  startChannel(id: string): Promise<void>
  stopChannel(id: string): Promise<void>
}
```

### Task 4.9: 前端 API Client — Channels 方法

**文件**: `frontend/src/api/client.ts`

**新增**: 7 个渠道相关 API 方法

### Task 4.10: 前端 ChannelCard 组件

**新增文件**: `frontend/src/components/channels/ChannelCard.tsx`

**实现**:
- 卡片头部: 渠道图标 + 名称 + 状态灯 + 启用开关
- 展开/折叠
- 展开后显示配置表单 + 测试按钮

### Task 4.11: 前端各渠道配置表单

**新增文件**:
- `frontend/src/components/channels/FeishuConfig.tsx`
- `frontend/src/components/channels/DingTalkConfig.tsx`
- `frontend/src/components/channels/WeChatConfig.tsx`
- `frontend/src/components/channels/QQConfig.tsx`
- `frontend/src/components/channels/TelegramConfig.tsx`
- `frontend/src/components/channels/DiscordConfig.tsx`

每个表单:
- 对应渠道特有的配置字段
- 密码字段使用 type="password"
- 测试连接按钮
- 保存按钮

### Task 4.12: 前端 ChannelsPanel 主面板

**新增文件**: `frontend/src/components/channels/ChannelsPanel.tsx`

**实现**:
- 顶部统计栏: 已启用数 / 运行中数
- 渠道卡片列表 (使用 ChannelCard)
- 每个 ChannelCard 内嵌对应渠道的配置表单
- 渠道按推荐顺序排列: 飞书、钉钉、微信、QQ、Telegram、Discord

### Task 4.13: 集成渠道面板到设置

**文件**: `frontend/src/components/settings/SettingsContent.tsx`

**改动**:
- 在设置面板的"通信渠道"Tab 中渲染 `ChannelsPanel`

---

## 任务依赖关系

```
Phase 1 (全部任务) 是所有后续 Phase 的前提

Phase 2 依赖:
  Task 2.1 (类型) → Task 2.2 (SettingsContent) → Task 2.3 (ModelsPanel)
  Task 2.4 (ModelConfigCard) → Task 2.5, 2.6, 2.7 (三个模型配置)
  Task 2.8 (EnhancedModels) 独立
  Task 2.10, 2.11 (后端) 可与前端并行
  Task 2.12 (API client) 依赖 Task 2.1

Phase 3 依赖:
  Task 3.1 (migration) → Task 3.2 (types) → Task 3.3 (service) → Task 3.4 (scheduler)
  Task 3.5 (API routes) 依赖 3.3, 3.4
  Task 3.6 (挂载) 依赖 3.5
  前端 Task 3.7-3.13 可与后端并行
  Task 3.14 (集成) 依赖 3.13

Phase 4 依赖:
  Task 4.1 (types) → Task 4.2 (base) → Task 4.3 (manager)
  Task 4.4 (各渠道) 依赖 4.2
  Task 4.5 (API routes) 依赖 4.3, 4.4
  Task 4.6 (挂载) 依赖 4.5
  前端 Task 4.7-4.12 可与后端并行
  Task 4.13 (集成) 依赖 4.12
```

---

## 验收标准

### Phase 1 验收
- [ ] Header 右上角显示 5 个功能按钮 + 主题切换
- [ ] 点击各按钮打开右侧滑出面板
- [ ] 面板宽度根据内容类型自适应
- [ ] 侧边栏不再显示插件导航项
- [ ] 主视图切换 (Chat/Knowledge/Reports/Tasks) 正常工作
- [ ] 会话面板在右侧面板中可正常浏览和切换会话
- [ ] 主题切换正常
- [ ] 响应式布局在移动端正常

### Phase 2 验收
- [ ] 设置面板内部有二级导航 (模型/渠道/定时/通用)
- [ ] 主模型配置: 选择 Provider + 设置参数 + 测试连接 + 设为默认
- [ ] 辅助模型配置: 可启用/禁用 + 选择 Provider + 设置参数
- [ ] 嵌入模型配置: 选择 Provider + 模型名 + 测试
- [ ] 增强模型: 按类型筛选、新增/编辑/删除模型条目
- [ ] Agent 设置 (通用 Tab): 所有参数可调
- [ ] 主题设置 (通用 Tab): 正常切换
- [ ] 模型配置变更后 ModelRouter 自动重新加载
- [ ] 现有 Agent 功能不受影响

### Phase 3 验收
- [ ] 可以创建定时任务 (名称 + cron + 提示词)
- [ ] CronBuilder 简易模式和高级模式切换正常
- [ ] cron 表达式验证正确
- [ ] 定时任务列表显示正确（名称、调度、状态、统计）
- [ ] 启用/禁用任务正常
- [ ] 手动执行任务正常
- [ ] 编辑/删除任务正常
- [ ] 后端调度器按时触发任务
- [ ] 任务执行后状态正确更新

### Phase 4 验收
- [ ] 渠道列表显示 6 种渠道及状态
- [ ] 每个渠道的配置表单字段正确
- [ ] 测试连接功能正常 (飞书/钉钉/Telegram/Discord 至少可验证 token)
- [ ] 保存配置正常
- [ ] 启用/禁用渠道正常
- [ ] 启动/停止渠道正常
- [ ] 敏感信息在列表视图中脱敏显示
- [ ] 未配置的渠道不影响系统运行
