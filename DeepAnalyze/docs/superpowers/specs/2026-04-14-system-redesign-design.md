# DeepAnalyze 系统重新设计文档

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**目标：** 重新设计深度测试中发现的6个系统性问题 —— 上传失败、状态持久化、统一搜索、报告集成、报告噪音、多Agent并行。

**架构：** 三层系统：输入层（上传 + 聊天）、核心引擎（搜索 + Agent + 报告）、展示层（嵌入式报告 + 状态持久化）。多Agent采用三层架构：底层（AgentRunner + Orchestrator）、中间层（WorkflowEngine，4种调度模式）、顶层（4个多Agent分发入口）。

**技术栈：** React + Zustand、Hono（后端）、better-sqlite3、WebSocket、现有AgentRunner/Orchestrator、WorkflowEngine（从CountBot移植）。

---

## 模块A：文件上传 + 状态持久化

### A.1 上传管道改进

**问题：** 文件在WSL环境下无法上传，上传过程中无反馈，无超时机制，无重试机制。

**解决方案：**

- 非阻塞上传：上传在后台运行，UI保持可交互
- 每次上传尝试30秒超时
- 失败后自动重试2次
- 轮询回退：当WebSocket断开时，每3秒轮询文档状态
- 详细的进度阶段：Upload% -> Parsing -> Compiling -> Indexing -> Linking -> Ready
- 错误恢复：失败的文件显示重试按钮

**上传进度阶段详情：**

| 阶段 | 描述 | 进度 % |
|------|------|--------|
| Upload | 将文件字节传输到服务器 | 0-40% |
| Parsing | 从文档格式中提取文本 | 40-55% |
| Compiling | 构建内部文档结构 | 55-70% |
| Indexing | 创建搜索索引条目 | 70-85% |
| Linking | 构建实体链接和交叉引用 | 85-95% |
| Ready | 文档可用于搜索和分析 | 100% |

**重试逻辑：**

```
attempt = 1
maxAttempts = 3

function uploadWithRetry(file):
  while attempt <= maxAttempts:
    try:
      result = await upload(file, { timeout: 30000 })
      return result
    catch (error):
      if attempt == maxAttempts:
        showRetryButton(file)
        return { status: "failed", error }
      attempt++
      await delay(1000 * attempt) // exponential backoff: 1s, 2s
```

**轮询回退逻辑：**

```
// When WebSocket disconnects, start polling
ws.onDisconnect = () => {
  pollInterval = setInterval(async () => {
    const status = await fetch(`/api/knowledge/${kbId}/documents/${docId}/status`)
    updateProgress(status)
    if (status.stage === "Ready" || status.stage === "Failed") {
      clearInterval(pollInterval)
    }
  }, 3000)
}
```

**需要修改的文件：**

- `frontend/src/components/knowledge/KnowledgePanel.tsx` -- 添加带进度的非阻塞上传
- `frontend/src/api/client.ts` -- 添加带超时和重试的上传
- `src/server/routes/knowledge.ts` -- 确保上传端点返回即时确认

### A.2 状态持久化 —— URL路由 + localStorage

**问题：** 页面刷新丢失所有状态（活动视图、会话、知识库选择、范围）。

**解决方案：双层持久化**

**URL路由：**

| 路由 | 视图 |
|------|------|
| `/chat` | 聊天视图 |
| `/knowledge/:kbId` | 知识库 |
| `/knowledge/:kbId/search` | 搜索 |
| `/reports` | 报告列表 |
| `/reports/:reportId` | 单个报告 |
| `/tasks` | 任务列表 |
| `/sessions/:sessionId` | 特定会话 |

**localStorage 键：**

| 键 | 用途 |
|----|------|
| `deepanalyze-theme` | 主题偏好 |
| `deepanalyze-session` | 当前会话ID |
| `deepanalyze-kb` | 当前知识库ID |
| `deepanalyze-sidebar` | 侧边栏开启/关闭状态 |
| `deepanalyze-scope` | 分析范围选择 |

**刷新流程：** URL解析 -> 确定视图 -> 从localStorage恢复UI状态 -> 通过API加载服务器数据 -> 渲染完成。

**详细刷新流程：**

```
1. User refreshes page or navigates to a URL
2. Router parses URL path and query parameters
   - Extract route segments (e.g., /knowledge/abc123/search)
   - Extract query params (e.g., ?q=keyword)
3. Determine active view from route
   - Match route to view component
   - Set active view in Zustand store
4. Restore supplementary state from localStorage
   - Theme preference
   - Sidebar state
   - Last-used scope
5. Load server data via API
   - If session ID in URL or localStorage, fetch session
   - If kbId in URL, fetch KB details and document list
   - If search query in URL params, execute search
6. Render complete view with all data
```

**示例：** 刷新 `/knowledge/abc123/search?q=夏某某` -> 自动选择知识库 abc123 -> 搜索 "夏某某" -> 显示结果。

**路由实现方案：**

使用react-router v6的hash路由以保证WSL兼容性。路由器包裹整个App组件，并将URL模式映射到视图组件。每次路由变化同时触发URL更新和Zustand store更新，以保持两者同步。

```typescript
// router.tsx structure
const router = createHashRouter([
  { path: "/chat", element: <ChatView /> },
  { path: "/knowledge/:kbId", element: <KnowledgeView /> },
  { path: "/knowledge/:kbId/search", element: <KnowledgeView initialTab="search" /> },
  { path: "/reports", element: <ReportsView /> },
  { path: "/reports/:reportId", element: <ReportDetailView /> },
  { path: "/tasks", element: <TasksView /> },
  { path: "/sessions/:sessionId", element: <ChatView /> },
  { path: "/", element: <Navigate to="/chat" replace /> },
])
```

**需要创建/修改的文件：**

- 创建 `frontend/src/router.tsx` -- 使用react-router或自定义hash路由的URL路由
- 修改 `frontend/src/App.tsx` -- 集成路由器
- 修改 `frontend/src/store/ui.ts` -- 同步状态到localStorage和URL
- 修改 `frontend/src/store/chat.ts` -- 持久化会话ID

### A.3 文档列表批量操作

**功能：**

- 全选 / 单选复选框
- 批量删除（显示选中数量）
- 批量重新处理
- 状态指示器：Ready（绿色勾号）、Processing（带%的旋转图标）、Failed（红色图标带重试按钮）

**批量操作UI详情：**

| 操作 | 行为 | 确认 |
|------|------|------|
| 全选 | 勾选当前视图中所有文档 | 无 |
| 单选 | 切换单个文档复选框 | 无 |
| 批量删除 | 删除所有选中的文档 | 弹窗："删除N个文档？此操作不可撤销。" |
| 批量重新处理 | 对选中的文档重新运行处理管道 | 无（立即开始） |
| 重试失败的 | 仅重试状态为Failed的文档 | 无 |

**状态指示器：**

| 状态 | 图标 | 颜色 | 交互 |
|------|------|------|------|
| Ready | 勾号 | 绿色 | 点击查看 |
| Processing | 带百分比的旋转器 | 蓝色 | 点击查看进度详情 |
| Failed | X标记 | 红色 | 点击重试 |
| Queued | 时钟 | 灰色 | 无 |

**需要修改的文件：**

- `frontend/src/components/knowledge/KnowledgePanel.tsx` -- 添加批量选择和操作

---

## 模块B：统一搜索系统

### B.1 统一搜索界面

**问题：** 搜索、Wiki和预览是断开的模块。用户想要一个统一搜索，结果按层级展示。

**解决方案：单一搜索入口，结果按层级显示**

**搜索结果布局：**

- **L0 结果**（绿色徽章）：摘要级别匹配，速度最快
- **L1 结果**（蓝色徽章）：概述级别匹配，上下文更丰富
- **L2 结果**（黄色徽章）：原文片段匹配，精确到段落
- **实体结果**（紫色徽章）：匹配的实体及其出现次数

每条结果显示：标题、高亮摘要（关键词以黄色高亮）、来源文档信息、层级徽章。

**统一搜索API：**

```
GET /api/knowledge/:kbId/search

Parameters:
  q: "夏某某"                    // search keyword
  levels: "L0,L1,L2"            // which levels to return (default all)
  entities: true                 // whether to return entity matches
  limit: 10                      // max results per level
  offset: 0                      // pagination

Response:
{
  "query": "夏某某",
  "results": {
    "L0": [{ "pageId", "title", "snippet", "highlights" }],
    "L1": [{ "pageId", "title", "snippet", "highlights" }],
    "L2": [{ "pageId", "title", "snippet", "highlights" }]
  },
  "entities": [{ "name", "type", "count", "relatedPages" }],
  "total": 19
}
```

**搜索性能要求：**

| 指标 | 目标 |
|------|------|
| L0 搜索延迟 | < 200ms |
| L1 搜索延迟 | < 500ms |
| L2 搜索延迟 | < 1000ms |
| 实体搜索延迟 | < 300ms |
| 组合响应时间 | < 1500ms |

**关键词高亮：**

搜索关键词在结果摘要中使用 `<mark>` 标签高亮。高亮算法：

1. 对查询字符串进行分词
2. 对于每个词元，在摘要中查找所有不区分大小写的出现
3. 用 `<mark class="search-highlight">` 标签包裹匹配项
4. 对于多词元查询，独立高亮每个词元

**需要创建/修改的文件：**

- 创建 `src/server/routes/search.ts` -- 统一搜索端点
- 创建 `frontend/src/components/search/UnifiedSearch.tsx` -- 带层级标签的搜索UI
- 创建 `frontend/src/components/search/SearchResultCard.tsx` -- 单个结果卡片
- 修改 `src/wiki/retriever.ts` -- 支持带关键词高亮的多层级搜索

### B.2 悬停预览卡片

**行为：** 鼠标悬停在任何搜索结果上 -> 弹出预览卡片，显示带关键词高亮的文档内容。

**预览卡片内容：**

- 头部：文档标题 + 层级 + 大小
- 主体：带关键词高亮的内容摘要
- 底部：上传日期 + "打开完整页面" 链接

**预览卡片实现详情：**

```
Appearance:
+-------------------------------------------+
| 案件基本情况        L1 概述     5.8KB      |
+-------------------------------------------+
| ...夏某某在2023年3月期间，通过其控制的     |
| 多个银行账户进行资金往来...                |
| ...经查明，夏某某与张某存在...             |
+-------------------------------------------+
| 2024-01-15  |  Open full page ->          |
+-------------------------------------------+

Trigger: mouseenter on search result card
Dismiss: mouseleave (300ms delay to prevent flicker)
Load: fetch preview content via API on first hover, cache for session
Position: anchored to right side of result card, flip if near viewport edge
```

**预览数据API：**

```
GET /api/knowledge/:kbId/pages/:pageId/preview?level=L1&q=keyword

Response:
{
  "pageId": "page-xxx",
  "title": "案件基本情况",
  "level": "L1",
  "size": "5.8KB",
  "snippet": "...highlighted content...",
  "uploadDate": "2024-01-15"
}
```

**需要创建的文件：**

- 创建 `frontend/src/components/search/PreviewCard.tsx` -- 悬停预览组件

### B.3 单文档层级切换（新增）

**需求：** 每个文档可以通过在文档上选择层级以L0/L1/L2方式查看。LevelSwitcher组件在搜索结果、Wiki浏览和文档详情视图中复用。

**层级切换器组件：**

- 标签式按钮：`L0 摘要` | `L1 概述` | `L2 原文`
- 活动标签以蓝色高亮
- 点击标签加载该层级内容，无需刷新页面
- 关键词在层级切换之间保持高亮
- 记住用户偏好的默认层级（存储在localStorage的 `deepanalyze-default-level` 中）

**层级切换器组件Props：**

```typescript
interface LevelSwitcherProps {
  pageId: string
  kbId: string
  currentLevel: "L0" | "L1" | "L2"
  availableLevels: Array<"L0" | "L1" | "L2">
  onLevelChange: (level: "L0" | "L1" | "L2") => void
  keywords?: string[]  // for maintaining highlights across switches
}
```

**API：**

```
GET /api/knowledge/:kbId/pages/:pageId?level=L1

Response:
{
  "pageId": "page-xxx",
  "docId": "doc-xxx",
  "title": "案件基本情况",
  "level": "L1",
  "content": "...",
  "availableLevels": ["L0", "L1", "L2"],
  "levelMeta": {
    "L0": { "size": "2.1KB", "generated": true },
    "L1": { "size": "5.8KB", "generated": true },
    "L2": { "size": "12.4KB", "generated": false }
  },
  "entities": [...],
  "links": [...]
}
```

**层级描述：**

| 层级 | 大小 | 描述 |
|------|------|------|
| L0 摘要 | ~200-500字符 | AI生成的摘要，快速概览 |
| L1 概述 | ~500-2000字符 | AI生成的结构化概述，分节展示 |
| L2 原文 | 完整文档 | 原始上传文档，完整内容 |

**需要创建/修改的文件：**

- 创建 `frontend/src/components/search/LevelSwitcher.tsx` -- 可复用的层级切换组件
- 修改 `src/server/routes/knowledge.ts` -- 为页面API添加层级参数
- 修改 `frontend/src/components/knowledge/KnowledgePanel.tsx` -- 在Wiki视图中集成LevelSwitcher
- 修改 `frontend/src/components/search/UnifiedSearch.tsx` -- 在搜索结果中集成LevelSwitcher

### B.4 模块集成 —— 三合一

**当前：** 3个独立模块（搜索、Wiki、预览）—— 点击搜索结果无法预览，Wiki是断开的。

**改进后：** 统一知识面板：

- 顶部：统一搜索栏（始终可见）
- 结果：按层级分组的结果，带悬停预览
- Wiki浏览：搜索下方可展开区域，与搜索结果关联
- 实体卡片：与搜索结果一起显示

**统一知识面板布局：**

```
+--------------------------------------------------+
| [Search bar: Search across all levels...]   [?]  |
+--------------------------------------------------+
| L0 (3)  |  L1 (7)  |  L2 (9)  |  Entities (4)   |
+--------------------------------------------------+
|                                                    |
|  Result Card 1                     [Preview ->]   |
|  +----------------------------------------------+ |
|  | 案件基本情况                    L1 概述        | |
|  | ...夏某某在2023年3月期间...                    | |
|  | Source: doc-001 | 5.8KB                       | |
|  +----------------------------------------------+ |
|                                                    |
|  Result Card 2                     [Preview ->]   |
|  +----------------------------------------------+ |
|  | 资金往来记录                    L2 原文        | |
|  | ...经查明，夏某某与张某存在...                 | |
|  | Source: doc-002 | 12.4KB                      | |
|  +----------------------------------------------+ |
|                                                    |
|  --- Wiki Browsing (expandable) ---                |
|  [Expand to browse full knowledge base wiki]       |
|                                                    |
+--------------------------------------------------+
```

**需要修改的文件：**

- 修改 `frontend/src/components/knowledge/KnowledgePanel.tsx` -- 重构为统一布局

---

## 模块C：报告 + 聊天集成

### C.1 报告嵌入聊天

**问题：** Agent生成报告但不在聊天窗口中显示。报告发送到单独的面板。Agent不了解自己生成的报告。

**解决方案：** 报告直接在聊天消息流中渲染为富卡片。

**聊天中的报告卡片：**

- 头部（渐变蓝色）：标题、生成时间、文档数量、引用数量、下载/复制按钮
- 主体：干净的Markdown内容，带引用标记[n]和实体链接（虚线下划线）
- 底部：引用数量、"查看完整报告" 链接
- 卡片下方：Agent摘要文本（1-2句话总结关键发现）

**报告卡片视觉布局：**

```
+----------------------------------------------------------+
|  案件综合分析报告              2024-01-15 14:32  [>] [copy] |
|  3 documents | 12 references | [download PDF]             |
+----------------------------------------------------------+
|                                                            |
|  ## 核心发现                                               |
|                                                            |
|  夏某某涉嫌非法经营案涉及金额达500万元[n1]。              |
|  根据银行流水记录，资金主要通过三个账户流转[n2]。         |
|                                                            |
|  ## 关键人物                                               |
|                                                            |
|  夏某某 作为核心嫌疑人，与张某[n3]存在密切资金往来。     |
|  李某某 作为中间人，参与了资金的[部分操作]。               |
|                                                            |
+----------------------------------------------------------+
|  12 references  |  View full report ->                     |
+----------------------------------------------------------+
|  Agent: 本报告分析了3份核心文档，发现夏某某涉案金额       |
|  达500万元，涉及3个银行账户的资金流转。关键证据集中在     |
|  银行流水记录中。                                          |
+----------------------------------------------------------+
```

**聊天消息类型扩展：**

```typescript
// Extend existing chat message types
interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: string
  // New field for embedded reports
  report?: {
    id: string
    title: string
    summary: string  // Agent's 1-2 sentence summary
  }
}
```

**需要创建/修改的文件：**

- 创建 `frontend/src/components/chat/ReportCard.tsx` -- 嵌入式报告组件
- 修改 `frontend/src/components/ChatWindow.tsx` -- 为报告消息渲染ReportCard
- 修改 `src/server/routes/chat.ts` -- 内联返回报告数据与聊天消息

### C.2 引用标记 + 悬停预览

**问题：** 报告中充斥着原始来源块，如"From: Overview: xxx"，而不是干净的分析。

**解决方案：** 带交互标记的干净引用系统。

**引用标记类型：**

| 类型 | 样式 | 行为 |
|------|------|------|
| 文档引用 [n] | 蓝色上标徽章 | 悬停：显示来源文档摘要，带关键词高亮 |
| 实体链接 | 蓝色虚线下划线 | 悬停：显示实体类型 + 出现次数 |
| 数据高亮 | 黄色背景 | 关键数据的视觉强调 |

**引用标记悬停详情：**

```
[n1] hover popup:
+-------------------------------------------+
| 来源: 银行流水记录.pdf                    |
| Level: L1 概述                            |
+-------------------------------------------+
| ...夏某某在2023年3月期间，通过其控制的     |
| 多个银行账户进行资金往来，总金额达         |
| 500万元...                                 |
+-------------------------------------------+
| [Open source document ->]                  |
+-------------------------------------------+
```

**实体链接悬停详情：**

```
张某 hover popup:
+-------------------------------------------+
| Entity: Person                            |
| Occurrences: 23 across 5 documents        |
| Type: 自然人                              |
+-------------------------------------------+
| [View all mentions ->]                     |
+-------------------------------------------+
```

**去噪管道：**

Agent原始输出 -> 内容清洗（移除"From: ..."块）-> 引用标记（原始引文 -> 链接到源文档的[n]标记）-> 干净报告

**去噪管道详情：**

```
Stage 1: Content Cleaning
  - Remove "From: Overview: xxx" blocks
  - Remove "From: Summary: xxx" blocks
  - Remove "Based on the document..." prefixes
  - Remove raw tool output formatting
  - Preserve actual analysis and conclusions

Stage 2: Reference Marking
  - Identify quoted passages from source documents
  - Replace with [n] markers
  - Build reference index linking each [n] to source doc + page + level

Stage 3: Entity Linking
  - Identify entity mentions (persons, organizations, amounts, dates)
  - Wrap in entity link markup
  - Link to entity database for hover preview

Stage 4: Final Cleanup
  - Normalize Markdown formatting
  - Ensure heading hierarchy is consistent
  - Remove duplicate whitespace
```

**内容清洗器实现方案：**

```typescript
// src/services/report/cleaner.ts

interface CleanResult {
  cleanContent: string        // Markdown with [n] markers and entity links
  references: Reference[]     // Extracted reference data
  entities: string[]          // Identified entities
  stats: {
    originalLength: number
    cleanLength: number
    referencesExtracted: number
    entitiesLinked: number
    blocksRemoved: number
  }
}

function cleanReport(rawContent: string, sourceDocuments: Document[]): CleanResult
```

**需要创建/修改的文件：**

- 创建 `frontend/src/components/chat/ReferenceMarker.tsx` -- 带悬停的[n]标记
- 创建 `frontend/src/components/chat/EntityLink.tsx` -- 带悬停的实体链接
- 创建 `src/services/report/cleaner.ts` -- 去噪管道
- 修改 `src/services/agent/tools/report-generate.ts` -- 生成带引用标记的干净输出

### C.3 报告数据结构

```typescript
interface Report {
  id: string;
  sessionId: string;
  messageId: string;          // linked to chat message
  title: string;
  cleanContent: string;       // cleaned Markdown
  rawContent: string;         // agent raw output (archive)
  references: Array<{
    id: number;
    docId: string;
    pageId: string;
    title: string;
    level: "L0" | "L1" | "L2";
    snippet: string;
    highlight: string;
  }>;
  entities: string[];
  createdAt: string;
}
```

**报告存储Schema（SQLite）：**

```sql
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  title TEXT NOT NULL,
  clean_content TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  entities TEXT, -- JSON array of entity names
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE TABLE report_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL,
  ref_index INTEGER NOT NULL, -- the [n] number
  doc_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  title TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2')),
  snippet TEXT NOT NULL,
  highlight TEXT NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE INDEX idx_reports_session ON reports(session_id);
CREATE INDEX idx_reports_message ON reports(message_id);
CREATE INDEX idx_report_refs_report ON report_references(report_id);
```

**报告API端点：**

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/reports` | 列出所有报告（分页） |
| GET | `/api/reports/:id` | 获取单个报告及其引用 |
| GET | `/api/sessions/:sessionId/reports` | 获取会话的报告 |
| DELETE | `/api/reports/:id` | 删除报告 |
| GET | `/api/reports/:id/export` | 导出报告为PDF/Markdown |

**需要创建/修改的文件：**

- 创建 `src/store/reports.ts` -- 报告持久化（SQLite）
- 修改 `src/server/routes/reports.ts` -- 报告的CRUD API

---

## 模块D：多Agent系统（v2 —— AgentTeams集成）

### D.1 三层架构

**底层 —— 核心Agent能力（现有，保留）：**

- AgentRunner：TAOR循环、上下文管理、工具执行、会话记忆
- Orchestrator：runSingle、runParallel、runCoordinated
- Swarm：进程级隔离、队友生成（用于高级场景）

**中间层 —— 调度引擎（新增，从CountBot移植）：**

- WorkflowEngine，4种调度模式
- Pipeline、Graph（DAG）、Council、Parallel

**顶层 —— 入口层（4种触发多Agent的方式）：**

1. 用户指定：在聊天中通过 `@team_name goal` 提及或 `/team` 命令
2. 技能驱动：Skill定义包含调度建议，Agent决定是否采纳
3. Agent自主：Agent使用 `workflow_run` 工具按需创建子Agent
4. 插件注册：插件注册自定义Agent团队和调度策略

**架构图：**

```
+-------------------------------------------------------------------+
|                        Entry Points                                |
|  User Command  |  Skill Suggestion  |  Agent Tool  |  Plugin      |
+-------------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------------+
|                    WorkflowEngine (new)                            |
|  Pipeline  |  Graph (DAG)  |  Council  |  Parallel               |
+-------------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------------+
|                  Existing Core (preserved)                        |
|  AgentRunner  |  Orchestrator  |  Swarm  |  ToolRegistry         |
+-------------------------------------------------------------------+
```

### D.2 调度模式

**Pipeline（管道）模式：**

- 顺序阶段，带累积上下文
- 每个阶段接收所有先前输出
- 用例：研究 -> 整理 -> 分析 -> 报告

**Pipeline模式详情：**

```
Input: { goal: "Analyze case documents", stages: [...] }

Stage 1 (Research Agent):
  input: goal
  output: { findings: [...], documents: [...] }

Stage 2 (Organize Agent):
  input: goal + Stage 1 output
  output: { organizedData: {...}, categories: [...] }

Stage 3 (Analyze Agent):
  input: goal + Stage 1 + Stage 2 output
  output: { analysis: {...], keyPoints: [...] }

Stage 4 (Report Agent):
  input: goal + all prior outputs
  output: { report: "...", references: [...] }

Final: Combined output returned to caller
```

**Graph（DAG）模式：**

- 基于依赖的调度，自动并行化
- 就绪节点（所有依赖已满足）通过Promise.allSettled并行运行
- 条件评估：跳过条件不满足的节点
- 失败传播：上游失败时下游节点标记为FAILED
- 通过DFS进行环检测
- 用例：3个研究Agent并行 -> 分析 -> 报告

**Graph（DAG）模式详情：**

```
Input: {
  nodes: [
    { id: "research-1", task: "Research bank records", dependsOn: [] },
    { id: "research-2", task: "Research witness statements", dependsOn: [] },
    { id: "research-3", task: "Research evidence chain", dependsOn: [] },
    { id: "analyze", task: "Analyze all findings", dependsOn: ["research-1", "research-2", "research-3"] },
    { id: "report", task: "Generate final report", dependsOn: ["analyze"] },
    { id: "optional-review", task: "Legal review", dependsOn: ["report"],
      condition: { type: "output_contains", node: "analyze", text: "legal" }
    }
  ]
}

Execution:
  Round 1: research-1, research-2, research-3 run in parallel
  Round 2: analyze runs (all 3 research complete)
  Round 3: report runs (analyze complete)
  Round 4: optional-review runs only if analyze output contains "legal"
```

**条件评估：**

```typescript
type Condition = {
  type: "output_contains" | "output_not_contains"
  node: string    // which upstream node's output to check
  text: string    // text to search for
}

function evaluateCondition(condition: Condition, nodeOutputs: Map<string, any>): boolean {
  const output = nodeOutputs.get(condition.node)
  const outputText = JSON.stringify(output)
  if (condition.type === "output_contains") {
    return outputText.includes(condition.text)
  }
  return !outputText.includes(condition.text)
}
```

**环检测（DFS）：**

```typescript
function detectCycle(nodes: DAGNode[]): string[] | null {
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const path: string[] = []

  function dfs(nodeId: string): boolean {
    visited.add(nodeId)
    recursionStack.add(nodeId)
    path.push(nodeId)

    const node = nodes.find(n => n.id === nodeId)
    for (const dep of node?.dependsOn ?? []) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true
      } else if (recursionStack.has(dep)) {
        path.push(dep)
        return true // cycle found
      }
    }

    recursionStack.delete(nodeId)
    path.pop()
    return false
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (dfs(node.id)) return path // return cycle path
    }
  }
  return null // no cycle
}
```

**Council（议会）模式：**

- 第一轮：所有成员从各自特定视角进行分析（并行）
- 第二轮（可选交叉评审）：每位成员评审其他成员的观点并优化
- 用例：法律视角 + 财务视角 + 证据视角，带交叉评审

**Council模式详情：**

```
Input: {
  goal: "Evaluate case strength",
  members: [
    { role: "Legal Analyst", perspective: "legal" },
    { role: "Financial Analyst", perspective: "financial" },
    { role: "Evidence Analyst", perspective: "evidence" }
  ],
  crossReview: true
}

Round 1 (Parallel):
  Legal Analyst:   "From legal perspective, the case has strong grounds for..."
  Financial Analyst: "From financial perspective, the money trail shows..."
  Evidence Analyst:  "From evidence perspective, the chain of custody is..."

Round 2 (Cross-Review, if enabled):
  Legal Analyst reviews Financial + Evidence positions:
    "Considering the financial analysis and evidence analysis, the legal
     position is strengthened by..."
  Financial Analyst reviews Legal + Evidence positions:
    "The legal findings confirm the financial anomalies identified..."
  Evidence Analyst reviews Legal + Financial positions:
    "The evidence supports both legal and financial conclusions..."

Synthesis: Combined report with all perspectives and cross-references
```

**Parallel（并行）模式：**

- 现有Orchestrator.runParallel的增强版本
- 协调器自动分解任务，并行运行子任务，综合结果
- 用例：Agent发现5个文档需要阅读 -> 生成5个并行研究Agent

**Parallel模式详情：**

```
Input: { goal: "Research all 5 case documents" }

Decomposition (automatic):
  Sub-task 1: "Research document 1 - 银行流水"
  Sub-task 2: "Research document 2 - 证人证言"
  Sub-task 3: "Research document 3 - 合同副本"
  Sub-task 4: "Research document 4 - 通讯记录"
  Sub-task 5: "Research document 5 - 审计报告"

Execution: All 5 sub-agents run in parallel

Synthesis: Combine results into unified research summary
  - Key findings from each document
  - Cross-references between documents
  - Outstanding questions
```

### D.3 Agent团队数据模型

```typescript
interface AgentTeam {
  id: string;
  name: string;
  description: string;
  mode: "pipeline" | "graph" | "council" | "parallel";
  agents: Array<{
    id: string;
    role: string;
    systemPrompt?: string;
    task: string;
    perspective?: string;     // council only
    dependsOn: string[];      // graph only
    condition?: {             // graph only
      type: "output_contains" | "output_not_contains";
      node: string;
      text: string;
    };
    tools: string[];
  }>;
  isActive: boolean;
  crossReview: boolean;       // council only
  enableSkills: boolean;
  modelConfig?: {             // optional model override
    provider?: string;
    model?: string;
    temperature?: number;
  };
}
```

**Agent团队SQLite Schema：**

```sql
CREATE TABLE agent_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('pipeline', 'graph', 'council', 'parallel')),
  is_active INTEGER NOT NULL DEFAULT 1,
  cross_review INTEGER NOT NULL DEFAULT 0,
  enable_skills INTEGER NOT NULL DEFAULT 0,
  model_config TEXT, -- JSON object
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agent_team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  role TEXT NOT NULL,
  system_prompt TEXT,
  task TEXT NOT NULL,
  perspective TEXT,
  depends_on TEXT, -- JSON array of member IDs
  condition_config TEXT, -- JSON object
  tools TEXT NOT NULL, -- JSON array of tool names
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (team_id) REFERENCES agent_teams(id) ON DELETE CASCADE
);

CREATE INDEX idx_team_members_team ON agent_team_members(team_id);
```

**REST API：**

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/agent-teams` | 列出所有团队 |
| GET | `/api/agent-teams/:id` | 获取团队 |
| POST | `/api/agent-teams` | 创建团队 |
| PUT | `/api/agent-teams/:id` | 更新团队 |
| DELETE | `/api/agent-teams/:id` | 删除团队 |

### D.4 workflow_run 工具

一个注册在ToolRegistry中的新工具，允许任何Agent创建和运行多Agent工作流：

```typescript
{
  name: "workflow_run",
  description: "Create and execute a multi-agent workflow. Specify pipeline/graph/council mode or let the system auto-select.",
  inputSchema: {
    teamName: { type: "string", description: "Existing team name to use (optional)" },
    mode: { type: "string", enum: ["pipeline", "graph", "council", "parallel"] },
    goal: { type: "string", description: "Workflow goal" },
    agents: [{
      id: "string",
      role: "string",
      task: "string",
      dependsOn: { type: "array", items: "string" },
      tools: { type: "array", items: "string" }
    }]
  }
}
```

**Agent调用流程：**

1. Agent判断任务复杂 -> 调用workflow_run
2. WorkflowEngine通过SubAgentManager创建子Agent
3. 每个子Agent通过现有AgentRunner.run()运行
4. WebSocket事件流式传输到前端：workflow_agent_start、workflow_agent_tool_call、workflow_agent_tool_result、workflow_agent_chunk、workflow_agent_complete
5. 结果聚合后返回给调用Agent

**WebSocket事件类型：**

| 事件 | 载荷 | 描述 |
|------|------|------|
| `workflow_start` | `{ workflowId, teamName, mode, agentCount }` | 工作流开始 |
| `workflow_agent_start` | `{ workflowId, agentId, role, task }` | 子Agent启动 |
| `workflow_agent_tool_call` | `{ workflowId, agentId, tool, args }` | 子Agent调用工具 |
| `workflow_agent_tool_result` | `{ workflowId, agentId, tool, result }` | 工具返回结果 |
| `workflow_agent_chunk` | `{ workflowId, agentId, chunk }` | 子Agent的流式文本 |
| `workflow_agent_complete` | `{ workflowId, agentId, status, duration }` | 子Agent完成 |
| `workflow_complete` | `{ workflowId, status, totalDuration, resultCount }` | 工作流完成 |

**workflow_run工具实现方案：**

```typescript
// src/services/agent/tools/workflow-run.ts

async function executeWorkflowRun(input: WorkflowRunInput, context: AgentContext) {
  const workflowId = generateId()

  // Determine team and mode
  const team = input.teamName
    ? await teamManager.getByName(input.teamName)
    : buildAdHocTeam(input)

  const mode = input.mode || team.mode

  // Emit start event
  context.emit("workflow_start", { workflowId, teamName: team.name, mode, agentCount: team.agents.length })

  // Execute via WorkflowEngine
  const engine = new WorkflowEngine(team, context)
  const results = await engine.execute(mode)

  // Aggregate results
  return {
    workflowId,
    mode,
    agentResults: results.map(r => ({
      agentId: r.agentId,
      role: r.role,
      status: r.status,
      output: r.output
    })),
    synthesis: synthesizeResults(results)
  }
}
```

### D.5 前端实时可视化

**SubAgentPanel组件：**

- 在工作流运行时显示
- Agent卡片网格，每个卡片显示：
  - 状态点（颜色编码，运行时有脉冲动画）
  - Agent角色和任务描述
  - 工具调用次数徽章
  - 状态标签：queued / running / waiting / completed / error
  - 持续时间显示
  - 进度条（动画）
  - 可滚动的消息区域，包含：
    - 工具调用卡片（可折叠，显示参数和结果）
    - 流式助手文本
    - 系统消息

**SubAgentPanel布局：**

```
+----------------------------------------------------------+
|  Workflow: Case Analysis          Pipeline Mode    [x]    |
|  4 agents | 2 completed | 1 running | ETA ~30s           |
+----------------------------------------------------------+
|                                                            |
|  +-----------------------+  +-----------------------+     |
|  | [o] Research Agent    |  | [o] Organize Agent    |     |
|  | Status: COMPLETED     |  | Status: COMPLETED     |     |
|  | Duration: 12.3s       |  | Duration: 8.7s        |     |
|  | Tools: 3 calls        |  | Tools: 2 calls        |     |
|  | [========100%]        |  | [========100%]        |     |
|  +-----------------------+  +-----------------------+     |
|                                                            |
|  +-----------------------+  +-----------------------+     |
|  | [*] Analyze Agent     |  | [ ] Report Agent      |     |
|  | Status: RUNNING       |  | Status: QUEUED        |     |
|  | Duration: 5.2s...     |  | Duration: --          |     |
|  | Tools: 1 call         |  | Tools: 0 calls        |     |
|  | [=====   60%]         |  | [        0%]          |     |
|  |                        |  |                       |     |
|  | > kb_search("夏某某")  |  |                       |     |
|  |   Found 15 results     |  |                       |     |
|  | > Analyzing findings.. |  |                       |     |
|  +-----------------------+  +-----------------------+     |
|                                                            |
+----------------------------------------------------------+
```

**状态颜色：**

| 状态 | 点颜色 | 动画 |
|------|--------|------|
| Queued | 灰色 | 无 |
| Running | 绿色 | 脉冲 |
| Waiting | 黄色 | 慢脉冲 |
| Completed | 蓝色 | 无 |
| Error | 红色 | 无 |

**SubAgentSlot（单个Agent卡片）Props：**

```typescript
interface SubAgentSlotProps {
  agentId: string
  role: string
  task: string
  status: "queued" | "running" | "waiting" | "completed" | "error"
  duration: number
  toolCallCount: number
  progress: number  // 0-100
  messages: Array<{
    type: "tool_call" | "tool_result" | "assistant_chunk" | "system"
    content: string
    expanded?: boolean
  }>
}
```

**TeamManager组件：**

- 团队列表以卡片形式展示，带模式徽章
- CRUD操作：创建、编辑、删除、切换启用
- 常见模式的模板预设

**TeamManager布局：**

```
+----------------------------------------------------------+
|  Agent Teams                              [+ New Team]    |
+----------------------------------------------------------+
|                                                            |
|  +------------------------------------------------------+ |
|  | Case Analysis Team                    Pipeline  [ON]  | |
|  | Research -> Organize -> Analyze -> Report             | |
|  | 4 agents | Last used: 2024-01-15                      | |
|  | [Edit] [Duplicate] [Delete]                           | |
|  +------------------------------------------------------+ |
|                                                            |
|  +------------------------------------------------------+ |
|  | Multi-Perspective Review              Council  [ON]   | |
|  | Legal + Financial + Evidence perspectives             | |
|  | 3 agents | Last used: 2024-01-14                      | |
|  | [Edit] [Duplicate] [Delete]                           | |
|  +------------------------------------------------------+ |
|                                                            |
+----------------------------------------------------------+
```

**团队预设模板：**

| 模板 | 模式 | Agent | 用例 |
|------|------|-------|------|
| 研究管道 | Pipeline | Research + Organize + Report | 通用文档研究 |
| 多视角分析 | Council | 3个视角Agent | 平衡分析 |
| 并行研究 | Parallel | N个研究Agent | 快速文档扫描 |
| 全面分析 | Graph | 3个研究 + 分析 + 报告 | 复杂案件分析 |

**TeamEditor组件：**

- 创建/编辑团队的弹窗
- 模式选择下拉菜单
- 每个成员的配置：ID、角色、任务、依赖、工具
- 可视化依赖预览

**TeamEditor布局：**

```
+----------------------------------------------------------+
|  Create Team                                              |
+----------------------------------------------------------+
|                                                            |
|  Name: [Case Analysis Team          ]                     |
|  Description: [Full case analysis pipeline...]            |
|  Mode: [Pipeline v]                                       |
|                                                            |
|  --- Agents ---                                            |
|                                                            |
|  Agent 1:                                                  |
|    Role: [Researcher        ]                              |
|    Task: [Research all case documents]                     |
|    Tools: [kb_search, wiki_browse, expand]                 |
|                                                            |
|  Agent 2:                                                  |
|    Role: [Organizer         ]                              |
|    Task: [Organize findings into categories]               |
|    Tools: [kb_search]                                      |
|                                                            |
|  [+ Add Agent]                                             |
|                                                            |
|  --- Dependency Preview (Graph mode only) ---              |
|                                                            |
|    [Research-1] ---> [Analyze] ---> [Report]               |
|    [Research-2] --/                                     |
|    [Research-3] --/                                     |
|                                                            |
+----------------------------------------------------------+
|  [Cancel]                              [Save Team]        |
+----------------------------------------------------------+
```

**WorkflowStore（Zustand）：**

```typescript
interface WorkflowState {
  // Active workflow
  activeWorkflows: Map<string, {
    workflowId: string
    teamName: string
    mode: string
    startedAt: string
    agents: Map<string, {
      agentId: string
      role: string
      task: string
      status: "queued" | "running" | "waiting" | "completed" | "error"
      duration: number
      toolCallCount: number
      progress: number
      messages: any[]
    }>
  }>

  // Event handlers
  handleWorkflowStart: (event: any) => void
  handleAgentStart: (event: any) => void
  handleAgentToolCall: (event: any) => void
  handleAgentToolResult: (event: any) => void
  handleAgentChunk: (event: any) => void
  handleAgentComplete: (event: any) => void
  handleWorkflowComplete: (event: any) => void

  // Actions
  clearWorkflow: (workflowId: string) => void
}
```

**需要创建的文件：**

- 创建 `src/services/agent/workflow-engine.ts` -- 支持4种模式的WorkflowEngine
- 创建 `src/services/agent/agent-team-manager.ts` -- 团队CRUD + 持久化
- 创建 `src/store/agent-teams.ts` -- 团队的SQLite持久化
- 创建 `src/server/routes/agent-teams.ts` -- REST API路由
- 创建 `frontend/src/components/teams/SubAgentPanel.tsx` -- 实时工作流展示
- 创建 `frontend/src/components/teams/SubAgentSlot.tsx` -- 单个Agent卡片
- 创建 `frontend/src/components/teams/TeamManager.tsx` -- 团队CRUD UI
- 创建 `frontend/src/components/teams/TeamEditor.tsx` -- 团队创建/编辑
- 创建 `frontend/src/store/workflow.ts` -- 工作流状态的Zustand store
- 创建 `frontend/src/api/agentTeams.ts` -- 团队的API客户端

**需要修改的文件：**

- 修改 `src/services/agent/tool-setup.ts` -- 注册workflow_run工具
- 修改 `src/services/agent/agent-system.ts` -- 初始化WorkflowEngine和AgentTeamManager
- 修改 `src/server/app.ts` -- 挂载agent-teams路由
- 修改 `src/ws/handler.ts` -- 处理workflow_* WebSocket事件
- 修改 `frontend/src/store/chat.ts` -- 集成工作流事件
- 修改 `frontend/src/components/ChatWindow.tsx` -- 工作流激活时显示SubAgentPanel
- 修改 `src/services/plugins/plugin-manager.ts` -- 支持来自插件的团队调度策略
- 扩展 `SkillDefinition` 类型 -- 添加可选的 `scheduling` 字段用于多Agent建议

### D.6 与现有系统集成

**保留不变的内容（不做修改）：**

- AgentRunner.run() -- 核心执行循环不变
- ToolRegistry -- 所有现有工具保留
- Orchestrator.runSingle/runParallel/runCoordinated -- 作为替代调度路径保留
- PluginManager -- 扩展但向后兼容
- 会话记忆、压缩、自动dream -- 全部保留

**新增内容：**

- WorkflowEngine位于Orchestrator和AgentRunner之间，作为新的调度层
- workflow_run工具赋予Agent自我组织的能力
- AgentTeamManager提供持久的团队模板
- 前端组件提供实时可视化

**调用链：**

```
User/Skill/Agent -> workflow_run tool -> WorkflowEngine -> SubAgentManager -> AgentRunner.run()
```

**详细调用链：**

```
1. User types "@case-analysis-team Analyze the case"
   OR Agent autonomously decides to call workflow_run
   OR Skill triggers workflow

2. workflow_run tool receives input

3. WorkflowEngine created with team definition
   - If teamName provided, load from AgentTeamManager (SQLite)
   - If agents array provided, create ad-hoc team
   - Determine mode (pipeline/graph/council/parallel)

4. WorkflowEngine.execute() called
   - Pipeline: run agents sequentially, accumulate context
   - Graph: build DAG, run ready nodes in parallel, propagate results
   - Council: run all members in parallel, optional cross-review round
   - Parallel: decompose task, run all sub-tasks in parallel, synthesize

5. For each sub-agent:
   - SubAgentManager creates new AgentRunner instance
   - AgentRunner.run() called with task + context + tools
   - Events emitted via onEvent callback

6. Events flow to frontend:
   - AgentRunner.onEvent -> WebSocket.emit -> Frontend WorkflowStore -> SubAgentPanel re-render

7. Results aggregated:
   - All sub-agent outputs collected
   - Synthesis performed (mode-specific)
   - Result returned to calling Agent
   - Calling Agent continues with workflow results
```

**事件链：**

```
AgentRunner -> onEvent callback -> WebSocket -> Frontend WorkflowStore -> SubAgentPanel update
```

**向后兼容性说明：**

- 所有现有的单Agent工作流无需任何修改即可继续工作
- Orchestrator方法对于直接使用它们的代码仍然可用
- 插件API是扩展的（而非替换）-- 现有插件无需修改即可工作
- workflow_run工具是可选的 -- 不需要多Agent的Agent永远不会使用它
- 前端优雅地处理工作流事件的缺失（SubAgentPanel仅在激活时显示）

---

## 实现优先级

| 优先级 | 模块 | 理由 |
|--------|------|------|
| P0 | 模块A（上传 + 持久化） | 基础：上传和状态是前提条件 |
| P1 | 模块B（统一搜索） | 核心交互：搜索是主要的知识发现工具 |
| P2 | 模块C（报告 + 聊天） | 依赖B：引用需要搜索来预览来源 |
| P3 | 模块D（多Agent） | 最复杂：需要A+B+C的稳定基础 |

**各模块预估工作量：**

| 模块 | 新文件 | 修改文件 | 预估工作量 |
|------|--------|----------|------------|
| A（上传 + 持久化） | 1 | 5 | 3-4天 |
| B（统一搜索） | 4 | 4 | 4-5天 |
| C（报告 + 聊天） | 5 | 3 | 3-4天 |
| D（多Agent） | 10 | 7 | 7-10天 |
| **合计** | **21** | **17** | **17-23天** |

---

## 跨模块依赖

- 模块C的引用预览依赖模块B的搜索API
- 模块D的workflow_run可以使用所有现有工具，包括B的工具（kb_search、wiki_browse、expand）
- 模块A的URL路由影响所有视图的访问方式
- 模块B的LevelSwitcher在搜索结果和Wiki浏览（模块A的知识面板）中均有使用

**依赖图：**

```
Module A (Upload + Persistence)
    |
    v
Module B (Unified Search)
    |       \
    v        v
Module C (Report + Chat)    Module D (Multi-Agent)
    |                              |
    +-- C depends on B -----------+
    +-- D uses B's tools ---------+
    +-- D uses A's routing -------+
```

---

## 完整文件清单

### 需要创建的新文件（21个文件）

| # | 文件路径 | 模块 | 用途 |
|---|----------|------|------|
| 1 | `frontend/src/router.tsx` | A | 使用react-router的URL路由 |
| 2 | `src/server/routes/search.ts` | B | 统一搜索端点 |
| 3 | `frontend/src/components/search/UnifiedSearch.tsx` | B | 带层级标签的搜索UI |
| 4 | `frontend/src/components/search/SearchResultCard.tsx` | B | 单个结果卡片 |
| 5 | `frontend/src/components/search/PreviewCard.tsx` | B | 悬停预览组件 |
| 6 | `frontend/src/components/search/LevelSwitcher.tsx` | B | 可复用的层级切换组件 |
| 7 | `frontend/src/components/chat/ReportCard.tsx` | C | 嵌入式报告组件 |
| 8 | `frontend/src/components/chat/ReferenceMarker.tsx` | C | 带悬停的[n]标记 |
| 9 | `frontend/src/components/chat/EntityLink.tsx` | C | 带悬停的实体链接 |
| 10 | `src/services/report/cleaner.ts` | C | 去噪管道 |
| 11 | `src/store/reports.ts` | C | 报告持久化（SQLite） |
| 12 | `src/services/agent/workflow-engine.ts` | D | 支持4种模式的WorkflowEngine |
| 13 | `src/services/agent/agent-team-manager.ts` | D | 团队CRUD + 持久化 |
| 14 | `src/store/agent-teams.ts` | D | 团队的SQLite持久化 |
| 15 | `src/server/routes/agent-teams.ts` | D | REST API路由 |
| 16 | `frontend/src/components/teams/SubAgentPanel.tsx` | D | 实时工作流展示 |
| 17 | `frontend/src/components/teams/SubAgentSlot.tsx` | D | 单个Agent卡片 |
| 18 | `frontend/src/components/teams/TeamManager.tsx` | D | 团队CRUD UI |
| 19 | `frontend/src/components/teams/TeamEditor.tsx` | D | 团队创建/编辑 |
| 20 | `frontend/src/store/workflow.ts` | D | 工作流状态的Zustand store |
| 21 | `frontend/src/api/agentTeams.ts` | D | 团队的API客户端 |

### 需要修改的现有文件（17个文件）

| # | 文件路径 | 模块 | 变更 |
|---|----------|------|------|
| 1 | `frontend/src/components/knowledge/KnowledgePanel.tsx` | A, B | 非阻塞上传、批量操作、统一布局、LevelSwitcher |
| 2 | `frontend/src/api/client.ts` | A | 带超时和重试的上传 |
| 3 | `src/server/routes/knowledge.ts` | A, B | 上传确认、层级参数 |
| 4 | `frontend/src/App.tsx` | A | 集成路由器 |
| 5 | `frontend/src/store/ui.ts` | A | 同步状态到localStorage和URL |
| 6 | `frontend/src/store/chat.ts` | A, D | 持久化会话ID、集成工作流事件 |
| 7 | `src/wiki/retriever.ts` | B | 带关键词高亮的多层级搜索 |
| 8 | `frontend/src/components/ChatWindow.tsx` | C, D | 渲染ReportCard、显示SubAgentPanel |
| 9 | `src/server/routes/chat.ts` | C | 内联返回报告数据与聊天消息 |
| 10 | `src/services/agent/tools/report-generate.ts` | C | 生成带引用标记的干净输出 |
| 11 | `src/server/routes/reports.ts` | C | 报告的CRUD API |
| 12 | `src/services/agent/tool-setup.ts` | D | 注册workflow_run工具 |
| 13 | `src/services/agent/agent-system.ts` | D | 初始化WorkflowEngine和AgentTeamManager |
| 14 | `src/server/app.ts` | D | 挂载agent-teams路由 |
| 15 | `src/ws/handler.ts` | D | 处理workflow_* WebSocket事件 |
| 16 | `src/services/plugins/plugin-manager.ts` | D | 支持来自插件的团队调度策略 |
| 17 | `src/services/plugins/types.ts` | D | 扩展SkillDefinition，添加可选的 `scheduling` 字段 |
