# DA 自进化能力实施计划

## Phase 1: 基础设施

### Task 1.1: 数据库迁移
- 创建 `agent_memory` 表
- 创建 `skill_usage` 表
- 创建 `skill_versions` 表
- 给 `messages` 表添加 `search_vector` 列和 GIN 索引
- 文件: `src/store/pg-migrations/019_self_evolution.ts`

### Task 1.2: 配置系统后端
- 定义 `SelfEvolutionConfig` 接口
- 实现 `getEvolutionConfig()` / `saveEvolutionConfig()`
- 添加 `/api/settings/evolution` GET/PUT 端点
- 文件: `src/services/agent/evolution-config.ts`, `src/server/routes/settings.ts`

### Task 1.3: agent_memory 数据层
- `PgAgentMemoryRepo` — CRUD + 列表 + 去重
- 文件: `src/store/repos/agent-memory.ts`

### Task 1.4: agent_memory 工具
- 注册 `agent_memory` 工具到 ToolRegistry
- 动作: add / replace / remove / list
- 安全扫描
- 文件: `src/services/agent/tool-setup.ts`（在工具注册区添加）

### Task 1.5: 系统提示注入
- 在系统提示构建时注入 agent_memory 内容
- 注入标记 `<!-- AGENT_MEMORY_START/END -->`
- 总字符限制 3000
- 文件: `src/services/agent/agent-definitions.ts` 或 `src/services/agent/prompt-builder.ts`

### Task 1.6: 前端 — Header 按钮 + RightPanel 注册
- Header.tsx 新增 `evolution` 按钮（Brain 图标）
- ui.ts 新增 `PanelContentType` 的 `'evolution'`
- RightPanel.tsx 注册标题和宽度
- 文件: `frontend/src/components/layout/Header.tsx`, `frontend/src/store/ui.ts`, `frontend/src/components/layout/RightPanel.tsx`

### Task 1.7: 前端 — 自进化控制面板
- `EvolutionPanel.tsx` — 总开关 + 四个子开关 + 经验库 + 统计 + 高级设置
- API client 添加 evolution 相关方法
- 文件: `frontend/src/components/evolution/EvolutionPanel.tsx`, `frontend/src/api/client.ts`

### Task 1.8: 验证
- 启动服务，打开自进化面板
- 总开关关闭时确认无任何额外行为
- 打开总开关，手动通过 agent_memory 工具添加经验，确认系统提示中出现
- 关闭总开关，确认经验不再注入

## Phase 2: 核心自进化

### Task 2.1: skill_usage 遥测
- `PgSkillUsageRepo` — bump_use / bump_patch / mark_agent_created / state 转移
- 在 skill_invoke / skill_create / skill_update 工具执行后打点
- 文件: `src/store/repos/skill-usage.ts`, `src/services/agent/tool-setup.ts`

### Task 2.2: skill_versions 版本记录
- `PgSkillVersionRepo` — 创建版本、查询版本列表、获取指定版本、diff 计算
- 在 skill_create / skill_update 执行后自动记录版本
- 文件: `src/store/repos/skill-version.ts`

### Task 2.3: Nudge Counter
- 在 `agent-runner.ts` 主循环中添加 `turnsSinceNudge` 计数器
- 检查 config.enabled 和 modules 开关
- 达到阈值时调用 `spawnBackgroundReview()`
- 文件: `src/services/agent/agent-runner.ts`

### Task 2.4: Background Review Fork
- `spawnBackgroundReview()` 函数
- 创建独立 AgentRunner（工具白名单、maxTurns=8、静默输出）
- Review Prompt 定义
- 防递归（review fork 不触发 review）
- 文件: `src/services/agent/background-review.ts`

### Task 2.5: skill 管理 API 增强
- `/api/agent-skills/:id/versions` GET — 版本历史列表
- `/api/agent-skills/:id/versions/:v/restore` POST — 回退到指定版本
- 前端技能详情页添加版本历史标签
- 文件: `src/server/routes/agent-skills.ts`, `frontend/src/components/skills/`

### Task 2.6: 验证
- 开启自进化，进行 10+ 轮对话，确认 Review 被触发
- 检查 agent_memory 表是否有新记录
- 检查 skill_versions 表是否有版本记录
- 在前端版本历史中查看 diff，执行回退操作
- 关闭开关确认 Review 不再触发

## Phase 3: 长期维护

### Task 3.1: Curator 核心
- `Curator` 类 — 定时检查、状态转移、LLM 合并
- Layer 1: 自动 stale/archive 转移
- Layer 2: LLM 驱动的技能合并（预留，Phase 3 后期实现）
- 文件: `src/services/agent/curator.ts`

### Task 3.2: Curator 集成
- 在 agent-system.ts 启动时注册 Curator
- 根据 evolution config 决定是否启动定时任务
- 添加 `/api/evolution/curate` POST 端点（手动触发）
- 文件: `src/services/agent/agent-system.ts`, `src/server/routes/settings.ts`

### Task 3.3: 前端 Curator 展示
- 自进化面板中显示维护统计
- 手动触发维护按钮
- 维护报告展示
- 文件: `frontend/src/components/evolution/`

### Task 3.4: 验证
- 手动触发 Curator，确认过时技能被标记/归档
- 确认 pinned 技能不受影响
- 确认版本历史中记录了 curator_merge

## Phase 4: 跨会话增强

### Task 4.1: session_recall 工具
- 注册 `session_recall` 工具（仅在 historyRecall=true 时）
- PostgreSQL tsvector 全文检索
- 按会话分组、排除当前会话、摘要返回
- 文件: `src/services/agent/tool-setup.ts`

### Task 4.2: 经验管理 API
- `/api/evolution/memories` GET/DELETE
- `/api/evolution/memories/:id` DELETE
- 前端经验库列表展示
- 文件: `src/server/routes/settings.ts`, `frontend/src/components/evolution/MemoryList.tsx`

### Task 4.3: 验证
- 使用 session_recall 搜索过去会话
- 确认搜索结果排除当前会话
- 确认关闭 historyRecall 后工具不可用
