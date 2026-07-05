# 阶段 1：核心数据层重构 — 三层架构 + 锚点系统

> **给执行代理的说明：** 必须使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 来逐步实施本计划。

**目标：** 将当前的 L2→L1→L0 维基编译替换为全新的 Raw→Structure→Abstract 三层架构，以完整 DoclingDocument JSON 为原始锚点，新增元素级锚点系统实现细粒度可追溯。

**架构方案：** Docling Python 微服务返回完整的 DoclingDocument JSON + DocTags + Markdown。新增 `AnchorGenerator` 从原始 JSON 生成稳定的元素级锚点。`WikiCompiler` 重构为输出三层：Raw（JSON 文件）、Structure（按章节分块的 DocTags/MD，绑定锚点）、Abstract（LLM 生成的摘要 + 目录）。所有数据库操作通过 Phase 0 的 Repository 接口层执行。

**技术栈：** TypeScript/Node.js、Python（Docling）、PostgreSQL + pgvector（Phase 0）、vitest

**前置条件：** 阶段 0（PostgreSQL 基础设施 + Repository 层）

**设计规格：** `docs/superpowers/specs/2026-04-15-three-layer-architecture-redesign.md` 第 3、5 章

**冻结范围：** 图谱和正反向关联系统（linker.ts、l0-linker.ts、GraphTool）不修改，详见设计规格 1.4 节。

---

## 文件清单

| 操作 | 文件路径 | 职责说明 |
|------|---------|---------|
| 新建 | `src/store/pg-migrations/002_anchors_structure.ts` | PG 迁移：创建 anchors 表 |
| 修改 | `src/types/index.ts` | PageType 新增 'structure' |
| 新建 | `src/wiki/anchor-generator.ts` | 从 DoclingDocument JSON 生成稳定锚点 ID |
| 新建 | `tests/anchor-generator.test.ts` | 锚点生成器测试 |
| 修改 | `docling-service/parser.py` | Python 端：返回完整 JSON + DocTags + Markdown |
| 修改 | `src/subprocess/docling-client.ts` | TypeScript 端：扩展 ParseResult 类型 |
| 修改 | `src/services/document-processors/types.ts` | ParsedContent 新增 raw/doctags/modality 字段 |
| 修改 | `src/services/document-processors/docling-processor.ts` | 透传 Docling 返回的丰富数据 |
| 修改 | `src/services/document-processors/excel-processor.ts` | 改用 Docling 完整解析 Excel |
| 新建 | `src/services/display-resolver.ts` | 内部 docId → 用户可见原始文件名 |
| 新建 | `tests/display-resolver.test.ts` | 名称解析器测试 |
| 修改 | `src/store/wiki-pages.ts` | 新增 structure 路径解析 + getStructurePagesByDoc() |
| 修改 | `src/wiki/compiler.ts` | 重构为三层编译流程（核心任务） |
| 修改 | `src/services/processing-queue.ts` | 传递完整 ParsedContent 给编译器 |
| 修改 | `src/wiki/retriever.ts` | 默认搜索 structure 页面，使用 VectorSearchRepo + FTSSearchRepo |
| 修改 | `src/wiki/expander.ts` | 新增 expandToRaw() 方法 |
| 新建 | `tests/compiler-e2e.test.ts` | 三层编译集成测试 |

---

## 任务 1：PG 迁移 + PageType 扩展

**涉及文件：** `src/store/pg-migrations/002_anchors_structure.ts`（新建）、`src/types/index.ts`

- [ ] **步骤 1：创建 PG 迁移文件**

新建 `src/store/pg-migrations/002_anchors_structure.ts`：
```sql
CREATE TABLE anchors (
  id                 TEXT PRIMARY KEY,
  doc_id             TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kb_id              TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  element_type       TEXT NOT NULL,
  element_index      INTEGER NOT NULL,
  section_path       TEXT,
  section_title      TEXT,
  page_number        INTEGER,
  raw_json_path      TEXT,
  structure_page_id  TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
  content_preview    TEXT,
  content_hash       TEXT,
  metadata           JSONB DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_anchors_doc ON anchors(doc_id);
CREATE INDEX idx_anchors_kb ON anchors(kb_id);
CREATE INDEX idx_anchors_structure ON anchors(structure_page_id);
CREATE INDEX idx_anchors_type ON anchors(element_type);
CREATE INDEX idx_anchors_section ON anchors(section_path);
```

wiki_pages 的 page_type CHECK 约束需更新，新增 'structure' 值。

- [ ] **步骤 2：更新 PageType 类型**

修改 `src/types/index.ts`：
```typescript
export type PageType = 'abstract' | 'overview' | 'fulltext' | 'structure' | 'entity' | 'concept' | 'report';
```

- [ ] **步骤 3：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **步骤 4：提交**
```bash
git add src/store/pg-migrations/002_anchors_structure.ts src/types/index.ts
git commit -m "feat: 新增 anchors 表 PG 迁移和 structure 页面类型"
```

---

## 任务 2：锚点生成器

**涉及文件：** `src/wiki/anchor-generator.ts`（新建）、`tests/anchor-generator.test.ts`（新建）

- [ ] **步骤 1：编写测试**

测试用例：
- 从简单 DoclingDocument body 生成锚点：ID 格式 `docId:elementType:index`，section_path 正确（h1→"1", h2→"1.1", 新 h1→"2"）
- 空 body 返回空数组
- h2 之后出现新 h1 时 section_path 正确重置
- content_preview 截断到 200 字符
- Excel 锚点：`generateExcelAnchors()`，ID 格式 `docId:table:sheetName_tableIdx`

- [ ] **步骤 2：实现 AnchorGenerator**

导出 `AnchorDef` 接口和 `AnchorGenerator` 类：
- `generateAnchors(docId, kbId, raw)` — 遍历 body.children，per-type 计数器，跟踪 heading 层级构建 section_path
- `generateExcelAnchors(docId, kbId, raw)` — 遍历 tables，按 sheet+table 编号
- 锚点基于位置生成（非哈希），确保重编译不变
- 元素类型映射：heading→heading, paragraph/text→paragraph, table→table, picture/figure→image, formula→formula, list→list, code→code

- [ ] **步骤 3：运行测试确认通过**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run tests/anchor-generator.test.ts
```

- [ ] **步骤 4：提交**
```bash
git add src/wiki/anchor-generator.ts tests/anchor-generator.test.ts
git commit -m "feat: 新增锚点生成器，支持稳定的元素级锚点 ID"
```

---

## 任务 3：Docling 服务升级

**涉及文件：** `docling-service/parser.py`、`src/subprocess/docling-client.ts`

- [ ] **步骤 1：更新 Python 解析器**

修改 `docling-service/parser.py`，返回结果新增：
- `"raw": doc.export_to_dict()` — 完整 DoclingDocument JSON
- `"doctags": doc.export_to_doctags()` — DocTags 文本
- `"doctagsAvailable": True`
- 保留现有 content/tables/images/metadata 不变

- [ ] **步骤 2：扩展 TypeScript ParseResult**

修改 `src/subprocess/docling-client.ts` 的 `ParseResult` 接口：
```typescript
raw?: Record<string, unknown>;
doctags?: string;
doctagsAvailable?: boolean;
```
`parseWithDocling()` 无需改动——已透传 result.data。

- [ ] **步骤 3：提交**
```bash
git add docling-service/parser.py src/subprocess/docling-client.ts
git commit -m "feat: Docling 服务返回完整 JSON + DocTags + Markdown 三种格式"
```

---

## 任务 4：ParsedContent 扩展 + 处理器更新

**涉及文件：** `src/services/document-processors/types.ts`、`docling-processor.ts`、`excel-processor.ts`

- [ ] **步骤 1：扩展 ParsedContent**

修改 `types.ts`，新增可选字段：
```typescript
raw?: Record<string, unknown>;
doctags?: string;
modality?: 'document' | 'image' | 'audio' | 'video' | 'excel';
```

- [ ] **步骤 2：更新 DoclingProcessor**

修改 `docling-processor.ts` 的 `parse()`：提取 raw 和 doctags，设置 modality='document'。

- [ ] **步骤 3：更新 ExcelProcessor**

修改 `excel-processor.ts`：获取 raw（DoclingDocument JSON）+ doctags，设置 modality='excel'。Docling 对 Excel 按Sheet拆分表格，完整 TableItem 保留。

- [ ] **步骤 4：提交**
```bash
git add src/services/document-processors/types.ts src/services/document-processors/docling-processor.ts src/services/document-processors/excel-processor.ts
git commit -m "feat: ParsedContent 新增 raw/doctags/modality，更新处理器"
```

---

## 任务 5：名称解析器（双名称体系）

**涉及文件：** `src/services/display-resolver.ts`（新建）、`tests/display-resolver.test.ts`（新建）

- [ ] **步骤 1：编写测试**
- [ ] **步骤 2：实现 DisplayResolver**

功能：`resolve(docId)` → `{originalName, kbName, displayLabel, fileType, modalityIcon}`
联查 documents + knowledge_bases，带缓存。`resolveBatch(docIds)` 批量查询避免 N+1。

- [ ] **步骤 3：运行测试**
- [ ] **步骤 4：提交**
```bash
git add src/services/display-resolver.ts tests/display-resolver.test.ts
git commit -m "feat: 新增名称解析器，实现双名称体系"
```

---

## 任务 6：wiki-pages.ts 更新

**涉及文件：** `src/store/wiki-pages.ts`

- [ ] **步骤 1：新增 structure case**

在 resolvePageFilePath 的 switch 中：路径 `{wikiDir}/{kbId}/documents/{docId}/structure/{sanitized_title}.md`

- [ ] **步骤 2：新增 getStructurePagesByDoc(docId)**

通过 WikiPageRepo 查询 `doc_id=? AND page_type='structure'`，按 title 排序。

- [ ] **步骤 3：提交**
```bash
git add src/store/wiki-pages.ts
git commit -m "feat: 维基页面存储新增 structure 页面类型"
```

---

## 任务 7：WikiCompiler 重构（核心任务）

**涉及文件：** `src/wiki/compiler.ts`（重大修改）

编译流程从 L2→L1→L0→Entity→Link 改为 Raw→Structure→Abstract→Entity→Link。

**注意：图谱链接部分冻结。** `extractAndUpdateLinks()` 中的实体提取保留（提取实体到 wiki_pages），但 wiki_links 的写入保持现有逻辑不改动。`buildForwardLinks(kbId)` 调用保持不变。

- [ ] **步骤 1：通读当前 compiler.ts**

理解所有现有方法和 L2/L1/L0 生成逻辑。

- [ ] **步骤 2：新增 compileRaw()**

保存 DoclingDocument JSON 到 `{dataDir}/raw/{kbId}/{docId}/docling.json` + metadata.json。不建索引。

- [ ] **步骤 3：新增 compileStructure()**

1. 调用 AnchorGenerator 生成锚点 → 通过 AnchorRepo 批量写入
2. DocTags 按 `[h1]` 分块（h1 新块，h2 子块，h3+ 归入最近 h2，无标题归入"概述"块；Excel 按 Sheet 分块）
3. 每块通过 WikiPageRepo 创建 structure 页面，metadata JSONB 含 anchorIds/pageRange/sectionPath/elementTypes/wordCount
4. 通过 FTSSearchRepo 建立全文索引

- [ ] **步骤 4：更新 compileAbstract()**

输入从 L1 overview 改为 Structure 层标题+预览。metadata 含 documentType/tags/keyDates/sectionAnchors。

- [ ] **步骤 5：重构主 compile() 方法**

新流程：compileRaw → compileStructure → compileAbstract → extractEntities → buildForwardLinks（冻结，不修改）

兼容性：同时接受 `string`（旧）和 `ParsedContent`（新）。

- [ ] **步骤 6：提交**
```bash
git add src/wiki/compiler.ts
git commit -m "feat: 重构 WikiCompiler 为 Raw→Structure→Abstract 三层编译"
```

---

## 任务 8：处理队列更新

**涉及文件：** `src/services/processing-queue.ts`

- [ ] **步骤 1：parseDocument() 返回 ParsedContent**

从返回 `string` 改为返回 `ParsedContent`。

- [ ] **步骤 2：stepCompiling() 传 ParsedContent**

- [ ] **步骤 3：提交**
```bash
git add src/services/processing-queue.ts
git commit -m "feat: 处理队列传递完整 ParsedContent"
```

---

## 任务 9：检索器更新

**涉及文件：** `src/wiki/retriever.ts`

- [ ] **步骤 1：默认搜索 structure 页面**

search() 的默认 pageTypes 过滤器改为 `["structure"]`。

- [ ] **步骤 2：使用 Repository 层**

向量搜索改用 VectorSearchRepo.searchByVector()（替代暴力 JS 遍历）。
全文搜索改用 FTSSearchRepo.searchByText()（替代 SQLite FTS5）。

- [ ] **步骤 3：新增 searchByStrategy()**

两阶段搜索：Abstract 层路由 → Structure 层精准检索。

- [ ] **步骤 4：提交**
```bash
git add src/wiki/retriever.ts
git commit -m "feat: 检索器使用 Repository 层，默认搜索 Structure"
```

---

## 任务 10：Expander Raw 层访问

**涉及文件：** `src/wiki/expander.ts`

- [ ] **步骤 1：新增 expandToRaw(anchorId)**

流程：从 AnchorRepo 查锚点 → 读取 docling.json → JSON Pointer 定位 → 返回目标节点+上下文。

- [ ] **步骤 2：新增 resolveJsonPointer()**

解析 `#/body/children/3` 格式的 JSON Pointer。

- [ ] **步骤 3：提交**
```bash
git add src/wiki/expander.ts
git commit -m "feat: Expander 新增 expandToRaw 锚点级 Raw 层访问"
```

---

## 任务 11：集成测试

**涉及文件：** `tests/compiler-e2e.test.ts`（新建）

- [ ] **步骤 1：编写端到端测试**

构造含 raw+doctags+text 的模拟 ParsedContent → 调用 WikiCompiler 编译 → 验证 raw JSON 已保存、Structure 页面已在 PG、锚点已写入且 ID 和 section_path 正确。

- [ ] **步骤 2：运行测试**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run tests/compiler-e2e.test.ts
```

- [ ] **步骤 3：提交**
```bash
git add tests/compiler-e2e.test.ts
git commit -m "test: 新增三层编译流程集成测试"
```

---

## 执行顺序

```
任务 1 (PG迁移)  ──┐
任务 2 (锚点)    ──┤
任务 3 (Docling) ──┼── 任务 4 (ParsedContent) ──┐
任务 5 (名称)    ──┤                              ├── 任务 7 (编译器) ── 任务 8 (队列)
任务 6 (页面)    ──┘                              │                   ├── 任务 9 (检索器)
                                                   │                   ├── 任务 10 (Expander)
                                                   │                   └── 任务 11 (集成测试)
```

任务 1-2、3、5 可并行。
任务 4 依赖 3。
任务 7 依赖 1、2、4、6。
任务 8、9、10、11 依赖 7。
