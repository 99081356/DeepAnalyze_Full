# 阶段 4：前端呈现与交互

> **给执行代理的说明：** 必须使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 来逐步实施本计划。

**目标：** 构建面向用户的完整交互层 — 层级预览、报告锚点悬浮预览、检索测试界面、跨模态导航、多模态文件管理、下载/导出功能。

**架构方案：** 新增 API 路由提供层级数据和锚点详情。前端组件渲染各模态预览。报告渲染支持锚点驱动的悬浮预览。检索测试页面允许对比不同检索方法的效果。所有数据库查询通过 Phase 0 的 Repository 接口层执行。

**技术栈：** Hono（API）、React（前端）、现有的 WebSocket 基础设施

**前置条件：** 阶段 0（PostgreSQL + Repository 层）、阶段 1（数据层 + 锚点）、阶段 2（多模态预览）、阶段 3（增强报告）

**设计规格：** `docs/superpowers/specs/2026-04-15-three-layer-architecture-redesign.md` 第 9、10 章

**冻结范围：** 图谱和正反向关联系统（linker.ts、l0-linker.ts、GraphTool）不修改，详见设计规格 1.4 节。

---

## 文件清单

| 操作 | 文件路径 | 职责说明 |
|------|---------|---------|
| 新建 | `src/server/routes/preview.ts` | 层级预览 + 锚点详情 API |
| 新建 | `src/server/routes/search-test.ts` | 检索测试 API |
| 修改 | `src/server/routes/reports.ts` | 增强报告导出（含锚点引用） |
| 修改 | `src/server/routes/knowledge.ts` | 下载/导出端点 |
| 新建 | 前端 `LayerPreview.tsx` | 三层预览组件（标签页切换） |
| 新建 | 前端 `AnchorHoverCard.tsx` | 报告锚点悬浮预览卡片 |
| 新建 | 前端 `SearchTestPanel.tsx` | 检索测试界面 |
| 新建 | 前端 `DocumentManager.tsx` | 增强版文件列表（多模态信息展示） |
| 新建 | 前端 `ReportViewer.tsx` | 报告展示（锚点链接 + 来源面板） |

---

## 任务 1：预览 API 路由

**涉及文件：** `src/server/routes/preview.ts`（新建）

- [ ] **步骤 1：通读现有路由文件**

理解当前路由注册方式（Hono 路由结构）、中间件使用和响应格式。

- [ ] **步骤 2：实现层级预览端点**

新建 `src/server/routes/preview.ts`：

```typescript
import { Hono } from 'hono';
import { createRepos } from '../../store/repos';

const preview = new Hono();

/**
 * GET /api/kbs/:kbId/documents/:docId/preview/:layer
 * 层级预览：raw / structure / abstract
 */
preview.get('/kbs/:kbId/documents/:docId/preview/:layer', async (c) => {
  const { kbId, docId, layer } = c.req.param();
  const repos = createRepos();

  switch (layer) {
    case 'raw': {
      // 读取 raw/{kbId}/{docId}/docling.json
      const rawPath = `${kbId}/documents/${docId}/raw/docling.json`;
      const fs = await import('fs/promises');
      try {
        const rawJson = await fs.readFile(rawPath, 'utf-8');
        const parsed = JSON.parse(rawJson);
        // 返回内容 + 元素数量摘要
        const elementCount = countElements(parsed);
        return c.json({ content: parsed, summary: { elementCount } });
      } catch {
        return c.json({ error: 'Raw data not found' }, 404);
      }
    }

    case 'structure': {
      const chunkId = c.req.query('chunkId');
      if (chunkId) {
        // 返回指定块的 DocTags 内容 + 锚点列表
        const page = await repos.wikiPage.getById(chunkId);
        if (!page) return c.json({ error: 'Chunk not found' }, 404);
        const anchors = await repos.anchor.getByStructurePageId(chunkId);
        return c.json({ chunk: page, anchors });
      }

      // 列出所有 structure 页面
      const pages = await repos.wikiPage.getByDocAndType(docId, 'structure');
      const summaries = pages.map(p => ({
        id: p.id,
        title: p.title,
        sectionPath: p.metadata?.sectionPath,
        anchorIds: p.metadata?.anchorIds,
        pageRange: p.metadata?.pageRange,
        hasTable: p.metadata?.elementTypes?.includes('table'),
        hasImage: p.metadata?.elementTypes?.includes('image'),
        wordCount: p.metadata?.wordCount,
        modality: p.metadata?.modality,
      }));
      return c.json({ chunks: summaries });
    }

    case 'abstract': {
      const pages = await repos.wikiPage.getByDocAndType(docId, 'abstract');
      if (pages.length === 0) return c.json({ error: 'Abstract not found' }, 404);
      const abstract = pages[0];
      return c.json({
        content: abstract.content,
        metadata: {
          documentType: abstract.metadata?.documentType,
          tags: abstract.metadata?.tags,
          keyDates: abstract.metadata?.keyDates,
          toc: abstract.metadata?.toc, // 目录大纲（含 anchorIds）
        },
      });
    }

    default:
      return c.json({ error: `Invalid layer: ${layer}` }, 400);
  }
});
```

- [ ] **步骤 3：实现锚点详情端点**

在同一个文件中追加：

```typescript
/**
 * GET /api/anchors/:anchorId
 * 返回锚点定义 + Structure 层内容片段 + Raw 层对应节点 + 上下文
 */
preview.get('/anchors/:anchorId', async (c) => {
  const { anchorId } = c.req.param();
  const repos = createRepos();

  // 1. 查锚点
  const anchor = await repos.anchor.getById(anchorId);
  if (!anchor) return c.json({ error: 'Anchor not found' }, 404);

  // 2. 获取 Structure 层内容片段
  let structureSnippet = null;
  if (anchor.structure_page_id) {
    const page = await repos.wikiPage.getById(anchor.structure_page_id);
    if (page) {
      // 提取锚点前后各 100 字符的内容片段
      structureSnippet = extractSnippet(page.content, anchor.content_preview);
    }
  }

  // 3. 获取 Raw 层对应节点 + 上下文
  let rawContext = null;
  if (anchor.raw_json_path) {
    try {
      const fs = await import('fs/promises');
      const rawPath = `data/${anchor.kb_id}/documents/${anchor.doc_id}/raw/docling.json`;
      const rawJson = JSON.parse(await fs.readFile(rawPath, 'utf-8'));
      rawContext = resolveJsonPointer(rawJson, anchor.raw_json_path);
    } catch {
      // Raw 文件不存在或路径无效，跳过
    }
  }

  // 4. 添加显示名称
  const displayResolver = new DisplayResolver();
  const displayInfo = await displayResolver.resolve(anchor.doc_id);

  return c.json({
    anchor,
    structureSnippet,
    rawContext,
    display: displayInfo,
  });
});
```

- [ ] **步骤 4：实现 Structure Map 端点**

```typescript
/**
 * GET /api/kbs/:kbId/documents/:docId/structure-map
 * 返回该文档所有 Structure 块的扁平列表（含锚点），用于构建导航侧边栏
 */
preview.get('/kbs/:kbId/documents/:docId/structure-map', async (c) => {
  const { kbId, docId } = c.req.param();
  const repos = createRepos();

  const pages = await repos.wikiPage.getByDocAndType(docId, 'structure');
  const anchors = await repos.anchor.getByDocId(docId);

  const map = pages.map(page => ({
    id: page.id,
    title: page.title,
    sectionPath: page.metadata?.sectionPath,
    pageRange: page.metadata?.pageRange,
    modality: page.metadata?.modality,
    anchors: anchors
      .filter(a => a.structure_page_id === page.id)
      .map(a => ({
        id: a.id,
        type: a.element_type,
        preview: a.content_preview,
      })),
  }));

  return c.json({ structureMap: map });
});
```

- [ ] **步骤 5：注册路由**

在应用启动文件中注册 preview 路由：

```typescript
import previewRoutes from './routes/preview';
app.route('/api', previewRoutes);
```

- [ ] **步骤 6：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 7：提交**
```bash
git add src/server/routes/preview.ts
git commit -m "feat: 新增层级预览和锚点详情 API 端点"
```

---

## 任务 2：检索测试 API

**涉及文件：** `src/server/routes/search-test.ts`（新建）

- [ ] **步骤 1：实现检索测试端点**

新建 `src/server/routes/search-test.ts`：

```typescript
import { Hono } from 'hono';
import { createRepos } from '../../store/repos';
import { getEmbeddingManager } from '../../models/embedding';

const searchTest = new Hono();

interface SearchTestRequest {
  query: string;
  kbIds: string[];
  docIds?: string[];
  methods: ('vector' | 'bm25' | 'grep')[];
  layer: 'abstract' | 'structure';
  topK: number;
}

/**
 * POST /api/search/test
 * 对每种选中的检索方式独立执行，返回各方式的结果 + RRF 融合结果
 */
searchTest.post('/search/test', async (c) => {
  const body = await c.req.json<SearchTestRequest>();
  const { query, kbIds, docIds, methods, layer, topK } = body;
  const repos = createRepos();

  const results: Record<string, any[]> = {};

  // 1. 对每种方法独立执行搜索
  if (methods.includes('vector')) {
    const embeddingManager = getEmbeddingManager();
    const queryVector = await embeddingManager.embed(query);
    results.vector = await repos.vectorSearch.searchByVector(queryVector, kbIds, {
      topK,
      pageTypes: [layer],
    });
  }

  if (methods.includes('bm25')) {
    results.bm25 = await repos.ftsSearch.searchByText(query, kbIds, { topK });
  }

  if (methods.includes('grep')) {
    // grep 搜索：在 Structure 层文件内容中精确匹配
    results.grep = await grepStructurePages(kbIds, docIds, query, topK);
  }

  // 2. RRF 融合（如果有多种方法）
  let fused: any[] | null = null;
  if (methods.length > 1) {
    fused = reciprocalRankFusion(results, topK);
  }

  // 3. 为结果添加显示名称
  const displayResolver = new DisplayResolver();
  const allDocIds = new Set<string>();
  Object.values(results).forEach(arr => arr.forEach(r => allDocIds.add(r.docId)));
  const displayMap = await displayResolver.resolveBatch([...allDocIds]);

  // 注入显示名称
  const enrichResult = (r: any) => ({
    ...r,
    originalName: displayMap[r.docId]?.originalName ?? r.docId,
    kbName: displayMap[r.docId]?.kbName ?? '',
  });

  return c.json({
    results: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, v.map(enrichResult)])
    ),
    fused: fused?.map(enrichResult),
  });
});

/**
 * RRF (Reciprocal Rank Fusion) 合并多路检索结果
 */
function reciprocalRankFusion(
  results: Record<string, any[]>,
  topK: number,
  k = 60,
): any[] {
  const scores = new Map<string, { item: any; score: number }>();

  for (const [, items] of Object.entries(results)) {
    items.forEach((item, rank) => {
      const key = item.pageId || item.id;
      const prev = scores.get(key);
      const rrfScore = 1 / (k + rank + 1);
      if (prev) {
        prev.score += rrfScore;
      } else {
        scores.set(key, { item, score: rrfScore });
      }
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ item, score }) => ({ ...item, rrfScore: score }));
}
```

- [ ] **步骤 2：注册路由**

```typescript
import searchTestRoutes from './routes/search-test';
app.route('/api', searchTestRoutes);
```

- [ ] **步骤 3：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 4：提交**
```bash
git add src/server/routes/search-test.ts
git commit -m "feat: 新增检索测试 API，支持多方法对比和 RRF 融合"
```

---

## 任务 3：增强报告 API

**涉及文件：** `src/server/routes/reports.ts`

- [ ] **步骤 1：通读当前 reports.ts**

理解现有的报告生成和导出逻辑。

- [ ] **步骤 2：更新报告导出功能**

在报告 Markdown 输出中，将现有的 `[来源: ...]` 引用变为可追溯的锚点链接：

```typescript
// 在生成报告 Markdown 时，替换来源引用格式
function enhanceReportWithAnchors(markdown: string): string {
  // 将 [来源: file.pdf → 第一章 (第3页)]
  // 替换为 [来源: file.pdf → 第一章 (第3页)](#anchor:docId:paragraph:5)
  return markdown.replace(
    /\[来源: (.+?) → (.+?) \(第(\d+)页\)\]/g,
    (match, fileName, section, page) => {
      // 从数据库查找对应的锚点
      // 这里需要异步处理，实际实现可能需要在生成时传入锚点映射
      return match; // 占位，实际实现需要锚点映射
    }
  );
}
```

注意：由于锚点 ID 是在编译时生成的，报告生成时需要维护一个 `{文件名+章节+页码 → anchorId}` 的映射。这个映射可以通过 DisplayResolver + AnchorRepo 反查获得。

- [ ] **步骤 3：新增来源清单端点**

```typescript
/**
 * GET /api/reports/:reportId/sources
 * 返回所有来源文档及其锚点引用，按文档分组
 */
router.get('/reports/:reportId/sources', async (c) => {
  const { reportId } = c.req.param();
  const repos = createRepos();

  // 1. 读取报告内容，提取所有锚点引用
  const report = await getReport(reportId);
  if (!report) return c.json({ error: 'Report not found' }, 404);

  const anchorIds = extractAnchorIds(report.content);
  const displayResolver = new DisplayResolver();

  // 2. 查询锚点详情
  const anchors = [];
  for (const id of anchorIds) {
    const anchor = await repos.anchor.getById(id);
    if (anchor) anchors.push(anchor);
  }

  // 3. 按文档分组
  const byDoc = new Map<string, typeof anchors>();
  for (const a of anchors) {
    const list = byDoc.get(a.doc_id) || [];
    list.push(a);
    byDoc.set(a.doc_id, list);
  }

  // 4. 添加显示名称
  const displayMap = await displayResolver.resolveBatch([...byDoc.keys()]);

  const sources = [...byDoc.entries()].map(([docId, docAnchors]) => ({
    docId,
    originalName: displayMap[docId]?.originalName ?? docId,
    kbName: displayMap[docId]?.kbName ?? '',
    fileType: displayMap[docId]?.fileType ?? '',
    anchors: docAnchors.map(a => ({
      id: a.id,
      type: a.element_type,
      sectionTitle: a.section_title,
      pageNumber: a.page_number,
      preview: a.content_preview,
    })),
  }));

  return c.json({ sources });
});
```

- [ ] **步骤 4：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 5：提交**
```bash
git add src/server/routes/reports.ts
git commit -m "feat: 报告 API 增强锚点引用和来源清单端点"
```

---

## 任务 4：下载和导出端点

**涉及文件：** `src/server/routes/knowledge.ts`

- [ ] **步骤 1：通读当前 knowledge.ts**

理解现有的知识库管理路由结构。

- [ ] **步骤 2：实现原始文件下载**

```typescript
/**
 * GET /api/kbs/:kbId/documents/:docId/download
 * 流式传输原始上传文件
 */
router.get('/kbs/:kbId/documents/:docId/download', async (c) => {
  const { kbId, docId } = c.req.param();
  const repos = createRepos();

  // 从 documents 表获取文件路径和原始文件名
  const doc = await repos.document.getById(docId);
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  const filePath = doc.file_path;
  const originalName = doc.original_name || doc.file_name;

  // 流式传输
  const stream = await createReadStream(filePath);
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(originalName)}"`,
    },
  });
});
```

- [ ] **步骤 3：实现多格式导出**

```typescript
/**
 * GET /api/kbs/:kbId/documents/:docId/export/:format
 * format: "raw-json" | "doctags" | "markdown" | "structure-bundle"
 */
router.get('/kbs/:kbId/documents/:docId/export/:format', async (c) => {
  const { kbId, docId, format } = c.req.param();
  const repos = createRepos();

  switch (format) {
    case 'raw-json': {
      // 读取 docling.json
      const fs = await import('fs/promises');
      const rawPath = `data/${kbId}/documents/${docId}/raw/docling.json`;
      const content = await fs.readFile(rawPath, 'utf-8');
      return new Response(content, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${docId}_raw.json"`,
        },
      });
    }

    case 'doctags': {
      // 拼接所有 Structure 页面的 DocTags 内容
      const pages = await repos.wikiPage.getByDocAndType(docId, 'structure');
      const doctags = pages.map(p => `# ${p.title}\n\n${p.content}`).join('\n\n---\n\n');
      return new Response(doctags, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${docId}_doctags.txt"`,
        },
      });
    }

    case 'markdown': {
      // 拼接所有 Structure 页面的 Markdown 内容
      const pages = await repos.wikiPage.getByDocAndType(docId, 'structure');
      const md = pages.map(p => `## ${p.title}\n\n${p.content}`).join('\n\n');
      return new Response(md, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${docId}.md"`,
        },
      });
    }

    case 'structure-bundle': {
      // 打包所有 Structure 分块 + 元数据为 zip
      const pages = await repos.wikiPage.getByDocAndType(docId, 'structure');
      const anchors = await repos.anchor.getByDocId(docId);
      const bundle = await createStructureBundle(pages, anchors);
      return new Response(bundle, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${docId}_structure.zip"`,
        },
      });
    }

    default:
      return c.json({ error: `Invalid format: ${format}` }, 400);
  }
});
```

其中 `createStructureBundle()` 使用 archiver 或 JSZip 将所有文件打包为 zip。

- [ ] **步骤 4：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 5：提交**
```bash
git add src/server/routes/knowledge.ts
git commit -m "feat: 新增文件下载和多格式导出端点（raw-json/doctags/markdown/structure-bundle）"
```

---

## 任务 5：前端 — LayerPreview 组件

**涉及文件：** 前端 `LayerPreview.tsx`

- [ ] **步骤 1：通读前端项目结构**

理解前端框架（React）、路由方式、组件组织方式和 API 调用模式。

- [ ] **步骤 2：实现三标签页布局**

创建 `LayerPreview.tsx` 组件：

```tsx
// 核心结构
function LayerPreview({ kbId, docId }: { kbId: string; docId: string }) {
  const [activeLayer, setActiveLayer] = useState<'abstract' | 'structure' | 'raw'>('abstract');
  const [structureMap, setStructureMap] = useState<StructureItem[]>([]);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);

  // 顶层标签页切换
  // 左侧边栏：文档元数据 + 导航
  //   - Structure 标签页：展示目录树（从 structure-map API 获取）
  //   - Raw 标签页：展示元素类型树
  // 主内容区：选中层级的渲染内容
  // 顶部栏：原始文件名 + 知识库名 + 文件类型图标 + 页数/元素数

  return (
    <div className="layer-preview">
      {/* 顶部栏 */}
      <header className="layer-header">
        <span className="file-icon">{modalityIcon}</span>
        <span className="file-name">{displayInfo.originalName}</span>
        <span className="kb-name">{displayInfo.kbName}</span>
        <span className="file-meta">{fileMetaText}</span>
      </header>

      {/* 标签页切换 */}
      <nav className="layer-tabs">
        <button onClick={() => setActiveLayer('abstract')}>Abstract</button>
        <button onClick={() => setActiveLayer('structure')}>Structure</button>
        <button onClick={() => setActiveLayer('raw')}>Raw</button>
      </nav>

      {/* 主体 */}
      <div className="layer-body">
        <aside className="layer-sidebar">
          {/* 根据层级显示不同导航 */}
        </aside>
        <main className="layer-content">
          {activeLayer === 'abstract' && <AbstractView />}
          {activeLayer === 'structure' && <StructureView chunkId={selectedChunk} />}
          {activeLayer === 'raw' && <RawJsonView />}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **步骤 3：Structure 标签页**

- 将 DocTags 内容渲染为可读的 HTML（标题、表格、段落）
- 显示分块元数据（页码范围、字数、元素类型）
- 点击侧边栏的章节可导航到对应位置

- [ ] **步骤 4：Raw 标签页**

- 将 JSON 渲染为可折叠树
- 每个节点显示类型标签
- 点击节点 → 高亮对应的 Structure 分块

- [ ] **步骤 5：Abstract 标签页**

- 展示摘要文本
- 显示标签云
- 可点击的目录列表 → 跳转到 Structure 分块

- [ ] **步骤 6：跨层导航**

点击任何元素，提供"查看 Raw 数据"或"查看 Structure 内容"的选项。

- [ ] **步骤 7：提交**
```bash
git add frontend/src/components/LayerPreview.tsx
git commit -m "feat: 新增 LayerPreview 组件，支持 Abstract/Structure/Raw 三标签页"
```

---

## 任务 6：前端 — AnchorHoverCard 悬浮预览组件

**涉及文件：** 前端 `AnchorHoverCard.tsx`

- [ ] **步骤 1：实现锚点悬浮预览**

创建 `AnchorHoverCard.tsx` 组件：

```tsx
function AnchorHoverCard({ anchorId }: { anchorId: string }) {
  const [data, setData] = useState<AnchorDetail | null>(null);
  const [visible, setVisible] = useState(false);

  // 鼠标悬浮时调用 GET /api/anchors/:anchorId
  const handleMouseEnter = useCallback(() => {
    setVisible(true);
    if (!data) {
      fetch(`/api/anchors/${anchorId}`)
        .then(r => r.json())
        .then(setData);
    }
  }, [anchorId, data]);

  return (
    <span
      className="anchor-ref"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setVisible(false)}
    >
      {/* 渲染来源引用文本 */}
      {children}
      {visible && (
        <div className="anchor-hover-card">
          {data ? (
            <>
              <div className="anchor-header">
                <span className="anchor-icon">{getModalityIcon(data.anchor.element_type)}</span>
                <span className="anchor-file">{data.display.originalName}</span>
                <span className="anchor-location">
                  {data.display.kbName} → {data.anchor.section_title}
                  {data.anchor.page_number != null && ` (第${data.anchor.page_number}页)`}
                </span>
              </div>
              <div className="anchor-snippet">
                {data.structureSnippet}
              </div>
              <a href={`/preview/${data.anchor.doc_id}?anchor=${anchorId}`} className="anchor-link">
                查看完整上下文
              </a>
            </>
          ) : (
            <span>加载中...</span>
          )}
        </div>
      )}
    </span>
  );
}
```

- [ ] **步骤 2：支持不同模态的预览样式**

```tsx
function ModalityPreview({ data }: { data: AnchorDetail }) {
  switch (data.display.modality) {
    case 'document':
      return <DocumentSnippet snippet={data.structureSnippet} />;
    case 'excel':
      return <ExcelSnippet anchor={data.anchor} />;
    case 'image':
      return <ImageSnippet thumbnail={data.rawContext?.thumbnail} description={data.anchor.content_preview} />;
    case 'audio':
      return <AudioSnippet turns={data.rawContext?.turns} />;
    case 'video':
      return <VideoSnippet frame={data.rawContext?.frame} description={data.anchor.content_preview} />;
    default:
      return <span>{data.anchor.content_preview}</span>;
  }
}
```

- [ ] **步骤 3：集成到报告渲染器**

在报告的 Markdown 渲染中，将 `[来源: ...]` 引用替换为 AnchorHoverCard 组件：

```tsx
// 报告 Markdown 渲染时，识别来源引用并替换
function renderReportContent(markdown: string) {
  // 正则匹配 [来源: ...] 格式
  const parts = markdown.split(/(\[来源: [^\]]+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/\[来源: [^\]]+\]\(#anchor:([^)]+)\)/);
    if (match) {
      return <AnchorHoverCard key={i} anchorId={match[1]}>{part}</AnchorHoverCard>;
    }
    return <Markdown key={i}>{part}</Markdown>;
  });
}
```

- [ ] **步骤 4：提交**
```bash
git add frontend/src/components/AnchorHoverCard.tsx
git commit -m "feat: 新增 AnchorHoverCard 报告来源悬浮预览组件"
```

---

## 任务 7：前端 — SearchTestPanel 检索测试组件

**涉及文件：** 前端 `SearchTestPanel.tsx`

- [ ] **步骤 1：实现搜索输入区**

创建 `SearchTestPanel.tsx` 组件：

```tsx
function SearchTestPanel() {
  const [query, setQuery] = useState('');
  const [selectedKbs, setSelectedKbs] = useState<string[]>([]);
  const [methods, setMethods] = useState<('vector' | 'bm25' | 'grep')[]>(['vector', 'bm25']);
  const [layer, setLayer] = useState<'abstract' | 'structure'>('structure');
  const [topK, setTopK] = useState(10);
  const [results, setResults] = useState<SearchTestResults | null>(null);

  const handleSearch = async () => {
    const res = await fetch('/api/search/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, kbIds: selectedKbs, methods, layer, topK }),
    });
    setResults(await res.json());
  };

  return (
    <div className="search-test-panel">
      {/* 搜索输入区 */}
      <div className="search-input-area">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="输入搜索查询..." />
        <KbSelector selected={selectedKbs} onChange={setSelectedKbs} />
        <MethodSelector methods={methods} onChange={setMethods} />
        <LayerSelector layer={layer} onChange={setLayer} />
        <button onClick={handleSearch}>搜索</button>
      </div>

      {/* 结果展示区 */}
      {results && (
        <div className="search-results">
          {/* 方法对比视图 */}
          <div className="results-comparison">
            {Object.entries(results.results).map(([method, items]) => (
              <div key={method} className="method-column">
                <h3>{method}</h3>
                {items.map((item, i) => (
                  <ResultCard key={i} result={item} />
                ))}
              </div>
            ))}
          </div>

          {/* RRF 融合结果 */}
          {results.fused && (
            <div className="fused-results">
              <h3>RRF 融合结果</h3>
              {results.fused.map((item, i) => (
                <ResultCard key={i} result={item} showMethod={true} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **步骤 2：实现结果卡片组件**

每条结果卡片显示：原始文件名 + 章节标题 + 分数 + 方式标签 + 高亮片段。每条结果有 [预览 Structure] [预览 Raw] 按钮。

- [ ] **步骤 3：实现导出功能**

添加导出按钮，将检索结果下载为 JSON 日志：

```tsx
const handleExport = () => {
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `search-test-${Date.now()}.json`;
  a.click();
};
```

- [ ] **步骤 4：提交**
```bash
git add frontend/src/components/SearchTestPanel.tsx
git commit -m "feat: 新增 SearchTestPanel 检索方法测试界面"
```

---

## 任务 8：前端 — DocumentManager 文件管理增强

**涉及文件：** 前端 `DocumentManager.tsx`

- [ ] **步骤 1：通读当前文件管理组件**

理解现有的文件列表组件和数据处理逻辑。

- [ ] **步骤 2：实现文件类型图标映射**

```tsx
const FILE_TYPE_ICONS: Record<string, string> = {
  pdf: '📄',
  docx: '📄',
  pptx: '📄',
  xlsx: '📊',
  xls: '📊',
  csv: '📊',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  mp3: '🎙️',
  wav: '🎙️',
  mp4: '📹',
  avi: '📹',
  mov: '📹',
};
```

- [ ] **步骤 3：实现各类型专属元数据展示**

```tsx
function FileMetaData({ doc }: { doc: DocumentInfo }) {
  switch (doc.modality) {
    case 'document':
      return <span>{doc.pageCount} 页</span>;
    case 'excel':
      return <span>{doc.sheetCount} Sheet · {doc.tableCount} 表格</span>;
    case 'audio':
      return <span>{formatDuration(doc.duration)} · {doc.speakerCount} 发言者</span>;
    case 'video':
      return <span>{formatDuration(doc.duration)} · {doc.resolution}</span>;
    case 'image':
      return <span>{doc.width}x{doc.height}</span>;
    default:
      return null;
  }
}
```

- [ ] **步骤 4：实现处理进度显示**

```tsx
function ProcessingProgress({ status }: { status: ProcessingStatus }) {
  const steps = [
    { label: '解析', progress: 20 },
    { label: '编译', progress: 40 },
    { label: '锚点', progress: 60 },
    { label: '索引', progress: 80 },
    { label: '完成', progress: 100 },
  ];

  return (
    <div className="processing-progress">
      <div className="progress-bar" style={{ width: `${status.progress}%` }} />
      <span className="progress-label">{steps.find(s => s.progress >= status.progress)?.label}</span>
    </div>
  );
}
```

- [ ] **步骤 5：实现每文档操作按钮**

每个文档行右侧的操作按钮：[预览] [重新处理] [下载原始] [删除]

- [ ] **步骤 6：提交**
```bash
git add frontend/src/components/DocumentManager.tsx
git commit -m "feat: 增强 DocumentManager，支持多模态展示、进度显示和操作按钮"
```

---

## 任务 9：前端 — ReportViewer 报告展示增强

**涉及文件：** 前端 `ReportViewer.tsx`

- [ ] **步骤 1：通读当前报告展示组件**

理解现有的报告渲染和展示逻辑。

- [ ] **步骤 2：实现报告头部**

```tsx
function ReportHeader({ report }: { report: ReportInfo }) {
  return (
    <div className="report-header">
      <h1>{report.title}</h1>
      <div className="report-meta">
        <span>生成时间: {formatDate(report.createdAt)}</span>
        <span>Agent 类型: {report.agentType}</span>
        <span>检索次数: {report.searchCount}</span>
        <ConfidenceBadge level={report.confidence} />
      </div>
    </div>
  );
}
```

- [ ] **步骤 3：集成 AnchorHoverCard**

报告正文使用 Markdown 渲染，所有 `[来源: ...]` 引用使用 AnchorHoverCard 组件（已在任务 6 实现）。

- [ ] **步骤 4：实现来源面板**

底部来源面板：列出所有来源文档（含模态图标），点击展开查看锚点引用。

```tsx
function SourcePanel({ reportId }: { reportId: string }) {
  const [sources, setSources] = useState<SourceDocument[]>([]);

  useEffect(() => {
    fetch(`/api/reports/${reportId}/sources`)
      .then(r => r.json())
      .then(data => setSources(data.sources));
  }, [reportId]);

  return (
    <div className="source-panel">
      <h3>信息来源</h3>
      {sources.map(src => (
        <div key={src.docId} className="source-doc">
          <span className="source-icon">{FILE_TYPE_ICONS[src.fileType]}</span>
          <span className="source-name">{src.originalName}</span>
          <span className="source-kb">{src.kbName}</span>
          <div className="source-anchors">
            {src.anchors.map(a => (
              <AnchorHoverCard key={a.id} anchorId={a.id}>
                {a.sectionTitle} (第{a.pageNumber}页)
              </AnchorHoverCard>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **步骤 5：实现 Agent 过程视图**

"查看 Agent 检索过程"按钮 → 展开面板，展示检索步骤、查询词、每步结果（从 agent_tasks 父子层级读取）。

- [ ] **步骤 6：实现操作按钮**

[导出报告] [重新生成] [用相同查询测试检索]

- [ ] **步骤 7：提交**
```bash
git add frontend/src/components/ReportViewer.tsx
git commit -m "feat: 增强 ReportViewer，支持锚点悬浮、来源面板和 Agent 过程视图"
```

---

## 执行顺序

任务 1-4（后端 API）应先完成。
任务 5-9（前端）依赖后端 API，但前端各任务之间可并行。

```
任务 1（预览 API）──── 任务 5（LayerPreview 组件）
任务 2（检索 API）──── 任务 7（SearchTestPanel 组件）
任务 3（报告 API）──── 任务 9（ReportViewer 组件）
任务 4（下载导出）──── 任务 8（DocumentManager 组件）
                     任务 6（AnchorHoverCard）— 依赖任务 1 + 任务 3
```

任务 1-4 可并行（独立的后端 API 路由）。
任务 5-9 依赖任务 1-4 的 API 端点，但前端各任务之间可并行。
任务 6（AnchorHoverCard）依赖任务 1（锚点 API）和任务 3（报告 API）。
