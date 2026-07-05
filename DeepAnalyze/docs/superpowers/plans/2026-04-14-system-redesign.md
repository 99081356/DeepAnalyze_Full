# 系统重新设计实施计划 — 索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**设计文档：** `docs/superpowers/specs/2026-04-14-system-redesign-design.md`

**目标：** 重新设计深度测试中发现的6个系统性问题——上传失败、状态持久化、统一搜索、报告集成、报告噪音、多Agent并行。

**技术栈：** React 19 + Zustand 5、Hono v4.7、better-sqlite3、WebSocket、现有AgentRunner/Orchestrator。

---

## 计划分期文件

| 文件 | 模块 | 任务数 | 优先级 |
|------|------|--------|--------|
| [phase1.md](./2026-04-14-system-redesign-phase1.md) | A: 文件上传 + 状态持久化 | 5 | P0 |
| [phase2.md](./2026-04-14-system-redesign-phase2.md) | B: 统一搜索系统 | 4 | P1 |
| [phase3.md](./2026-04-14-system-redesign-phase3.md) | C: 报告 + 聊天集成 | 3 | P2 |
| [phase4.md](./2026-04-14-system-redesign-phase4.md) | D: 多Agent系统 | 8 | P3 |

## 依赖关系

```
Phase 1 (上传 + 持久化)
    |
    v
Phase 2 (统一搜索)
    |       \
    v        v
Phase 3 (报告)    Phase 4 (多Agent)
```

- Phase 3 的引用预览依赖 Phase 2 的搜索API
- Phase 4 的 workflow_run 可以使用所有现有工具（包括Phase 2的kb_search）
- Phase 1 的URL路由影响所有视图的访问方式
- Phase 2 的 LevelSwitcher 在搜索结果和Wiki浏览中均有使用

## 完整文件清单

### 新建文件（21个）

| # | 文件路径 | 模块 | 用途 |
|---|----------|------|------|
| 1 | `frontend/src/router.tsx` | A | Hash路由 |
| 2 | `src/server/routes/search.ts` | B | 统一搜索端点 |
| 3 | `frontend/src/components/search/UnifiedSearch.tsx` | B | 搜索UI |
| 4 | `frontend/src/components/search/SearchResultCard.tsx` | B | 结果卡片 |
| 5 | `frontend/src/components/search/PreviewCard.tsx` | B | 悬停预览 |
| 6 | `frontend/src/components/search/LevelSwitcher.tsx` | B | 层级切换 |
| 7 | `frontend/src/components/chat/ReportCard.tsx` | C | 嵌入式报告 |
| 8 | `frontend/src/components/chat/ReferenceMarker.tsx` | C | [n]引用标记 |
| 9 | `frontend/src/components/chat/EntityLink.tsx` | C | 实体链接 |
| 10 | `src/services/report/cleaner.ts` | C | 去噪管道 |
| 11 | `src/store/reports.ts` | C | 报告SQLite持久化 |
| 12 | `src/services/agent/workflow-engine.ts` | D | WorkflowEngine |
| 13 | `src/services/agent/agent-team-manager.ts` | D | 团队CRUD |
| 14 | `src/store/agent-teams.ts` | D | 团队SQLite持久化 |
| 15 | `src/server/routes/agent-teams.ts` | D | 团队REST API |
| 16 | `frontend/src/components/teams/SubAgentPanel.tsx` | D | 工作流展示 |
| 17 | `frontend/src/components/teams/SubAgentSlot.tsx` | D | Agent卡片 |
| 18 | `frontend/src/components/teams/TeamManager.tsx` | D | 团队管理UI |
| 19 | `frontend/src/components/teams/TeamEditor.tsx` | D | 团队编辑器 |
| 20 | `frontend/src/store/workflow.ts` | D | 工作流Zustand store |
| 21 | `frontend/src/api/agentTeams.ts` | D | 团队API客户端 |

### 修改文件（17个）

| # | 文件路径 | 模块 | 变更 |
|---|----------|------|------|
| 1 | `frontend/src/components/knowledge/KnowledgePanel.tsx` | A,B | 非阻塞上传、批量操作、统一布局、LevelSwitcher |
| 2 | `frontend/src/api/client.ts` | A | 带超时和重试的上传 |
| 3 | `src/server/routes/knowledge.ts` | A,B | 上传确认、文档状态端点、层级参数 |
| 4 | `frontend/src/App.tsx` | A | 集成路由器 |
| 5 | `frontend/src/store/ui.ts` | A | localStorage同步 |
| 6 | `frontend/src/store/chat.ts` | A,D | 会话ID持久化、工作流事件 |
| 7 | `src/wiki/retriever.ts` | B | 多层级搜索+关键词高亮 |
| 8 | `frontend/src/components/ChatWindow.tsx` | C,D | ReportCard、SubAgentPanel |
| 9 | `src/server/routes/chat.ts` | C | 内联报告数据 |
| 10 | `src/services/agent/tools/report-generate.ts` | C | 干净输出+引用标记 |
| 11 | `src/server/routes/reports.ts` | C | 报告CRUD API |
| 12 | `src/services/agent/tool-setup.ts` | D | 注册workflow_run工具 |
| 13 | `src/services/agent/agent-system.ts` | D | 初始化WorkflowEngine和AgentTeamManager |
| 14 | `src/server/app.ts` | D | 挂载agent-teams路由 |
| 15 | `src/server/ws.ts` | D | workflow_* WebSocket事件 |
| 16 | `src/services/plugins/plugin-manager.ts` | D | 插件团队调度策略 |
| 17 | `src/services/plugins/types.ts` | D | SkillDefinition扩展scheduling字段 |

## 执行约定

- **TDD流程：** 写失败测试 → 验证失败 → 实现 → 验证通过 → 提交
- **每个Task完成后单独commit**
- **commit消息格式：** `feat(module): 描述`
- **测试命令：** `cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run [test-file]`
