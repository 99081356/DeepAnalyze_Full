# AIE 功能迁移设计文档

> 日期: 2026-04-12
> 状态: 待审核
> 范围: 从 AIE (refcode/AIE) 迁移关键功能和 UI 模式到 DeepAnalyze

---

## 1. 项目背景与目标

### 1.1 当前问题

DeepAnalyze 的前端界面存在以下问题:

1. **功能入口分散** — 插件管理在左下角，设置在右上角齿轮按钮，技能在插件页内二级 tab，没有统一的功能入口模式
2. **设置页简陋** — 只有基础的 Provider 列表管理，缺少辅助模型配置、增强模型管理、通信渠道、定时任务等
3. **模型配置不完善** — 只有简单的 Provider CRUD + 角色默认值，没有类似 AIE 的结构化模型配置（主模型/辅助模型/嵌入模型/增强模型）
4. **缺少定时任务系统** — 无法创建和管理周期性自动任务
5. **缺少通信渠道** — 不支持与飞书、钉钉、Telegram 等平台互联

### 1.2 迁移目标

| 功能 | 来源 | 目标 |
|------|------|------|
| Header 功能按钮组 | AIE ChatWindow headerActions | DeepAnalyze Header |
| 右侧滑出面板系统 | AIE ChatWindow panel system | DeepAnalyze RightPanel |
| 结构化模型配置 | AIE ModelsPanel (4 tabs) | DeepAnalyze SettingsPanel |
| 通信渠道管理 | AIE ChannelsConfig + 后端 | DeepAnalyze 新增模块 |
| 定时任务系统 | AIE CronManager + 后端 | DeepAnalyze 新增模块 |
| 技能库独立入口 | AIE Skills panel | DeepAnalyze Header 按钮 |

### 1.3 不在范围内

- 安全选项配置（以后再做）
- 工作区配置（不需要）
- AI 人格/性格配置（AIE 特有，不迁移）
- 心跳系统（AIE 特有，不迁移）

---

## 2. 模型体系映射设计

### 2.1 角色映射表

AIE 和 DeepAnalyze 的模型角色对应关系:

| AIE 角色 | DeepAnalyze 角色 | UI 显示名 | ModelRouter role | 用途 |
|----------|-----------------|-----------|-----------------|------|
| MainAgent (主模型) | main (主模型) | 主模型 | `main` | 主要对话、通用分析 |
| SubAgent (子模型) | summarizer (总结模型) | 辅助模型 | `summarizer` | 文档编译、摘要生成等轻量任务 |
| Embedder (嵌入模型) | embedding (嵌入模型) | 嵌入模型 | `embedding` | 文档向量化、相似度搜索 |
| EnhancedModels (增强模型) | vlm + 扩展 | 增强模型 | `vlm` + 自定义 | 多模态理解、图像/视频/音频生成等 |

### 2.2 模型配置数据结构

#### 后端 TypeScript 接口 (扩展 `ProviderConfig`)

```typescript
// 当前 DeepAnalyze 的 ProviderConfig 保持不变，作为底层 Provider 实例

// 新增：模型角色配置（引用 Provider 实例）
interface ModelRoleConfig {
  role: 'main' | 'summarizer' | 'embedding' | 'vlm'
  providerId: string      // 引用 ProviderConfig.id
  model: string           // 覆盖 Provider 默认模型名
  temperature?: number
  maxTokens?: number
  enabled: boolean
}

// 新增：增强模型条目
interface EnhancedModelEntry {
  id: string
  modelType: 'multimodal' | 'image_gen' | 'video_gen' | 'music_gen' | 'audio_gen' | 'three_d_gen' | 'custom'
  name: string
  description: string
  providerId: string
  model: string
  enabled: boolean
  capabilities: string[]
  priority: number        // 0-100
  temperature?: number
  maxTokens?: number
}

// settings 表中 'model_config' 键的值结构
interface ModelConfig {
  roles: ModelRoleConfig[]
  enhancedModels: EnhancedModelEntry[]
}
```

#### 前端设置页 Tab 结构

```
设置 (Settings)
├── 模型配置 (Models)
│   ├── 主模型 (Main)       — 选择 Provider + 模型参数
│   ├── 辅助模型 (Sub)      — 可启用/禁用，选择 Provider + 模型参数
│   ├── 嵌入模型 (Embedding) — 嵌入模型配置
│   └── 增强模型 (Enhanced) — 增强模型列表管理
├── 通信渠道 (Channels)
│   ├── 飞书 (Feishu)
│   ├── 钉钉 (DingTalk)
│   ├── 微信 (WeChat)
│   ├── QQ
│   ├── Telegram
│   └── Discord
├── 定时任务 (Cron)
│   └── 任务列表 + 创建/编辑
└── 通用 (General)
    └── Agent 设置 + 主题 + 关于
```

---

## 3. UI 布局重构设计

### 3.1 Header 重构

**当前布局:**
```
[Logo "D" + "DeepAnalyze"]  [搜索栏]  [模型状态] [主题] [设置齿轮]
```

**目标布局:**
```
[Logo + "DeepAnalyze"]  [搜索栏]  [会话历史] [技能库] [插件] [定时任务] [设置] [主题]
```

Header 右侧按钮从 3 个扩展到 7 个，所有功能型入口统一在右上角。

#### 按钮定义

| 按钮 | 图标 | 行为 |
|------|------|------|
| 会话历史 | `History` | 打开右侧面板，显示会话列表 |
| 技能库 | `Zap` | 打开右侧面板，显示技能浏览器 |
| 插件管理 | `Puzzle` | 打开右侧面板，显示插件管理 |
| 定时任务 | `Clock` | 打开右侧面板，显示定时任务管理 |
| 设置 | `Settings` | 打开右侧面板，显示设置面板 |
| 主题切换 | `Sun`/`Moon` | 切换主题（不打开面板） |

#### 模型状态指示

模型健康状态从 Header 中移除（或缩小为一个小圆点在 Logo 旁边），避免 Header 过于拥挤。

### 3.2 Sidebar 简化

**移除底部插件入口**，侧边栏只保留:

```
[+新建对话]
会话历史 (仅 chat 视图显示)
─────────
工作区
  对话 (Chat)
  知识库 (Knowledge)
  报告 (Reports)
  任务 (Tasks)
```

`bottomNavItems` 数组清空或删除。

### 3.3 RightPanel 增强

当前 `RightPanel` 只渲染 `children`，需要改造为 **内容感知面板**:

#### 面板内容类型

```typescript
type PanelContentType =
  | 'sessions'     // 会话历史列表
  | 'skills'       // 技能浏览器
  | 'plugins'      // 插件管理器
  | 'cron'         // 定时任务管理
  | 'settings'     // 设置面板
```

#### 面板宽度

- 默认宽度: `480px`（从当前 400px 增加）
- 设置面板: `640px`（设置内容更宽）
- 最小宽度: `380px`
- 最大宽度: `1200px`

#### 面板内部结构

```
┌─────────────────────────────────────────┐
│ [标题]                           [关闭] │
├─────────────────────────────────────────┤
│                                         │
│  根据 panelContentType 渲染对应组件      │
│                                         │
└─────────────────────────────────────────┘
```

设置面板内部有二级侧边导航（类似 AIE）:

```
┌────────────────────────────────────────────────────────┐
│ 设置                                            [关闭] │
├────────┬───────────────────────────────────────────────┤
│ 模型   │                                               │
│ 渠道   │  对应的配置内容区域                              │
│ 定时   │                                               │
│ 通用   │                                               │
└────────┴───────────────────────────────────────────────┘
```

### 3.4 ViewRouter 调整

从 ViewRouter 中移除 `plugins` 和 `settings` 视图:

```typescript
// 当前 ViewId: 'chat' | 'knowledge' | 'reports' | 'tasks' | 'plugins' | 'settings'
// 改为 ViewId: 'chat' | 'knowledge' | 'reports' | 'tasks'
```

插件和设置不再作为主视图，而是通过 RightPanel 打开。

---

## 4. 模型配置页详细设计

### 4.1 主模型配置

UI 元素:
- **Provider 选择** — 下拉选择已配置的 Provider 实例
- **模型名称** — 文本输入（默认值从 Provider 获取）
- **温度** — 滑块 (0.0 - 2.0, 步长 0.1, 默认 0.7)
- **最大 Tokens** — 滑块 (0 - 128000, 默认 4096)
- **最大迭代** — 滑块 (1 - 9999, 默认 50)
- **测试连接** — 按钮，调用 `POST /api/settings/providers/:id/test`
- **设为默认主模型** — 按钮，更新 defaults.main

### 4.2 辅助模型配置

在主模型基础上增加:
- **启用/禁用** — 开关（默认关闭）
- **最大并发** — 滑块 (1 - 10, 默认 3)

映射到当前 `summarizer` 角色。后端 `ModelRouter` 中 `summarizer` 已有路由逻辑。

### 4.3 嵌入模型配置

复用当前嵌入模型 Tab 的逻辑，但改为卡片式布局:
- 选择已配置的 Provider 作为嵌入模型 Provider
- 设置专用嵌入模型名
- 测试连接

### 4.4 增强模型管理

列表式管理，按模型类型分类:

| 类型 | 图标 | 说明 |
|------|------|------|
| multimodal | `Image` | 多模态理解（VLM） |
| image_gen | `Sparkles` | 图像生成 |
| video_gen | `Video` | 视频生成 |
| music_gen | `Music` | 音乐生成 |
| audio_gen | `Headphones` | 音频生成/语音合成 |
| three_d_gen | `Box` | 3D 生成 |
| custom | `Settings` | 自定义类型 |

每个增强模型条目:
- 名称、描述
- Provider 选择 + 模型名
- 能力标签
- 优先级 (0-100)
- 启用/禁用
- 编辑/删除

后端实现:
- 增强模型存储在 `settings` 表的 `enhanced_models` 键中
- `ModelRouter` 扩展 `getDefaultModel()` 支持 `modelType` 参数
- 新增 `getEnhancedModel(modelType: string)` 方法

### 4.5 设置页数据流

```
用户操作 → 组件本地 state
  → debounce 300ms → api.saveProvider() / api.saveDefaults()
  → 后端 SettingsStore 写入 SQLite
  → ModelRouter.reload() 重新加载配置
```

所有模型配置共享已配置的 Provider 列表，不需要在模型配置中重复输入 API Key/Endpoint。

---

## 5. 通信渠道详细设计

### 5.1 渠道类型与配置字段

| 渠道 | 必需字段 | 可选字段 |
|------|---------|---------|
| **飞书** | app_id, app_secret | verification_token, encrypt_key, allow_from[] |
| **钉钉** | client_id, client_secret | robot_code, allow_from[] |
| **微信** | token, encoding_aes_key, app_id, app_secret | allow_from[] |
| **QQ** | app_id, app_secret, token | intents[], allow_from[] |
| **Telegram** | token | allow_from[], api_base |
| **Discord** | token, application_id | guild_id, allow_from[] |

### 5.2 后端架构

```
src/services/channels/
├── types.ts              — 渠道配置接口定义
├── channel-manager.ts    — 渠道生命周期管理
├── channel-base.ts       — 渠道基类/接口
├── feishu.ts             — 飞书渠道实现
├── dingtalk.ts           — 钉钉渠道实现
├── wechat.ts             — 微信渠道实现
├── qq.ts                 — QQ 渠道实现
├── telegram.ts           — Telegram 渠道实现
└── discord.ts            — Discord 渠道实现
```

#### ChannelManager

```typescript
class ChannelManager {
  private channels: Map<string, ChannelInstance>
  private configs: Map<string, ChannelConfig>

  // 生命周期
  async startChannel(channelId: string): Promise<void>
  async stopChannel(channelId: string): Promise<void>
  async restartChannel(channelId: string): Promise<void>

  // 配置
  async updateConfig(channelId: string, config: ChannelConfig): Promise<void>
  async getConfig(channelId: string): Promise<ChannelConfig>
  async listChannels(): Promise<ChannelInfo[]>

  // 状态
  async getStatus(): Promise<Record<string, ChannelStatus>>
  async testConnection(channelId: string, tempConfig?: ChannelConfig): Promise<TestResult>

  // 消息发送
  async sendMessage(channelId: string, chatId: string, message: string): Promise<void>
}
```

### 5.3 API 路由设计

```
GET    /api/channels/list            — 列出所有渠道（脱敏配置）
GET    /api/channels/:id/config      — 获取单个渠道完整配置
POST   /api/channels/update          — 更新渠道配置
POST   /api/channels/test            — 测试渠道连接
POST   /api/channels/:id/start       — 启动渠道
POST   /api/channels/:id/stop        — 停止渠道
GET    /api/channels/status          — 获取所有渠道运行状态
```

### 5.4 数据库存储

渠道配置存储在 `settings` 表中，key 为 `channels`:

```json
{
  "feishu": { "enabled": false, "app_id": "", "app_secret": "", ... },
  "dingtalk": { "enabled": false, "client_id": "", "client_secret": "", ... },
  "wechat": { "enabled": false, "token": "", "app_id": "", ... },
  "qq": { "enabled": false, "app_id": "", "app_secret": "", ... },
  "telegram": { "enabled": false, "token": "", ... },
  "discord": { "enabled": false, "token": "", "application_id": "", ... }
}
```

### 5.5 前端组件结构

```
frontend/src/components/channels/
├── ChannelsPanel.tsx         — 渠道管理主面板
├── ChannelCard.tsx           — 单个渠道卡片（可展开）
├── FeishuConfig.tsx          — 飞书配置表单
├── DingTalkConfig.tsx        — 钉钉配置表单
├── WeChatConfig.tsx          — 微信配置表单
├── QQConfig.tsx              — QQ 配置表单
├── TelegramConfig.tsx        — Telegram 配置表单
└── DiscordConfig.tsx         — Discord 配置表单
```

每个渠道卡片:
- 头部: 渠道图标 + 名称 + 运行状态指示灯 + 启用开关
- 展开区域: 配置表单 + 测试按钮 + 保存按钮

---

## 6. 定时任务系统详细设计

### 6.1 数据模型

新增 `cron_jobs` 表:

```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,           -- cron 表达式 (5段)
  message TEXT NOT NULL,            -- 要执行的提示词
  enabled INTEGER NOT NULL DEFAULT 1,
  channel TEXT DEFAULT NULL,        -- 投递渠道 (null = 仅本地执行)
  chat_id TEXT DEFAULT NULL,        -- 渠道中的目标会话 ID
  deliver_response INTEGER DEFAULT 0, -- 是否投递执行结果
  last_run TEXT,                    -- 上次执行时间 (ISO 8601)
  next_run TEXT,                    -- 下次执行时间 (ISO 8601)
  last_status TEXT,                 -- success / failed / timeout
  last_error TEXT,                  -- 上次错误信息
  run_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 6.2 后端架构

```
src/services/cron/
├── types.ts              — CronJob 接口、DTO 定义
├── scheduler.ts          — 定时调度器核心
└── service.ts            — CRUD 服务层
```

#### CronScheduler

```typescript
class CronScheduler {
  private running: boolean
  private timer: NodeJS.Timeout | null
  private activeJobs: Set<string>
  private maxConcurrent: number  // 默认 3

  // 生命周期
  start(): void
  stop(): void

  // 调度
  recomputeNextRuns(): void      // 重算所有启用任务的下次执行时间
  triggerReschedule(): void      // 手动触发重新调度

  // 查询
  isJobActive(jobId: string): boolean
}
```

**调度策略:**
- 使用 `setInterval` 每分钟检查一次是否有任务到期
- 到期任务通过 Agent 系统 `runSkill` 或直接 `chat` 执行
- 信号量控制最大并发数 (默认 3)
- 单任务超时 300 秒

**执行流程:**
```
Timer tick → 获取到期任务 → 信号量控制并发
  → 执行 Agent chat (message 作为输入)
  → 更新 run_count / last_status / last_run
  → 如果指定了 channel + deliver_response → 通过 ChannelManager 发送结果
  → 重算 next_run
```

#### CronService

```typescript
class CronService {
  // CRUD
  createJob(data: CreateCronJobRequest): Promise<CronJob>
  updateJob(id: string, data: UpdateCronJobRequest): Promise<CronJob>
  deleteJob(id: string): Promise<void>
  getJob(id: string): Promise<CronJob | null>
  listJobs(): Promise<CronJob[]>

  // 执行
  executeJob(id: string): Promise<JobResult>

  // 工具方法
  validateSchedule(schedule: string): boolean
  calculateNextRun(schedule: string): Date
  describeSchedule(schedule: string): string  // 人类可读描述
}
```

### 6.3 API 路由设计

```
GET    /api/cron/jobs              — 列出所有定时任务
GET    /api/cron/jobs/:id          — 获取单个任务详情
POST   /api/cron/jobs              — 创建定时任务
PUT    /api/cron/jobs/:id          — 更新定时任务
DELETE /api/cron/jobs/:id          — 删除定时任务
POST   /api/cron/jobs/:id/run      — 手动执行一次
POST   /api/cron/validate          — 验证 cron 表达式
```

### 6.4 前端组件结构

```
frontend/src/components/cron/
├── CronManager.tsx          — 定时任务管理主面板
├── JobEditor.tsx            — 创建/编辑任务表单 (Modal)
├── CronBuilder.tsx          — cron 表达式可视化构建器
└── JobCard.tsx              — 单个任务卡片
```

#### CronManager

- 顶部: 统计栏 (总任务数 / 已启用数) + 创建按钮
- 任务列表: 卡片式排列
- 每个任务卡片:
  - 名称 + cron 表达式 + 人类可读描述
  - 启用/禁用开关
  - 执行统计 (成功次数 / 总次数)
  - 上次/下次执行时间
  - 操作: 手动执行、编辑、删除
  - 可展开详情: 上次执行结果、错误信息

#### JobEditor (Modal)

表单字段:
1. 任务名称 (必填)
2. Cron 调度 (必填) — CronBuilder 组件
3. 执行消息/提示词 (必填, textarea)
4. 投递到渠道 (可选) — 勾选后显示:
   - 渠道选择 (下拉)
   - 目标会话 ID (文本输入)
5. 创建后启用 (checkbox, 默认勾选)

#### CronBuilder

双模式切换:
- **简易模式** — 频率选择 (每分钟/每小时/每天/每周/每月) + 具体参数
- **高级模式** — 直接输入 5 段 cron 表达式
- **预设快捷** — 每5分钟、每小时、每天9点、每周一等

### 6.5 Cron 表达式解析

使用轻量级 cron 解析库（如 `cron-parser`）:
- 验证表达式有效性
- 计算下次执行时间
- 生成人类可读描述

---

## 7. 状态管理变更

### 7.1 UI Store 扩展

```typescript
// 新增 PanelContentType
type PanelContentType =
  | 'sessions'
  | 'skills'
  | 'plugins'
  | 'cron'
  | 'settings'

// UIState 新增字段
interface UIState {
  // ... 现有字段保持
  rightPanelContentType: PanelContentType | null  // 替代 rightPanelContent: string
}
```

### 7.2 新增 Store: CronStore

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

### 7.3 新增 Store: ChannelsStore

```typescript
interface ChannelsState {
  channels: Record<string, ChannelConfig>
  status: Record<string, ChannelStatus>
  loading: boolean
  error: string | null

  fetchChannels(): Promise<void>
  fetchStatus(): Promise<void>
  updateConfig(channelId: string, config: ChannelConfig): Promise<void>
  testChannel(channelId: string, config?: ChannelConfig): Promise<TestResult>
  startChannel(channelId: string): Promise<void>
  stopChannel(channelId: string): Promise<void>
}
```

---

## 8. API Client 扩展

### 8.1 新增 API 方法

**Cron 相关 (7 个):**
```typescript
listCronJobs(): Promise<CronJob[]>
getCronJob(id: string): Promise<CronJobDetail>
createCronJob(data: CreateCronJobRequest): Promise<CronJob>
updateCronJob(id: string, data: UpdateCronJobRequest): Promise<CronJob>
deleteCronJob(id: string): Promise<void>
executeCronJob(id: string): Promise<void>
validateCron(schedule: string): Promise<{ valid: boolean; description: string }>
```

**Channels 相关 (6 个):**
```typescript
listChannels(): Promise<ChannelInfo[]>
getChannelConfig(id: string): Promise<ChannelConfig>
updateChannel(id: string, config: ChannelConfig): Promise<void>
testChannel(id: string, config?: ChannelConfig): Promise<TestResult>
startChannel(id: string): Promise<void>
stopChannel(id: string): Promise<void>
getChannelsStatus(): Promise<Record<string, ChannelStatus>>
```

---

## 9. 文件变更总览

### 9.1 前端新增文件

```
frontend/src/
├── components/
│   ├── channels/
│   │   ├── ChannelsPanel.tsx
│   │   ├── ChannelCard.tsx
│   │   ├── FeishuConfig.tsx
│   │   ├── DingTalkConfig.tsx
│   │   ├── WeChatConfig.tsx
│   │   ├── QQConfig.tsx
│   │   ├── TelegramConfig.tsx
│   │   └── DiscordConfig.tsx
│   ├── cron/
│   │   ├── CronManager.tsx
│   │   ├── JobEditor.tsx
│   │   ├── CronBuilder.tsx
│   │   └── JobCard.tsx
│   └── settings/
│       ├── SettingsContent.tsx      — 设置面板内容（带二级导航）
│       ├── ModelsPanel.tsx          — 模型配置 4-tab 容器
│       ├── MainModelConfig.tsx      — 主模型配置卡
│       ├── SubModelConfig.tsx       — 辅助模型配置卡
│       ├── EmbeddingModelConfig.tsx — 嵌入模型配置卡
│       ├── EnhancedModelsConfig.tsx — 增强模型管理
│       └── ModelConfigCard.tsx      — 可复用模型配置卡片组件
├── store/
│   ├── cron.ts
│   └── channels.ts
└── types/
    ├── cron.ts
    └── channels.ts
```

### 9.2 前端修改文件

| 文件 | 修改内容 |
|------|---------|
| `components/layout/Header.tsx` | 增加 5 个功能按钮，调整布局 |
| `components/layout/Sidebar.tsx` | 移除底部插件导航项 |
| `components/layout/RightPanel.tsx` | 改为内容感知面板，支持不同宽度和内容类型 |
| `components/layout/AppLayout.tsx` | 调整 RightPanel 的使用方式 |
| `components/settings/SettingsPanel.tsx` | 重构为设置面板内容组件（不再作为独立视图） |
| `components/plugins/PluginManager.tsx` | 改为在右侧面板中渲染（不再作为主视图） |
| `components/plugins/SkillBrowser.tsx` | 改为在右侧面板中渲染 |
| `store/ui.ts` | ViewId 去掉 plugins/settings，PanelContentType 替代 rightPanelContent |
| `api/client.ts` | 新增 Cron 和 Channels API 方法 |
| `types/index.ts` | 新增 Cron/Channels/EnhancedModel 类型，更新相关接口 |
| `App.tsx` | ViewRouter 调整 |

### 9.3 后端新增文件

```
src/
├── server/routes/
│   ├── cron.ts                    — Cron API 路由
│   └── channels.ts                — Channels API 路由
├── services/
│   ├── cron/
│   │   ├── types.ts               — CronJob 等接口定义
│   │   ├── scheduler.ts           — 定时调度器
│   │   └── service.ts             — CRUD 服务
│   └── channels/
│       ├── types.ts               — 渠道接口定义
│       ├── channel-manager.ts     — 渠道管理器
│       ├── channel-base.ts        — 渠道基类
│       ├── feishu.ts              — 飞书实现
│       ├── dingtalk.ts            — 钉钉实现
│       ├── wechat.ts              — 微信实现
│       ├── qq.ts                  — QQ 实现
│       ├── telegram.ts            — Telegram 实现
│       └── discord.ts             — Discord 实现
├── store/
│   └── migrations/
│       └── 006_cron_jobs.ts       — 新增 cron_jobs 表
```

### 9.4 后端修改文件

| 文件 | 修改内容 |
|------|---------|
| `server/app.ts` | 挂载 cron 和 channels 路由 |
| `models/router.ts` | 扩展 ModelRouter 支持增强模型查询 |
| `store/settings.ts` | 扩展 ProviderDefaults 支持 enhancedModels 存取 |
| `store/migrations/index.ts` | 注册 006 迁移 |

---

## 10. 技术选型

| 领域 | 选型 | 理由 |
|------|------|------|
| Cron 表达式解析 | `cron-parser` | 轻量，支持计算下次执行时间 |
| 飞书 API | `@larksuiteoapi/node-sdk` 或原生 HTTP | 官方 SDK 或直接 REST |
| 钉钉 API | 原生 HTTP | 钉钉 SDK 较重，REST API 简单 |
| Telegram Bot API | `grammy` 或原生 HTTP | 成熟的 Telegram Bot 框架 |
| Discord Bot API | `discord.js` 或原生 HTTP | 成熟的 Discord Bot 框架 |
| QQ Bot API | 原生 HTTP | QQ 官方 Bot API |
| 微信公众号 API | 原生 HTTP | 微信 API 较简单 |

所有渠道实现使用统一的 `ChannelBase` 接口，具体实现可以先用 HTTP stub，后续逐步接入各平台 SDK。

---

## 11. 兼容性考虑

### 11.1 数据库兼容

- 新增 `cron_jobs` 表通过 migration 006 创建，不影响现有表
- 渠道配置存储在 `settings` 表中（已有），不新增表
- `ProviderDefaults` 扩展 `enhancedModels` 字段，向后兼容（可选字段）

### 11.2 API 兼容

- 所有新 API 使用新路径前缀 (`/api/cron/*`, `/api/channels/*`)，不影响现有 API
- 现有 `/api/settings/*` API 保持不变，扩展默认值支持

### 11.3 前端兼容

- `RightPanel` 改造保持 `children` 渲染模式作为 fallback
- `ViewId` 去掉 `plugins`/`settings` 但保持 URL 兼容（redirect）
- 现有组件不删除，改为在面板中复用

### 11.4 运行时兼容

- CronScheduler 懒初始化（与 Agent 系统类似）
- ChannelManager 懒初始化
- 没有配置渠道时，渠道功能静默不报错
- 没有定时任务时，调度器不启动
