# DeepAnalyze Agent 自进化能力设计

## 1. 概述

### 1.1 目标

为 DeepAnalyze Agent 系统引入自进化能力：Agent 从每次任务中自主学习和积累经验，逐步提升分析质量和工作效率。

### 1.2 设计原则

- **可选可控**：所有自进化功能默认关闭，用户主动开启。每个子功能独立可控。
- **多人通用**：DA 是多人协作的深度分析平台，自进化提取通用方法论而非个人偏好。
- **可回退**：技能变更有完整版本历史，支持任意版本间的回退和前滚。
- **零侵入**：关闭后 DA 行为与当前完全一致，无任何额外开销。
- **通用性**：遵循 CLAUDE.md 通用性原则，不包含领域特定内容。

### 1.3 参考

本设计参考了 hermes-agent（Nous Research）的自进化架构，提取了其中 6 个学习闭环的核心思想，并针对 DA 的多人协作、PostgreSQL 后端、服务端应用等特性进行了适配。

## 2. 架构总览

### 2.1 五个学习闭环

```
┌──────────────────────────────────────────────────────┐
│                    DA 自进化体系                       │
│                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │ Loop 1   │   │ Loop 2       │   │ Loop 3       │ │
│  │ 轮次级   │   │ 周期级       │   │ 持久记忆     │ │
│  │ 即时学习 │──▶│ Curator      │──▶│ agent_memory │ │
│  │          │   │ 维护         │   │ 表           │ │
│  │ Background│   │              │   │              │ │
│  │ Review   │   │              │   │              │ │
│  └──────────┘   └──────────────┘   └──────────────┘ │
│        │                                     ↑       │
│        │            ┌──────────────┐         │       │
│        └───────────▶│ Loop 4      │─────────┘       │
│                     │ 跨会话搜索  │                  │
│                     │ 全文检索     │                  │
│                     └──────────────┘                  │
│                             │                         │
│                     ┌──────────────┐                  │
│                     │ Loop 5      │                   │
│                     │ 使用遥测    │                   │
│                     │ skill_usage │                   │
│                     └──────────────┘                  │
└──────────────────────────────────────────────────────┘
```

| 闭环 | 时间尺度 | 作用 | 可独立开关 |
|------|---------|------|:---------:|
| Loop 1: Background Review | 轮次级（~10轮触发一次） | 从当前对话提取经验和改进技能 | ✓ |
| Loop 2: Curator | 周期级（~7天） | 整理归档过时技能，合并同类技能 | ✓ |
| Loop 3: Agent Memory | 持久化 | 存储通用工具技巧和工作流经验 | ✓ |
| Loop 4: 历史搜索 | 按需 | 跨会话搜索过去的分析经验 | ✓ |
| Loop 5: 使用遥测 | 实时 | 追踪技能使用频率，供 Curator 决策 | 随 Curator |

## 3. 数据模型

### 3.1 agent_memory 表

Agent 的通用经验笔记。不包含用户画像或个人偏好。

```sql
CREATE TABLE agent_memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category    TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT DEFAULT 'foreground',
  relevance   INT DEFAULT 5,
  use_count   INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
```

**category 枚举**：

| category | 记什么 | 示例 |
|----------|--------|------|
| `tool_technique` | 工具使用技巧 | "run_sql 配合 information_schema 可自动发现表结构" |
| `workflow` | 工作流改进 | "多文档交叉分析时，先用 run_sql 统计再逐个 expand 更高效" |
| `convention` | 系统约定 | "图片 L1 层含 VLM 预编译描述，优先用 expand 获取" |
| `lesson_learned` | 经验教训 | "kb_search topK=10 可能遗漏大量相关文档，复杂查询建议配合 doc_grep" |

**source 枚举**：`foreground`（Agent 对话中主动保存）、`background_review`（后台 Review 保存）、`curator`（Curator 保存）。

### 3.2 skill_usage 表

技能使用遥测，供 Curator 判断技能生命周期。

```sql
CREATE TABLE skill_usage (
  skill_id        UUID PRIMARY KEY REFERENCES agent_skills(id) ON DELETE CASCADE,
  created_by      TEXT DEFAULT 'user',
  use_count       INT DEFAULT 0,
  patch_count     INT DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  last_patched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  state           TEXT DEFAULT 'active',
  pinned          BOOLEAN DEFAULT false
);
```

**state 生命周期**：`active` → `stale`（>30天未用） → `archived`（>90天未用）。被 pin 的技能跳过所有自动转移。

**created_by**：`user`（用户手动创建）或 `agent`（后台 Review 创建）。Curator 只管 `agent` 创建的技能。

### 3.3 skill_versions 表

技能版本历史，支持完整的版本追溯和回退。

```sql
CREATE TABLE skill_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id       UUID NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  version        INT NOT NULL,
  prompt         TEXT NOT NULL,
  description    TEXT,
  change_type    TEXT NOT NULL,
  change_source  TEXT NOT NULL,
  change_summary TEXT,
  diff_patch     TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_skill_versions_unique ON skill_versions (skill_id, version);
CREATE INDEX idx_skill_versions_time ON skill_versions (skill_id, created_at DESC);
```

**change_type 枚举**：`create`、`update`、`patch`、`curator_merge`、`restore`

**change_source 枚举**：`user`（用户手动）、`foreground`（Agent 对话中）、`background_review`（后台学习）、`curator`（自动维护）

**关键设计**：回退不是删除历史，而是创建新版本（`change_type='restore'`）。版本号单调递增，永远可追溯。

### 3.4 messages 全文检索索引

复用现有 messages 表，添加全文检索能力。

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING GIN (search_vector);
```

## 4. 配置系统

### 4.1 配置数据结构

存储在 `settings` 表，key = `"self_evolution_config"`。

```typescript
interface SelfEvolutionConfig {
  enabled: boolean;
  modules: {
    memoryAccumulation: boolean;   // 经验积累
    skillEvolution: boolean;       // 技能自优化
    skillMaintenance: boolean;     // 技能维护
    historyRecall: boolean;        // 历史经验搜索
  };
  params: {
    nudgeInterval: number;         // 学习触发间隔（轮次，默认 10）
    curatorIntervalDays: number;   // Curator 周期（天，默认 7）
    archiveAfterDays: number;      // 归档阈值（天，默认 90）
    staleAfterDays: number;        // 过时阈值（天，默认 30）
  };
}
```

### 4.2 默认值

```typescript
const DEFAULT_EVOLUTION_CONFIG: SelfEvolutionConfig = {
  enabled: false,   // 默认关闭
  modules: {
    memoryAccumulation: true,
    skillEvolution: true,
    skillMaintenance: true,
    historyRecall: true,
  },
  params: {
    nudgeInterval: 10,
    curatorIntervalDays: 7,
    archiveAfterDays: 90,
    staleAfterDays: 30,
  },
};
```

### 4.3 开关传导逻辑

```
总开关 enabled=false → 完全跳过所有自进化逻辑，零开销
总开关 enabled=true:
  ├── memoryAccumulation=true  → 运行 Memory Review，agent_memory 系统提示注入
  ├── skillEvolution=true      → 运行 Skill Review
  ├── skillMaintenance=true    → 运行 Curator
  ├── historyRecall=true       → 注册 session_recall 工具
  └── agent_memory 工具始终可用（总开关开着即可）
```

当 `memoryAccumulation=false` 且 `skillEvolution=false` 时，Nudge Counter 不递增，不触发 Background Review。

## 5. 各闭环详细设计

### 5.1 Loop 1: Background Review（轮次级即时学习）

#### 触发机制

在 `agent-runner.ts` 主循环中，每个用户轮次完成后：

```
响应已交付给用户
  ↓
if (config.enabled && (memoryAccumulation || skillEvolution)) {
  turnsSinceNudge++;
  if (turnsSinceNudge >= config.params.nudgeInterval) {
    spawnBackgroundReview(config);
    turnsSinceNudge = 0;
  }
}
```

计数器重置条件：
- 达到阈值触发 Review 后
- Agent 在对话中主动调用了 agent_memory 或 skill_update 工具

#### 执行机制

`spawnBackgroundReview()` 使用 `setImmediate` 异步执行，不阻塞主流程：

1. 创建独立 AgentRunner 实例（复用模型配置）
2. 工具白名单：仅 `agent_memory`、`skill_update`、`skill_create`、`list_skills`
3. 注入 Review Prompt + 当前对话快照
4. maxTurns=8
5. 写入来源标记为 `background_review`
6. 不发送 SSE 事件，输出不进入用户可见消息流
7. 失败只记录日志（best-effort）

防递归：Review fork 内部不再触发 Review（nudge interval 设为 0）。

#### Review Prompt

**Memory Review**（当 `memoryAccumulation=true` 时）：

聚焦工具技巧、工作流改进、系统约定、经验教训。明确禁止记录用户个人信息或偏好。

**Skill Review**（当 `skillEvolution=true` 时）：

信号识别：工作流被证明更高效、现有技能暴露不足、发现新的分析模式。

更新偏好顺序：更新当前技能 > 更新 umbrella > 添加参考文件 > 创建新技能。

明确禁止：环境依赖的一次性错误、负面工具声明、会话特定临时问题、用户个人信息。

### 5.2 Loop 2: Curator（周期级技能维护）

#### 触发

服务器启动时注册定时检查（每小时一次），在无活跃 Agent 任务时运行。

门控条件：
- `config.enabled && config.modules.skillMaintenance`
- 距上次运行 > `curatorIntervalDays` 天
- `activeAgentRuns === 0`

#### 三层工作

**Layer 1: 自动状态转移（纯函数，无 LLM）**

查询 skill_usage 表，按时间阈值标记 stale/archived。Pinned 技能跳过。

**Layer 2: LLM 驱动的技能合并**

扫描所有 `created_by='agent'` 且 `state='active'` 的技能。识别名称/内容前缀集群，合并为 umbrella 技能。被吸收的技能归档（不删除）。

**Layer 3: 后处理**

分类归档、生成维护报告、前端可查看。

### 5.3 Loop 3: Agent Memory（持久化经验）

#### 系统提示注入

会话开始时从 `agent_memory` 表读取所有条目（按 category 和 relevance 排序），格式化为系统提示块注入。总字符限制 3000（约 1000 tokens）。

注入标记：
```
<!-- AGENT_MEMORY_START -->
[经验笔记内容]
<!-- AGENT_MEMORY_END -->
```

#### agent_memory 工具

Agent 可在对话中主动调用：
- `add(category, content)` — 添加经验
- `replace(old_content, new_content)` — 更新经验
- `remove(content)` — 删除经验
- `list()` — 查看当前所有经验

安全扫描：阻止注入/泄露模式。

### 5.4 Loop 4: 跨会话搜索

#### session_recall 工具

```typescript
{
  name: "session_recall",
  description: "搜索你过去的对话历史，找回处理类似问题的经验和方法",
  parameters: {
    query: { type: "string", description: "搜索关键词" },
    limit: { type: "number", default: 3, description: "返回结果数（1-5）" }
  }
}
```

实现：PostgreSQL `tsvector` 全文检索 → 按会话分组 → 排除当前会话 → 返回匹配摘要。

### 5.5 Loop 5: 使用遥测

#### 打点位置

| 触发点 | 动作 |
|--------|------|
| skill_invoke 执行成功 | `bump_use(skillId)` |
| skill_create（source=background_review） | `mark_agent_created(skillId)` |
| skill_update | `bump_patch(skillId)` + 记录 skill_versions |
| list_skills 返回中包含技能 | 不打点（避免噪音） |

#### Curator 消费

Curator 的 Layer 1 直接查询 skill_usage 的 `last_used_at` 和 `state` 字段做状态转移。

## 6. 版本历史与回退

### 6.1 版本记录规则

每次 `agent_skills` 表发生写操作时，自动在 `skill_versions` 表插入一条记录。版本号单调递增。

| 操作 | change_type | change_source | 说明 |
|------|-------------|---------------|------|
| 用户创建技能 | create | user | v1 |
| 后台学习创建技能 | create | background_review | v1 |
| 用户编辑技能 | update | user | vN+1 |
| 后台学习修补技能 | patch | background_review | vN+1 |
| Curator 合并技能 | curator_merge | curator | vN+1 |
| 用户回退到历史版本 | restore | user | vN+1（内容=目标版本） |

### 6.2 前端展示

技能详情页增加"版本历史"标签，显示时间线。每个版本显示：
- 版本号和时间
- 变更来源（颜色区分：蓝=用户、绿=Agent对话、黄=自动学习、紫=自动维护）
- 变更摘要
- 变更行数统计
- 操作：查看完整内容、查看差异、恢复此版本

### 6.3 差异计算

diff_patch 字段存储与上一版本的 unified diff（人类可读）。前端可展示行级增删。

### 6.4 回退机制

用户选择历史版本回退时：
1. 读取目标版本的完整 prompt
2. 用该内容更新 agent_skills 表
3. 在 skill_versions 表新增一条 `change_type='restore'` 记录

## 7. UI 设计

### 7.1 Header 入口

在现有 Header 按钮组中，"设置"之前新增"自进化"按钮：

```
[会话历史] [插件] [技能库] [团队] [定时任务] [自进化] [设置] | [主题]
                                            ↑
                                      图标: Brain (lucide-react)
                                      标题: "自进化"
```

### 7.2 自进化控制面板

RightPanel 中渲染，宽度 560px，包含：

1. **总开关**：ToggleSwitch，启用/禁用自进化能力
2. **功能模块**：四个独立 ToggleSwitch（经验积累、技能自优化、技能维护、历史搜索）
3. **经验库**：当前经验数量、上次学习时间、查看/清空按钮
4. **技能统计**：Agent 自创建技能数、维护次数、查看/手动维护按钮
5. **高级设置**：学习触发间隔、维护周期、归档天数等数值参数
6. **保存按钮**

### 7.3 API 端点

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/settings/evolution` | GET/PUT | 自进化配置 |
| `/api/evolution/memories` | GET | 列出经验库 |
| `/api/evolution/memories/:id` | DELETE | 删除单条经验 |
| `/api/evolution/memories` | DELETE | 清空经验库 |
| `/api/evolution/curate` | POST | 手动触发技能维护 |
| `/api/agent-skills/:id/versions` | GET | 技能版本历史 |
| `/api/agent-skills/:id/versions/:v/restore` | POST | 回退到指定版本 |

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Background Review 消耗 LLM 资源 | 默认关闭；nudge interval 可调；可使用辅助模型 |
| Agent 学习了错误经验 | 安全扫描；经验可删除；默认关闭 |
| 技能被错误修改 | 完整版本历史；一键回退；归档不删除 |
| 多人场景下经验冲突 | 经验是通用方法论不涉及个人偏好；去重机制 |
| 关闭后行为不一致 | 关闭=零开销，完全不触发任何自进化逻辑 |
