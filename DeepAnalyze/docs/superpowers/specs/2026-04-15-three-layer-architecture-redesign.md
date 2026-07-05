# DeepAnalyze 三层架构重新设计 — 设计规格文档

**版本：** 1.1（新增数据库基础设施升级章节）
**日期：** 2026-04-15
**状态：** 已评审，待实施

---

## 1. 背景与问题陈述

### 1.1 当前系统架构概述

DeepAnalyze 是一个多模态知识库分析系统，核心能力包括：文档解析（Docling）、知识库管理、智能检索（BM25 + 向量 + RRF 融合）、多 Agent 协作分析、报告生成。系统采用 TypeScript/Node.js 后端 + React 前端，数据存储使用 SQLite（better-sqlite3），文档解析通过 Python Docling 微服务完成。

**当前三层 Wiki 架构：**

```
L2 (fulltext)  — Docling 导出的 Markdown 原文
L1 (overview)  — LLM 从 L2 生成的概览文本
L0 (abstract)  — LLM 从 L1 生成的摘要文本
```

**当前数据处理流程：**

```
上传文件 → DoclingProcessor → Markdown 文本 → WikiCompiler (5步) → 检索索引
```

### 1.2 核心问题

经过对系统深入分析和多轮讨论，识别出以下核心问题：

**问题 1：结构信息完全丢失**
Docling 解析文档后生成 DoclingDocument——一个强类型的树状结构化 JSON，包含标题层级、表格单元格坐标、图片位置、公式、页码、阅读顺序等全部语义信息。但当前系统只调用 `doc.export_to_markdown()` 获取 Markdown 文本，丢弃了所有结构信息。这意味着：
- 表格失去精确的行列坐标和合并单元格信息
- 图片失去在文档中的位置上下文
- 公式失去原始表达式
- 无法从检索结果追溯到底层原始元素

**问题 2：检索粒度过粗**
当前系统的追溯粒度是 `wiki_pages` 表的 `page_id`——一整个页面。用户无法定位到具体的段落、表格或图片。Agent 在报告中引用来源时，只能说"来自技术方案.pdf"，无法说"来自技术方案.pdf 第6页 第二章 2.1节 第2段"。

**问题 3：多模态处理不统一**
系统已有 5 种文件处理器（Docling、Image、Audio、Video、Excel），但各处理器的输出格式不统一，没有统一的三层结构，导致：
- 跨模态检索结果格式不一致
- Agent 无法用统一工作流处理不同模态
- 前端无法用统一组件展示不同模态

**问题 4：Agent 输出显示内部 ID**
Agent 在输出中引用文档时使用内部 UUID（如 `doc_abc123`），而非用户上传时的原始文件名。用户看到的报告充满不可读的 ID。

**问题 5：Excel 处理不充分**
Excel 文件包含丰富的表格结构（多 Sheet、公式、合并单元格），Docling 已经能完整提取这些信息（TableItem 结构），但当前系统的 ExcelProcessor 没有利用这些能力。

**问题 6：数据库基础设施不满足企业级需求**
当前使用 SQLite（better-sqlite3）存在三个核心瓶颈：

1. **向量检索是暴力全表扫描**（`src/wiki/retriever.ts:109-156`）：从 `embeddings` 表 SELECT 出指定知识库的全部向量 BLOB，在 JavaScript 中逐一反序列化并计算余弦相似度。没有向量索引（无 HNSW/IVF），复杂度 O(N×D)。随知识库规模增长，检索延迟线性上升：
   - 1,000 向量 ≈ 50ms
   - 10,000 向量 ≈ 500ms
   - 100,000 向量 ≈ 5s
   - 1,000,000 向量 ≈ 50s

2. **FTS5 中文分词缺失**：使用 `unicode61` tokenizer，对中文只能做单字分词（"微服务架构" → "微""服""务""架""构"），召回大量无关内容。没有 jieba/zhparser 级别的中文分词支持。

3. **单连接阻塞事件循环**：better-sqlite3 是同步驱动，所有数据库操作阻塞 Node.js 事件循环。一次向量搜索 500ms 期间，整个服务器无法响应其他请求。多 Agent 并行时，数据库操作互相等待。

### 1.3 设计目标

1. **信息零损失**：保留 Docling 解析的完整结构化数据作为 truth source
2. **元素级追溯**：任何检索结果、报告引用都能精确到段落/表格/图片级别
3. **跨模态统一**：所有文件类型输出相同的三层结构，使用统一的检索和展示方式
4. **向后兼容**：在现有架构上增量演进，不推翻重来
5. **前端可检验**：用户可以在前端逐层查看、验证、导航所有处理结果
6. **企业级性能**：数据库基础设施支撑百万级向量检索（<100ms）、中文全文检索、多用户并发访问

### 1.4 冻结范围

以下模块在本次架构调整中**冻结不修改**，保持现有实现，后续根据需要再优化：

**图谱和正反向关联系统（冻结）：**

| 冻结模块 | 涉及文件 | 冻结原因 |
|---------|---------|---------|
| 跨文档链接构建 | `src/wiki/linker.ts` | 构建成本高，构建速度慢 |
| L0 层关联 | `src/wiki/l0-linker.ts` | 基于标签匹配的关联效果有限 |
| 实体引用链接 | `src/wiki/compiler.ts` 中 `extractAndUpdateLinks()` 的 wiki_links 写入部分 | 与锚点系统功能重叠 |
| 链接遍历检索 | `src/wiki/retriever.ts` 中 `linkedSearch()` | BFS 遍历有 N+1 查询问题，且锚点检索已覆盖 |
| 知识图谱工具 | `src/tools/GraphTool/index.ts` | 依赖 wiki_links 的图谱可视化 |
| 图谱 API | `src/server/routes/reports.ts` 中 `GET /graph/:kbId` | 依赖 wiki_links |
| 知识复合中的实体链接 | `src/wiki/knowledge-compound.ts` 中 `compoundWithEntities()` | 依赖现有链接体系 |

**冻结期间的处理方式：**
- `wiki_links` 表保留不删除，现有数据保持不变
- ProcessingQueue 中的 Step 4（Linking/L0Linker）继续执行但不修改
- Agent 的 GraphTool 继续可用但不增强
- 检索中的 `linkedSearch()` 继续作为 RRF 融合的第三路信号，但不优化
- 新的三层编译流程中，不生成新的 wiki_links 条目（Structure/Abstract 页面不参与图谱构建）

**解冻条件：** 三层架构 + 锚点系统稳定运行后，评估图谱是否仍有增量价值。如果锚点级关联已经足够，可以移除图谱模块；如果仍有需要，再基于锚点重新设计图谱。

---

## 2. 架构设计

### 2.1 核心原则

**在现有架构上增量演进。** 现有模块划分（wiki/、services/agent/、services/document-processors/、store/、server/routes/）是合理的。改动集中在数据层重构、新增锚点系统、Team/Skill 模板更新，不需要改变 Agent 基础设施（AgentRunner、WorkflowEngine、ToolRegistry）。

**不新增 Agent 类型。** 现有 AgentTeam + WorkflowEngine 已支持 pipeline/parallel/council/graph 四种调度模式。并行检索等需求通过定义合适的 Team 模板和 Skills 实现，而非创建新的 Agent 基础设施。

**校验嵌入编译流程，不独立成层。** 数据生成时做校验（compiler 阶段），检索返回时做防御性检查（retriever 阶段），报告生成时做校验（compounder 阶段）。不需要独立的"校验层"。

### 2.2 新的三层数据模型

替代当前的 L2→L1→L0 架构：

```
┌─────────────────────────────────────────────────────────────┐
│ Abstract 层（顶层）                                          │
│ ├── 内容：超级摘要(100-300字) + 目录大纲 + 标签 + 文档类型    │
│ ├── 生成：LLM 从 Structure 层输入生成                        │
│ ├── 检索：仅向量检索（用于文档级路由）                        │
│ └── 存储：wiki_pages (page_type='abstract')                  │
├─────────────────────────────────────────────────────────────┤
│ Structure 层（中层）  ← 替代 L2 + L1                        │
│ ├── 内容：DocTags / Markdown，按章节自然分块                 │
│ ├── 生成：从 Raw 层自动导出（不需要 LLM）                    │
│ ├── 检索：BM25 + 向量 + grep 的主战场                       │
│ ├── 每块携带：anchor_ids, doc_id, kb_id, page_number,       │
│ │             section_heading, word_count                    │
│ └── 存储：wiki_pages (page_type='structure')                 │
├─────────────────────────────────────────────────────────────┤
│ Raw 层（底层）                                               │
│ ├── 内容：完整 DoclingDocument JSON / ASR转写 / 视频描述     │
│ ├── 格式：各模态原生结构化 JSON                              │
│ ├── 存储：文件系统（不建索引，按需读取）                     │
│ └── 路径：{dataDir}/raw/{kbId}/{docId}/docling.json          │
└─────────────────────────────────────────────────────────────┘
```

**关键变化：**

| 维度 | 当前 L2→L1→L0 | 新 Raw→Structure→Abstract |
|------|---------------|--------------------------|
| 底层格式 | Markdown 文本 | DoclingDocument JSON |
| 中层生成 | LLM 生成概览 | Docling 直接导出 DocTags，无需 LLM |
| 中层分块 | 整篇为一个页面 | 按章节标题自然分块，每块独立页面 |
| 结构信息 | 全部丢失 | 零损失 |
| 追溯粒度 | 页面级 | 元素级（段落/表格/图片） |

**Structure 层分块策略：**

- 按 h1/h2 标题将 DocTags 文本分为章节块
- h1 标题创建新块（第一级分块）
- h2 标题创建子块（第二级分块）
- h3+ 不单独分块，归入最近的 h2 块
- 无标题的内容归入"概述"块
- Excel：每个 Sheet 作为一个块

### 2.3 锚点系统设计

锚点（Anchor）是实现元素级追溯的核心机制。

**锚点 ID 格式：** `{docId}:{elementType}:{index}`

```
示例：
  abc123:heading:0      — 第1个标题
  abc123:paragraph:5    — 第6个段落
  abc123:table:2        — 第3个表格
  abc123:image:1        — 第2张图片
  abc123:formula:0      — 第1个公式
```

**设计决策——为什么用位置而非哈希：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| `{docId}:{type}:{index}` | 同文档重编译锚点不变；可解析；简短 | 文档内容变化时索引偏移 |
| `{docId}:{type}:{contentHash}` | 内容变化锚点不变 | 哈希不可读；微改内容也导致哈希变化 |
| `{kbId}:{timestamp}:{random}` | 全局唯一 | 不可解析；同文档重编译锚点全变 |

选择位置方案的原因：同一文档重新编译时，只要结构不变（通常如此），锚点保持一致。已生成的报告中引用的锚点不会失效。

**锚点的层级关联：**

```
Anchor: abc123:paragraph:5
  ├── raw_json_path → DoclingDocument JSON 中 body.children[23]
  ├── structure_page_id → wiki_pages 中 page_type="structure" 的某个分块
  └── abstract 引用 → abstract 页面中目录大纲条目
```

通过锚点，可以实现：
- 报告中点击引用 → 定位到 Structure 层具体段落 → 查看 Raw 层原始数据
- 检索结果展示来源 → 显示原始文件名 + 章节 + 页码
- 跨层导航 → 在三层之间自由跳转

### 2.4 双名称体系

```
┌─────────────────────┐     ┌──────────────────────┐
│ 内部处理             │     │ 用户可见              │
│ doc_abc123           │ ──→ │ 项目方案.pdf          │
│ kb_def456            │ ──→ │ 项目知识库            │
│ page_ghi789          │ ──→ │ 第二章 技术方案        │
└─────────────────────┘     └──────────────────────┘
                  DisplayResolver
```

- 内部使用 UUID 保证唯一性，显示层通过 `DisplayResolver` 转换为原始文件名
- Agent 工具结果自动注入 `originalName` 和 `kbName`，使 LLM 能在输出中使用用户可见的文件名
- 报告生成工具在最终输出前扫描所有 docId 引用，替换为 `知识库名 → 文件名` 格式

---

## 3. 数据模型详细设计

### 3.1 数据库表变更

**新增 anchors 表：**

```sql
CREATE TABLE anchors (
  id                 TEXT PRIMARY KEY,           -- {docId}:{elementType}:{index}
  doc_id             TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kb_id              TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  element_type       TEXT NOT NULL,              -- heading/paragraph/table/image/formula/list/code
  element_index      INTEGER NOT NULL,           -- 同类型中序号（0-based）
  section_path       TEXT,                       -- 层级路径: "1" / "1.2" / "1.2.3"
  section_title      TEXT,                       -- 章节标题文本
  page_number        INTEGER,                   -- 页码（如有）
  raw_json_path      TEXT,                       -- JSON Pointer 到 DoclingDocument 中的位置
  structure_page_id  TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  content_preview    TEXT,                       -- 前 200 字符预览
  content_hash       TEXT,                       -- 内容哈希（用于变更检测）
  metadata           TEXT,                       -- JSON 扩展字段
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_anchors_doc ON anchors(doc_id);
CREATE INDEX idx_anchors_kb ON anchors(kb_id);
CREATE INDEX idx_anchors_structure ON anchors(structure_page_id);
CREATE INDEX idx_anchors_type ON anchors(element_type);
CREATE INDEX idx_anchors_section ON anchors(section_path);
```

**wiki_pages 表 page_type 扩展：**

```sql
-- 当前约束：
CHECK (page_type IN ('abstract','overview','fulltext','entity','concept','report'))

-- 新约束（新增 structure，保留旧值以兼容已有数据）：
CHECK (page_type IN ('abstract','overview','fulltext','structure','entity','concept','report'))
```

新文档编译后，不再生成 `fulltext` 和 `overview` 类型的页面，改为生成 `structure` 类型的页面。

### 3.2 文件存储路径

```
{dataDir}/
  raw/
    {kbId}/
      {docId}/
        docling.json              — 完整 DoclingDocument JSON（Raw 层）
        metadata.json             — 元数据快照

  wiki/
    {kbId}/
      documents/
        {docId}/
          structure/              — Structure 层目录
            00_overview.md        — 文档整体概述块
            01_{heading}.md       — 按章节标题分块
            01_{heading}.doctags  — 同块的 DocTags 版本
          .abstract.md            — Abstract 层（保持不变）
```

### 3.3 Structure 页面 Metadata 结构

每个 Structure 层的 wiki_page 的 metadata JSON 字段：

```typescript
interface StructurePageMetadata {
  anchorIds: string[];              // 该块覆盖的所有锚点 ID
  pageRange: [number, number];      // 涉及的页码范围 [start, end]
  sectionPath: string;              // "1.2.3"
  elementTypes: string[];           // 该块包含的元素类型
  wordCount: number;                // 字数统计
  hasTable: boolean;                // 是否包含表格
  hasImage: boolean;                // 是否包含图片
  hasFormula: boolean;              // 是否包含公式
}
```

### 3.4 Abstract 页面 Metadata 结构

```typescript
interface AbstractPageMetadata {
  documentType: string;             // "报告"/"合同"/"会议纪要"/"数据表" 等
  tags: string[];                   // 关键标签
  keyDates: string[];               // 文档中提到的关键日期
  sectionAnchors: Array<{           // 目录大纲与锚点关联
    title: string;
    path: string;
    anchorId: string;
  }>;
  confidence: number;               // 生成置信度（0-1）
}
```

---

## 4. 数据库基础设施升级设计

### 4.1 方案对比分析

| 维度 | SQLite + sqlite-vec | PostgreSQL + pgvector | PostgreSQL + 外挂向量库 |
|------|---------------------|----------------------|----------------------|
| **向量检索性能** | sqlite-vec（实验性，HNSW 支持 2024 年底才加入，稳定性未验证） | pgvector HNSW（生产级，毫秒级百万向量） | Qdrant/Milvus（专业级，但增加系统复杂度） |
| **中文全文检索** | 需编译 jieba C 扩展或用 simple tokenizer（效果差） | zhparser/pg_jieba 扩展（成熟中文分词） | 需外挂 Elasticsearch |
| **并发能力** | 单连接阻塞事件循环 | 连接池 + 真正并发 + MVCC | 取决于外挂服务 |
| **JSONB 查询** | JSON 扩展函数有限 | 原生 JSONB + GIN 索引 | 取决于主数据库 |
| **运维复杂度** | 零（文件数据库） | 需要 PG 服务（Docker 一键部署） | 需要额外服务维护 |
| **迁移成本** | 低 | 中 | 高 |
| **扩展性** | 单机上限 | 支持读写分离、分库 | 分布式 |
| **生态** | 扩展生态弱 | 极其丰富（PostGIS、pg_cron 等） | 各自独立 |

### 4.2 推荐方案：PostgreSQL + pgvector

**选择理由：**

1. **向量检索是企业级系统的核心能力，不能妥协。** pgvector 提供生产级 HNSW 索引，百万级向量检索 <100ms。SQLite 生态中没有任何同等能力的方案。sqlite-vec 仍在实验阶段，不适合生产环境。

2. **中文全文检索是中文用户的基本需求。** PostgreSQL 的 zhparser 扩展提供 jieba 级别的中文分词，FTS5 的 unicode61 tokenizer 在中文场景下几乎不可用。

3. **多 Agent 并发是架构的必然方向。** 三层架构改造后，Agent 并行检索会成为常态。PostgreSQL 的 MVCC 和连接池天然支持并发，SQLite 的单连接阻塞会成为瓶颈。

4. **JSONB 对 metadata 查询至关重要。** 新增的锚点系统、Structure 块 metadata 都需要结构化 JSON 查询。PostgreSQL 的 JSONB + GIN 索引比 SQLite 的 TEXT JSON 字段高效得多。

5. **统一数据基础设施。** 一个 PostgreSQL 实例提供关系数据 + 全文检索 + 向量检索，各模块使用不同的表完成业务，不需要额外引入 Qdrant、Elasticsearch 等独立服务。

### 4.3 迁移策略：Repository 抽象层

**不是简单替换 SQL 方言，而是构建 Repository 抽象层隔离底层实现。**

```
┌──────────────────────────────────────────────────────┐
│                   业务代码层                          │
│  wiki/compiler.ts, agent/orchestrator.ts, etc.       │
├──────────────────────────────────────────────────────┤
│               Repository 抽象层（新增）               │
│  AnchorRepo, WikiPageRepo, DocumentRepo, EmbeddingRepo │
│  VectorSearchRepo, FTSSearchRepo, SessionRepo, ...    │
├──────────────────────────────────────────────────────┤
│              数据库驱动适配层                          │
│  PostgreSQL 适配（主） │  SQLite 适配（兼容/测试）     │
├──────────────────────────────────────────────────────┤
│  PostgreSQL + pgvector  │  SQLite + better-sqlite3    │
└──────────────────────────────────────────────────────┘
```

**Repository 接口定义（关键部分）：**

```typescript
// 向量检索 — 核心差异点
interface VectorSearchRepo {
  /** 存储向量嵌入 */
  upsertEmbedding(id: string, pageId: string, vector: Float32Array,
                  textChunk: string, modelName: string): Promise<void>;

  /** 向量相似度搜索（底层使用 pgvector 的 <=> 操作符 + HNSW 索引） */
  searchByVector(queryVector: Float32Array, kbIds: string[],
                 options: { topK: number; minScore?: number;
                           pageTypes?: string[] }): Promise<VectorSearchResult[]>;

  /** 删除指定页面的嵌入 */
  deleteByPageId(pageId: string): Promise<void>;
}

// 全文检索 — 中文分词差异点
interface FTSSearchRepo {
  /** 创建/更新全文索引 */
  upsertFTSEntry(pageId: string, title: string, content: string): Promise<void>;

  /** BM25 搜索（底层使用 PG tsvector + zhparser 或 SQLite FTS5） */
  searchByText(query: string, kbIds: string[],
               options: { topK: number }): Promise<FTSSearchResult[]>;

  /** 删除全文索引条目 */
  deleteByPageId(pageId: string): Promise<void>;
}

// 锚点 — 新增能力
interface AnchorRepo {
  batchInsert(anchors: AnchorDef[]): Promise<void>;
  getByDocId(docId: string): Promise<AnchorDef[]>;
  getById(anchorId: string): Promise<AnchorDef | null>;
  getByStructurePageId(pageId: string): Promise<AnchorDef[]>;
  updateStructurePageId(anchorIds: string[], pageId: string): Promise<void>;
  deleteByDocId(docId: string): Promise<void>;
}

// Wiki 页面 — 扩展
interface WikiPageRepo {
  create(page: WikiPageCreate): Promise<WikiPage>;
  getById(id: string): Promise<WikiPage | null>;
  getByDocAndType(docId: string, pageType: string): Promise<WikiPage[]>;
  getByKbAndType(kbId: string, pageType: string): Promise<WikiPage[]>;
  updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void>;
  deleteById(id: string): Promise<void>;
}
```

**迁移优势：**
- 业务代码只依赖 Repository 接口，不直接写 SQL
- 可以先实现 PostgreSQL 适配器，SQLite 适配器用于测试环境
- 逐步迁移：先实现 VectorSearchRepo（解决最紧迫的向量检索问题），再迁移其他 Repo
- 未来如果需要支持其他数据库（如 MySQL），只需添加新的适配器

### 4.4 PostgreSQL Schema 设计

以下是与 SQLite Schema 的关键差异：

**向量存储（pgvector）：**

```sql
-- 启用扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- embeddings 表使用 pgvector 的 vector 类型替代 BLOB
CREATE TABLE embeddings (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  model_name   TEXT NOT NULL,
  dimension    INTEGER NOT NULL,
  vector       vector(dimension) NOT NULL,   -- pgvector vector 类型
  text_chunk   TEXT,
  chunk_index  INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW 索引 — 核心性能提升
CREATE INDEX idx_embeddings_vector ON embeddings
  USING hnsw (vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

向量检索从暴力全表扫描变为索引查询：

```sql
-- 当前（SQLite）：加载所有向量到 JS 内存，逐一计算相似度
-- 新（pgvector）：一条 SQL 利用 HNSW 索引
SELECT e.id, e.page_id, e.text_chunk,
       1 - (e.vector <=> $queryVector) as similarity,
       wp.kb_id, wp.doc_id, wp.page_type, wp.title
FROM embeddings e
JOIN wiki_pages wp ON wp.id = e.page_id
WHERE wp.kb_id = ANY($kbIds)
  AND e.model_name = $modelName
ORDER BY e.vector <=> $queryVector
LIMIT $topK;
```

**中文全文检索（zhparser）：**

```sql
-- 启用中文分词扩展
CREATE EXTENSION IF NOT EXISTS zhparser;

-- 创建中文全文搜索配置
CREATE TEXT SEARCH CONFIGURATION chinese (PARSER = zhparser);
ALTER TEXT SEARCH CONFIGURATION chinese ADD MAPPING FOR n,v,a,i,e,l WITH simple;

-- wiki_pages 表增加 tsvector 列
ALTER TABLE wiki_pages ADD COLUMN fts_vector tsvector;

-- 创建 GIN 索引
CREATE INDEX idx_wiki_pages_fts ON wiki_pages USING gin(fts_vector);

-- 更新触发器：插入/更新时自动维护 tsvector
CREATE OR REPLACE FUNCTION wiki_pages_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('chinese', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('chinese', COALESCE(NEW.content_text, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wiki_pages_fts
  BEFORE INSERT OR UPDATE OF title, content_text ON wiki_pages
  FOR EACH ROW EXECUTE FUNCTION wiki_pages_fts_trigger();
```

全文检索查询：

```sql
-- 当前（SQLite FTS5）：unicode61 单字分词，中文效果差
-- 新（PostgreSQL zhparser）：jieba 级别中文分词
SELECT wp.id, wp.title,
       ts_rank(wp.fts_vector, query) as rank
FROM wiki_pages wp, to_tsquery('chinese', $searchTerms) query
WHERE wp.fts_vector @@ query
  AND wp.kb_id = ANY($kbIds)
ORDER BY rank DESC
LIMIT $topK;
```

**JSONB 替代 TEXT JSON：**

```sql
-- 当前（SQLite）：metadata 是 TEXT 类型，需要 JSON_EXTRACT 解析
-- 新（PostgreSQL）：使用 JSONB + GIN 索引
ALTER TABLE wiki_pages ALTER COLUMN metadata TYPE jsonb USING metadata::jsonb;
CREATE INDEX idx_wiki_pages_metadata ON wiki_pages USING gin(metadata);

-- 高效查询 Structure 块
SELECT * FROM wiki_pages
WHERE page_type = 'structure'
  AND metadata @> '{"hasTable": true}'::jsonb  -- GIN 索引命中
  AND metadata->>'sectionPath' LIKE '1.%';
```

**连接池配置：**

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'deepanalyze',
  user: process.env.PG_USER || 'deepanalyze',
  password: process.env.PG_PASSWORD,
  max: 20,                    // 最大连接数
  idleTimeoutMillis: 30000,   // 空闲连接超时
  connectionTimeoutMillis: 2000,
});
```

### 4.5 PostgreSQL 核心优势与业务影响

| 模块 | 当前 SQLite 瓶颈 | PostgreSQL 改进 | 业务价值 |
|------|-----------------|----------------|---------|
| **向量检索** | JS 暴力全表扫描，10K 向量 500ms | pgvector HNSW 索引，1M 向量 <100ms | 支撑大规模知识库，检索响应从秒级降到毫秒级 |
| **中文全文检索** | unicode61 单字分词，召回率低 | zhparser jieba 分词，精确匹配 | 中文检索质量从"几乎不可用"提升到专业级 |
| **多 Agent 并发** | 单连接阻塞事件循环 | 连接池 + MVCC 并发 | 多 Agent 并行检索互不阻塞 |
| **Metadata 查询** | JSON_EXTRACT 全表扫描 | JSONB + GIN 索引 | 按标签/类型/属性过滤 Structure 块毫秒级 |
| **数据迁移** | ALTER TABLE 重建整表 | ADD COLUMN 原地执行 | Schema 演进零停机 |
| **备份恢复** | 文件复制（需停写） | pg_dump 在线备份 | 不影响业务的数据备份 |

### 4.6 迁移路径

```
Phase 0 (数据库基础设施) ← 在所有其他 Phase 之前执行
  ├── Step 1: 定义 Repository 接口层
  ├── Step 2: 实现 PostgreSQL 适配器（优先 VectorSearchRepo + FTSSearchRepo）
  ├── Step 3: Docker Compose 增加 PostgreSQL 服务
  ├── Step 4: 数据迁移脚本（SQLite → PostgreSQL）
  ├── Step 5: 逐步将业务代码从直接 DB 访问迁移到 Repository 调用
  └── Step 6: 移除 better-sqlite3 依赖（可选，保留测试适配器）
```

**关键决策：不追求一次性全量迁移。** 先实现 VectorSearchRepo 和 FTSSearchRepo 的 PostgreSQL 适配器（解决最紧迫的两个性能问题），其他表可以后续逐步迁移。在过渡期，系统可以同时使用 SQLite（业务数据）和 PostgreSQL（向量+全文检索）。

### 4.7 部署方案

```yaml
# docker-compose.yml 新增
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: deepanalyze
      POSTGRES_USER: deepanalyze
      POSTGRES_PASSWORD: ${PG_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U deepanalyze"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

环境变量：

```env
# 数据库配置
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=deepanalyze
PG_USER=deepanalyze
PG_PASSWORD=changeme

# 向量检索配置
EMBEDDING_DIMENSION=1536
HNSW_M=16
HNSW_EF_CONSTRUCTION=64
```

### 4.8 嵌入模型选择与配置

#### 4.8.1 当前嵌入系统状态

当前 `EmbeddingManager`（`src/models/embedding.ts`）支持两种模式：
- **OpenAI 兼容 API 模式**：调用 `/v1/embeddings` 端点，兼容 Ollama/vLLM/LiteLLM/OpenAI 等
- **Hash 回退模式**：无配置时使用 n-gram 哈希生成 256 维伪向量，仅支持近似词汇匹配

配置通过 `config/default.yaml` 的 `models.embedding` + `defaults.embedding` 指定，或通过数据库 settings 表的 `providers` 键动态配置。当前 `dimension` 字段不在 YAML schema 中，硬编码默认 768。

#### 4.8.2 推荐嵌入模型

**设计原则：优先 CPU 可运行的本地模型，同时支持配置外部 API。**

| 模型 | 维度 | CPU 可用 | 中文支持 | MTEB 排名 | 推荐场景 |
|------|------|---------|---------|----------|---------|
| **bge-m3**（BAAI） | 1024 | 通过 Ollama 运行 | 优秀（多语言） | 前5 | **推荐默认**：多语言+长文本+稠密/稀疏混合 |
| **nomic-embed-text** | 768 | 通过 Ollama 运行 | 良好 | 前10 | 轻量级，内存占用小 |
| **mxbai-embed-large** | 1024 | 通过 Ollama 运行 | 良好 | 前10 | 均衡选择 |
| **text-embedding-3-small**（OpenAI） | 1536 | API 调用 | 优秀 | 前5 | 外部 API 方案（成本可控） |
| **bce-embedding-base**（NetEase） | 768 | 通过 Ollama 运行 | 优秀 | 中文专项 | 中文为主场景 |

**推荐默认模型：bge-m3（BAAI/bge-m3）**

选择理由：
1. **多语言支持优秀**：中英文效果都很好，MTEB 多语言排行榜前5
2. **CPU 可运行**：通过 Ollama 一键部署（`ollama pull bge-m3`），无需 GPU
3. **多维检索能力**：支持稠密向量（Dense）、稀疏向量（Sparse/ColBERT）、多向量（Multi-vector）三种模式
4. **长文本支持**：8192 token 上下文窗口，适合长文档 Structure 块
5. **1024 维**：在精度和存储/计算成本之间取得好的平衡

Ollama 部署方式：
```bash
# 安装 Ollama 后
ollama pull bge-m3
# 自动提供 OpenAI 兼容 API：http://localhost:11434/v1
```

#### 4.8.3 嵌入模型配置设计

**YAML 配置（config/default.yaml）：**

```yaml
models:
  # ... 其他模型 ...

  # 本地嵌入模型（通过 Ollama）
  embedding:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: bge-m3
    dimension: 1024
    maxTokens: 8192

  # 或使用外部 API
  # embedding-openai:
  #   provider: openai-compatible
  #   endpoint: https://api.openai.com/v1
  #   apiKey: ${OPENAI_API_KEY}
  #   model: text-embedding-3-small
  #   dimension: 1536
  #   maxTokens: 8192

defaults:
  main: main
  embedding: embedding
```

**数据库动态配置（settings 表 providers 键）：**

用户可在前端设置页面切换嵌入模型，无需修改 YAML。settings 中的配置优先于 YAML。

```typescript
// providers 键的 JSON 结构（与现有格式兼容）
{
  "providers": [
    {
      "id": "embedding-local",
      "name": "本地嵌入 (bge-m3)",
      "type": "ollama",
      "endpoint": "http://localhost:11434/v1",
      "model": "bge-m3",
      "dimension": 1024,
      "maxTokens": 8192,
      "enabled": true
    },
    {
      "id": "embedding-openai",
      "name": "OpenAI 嵌入",
      "type": "openai-compatible",
      "endpoint": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "text-embedding-3-small",
      "dimension": 1536,
      "maxTokens": 8192,
      "enabled": true
    }
  ],
  "defaults": {
    "main": "main",
    "embedding": "embedding-local"
  }
}
```

#### 4.8.4 EmbeddingManager 改造要点

当前 `tryCreateFromConfig()` 只读取 YAML 文件，需要改造为：

1. **优先读取数据库 settings**：从 `settings` 表的 `providers` 键获取嵌入模型配置（endpoint、model、dimension、apiKey）
2. **YAML 作为兜底**：数据库无配置时从 `config/default.yaml` 读取
3. **dimension 字段纳入 schema**：在 `ModelConfigSchema` 和 `ProviderConfig` 中新增可选 `dimension` 字段
4. **模型切换时重建索引**：切换嵌入模型后，已有向量的维度可能不同，需要重新计算所有嵌入

```
EmbeddingManager 构造流程：
  1. 从 ModelRouter 获取 defaults.embedding 对应的 provider ID
  2. 尝试从数据库 settings 加载该 provider 的配置（含 dimension）
  3. 如果数据库无配置，尝试从 YAML 加载
  4. 创建 OpenAIEmbeddingProvider（含 dimension）
  5. 全部失败 → HashEmbeddingProvider（256 维）
```

#### 4.8.5 向量维度变更处理

当用户切换嵌入模型（维度可能从 768 变为 1024）时：
- 检测新 dimension != 已有 dimension
- 标记所有旧 embedding 为 stale
- 后台异步重建所有嵌入（通过 ProcessingQueue 的重新索引任务）
- 重建期间使用旧嵌入降级检索（不阻塞用户）

#### 4.8.6 可选：排序模型（Reranker）

嵌入模型负责召回（recall），排序模型负责精排（precision）。可在检索流程中增加可选的 Reranker 阶段：

| 模型 | CPU 可用 | 中文支持 | 说明 |
|------|---------|---------|------|
| **bge-reranker-v2-m3** | 通过 Ollama | 优秀 | 与 bge-m3 配套，跨编码器 |
| **bce-reranker-base** | 通过 Ollama | 优秀 | 网易出品，中文专项 |

Reranker 不是必需的，但可以作为 Phase 3+ 的增强。配置方式与嵌入模型相同，在 settings 中增加 `reranker` 角色：

```yaml
defaults:
  embedding: embedding
  reranker: reranker  # 可选
```

检索流程增强：
```
当前：向量召回 → BM25召回 → RRF融合 → 返回
增强：向量召回 → BM25召回 → RRF融合 → Reranker精排 → 返回
```

### 4.9 需要规避的陷阱

1. **不要在 Phase 1-4 的业务逻辑中直接写 PostgreSQL 特定 SQL** — 所有数据库访问通过 Repository 接口，保持可替换性。

2. **不要一开始就全量迁移所有表** — 先迁移性能敏感的表（embeddings、fts），业务表后续逐步迁移。

3. **不要忽略连接池配置** — PostgreSQL 的连接建立开销比 SQLite 大。必须配置合理的连接池（推荐 20 个连接）。

4. **不要忘记 zhparser 的安装** — pgvector/pgvector Docker 镜像不包含 zhparser，需要自定义 Dockerfile 或使用包含中文分词的镜像。

5. **不要在迁移期间同时写两个数据库** — 选择一个 cutoff 点，一次性切换到 PostgreSQL，避免数据不一致。

6. **不要硬编码向量维度** — 维度必须从嵌入模型配置中读取（bge-m3=1024, nomic=768, OpenAI=1536），不同模型维度不同。

7. **不要在切换嵌入模型后立即使用旧索引** — 维度变更必须触发重新索引，否则向量比较无意义。

8. **不要忽略 HashEmbeddingProvider 的兼容** — 无嵌入模型配置时仍需降级可用，但应在生产环境明确告警。

---

## 5. Docling 集成设计

### 5.1 当前状态

`docling-service/parser.py` 只返回 Markdown 文本：

```python
result = {
    "content": doc.export_to_markdown(),  # 只有 Markdown
    "tables": [...],
    "images": [...],
    "metadata": {...}
}
```

### 5.2 目标状态

返回三份数据，保留所有信息：

```python
result = {
    "raw": doc.export_to_dict(),           # 完整 DoclingDocument JSON
    "doctags": doc.export_to_doctags(),    # DocTags 文本
    "markdown": doc.export_to_markdown(),  # Markdown 文本（向后兼容）
    "metadata": {...},
    "tables": [...],
    "images": [...]
}
```

### 5.3 DocTags 格式说明

DocTags 是 Docling 提供的轻量结构化标记格式，专为 RAG 场景优化：

```
[h1] 第一章 项目概述
[p] 本系统旨在构建一个面向企业的...
[table]
| 模块 | 功能 | 技术栈 |
| 用户管理 | 认证授权 | JWT |
[p] 上述模块采用微服务架构...

[h1] 第二章 技术方案
[h2] 2.1 架构设计
[p] 系统整体采用分层架构...
```

选择 DocTags 而非 Markdown 作为 Structure 层主格式的原因：
1. 结构信息更丰富（明确的元素类型标签 `[h1]`、`[p]`、`[table]`）
2. 比 JSON 轻量得多，适合检索和 Agent 消费
3. 分块逻辑更清晰（按标签识别元素边界）
4. 同时保存 Markdown 版本用于前端展示

### 5.4 DoclingDocument 关键结构

DoclingDocument 是 Docling 的核心中间表示，Pydantic 强类型树状结构：

```json
{
  "name": "技术方案",
  "page_count": 32,
  "body": {
    "children": [
      {"type": "heading", "text": "第一章 项目概述", "level": 1, "page": 1},
      {"type": "paragraph", "text": "本系统旨在...", "page": 1},
      {"type": "table", "data": {"headers": [...], "rows": [...]}, "page": 2},
      {"type": "picture", "caption": "架构图", "page": 3}
    ]
  },
  "tables": [...],
  "pictures": [...]
}
```

---

## 6. 多模态统一处理设计

### 6.1 核心原则

每种模态都输出相同的三层结构，只是 Raw 层格式不同：

```
┌─────────────┬──────────────────────────────────┬───────────────────┬─────────────┐
│    模态     │           Raw 层                  │  Structure 层     │ Abstract 层 │
├─────────────┼──────────────────────────────────┼───────────────────┼─────────────┤
│ PDF/DOCX    │ DoclingDocument JSON              │ DocTags 章节块    │ LLM 摘要    │
│ /PPTX       │                                  │                   │             │
├─────────────┼──────────────────────────────────┼───────────────────┼─────────────┤
│ Excel       │ DoclingDocument JSON              │ DocTags 表格块    │ LLM 摘要    │
│             │ (TableItem 完整数据)              │ (Markdown 表格)   │             │
├─────────────┼──────────────────────────────────┼───────────────────┼─────────────┤
│ 图片        │ {description, ocrText, metadata}  │ 视觉描述+OCR文本  │ 一句话摘要  │
├─────────────┼──────────────────────────────────┼───────────────────┼─────────────┤
│ 音频        │ {speakers, turns, timestamps}     │ 分角色转写文本    │ 主题摘要    │
├─────────────┼──────────────────────────────────┼───────────────────┼─────────────┤
│ 视频        │ {keyframes, audio, timeline}      │ 时间轴描述文本    │ 主题摘要    │
└─────────────┴──────────────────────────────────┴───────────────────┴─────────────┘
```

### 6.2 Excel 完整 Docling 处理

**关键设计决策：** Excel 走完整的 Docling 处理流程（而非轻量化跳过），因为 Docling 已经有完整的 Excel 中间格式支持。

Docling 对 Excel 的处理逻辑：
1. **按 Sheet 拆分**：每个 Sheet 生成独立章节
2. **表格识别**：检测连续非空单元格块为独立 TableItem
3. **完整数据保留**：每个 TableItem 包含 headers、rows（含 text/col/row/row_span/col_span/formula/value）、provenance（来源信息）
4. **导出格式**：Markdown 表格（LLM 友好）+ 完整 JSON（无损）+ DocTags（RAG 优化）

```
Excel 文件
  ↓ Docling 解析
  ↓ 每个 Sheet → SectionHeaderItem
  ↓ 每个表格 → TableItem (headers + rows + formulas + merged cells)
  ↓
Raw 层: 完整 DoclingDocument JSON (包含所有 TableItem)
Structure 层: 按 Sheet 分块，每块包含该 Sheet 所有表格的 DocTags/Markdown
Abstract 层: LLM 生成摘要（Sheet列表、表格数、主要内容概述）
```

超大 Excel（行数 > 100,000 或 Sheet > 20）的处理策略：
- 仍然通过 Docling 解析，配置 `max_sheets` 限制
- Structure 层的每个 Sheet 块只保留前 N 行数据的 DocTags（配置 N=50）
- Raw 层保留完整数据
- Agent 需要完整数据时，通过 `expandToRaw()` 按需读取

### 6.3 ParsedContent 接口扩展

```typescript
interface ParsedContent {
  text: string;                           // 主文本内容
  metadata: Record<string, unknown>;      // 元数据
  success: boolean;
  error?: string;

  // 新增字段
  raw?: Record<string, unknown>;          // 完整结构化原始数据
  doctags?: string;                       // DocTags 风格轻量文本
  modality?: 'document' | 'image' | 'audio' | 'video' | 'excel';
}
```

### 6.4 各模态 DocTags 格式

```
图片：
  [img] 视觉描述: ...
  [ocr] 文本内容: ...
  [meta] 1920x1080, JPEG

音频：
  [p](speaker=A;time=00:00-00:45) 对话内容...

视频：
  [scene](time=00:00-01:30) 画面描述...
  [dialog](speaker=A;time=00:30) 对话内容...
```

### 6.5 多模态锚点

| 模态 | 锚点格式 | 示例 |
|------|---------|------|
| 文档 | `{docId}:{elementType}:{index}` | `abc123:paragraph:5` |
| Excel | `{docId}:table:sheet{sheetIdx}_table{tableIdx}` | `abc123:table:sheet0_table1` |
| 图片 | `{docId}:image:0` | `abc123:image:0` |
| 音频 | `{docId}:turn:{index}` | `abc123:turn:15` |
| 视频 | `{docId}:scene:{index}` / `{docId}:turn:{index}` | `abc123:scene:3` |

### 6.6 WikiCompiler 多模态编译策略

```
compile(kbId, docId, parsedContent)
  ├── compileRaw() — 所有模态统一存储
  ├── compileStructure() — 根据模态选择策略
  │   ├── document/excel → compileStructureDocument() — 按标题/Sheet分块
  │   ├── image → compileStructureImage() — 单块（描述+OCR+元数据）
  │   ├── audio → compileStructureAudio() — 按发言者或时间窗口分块
  │   └── video → compileStructureVideo() — 按场景边界分块
  ├── compileAbstract() — 所有模态统一（LLM 生成）
  ├── extractEntities() — 所有模态统一
  └── buildLinks() — 所有模态统一
```

**音频分块策略：** 将同一发言者的连续段落归为一个块。块标题 = "发言者A (00:00-02:35)"。无发言者信息时按 30 秒窗口分块。

**视频分块策略：** 按关键帧场景边界分块。每块 = 场景描述 + 该时段内的对话文本。块标题 = "场景1 (00:00-01:30)"。

**图片分块策略：** 单块，标题 = 文件名，内容 = 视觉描述 + OCR + 元数据。

---

## 7. Agent 系统优化设计

### 7.1 设计原则

**不需要新增 Agent 基础设施。** 现有组件已经足够：

| 现有组件 | 能力 | 对应需求 |
|---------|------|---------|
| WorkflowEngine | pipeline/parallel/council/graph 四种调度 | 并行检索 |
| AgentTeam | 角色定义 + 工具分配 + 依赖关系 | 多路检索团队 |
| Skills | prompt + tools + 变量 | 三层递进检索工作流 |
| AgentRunner | TAOR 循环 + 自动复合 + 来源追踪 | 核心执行引擎 |

改动集中在：
1. 更新 Agent 系统提示词（让 Agent 了解三层架构）
2. 新增 Skills（固化最优检索工作流）
3. 新增 Team 模板（并行检索配置）

### 7.2 Agent 提示词更新要点

**GENERAL_AGENT 新增章节：**

```
## 数据层级
本系统使用三层文档架构：
- Abstract 层：文档摘要和目录大纲（极轻量，用于文档路由）
- Structure 层：DocTags/Markdown 格式的章节分块（检索主战场）
- Raw 层：DoclingDocument JSON 完整原始数据（按需访问）

## 检索工作流
1. 先用 kb_search 在 Abstract 层判断哪些文档相关
2. 在 Structure 层执行精准检索（BM25 + 向量融合）
3. 需要原始数据时使用 expandToRaw 获取 Raw 层内容
4. 可以使用 grep 工具在 Structure 层文件中精确搜索

## 引用规则
所有分析结果必须标注来源：
- 文件名（使用原始文件名，不是内部ID）
- 章节/页码
- 锚点ID（如果有）

## 信息验证
- 不要编造文档中不存在的信息
- 对关键数据，使用 expandToRaw 验证原文
```

**REPORT_AGENT 新增章节：**

```
## 报告引用格式
[来源: {原始文件名} → {章节标题} (第X页)]

示例：
华东地区Q1销售额为1250万元 [来源: 销售数据.xlsx → Sheet1:Q1销售 (表格1)]
项目采用微服务架构 [来源: 技术方案.pdf → 第二章 技术方案 (第6页)]

## 报告结构
1. 执行摘要（5条以内核心发现）
2. 详细分析（按主题分段，每段引用来源）
3. 数据支撑（引用具体数值，标注来源表格）
4. 信息来源清单（所有引用的文件 + 章节 + 锚点ID）
```

### 7.3 新增 Skills

| Skill 名称 | 工作流 | 工具 | maxTurns |
|-----------|--------|------|----------|
| 三层递进检索 | Abstract 路由 → Structure 检索 → Raw 验证 | kb_search, wiki_browse, expand, grep, think, finish | 25 |
| 表格专项分析 | 定位表格 → 浏览 Structure → 读取 Raw → 分析 | kb_search, wiki_browse, expand, bash, think, finish | 20 |
| 多模态综合检索 | 跨模态 Abstract → 各模态 Structure → 交叉验证 | kb_search, wiki_browse, expand, grep, think, finish | 30 |

**三层递进检索工作流详情：**

```
第一层：文档路由
  1. kb_search 搜索 Abstract 层
  2. 确定哪些文档与问题相关

第二层：精准检索
  1. 在 Structure 层用多个关键词搜索（至少3个不同角度）
  2. wiki_browse 浏览相关章节完整内容
  3. grep 对关键术语精确搜索
  4. 合并结果，去重并记录锚点ID

第三层：验证与补充
  1. 对关键信息使用 expandToRaw 验证原始内容
  2. 检查是否遗漏了重要表格、数据
  3. 确认所有引用的准确性
```

### 7.4 新增 Team 模板

**并行深度检索团队（graph 模式）：**

```
agent-0 "语义检索员" — kb_search 多角度语义检索
  工具: [kb_search, wiki_browse, expand, think, finish]

agent-1 "精确检索员" — grep 精确匹配
  工具: [grep, glob, read_file, think, finish]
  与 agent-0 并行执行

agent-2 "汇总分析师" — 合并结果 + Raw 验证 + 报告
  工具: [kb_search, wiki_browse, expand, report_generate, think, finish]
  dependsOn: [agent-0, agent-1]
```

**跨库对比分析团队（parallel 模式）：**
- 动态生成：每个选中的知识库一个成员
- 运行时将 KB ID 注入到每个成员的 task 提示词中

**全面深度分析团队（graph 模式，增强版）：**

```
agent-0 "初步调查员" — Abstract 层路由筛选
agent-1 "语义深度检索" — dependsOn: [agent-0], Structure 层搜索
agent-2 "精确检索" — dependsOn: [agent-0], grep 搜索
agent-3 "验证报告员" — dependsOn: [agent-1, agent-2], Raw 验证 + 报告
```

### 7.5 知识复合增强

将 `compoundWithTracing()` 升级为 `compoundWithAnchors()`：

```typescript
compoundWithAnchors(
  kbId: string,
  agentType: string,
  input: string,
  output: string,
  anchors: Array<{
    anchorId: string;
    docId: string;
    originalName: string;
    sectionTitle: string;
    pageNumber: number | null;
    role: 'supporting' | 'contradicting' | 'referenced';
  }>,
): string | null
```

增强点：
- 锚点级精确追溯（替代原来的页面级追溯）
- 按文档分组来源，生成来源溯源节
- 引用角色分类（supporting/contradicting/referenced）
- 置信度评估：高（≥3个来源）、中（≥1个）、低（0个）

### 7.6 工具结果自动注入显示名称

在 `AgentRunner.collectAccessedPages()` 中，同时收集 `originalName` 和 `kbName`。对 kb_search、wiki_browse、expand 的工具结果，在返回的 JSON 中注入 `originalName` 和 `kbName` 字段。

---

## 8. 检索系统设计

### 8.1 检索策略分配

| 检索方式 | 作用层 | 适用场景 |
|---------|--------|---------|
| 向量检索 | Abstract（文档路由）+ Structure（语义召回） | 语义相似度匹配 |
| BM25 检索 | Structure（关键词精准） | 关键词精确匹配 |
| Grep | Structure（精确匹配） | 术语/编号/数据精确查找 |
| RRF 融合 | 合并向量 + BM25 结果 | 综合排序 |

### 8.2 两阶段搜索策略

```
阶段 1 (可选): 文档路由
  → 向量搜索 Abstract 层
  → 返回相关文档列表
  → 缩小后续搜索范围

阶段 2: 精准检索
  → 在 Structure 层执行 BM25 + 向量 + RRF
  → 如果阶段1提供了 routedDocs，只搜这些文档的 Structure 页面
  → 返回带锚点的精准结果
```

### 8.3 Raw 层按需访问

通过 Expander 的 `expandToRaw(anchorId)` 方法：

```
1. 从 anchors 表查到 raw_json_path
2. 读取 {dataDir}/raw/{kbId}/{docId}/docling.json
3. 用 JSON Pointer 定位到目标节点
4. 返回目标节点 + 前后各1个兄弟节点（上下文）
```

Raw 层不建索引（JSON 可能有几 MB），只在 Agent 判断需要验证关键信息时按需读取。

---

## 9. API 设计

### 9.1 预览 API

```
GET /api/kbs/:kbId/documents/:docId/preview/:layer
  layer = "raw" | "structure" | "abstract"
  ?chunkId=xxx  — Structure 层指定块

GET /api/anchors/:anchorId
  返回：锚点定义 + Structure 层内容片段 + Raw 层对应节点 + 上下文

GET /api/kbs/:kbId/documents/:docId/structure-map
  返回：所有 Structure 块的扁平列表（含锚点），用于构建导航侧边栏
```

### 9.2 检索测试 API

```
POST /api/search/test
  请求体：{ query, kbIds, docIds?, methods, layer, topK }
  响应：各方法独立结果 + RRF 融合结果
```

### 9.3 报告 API 增强

```
GET /api/reports/:reportId/sources
  返回：所有来源文档及锚点引用，按文档分组
```

### 9.4 下载导出 API

```
GET /api/kbs/:kbId/documents/:docId/download
  流式传输原始上传文件

GET /api/kbs/:kbId/documents/:docId/export/:format
  format: "raw-json" | "doctags" | "markdown" | "structure-bundle"
```

---

## 10. 前端交互设计

### 10.1 层级预览页面

三标签页布局：Abstract | Structure | Raw

- **左侧边栏**：文档元数据 + 导航（Structure 展示目录，Raw 展示元素树）
- **主内容区**：选中层级的渲染内容
- **顶部栏**：原始文件名 + 知识库名 + 文件类型图标 + 页数/元素数

**跨层导航：**
- Abstract 目录条目 → 点击跳转到 Structure 对应章节块
- Structure 段落 → 右键"查看原始数据" → 跳转到 Raw 层对应节点
- Raw 节点 → 显示锚点 ID + 关联的 Structure 块链接

### 10.2 报告锚点悬浮预览

报告中的 `[来源: ...]` 引用渲染为可交互链接。鼠标悬浮时：

```
┌──────────────────────────────┐
│ 📄 技术方案.pdf               │
│ 项目知识库 → 第二章 (第6页)   │
│                              │
│ ...系统采用微服务架构，核心    │
│ 模块包括用户管理、数据处理...  │
│                              │
│ [查看完整上下文]              │
└──────────────────────────────┘
```

不同模态的预览样式：
- 文档：文本片段
- Excel：表格单元格 + 表头
- 图片：缩略图 + 描述
- 音频：带发言者标签的转写片段
- 视频：帧缩略图 + 描述

### 10.3 检索测试界面

```
搜索输入区：查询输入框 + KB选择 + 检索方式复选框 + 层级选择器
结果展示区：卡片式结果（文件名+章节+分数+方式标签+高亮片段）
方法对比视图：同一查询的不同检索方式结果并列对比
```

### 10.4 多模态文件管理

每个文档显示：
- 文件类型图标（PDF/Excel/图片/音频/视频）
- 类型专属元数据（PDF→页数、Excel→Sheet数+表格数、Audio→时长+发言者数等）
- 处理进度（解析/编译/锚点/索引/链接）
- 操作按钮（预览/重新处理/下载/删除）

### 10.5 文档处理进度增强

```
5步流程对应前端进度：
  Queued (5%) → 解析文档结构 (20%) → 构建三层索引 (40%)
  → 建立锚点关联 (60%) → 建立检索索引 (80%) → 处理完成 (100%)
```

每个步骤完成后前端可立即预览已完成层的内容。

---

## 11. 数据流总览

### 11.1 文档上传处理流程

```
用户上传文件
  → ProcessingQueue 接收任务
  → Step 1: 解析 (DoclingProcessor)
      → 调用 Docling 微服务
      → 返回 ParsedContent (text + raw + doctags + modality)
  → Step 2: 编译 (WikiCompiler)
      → compileRaw(): 保存 docling.json + metadata.json
      → compileStructure(): 生成锚点 + DocTags分块 + 创建 structure wiki_pages
      → compileAbstract(): LLM 生成摘要 + 目录 + 标签
  → Step 3: 锚点 (AnchorGenerator)
      → 写入 anchors 表
      → 关联 structure_page_id
  → Step 4: 索引 (Indexer)
      → Structure 层各块建 FTS5 + 向量索引
      → Abstract 层建向量索引
  → Step 5: 链接 (LinkBuilder)
      → 跨文档链接
      → 锚点关联校验
  → 完成
```

### 11.2 Agent 检索分析流程

```
用户提问
  → Coordinator Agent 分析问题
  → 分解为子任务（语义检索 + 精确检索 + 表格分析）
  → 并行执行子任务
      → 语义检索: kb_search (Structure层) → wiki_browse → 记录锚点
      → 精确检索: grep → 记录命中位置
      → 表格分析: kb_search → expandToRaw → 读取完整表格数据
  → 汇总结果
      → 去重排序
      → 关键信息 expandToRaw 验证
  → Report Agent 生成报告
      → [来源: 原始文件名 → 章节 (页码)] 格式
      → 锚点ID标记
  → KnowledgeCompounder 写入 wiki_pages
      → compoundWithAnchors() 锚点级来源追溯
```

### 11.3 前端预览数据流

```
用户点击检索结果 / 报告引用
  → 携带 anchorId
  → GET /api/anchors/:anchorId
      → 返回: 锚点定义 + Structure内容 + Raw节点
  → 前端渲染悬浮预览
  → 用户点击"查看完整上下文"
  → 跳转到 LayerPreview 页面
      → GET /api/kbs/:kbId/documents/:docId/preview/structure?chunkId=xxx
      → 渲染完整 Structure 块内容
      → 提供 Raw / Abstract 标签页切换
```

---

## 12. 关键设计决策总结

| 决策点 | 选择 | 理由 |
|--------|------|------|
| **数据库** | PostgreSQL + pgvector + zhparser | 向量索引+中文FTS+并发+JSONB，企业级需求 |
| 数据库迁移方式 | Repository 抽象层 | 隔离底层实现，渐进迁移，保持可替换性 |
| **图谱/链接系统** | 冻结不修改 | 构建成本高、速度慢，锚点系统已覆盖核心追溯需求 |
| **嵌入模型（默认）** | bge-m3 (BAAI)，Ollama 本地运行 | CPU可用+多语言优秀+1024维+8K上下文 |
| 嵌入模型（备选） | 支持配置任何 OpenAI 兼容 API | 已有 EmbeddingManager 框架，配置即切换 |
| 排序模型 | 可选 bge-reranker-v2-m3 | Phase 3+ 增强，非必需 |
| Raw 层格式 | 完整 DoclingDocument JSON | 保留所有信息，支持未来导出和验证 |
| Structure 层格式 | DocTags 按章节分块 | 结构丰富+轻量+Agent友好+分块自然 |
| Abstract 层生成 | LLM 生成 | 需要语义理解，自动摘要质量不够好 |
| 锚点 ID 格式 | `docId:elementType:index` | 稳定、可解析、同文档重编不变 |
| 并行检索实现 | 复用 AgentTeam + WorkflowEngine | 已有完整基础设施 |
| 校验机制 | 编译时断言 + 运行时防御 | 不需要独立校验层 |
| Excel 处理 | 完整 Docling 处理 | Docling 已有完整 TableItem 支持 |
| 同名文件区分 | KB 前缀 | UUID 已保证内部唯一 |
| Raw 层索引 | 不建索引 | JSON 太大，按需读取更合理 |
| 跨模态统一 | 统一三层输出 + 模态感知编译 | 统一接口 + 差异化处理 |
| 向量索引算法 | pgvector HNSW | 比暴力扫描快1000倍，百万级向量毫秒检索 |

---

## 13. 需要规避的设计陷阱

1. **锚点 ID 不加时间戳或随机数** — 同一文档重新编译时锚点会变化，导致已有报告的引用失效。应基于文档内部结构生成确定性锚点。

2. **Raw 层不建索引** — DoclingDocument JSON 可能有几 MB，对其做向量嵌入既贵又不准。Raw 层只存不索，按需读取。

3. **不给每种检索方式创建独立 Agent 类型** — 现有 AgentTeam + WorkflowEngine 已经能表达任何并行模式。过度拆分 Agent 类型会导致调度逻辑膨胀。

4. **不在检索路径上做实时校验** — 编译时保证一致性（同一次编译生成三层），运行时只做防御性检查（锚点是否存在）。定期全量校验可以作为后台任务，但不能在检索路径上。

5. **DocTags 导出不丢页码信息** — DocTags 默认可能不包含页码。导出时确保每个块知道自己在第几页，这是前端预览和溯源的关键。

6. **不要在业务逻辑中直接写数据库特定 SQL** — 所有数据库访问通过 Repository 接口，保持可替换性和可测试性。

7. **不要一开始就全量迁移所有表** — 先迁移性能敏感的表（embeddings、fts），业务表后续逐步迁移。

8. **不要忽略 PostgreSQL 连接池** — PG 连接建立开销比 SQLite 大，必须配置合理的连接池（推荐 20 连接）。

9. **不要忘记 zhparser 安装** — pgvector/pgvector Docker 镜像不包含中文分词，需要自定义 Dockerfile 或使用包含 zhparser 的镜像。

---

## 14. 与实施计划的对应关系

本设计文档定义"为什么做"和"做什么"。具体的实施步骤见以下计划文档：

| 设计章节 | 对应实施计划 | 任务数 | 优先级 |
|---------|-------------|--------|--------|
| 4 (数据库基础设施) | `2026-04-15-phase0-database-infrastructure.md`（待编写） | ~10 | P0 |
| 3、5 (数据模型、Docling、锚点) | `2026-04-15-phase1-data-layer-redesign.md` | 11 | P1 |
| 6 (多模态统一) | `2026-04-15-phase2-multimodal-unification.md` | 8 | P2 |
| 7 (Agent优化) | `2026-04-15-phase3-agent-system-optimization.md` | 5 | P3 |
| 9-10 (API、前端) | `2026-04-15-phase4-frontend-interaction.md` | 9 | P4 |

**执行依赖关系（新增 Phase 0）：**

```
Phase 0 (数据库基础设施) ← PostgreSQL + pgvector + zhparser 部署 + Repository 层
    ↓
Phase 1 (数据层核心) ← 依赖 Phase 0 的 Repository 接口
    ↓
Phase 2 (多模态) 依赖 Phase 1 的三层编译 + 锚点
Phase 3 (Agent优化) 依赖 Phase 1 的检索器 + 名称解析器
    ↓
Phase 4 (前端交互) 依赖 Phase 1-3 的 API
```

每个 Phase 完成后系统都是可运行的：
- **Phase 0 完成后** → 向量检索和中文全文检索性能大幅提升，但业务逻辑不变
- Phase 1 完成后 → 新的三层结构和检索效果可见
- Phase 2 完成后 → 所有文件类型都能正确处理
- Phase 3 完成后 → Agent 检索质量提升
- Phase 4 完成后 → 交互体验完善
