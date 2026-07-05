# 第 2 册：整体架构与数据模型

> **文档日期**: 2026-04-20
> **来源**: 综合 04-08 初始设计、04-14 系统重新设计、04-15 三层架构重新设计、04-17 PG 迁移设计
> **最新状态**: 以 04-15/04-17 设计为准

---

## 1. 整体架构

### 1.1 架构总览

```
+---------------------------------------------------------------------+
|                        DeepAnalyze 单进程                            |
|                                                                     |
|  +-- React SPA 前端 ----------------------------------------------+ |
|  |  聊天对话 | 知识库浏览 | 报告查看 | 任务面板 | 设置 | Teams   | |
|  +------------------------------+---------------------------------+ |
|                                 | WebSocket + REST API + SSE       |
|  +-- Agent Service (TS/Bun) ---+--------------------------------+  |
|  |                                                             |  |
|  |  +-- 核心Harness (来自Claude Code) ---------------------+|  |
|  |  |  Query Loop (TAOR: Think-Act-Observe-Reflect)       ||  |
|  |  |  Tool Registry & Orchestration                       ||  |
|  |  |  Parent-Child Agent Dispatch (AgentTeams)             ||  |
|  |  |  Context Compaction & Memory                         ||  |
|  |  |  Streaming Response Pipeline                         ||  |
|  |  +------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- WorkflowEngine (来自CountBot) ---------------------+|  |
|  |  |  4种调度模式: 顺序/并行/委员会/图谱                    ||  |
|  |  |  AbortController 取消支持                             ||  |
|  |  |  结果持久化到 agent_tasks 表                          ||  |
|  |  +------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- 模型接入层 -----------------------------------------+|  |
|  |  |  ModelRouter (DB-first, YAML fallback)                ||  |
|  |  |  22+ Provider 统一路由 (OpenAI兼容协议)                ||  |
|  |  |  CapabilityDispatcher (增强模型调度)                   ||  |
|  |  |  CircuitBreaker (熔断降级)                            ||  |
|  |  +------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- 服务层 ---------------------------------------------+|  |
|  |  |  HTTP/WS Server (Hono)                                ||  |
|  |  |  Session Manager                                      ||  |
|  |  |  ProcessingQueue (文档处理队列)                       ||  |
|  |  +------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- Wiki知识引擎 ---------------------------------------+|  |
|  |  |  WikiCompiler (Raw→Structure→Abstract 三层编译)       ||  |
|  |  |  AnchorGenerator (锚点系统)                           ||  |
|  |  |  Retriever (融合检索: 向量 + zhparser FTS + RRF)     ||  |
|  |  |  Expander (按需 Raw 层访问)                           ||  |
|  |  |  Linker (交叉引用，已冻结)                            ||  |
|  |  |  Indexer (嵌入索引管理)                               ||  |
|  |  +------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- 工具集 ---------------------------------------------+|  |
|  |  |  保留: Read/Grep/Glob/WebSearch/Bash/FileEdit/...     ||  |
|  |  |  新增: kb_search/kb_browse/kb_expand/kb_ingest/...   ||  |
|  |  |  增强: web_search(SearXNG/Serper)/...                 ||  |
|  |  +------------------------------------------------------+|  |
|  |                                                             |  |
|  +-------------------------------------------------------------+  |
|                                                                     |
|  +-- 子进程管理 --------------------------------------------------+ |
|  |  Docling Parser (Python) -- 进程池管理，主程序启停             | |
|  |  Ollama (可选) -- 本地嵌入模型推理                             | |
|  +---------------------------------------------------------------+ |
|                                                                     |
|  +-- PostgreSQL 数据库 ------------------------------------------+ |
|  |  +-- 元数据表 (文档、会话、消息、设置)                        | |
|  |  +-- 向量索引 (pgvector HNSW)                                | |
|  |  +-- 全文索引 (zhparser 中文分词)                             | |
|  |  +-- Wiki 页面表 + 锚点表 + 链接表                           | |
|  |  +-- Agent 团队表 + 任务表                                    | |
|  |  +-- 定时任务表 + 插件表 + 技能表                             | |
|  |  +-- 审计日志表                                              | |
|  +---------------------------------------------------------------+ |
+---------------------------------------------------------------------+
```

### 1.2 运行模型

- **单进程启动**：`python start.py start` 启动 Bun 主进程，自动拉起 Docling Python 子进程
- **前端服务**：内嵌静态文件服务，浏览器访问 `http://localhost:21000`
- **数据目录**：可通过配置指定，支持外部存储/U盘迁移
- **模型配置**：首次配置 LLM/嵌入模型端点，支持本地 ONNX 或远端 API
- **Docker 部署**：docker-compose 一键启动（含 PostgreSQL）

### 1.3 三层系统架构（04-14 提出）

从系统职责角度，分为三层：

```
输入层（上传 + 聊天）
    ↓
核心引擎（搜索 + Agent + 报告 + Wiki编译）
    ↓
展示层（嵌入式报告 + 状态持久化 + 多媒体预览）
```

---

## 2. 三层数据模型（核心设计）

> **重大架构变更** (04-15)：原 L0(摘要)/L1(概览)/L2(全文) 已变更为 **Raw(原始层)/Structure(结构层)/Abstract(摘要层)**

### 2.1 三层定义

```
┌─────────────────────────────────────────────────────────────┐
│ Abstract 层（顶层）                                          │
│ ├── 内容：超级摘要(100-300字) + 目录大纲 + 标签 + 文档类型    │
│ ├── 生成：LLM 从 Structure 层输入生成                        │
│ ├── 检索：仅向量检索（用于文档级路由）                        │
│ └── 存储：wiki_pages (page_type='abstract')                  │
├─────────────────────────────────────────────────────────────┤
│ Structure 层（中层）  ← 替代原 L2+L1                        │
│ ├── 内容：DocTags / Markdown，按章节自然分块                 │
│ ├── 生成：从 Raw 层自动导出（不需要 LLM）                    │
│ ├── 检索：BM25 + 向量 + grep 的主战场                       │
│ ├── 每块携带：anchor_ids, doc_id, kb_id, page_number,       │
│ │             section_heading, word_count                    │
│ └── 存储：wiki_pages (page_type='structure')                │
├─────────────────────────────────────────────────────────────┤
│ Raw 层（底层）                                               │
│ ├── 内容：完整 DoclingDocument JSON / ASR转写 / 视频描述     │
│ ├── 格式：各模态原生结构化 JSON                              │
│ ├── 存储：文件系统（不建索引，按需读取）                     │
│ └── 路径：{dataDir}/raw/{kbId}/{docId}/docling.json         │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 层级对比（变更前后）

| 维度 | 原 L2→L1→L0 | 新 Raw→Structure→Abstract |
|------|-------------|-------------------------|
| 底层格式 | Markdown 文本 | DoclingDocument JSON |
| 中层生成 | LLM 生成概览 | Docling 直接导出 DocTags，无需 LLM |
| 中层分块 | 整篇为一个页面 | 按章节标题自然分块，每块独立页面 |
| 结构信息 | 全部丢失 | 零损失 |
| 追溯粒度 | 页面级 | 元素级（段落/表格/图片） |
| 锚点 | 无 | 有（anchor_id） |

### 2.3 Structure 层分块策略

- 按 h1/h2 标题将 DocTags 文本分为章节块
- h1 标题创建新块（第一级分块）
- h2 标题创建子块（第二级分块）
- h3+ 不单独分块，归入最近的 h2 块
- 无标题的内容归入"概述"块
- 表格（XLSX/XLS/CSV）：Excel 每个 Sheet 作为一个块，CSV 整体作为一个块
- 音频：按发言人分段
- 视频：按时段分场景

### 2.4 各模态在三层中的表现

| 模态 | Raw 层 | Structure 层 | Abstract 层 |
|------|--------|-------------|-------------|
| **文档(PDF/Word等)** | DoclingDocument JSON | DocTags按章节分块 | LLM生成的摘要+标签 |
| **图片** | 完整VLM描述+OCR+EXIF+尺寸 | VLM描述+OCR文字+元数据标签 | 主题摘要 |
| **音频** | ASR转写JSON(含时间戳+发言人) | 按发言人分段的转写文本 | 主题摘要+发言人数+关键观点 |
| **视频** | 场景描述JSON+ASR转写JSON+帧数据 | 按场景/时段分段(画面+对话) | 主题摘要+场景数+关键事件 |

### 2.5 文件存储结构

```
{dataDir}/
  raw/
    {kbId}/
      {docId}/
        docling.json              — 完整 DoclingDocument JSON（Raw 层）
        metadata.json             — 元数据快照
        thumb.webp                — 图片缩略图（仅图片文件）
        frames/                   — 视频关键帧缩略图（仅视频文件）

  wiki/
    {kbId}/
      documents/
        {docId}/
          structure/              — Structure 层目录
            00_overview.md        — 文档整体概述块
            01_{heading}.md       — 按章节标题分块
            01_{heading}.doctags  — 同块的 DocTags 版本
          .abstract.md            — Abstract 层

  original/
    {kbId}/
      {docId}/
        {original_filename}       — 用户上传的原始文件（保留原文件名）

  models/
    docling/                      — Docling 模型文件
      layout/                     — 布局模型
      table/                      — 表格模型
      vlm/                        — VLM 模型
      ocr/                        — OCR 模型

  embeddings/                     — 本地嵌入缓存（如果使用本地模型）
```

### 2.6 双名称体系

- **内部 ID**：UUID（如 `550e8400-e29b-41d4-a716-446655440000`）
- **用户可见名**：原始文件名（如 `2024年度审计报告.pdf`）
- 文件系统目录使用 UUID，避免中文路径和重名问题
- API 响应中同时返回 `id` 和 `originalName` 字段

---

## 3. 锚点系统

### 3.1 设计目标

实现从 Abstract 层 → Structure 层 → Raw 层的精确元素级追溯。

### 3.2 锚点 ID 格式

```
docId:elementType:index
```

- `docId`：文档 UUID
- `elementType`：元素类型（`paragraph` | `table` | `image` | `heading` | `code`）
- `index`：该类型元素在文档中的顺序编号（0-based，同级递增）

示例：`550e8400:paragraph:42`

### 3.3 锚点属性

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `docId:elementType:index` |
| `doc_id` | string | 所属文档 |
| `element_type` | string | 元素类型 |
| `element_index` | number | 顺序编号 |
| `content_hash` | string | 元素内容的 SHA-256 前缀 |
| `content_preview` | string | 前 100 字符预览 |
| `page_number` | number | PDF 页码（仅 PDF） |
| `position` | JSON | Docling 中的 bbox/行号 |
| `structure_page_id` | string | 关联的 Structure 层页面 ID |

### 3.4 锚点生成流程

```
DoclingDocument JSON (Raw层)
    ↓ AnchorGenerator
    ↓ 遍历 body 元素，为每个 paragraph/table/image/heading 生成锚点
    ↓ 写入 anchors 表
    ↓ 关联到 Structure 层页面（structure_page_id）
```

### 3.5 溯源流程

```
用户看到 Abstract 摘要中的某个结论
  → 点击展开 → 看到 Structure 层的 DocTags 块（携带 anchor_ids）
  → 点击锚点 → 加载 Raw 层对应 JSON 片段
  → 定位到原始文档的具体段落/表格/图片
```

---

## 4. 数据库基础设施

### 4.1 PostgreSQL 迁移决策

**决策日期**: 04-15 设计，04-17 完成迁移方案

**迁移原因**:

| SQLite 不足 | PostgreSQL 解决方案 |
|-------------|-------------------|
| 无原生向量支持 | pgvector HNSW 索引，百万级毫秒检索 |
| FTS5 unicode61 对中文分词效果差 | zhparser (jieba 级) 中文分词 |
| 单写锁，高并发写性能差 | MVCC 多版本并发控制 |
| 无 JSONB 类型 | JSONB 高效查询和索引 |
| 单机单文件 | 支持网络连接、流复制、WAL |

**迁移后删除的文件**:
- `src/store/database.ts` (SQLite 单例)
- `src/store/migrations/001-010` (SQLite 迁移)
- `src/store/sessions.ts`, `messages.ts`, `knowledge-bases.ts`, `wiki-pages.ts`, `documents.ts`, `settings.ts`, `settings-reader.ts`, `reports.ts`, `agent-teams.ts`
- `data/deepanalyze.db` (SQLite 数据库文件)

### 4.2 Repository 抽象层

所有数据库操作通过 Repository 接口访问，业务代码不直接操作 SQL。

```
Consumer Files (37 files)
    │
    ▼
Repository Interfaces (repos/interfaces.ts) — 17 个接口
    │
    ▼
PG Implementations (repos/*.ts)
    │
    ▼
PostgreSQL + pgvector + zhparser
```

**RepoSet 完整接口列表**:

| 接口 | 职责 | 状态 |
|------|------|------|
| `VectorSearchRepo` | 向量嵌入 upsert/search/delete | 已有 |
| `FTSSearchRepo` | 全文检索 upsert/search/delete | 已有 |
| `AnchorRepo` | 锚点批量写入/查询/删除 | 已有 |
| `WikiPageRepo` | Wiki 页面 CRUD | 已有，需扩展 |
| `DocumentRepo` | 文档 CRUD + 处理状态 | 已有，需扩展 |
| `EmbeddingRepo` | 嵌入管理 + stale 标记 | 已有，需扩展 |
| `SessionRepo` | 会话 CRUD | 新增 |
| `MessageRepo` | 消息写入/列表 | 新增 |
| `KnowledgeBaseRepo` | 知识库 CRUD | 新增 |
| `WikiLinkRepo` | Wiki 链接关系 | 新增 |
| `SettingsRepo` | 设置 KV + Provider 配置 | 新增 |
| `ReportRepo` | 报告 CRUD + 引用 | 新增 |
| `AgentTeamRepo` | Agent 团队 CRUD | 新增 |
| `CronJobRepo` | 定时任务调度 | 新增 |
| `PluginRepo` | 插件管理 | 新增 |
| `SkillRepo` | 技能管理 | 新增 |
| `SessionMemoryRepo` | 会话记忆持久化 | 新增 |
| `AgentTaskRepo` | Agent 任务状态 | 新增 |

### 4.3 PG Schema (迁移后)

```
pg-migrations/
├── 001_init.ts                # 核心表：documents, wiki_pages, embeddings, knowledge_bases
├── 002_anchors_structure.ts   # 锚点索引
├── 003_minimax_providers.ts   # 初始 Provider 数据
├── 004_reports_and_teams.ts   # 报告 + Agent 团队表
└── 005_embedding_stale.ts     # 嵌入 stale 标记

关键表：
- documents: 文档元数据 + 处理状态
- wiki_pages: 三层页面（abstract/structure/raw 引用）
- anchors: 锚点系统
- embeddings: 向量嵌入（关联 wiki_pages）
- wiki_links: 页面间链接（已冻结）
- sessions, messages: 对话历史
- knowledge_bases: 知识库
- settings: KV 配置 + Provider JSON
- reports, report_references: 分析报告
- agent_teams, agent_team_members: Agent 团队
- agent_tasks: 工作流任务持久化
- cron_jobs: 定时任务
- plugins, skills: 插件系统
```

### 4.4 设计原则

| 原则 | 说明 |
|------|------|
| 所有 Repo 方法都是 async | PG 驱动天然异步，统一接口 |
| RepoSet 单例 `getRepos()` | 避免传递 repo 实例，首次初始化后缓存 |
| 文件系统操作在 Repo 外 | Wiki 文件读写留在 wiki 子系统，Repo 只管数据库 |
| PG 是唯一后端 | 不保留 SQLite 切换逻辑 |
| Wiki 子系统接收 RepoSet 注入 | Linker/Indexer/Compiler 通过构造函数注入 |
