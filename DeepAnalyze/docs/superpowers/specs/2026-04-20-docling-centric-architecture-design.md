# DeepAnalyze — Docling 中心化架构改造设计

> 日期：2026-04-20 | 状态：已批准 | 关联需求：C-03, C-07~C-12, C-13~C-17, C-18~C-21

---

## 一、背景与目标

### 当前问题

1. **处理路由混乱**：Docling 支持 16 种输入格式（PDF、DOCX、PPTX、XLSX、HTML、MD、TXT、CSV、图片、音频等），但当前 `ProcessorFactory` 仅将 PDF/DOCX/PPTX/PPT 路由到 Docling，其余走自定义处理器，导致同一类型文件有时走 Docling 有时走自定义处理器，输出格式不统一。

2. **L1 层单格式**：当前 L1 只有 DocTags 格式（`structure` pageType），缺少 Markdown 格式。Docling 本身支持同时导出两种格式，但未被充分利用。

3. **Raw 层定位不清**：当前 `fulltext` pageType 承担 L2 角色，存储的是纯文本而非 Docling 原始 JSON。真正的 Raw 层（docling.json 磁盘文件）没有被系统性地作为数据基础层使用。

4. **知识复利/图谱功能鸡肋**：实体提取、图谱链接、知识复合写入等功能占用处理时间和 LLM 调用成本，但实际价值有限，需要禁用。

### 设计目标

- **Docling 优先**：所有 Docling 支持的格式默认走 Docling 处理，最大化利用其结构化解析能力
- **统一三层模型**：Raw(L2) → L1(Markdown + DocTags) → L0(LLM 摘要)，每层定位清晰
- **双格式 L1**：L1 层同时存储 Markdown（人阅读）和 DocTags（LLM 使用），各自独立索引
- **禁用鸡肋功能**：知识复利、实体提取、图谱构建全部禁用，代码保留
- **处理器可切换**：前端提供手动通道，用户可在 Docling 和本地处理器之间切换

---

## 二、Docling 能力现状

Docling（≥2.89）原生支持的输入格式：

| 格式类别 | 文件类型 | Docling 后端 |
|----------|----------|-------------|
| 文档 | PDF, DOCX, DOC, PPTX, PPT, XLSX, XLSM, HTML, HTM | 各类 DocumentBackend |
| 文本 | MD, TXT, QMD, RMD, ASCIIDOC, LATEX | MarkdownDocumentBackend 等 |
| 图片 | JPG, JPEG, PNG, TIF, TIFF, BMP, WEBP | ImageDocumentBackend |
| 音频 | WAV, MP3, M4A, AAC, OGG, FLAC | AsrPipeline |
| 其他 | JSON(Docling), VTT, XML(USPTO/JATS/XBRL) | 各类 Backend |

Docling 原生支持的输出格式：

| 输出格式 | 方法 | 用途 |
|----------|------|------|
| Markdown | `export_to_markdown()` | 人阅读 |
| DocTags | `export_to_doctags()` | LLM 友好的结构化标注 |
| JSON | `export_to_dict()` | 完整 DoclingDocument 结构 |
| HTML | `save_as_html()` | 浏览器预览 |
| TEXT | `save_as_markdown(strict_text=True)` | 纯文本 |

Docling 内建并发处理：`doc_batch_concurrency` + `ThreadPoolExecutor`。

**DeepAnalyze 不支持的视频格式**（mp4, avi, mov, mkv, webm, flv, wmv）由自定义 VideoProcessor 处理。

---

## 三、处理管线重构

### 3.1 新 ProcessorFactory 路由

```
输入文件 → ProcessorFactory
  │
  ├─ Step 1: 表格文件？
  │    xlsx, xls, csv
  │    → NativeTableProcessor（元数据描述，Agent 用 pandas 分析源文件）
  │
  ├─ Step 2: 视频格式？
  │    mp4, avi, mov, mkv, webm, flv, wmv
  │    → VideoProcessor（输出 Docling 兼容 JSON）
  │
  ├─ Step 3: 图片格式？
  │    png, jpg, jpeg, gif, bmp, tiff, webp, svg
  │    → ImageProcessor（VLM + Docling OCR）
  │
  ├─ Step 4: Docling 可用且格式受支持？
  │    支持: pdf, docx, doc, pptx, ppt, xlsm,
  │          html, htm, md, txt, asciidoc, latex,
  │          jpg, jpeg, png, tif, tiff, bmp, webp,
  │          wav, mp3, m4a, aac, ogg, flac
  │    → DoclingProcessor
  │
  ├─ Step 5: 音频？
  │    → AudioProcessor（ASR + 发言人分离）
  │
  └─ Step 6: 剩余纯文本格式
       json, xml, rtf, odt, epub 等
       → TextProcessor（纯文本，无结构信息）
```

### 3.2 DoclingProcessor 扩展

当前 `DoclingProcessor` 仅处理 PDF/DOCX/PPTX/PPT，需扩展支持：

- **新增文件类型**：xlsx, xlsm, html, htm, md, txt, asciidoc, latex, jpg, jpeg, png, tif, tiff, bmp, webp, wav, mp3, m4a, aac, ogg, flac
- **CSV 不经 Docling**：CSV 文件由 NativeTableProcessor 统一处理（与 XLSX/XLS 同一通道），生成元数据描述，Agent 通过 pandas 分析源文件
- **统一输出**：所有格式都返回完整的 `ParsedContent`，包含 `raw`（DoclingDocument JSON）、`doctags`、`markdown`、`text`

### 3.3 处理器手动切换

前端文档卡片增加「处理器」选择：

| 选项 | 行为 |
|------|------|
| `auto`（默认） | Docling 优先，不支持时回退到本地处理器 |
| `docling` | 强制使用 Docling（格式不支持时提示错误） |
| `native` | 强制使用本地处理器（绕过 Docling） |

切换后调用 `POST /kbs/:kbId/process/:docId` 重新处理，传入 `processor` 参数。选项根据文件类型动态过滤（视频格式不显示 `docling`）。

### 3.4 ParsedContent 统一接口

```typescript
interface ParsedContent {
  text: string;                    // 纯文本（向后兼容）
  markdown: string;                // Markdown 格式（新增，用于 L1_md）
  metadata: Record<string, unknown>;
  success: boolean;
  error?: string;
  raw?: Record<string, unknown>;   // DoclingDocument JSON 或兼容 JSON
  doctags?: string;                // DocTags 格式（用于 L1_dt）
  modality?: 'document' | 'image' | 'audio' | 'video';
}
```

---

## 四、编译管线重构

### 4.1 新编译流程

```
ParsedContent
  ├── raw: DoclingDocument JSON        ← Raw/L2
  ├── doctags: DocTags                 ← 用于 L1_dt
  ├── markdown: Markdown               ← 用于 L1_md
  └── modality
       ↓
┌──────────────────────────────────────────────┐
│ Step 1: compileRaw()                         │
│   保存 docling.json + metadata.json 到磁盘   │
│   AnchorGenerator 基于 raw JSON 生成锚点     │
│   Raw 层 = 原始 Docling JSON，确定性锚点     │
├──────────────────────────────────────────────┤
│ Step 2: compileL1()                          │
│   有 doctags/markdown?                       │
│     → 按标题/章节切分为 section              │
│     → 每个 section 生成:                     │
│       structure_md page (Markdown)           │
│       structure_dt page (DocTags)            │
│     → 共享锚点 ID，各自独立 embedding + FTS  │
│   无 doctags（纯文本回退）?                   │
│     → 整篇作为一个 L1_md page（无 L1_dt）    │
├──────────────────────────────────────────────┤
│ Step 3: compileL0()                          │
│   LLM 从 L1_md sections 生成:               │
│     - 文档摘要（≤300 字）                    │
│     - 标签                                   │
│     - 文档类型                               │
│   保存为 abstract page                       │
├──────────────────────────────────────────────┤
│ Step 4: compileIndex()                       │
│   L0 + L1_md + L1_dt → embedding + FTS      │
│   不再执行实体提取、图谱链接、知识复利        │
└──────────────────────────────────────────────┘
```

### 4.2 层级对照表

| 层级 | pageType(s) | 来源 | LLM？ | 索引 | 前端预览 |
|------|-------------|------|-------|------|----------|
| L0 | `abstract` | LLM 从 L1 生成 | 是 | FTS + 向量 | 摘要+标签+类型 |
| L1_md | `structure_md` | Docling `export_to_markdown()` 切分 | 否 | FTS + 向量 | Markdown 渲染 |
| L1_dt | `structure_dt` | Docling `export_to_doctags()` 切分 | 否 | FTS + 向量 | DocTags 原文 |
| L2/Raw | 磁盘 `docling.json` | Docling `export_to_dict()` | 否 | 不索引 | 按锚点定位读取 |

### 4.3 多模态编译

保持现有 modality compiler 逻辑，调整为双格式输出：

- **图片**：L1_md = VLM 描述 Markdown，L1_dt = `[img]` + `[ocr]` DocTags
- **音频**：L1_md = 发言人标签 Markdown 转写，L1_dt = `[p](speaker=...;time=...)` DocTags
- **视频**：L1_md = 场景描述 Markdown，L1_dt = `[scene](time=...)` + `[dialog]` DocTags

### 4.4 向后兼容

- 旧的 `overview` 和 `structure` pageType 的已有数据保持不变
- 旧数据仍可通过 Retriever 搜索到（Retriever 同时映射旧类型和新类型）
- 不需要 DB migration，`page_type` 字段是 TEXT 类型，直接新增值

---

## 五、Agent 检索与工具层

### 5.1 层次递进检索策略

```
Step 1: kb_search(query, pageTypes=["abstract"])
        → L0 快速定位相关文档

Step 2: kb_search(query, pageTypes=["structure_dt"])
        → L1 DocTags 精准检索（推荐，LLM 友好）
   或:  kb_search(query, pageTypes=["structure_md"])
        → L1 Markdown 检索

Step 3: expand(pageId, targetLevel="raw", anchorId="...")
        → 按需展开到 Raw 层，通过锚点精确定位

Step 4: wiki_browse(pageId)
        → 浏览页面详情
```

### 5.2 工具改动

**`kb_search`：**
- `pageTypes` 新增 `structure_md` 和 `structure_dt`
- 移除 `"entity"`, `"concept"` 搜索支持
- Retriever 层级映射：
  - L0 = `["abstract"]`
  - L1 = `["structure_md", "structure_dt", "overview", "structure"]`（新旧兼容）
  - L2 = `["fulltext"]`
- 新增 `mode: "grep"` 参数，支持正则表达式在 structure_dt 层搜索（C-19）

**`wiki_browse`：**
- 移除 `followLinks` 参数和链接遍历功能
- 移除关联面板
- 新增 `format` 参数：`"markdown"` | `"doctags"`

**`expand`：**
- `targetLevel` 新增 `"raw"` 选项
- L1 展开时默认返回 `structure_dt`，增加 `format` 参数
- Raw 层通过锚点定位读取 `docling.json` 片段

**`graph_build`：** 注释掉工具注册，代码保留。

**`timeline_build`：** 保留不改动。

### 5.3 前端搜索与预览

**搜索栏：**
- 层级选择器：L0 / L1 / L2 / 全部
- L1 搜索结果默认展示 `structure_md`，提供切换到 `structure_dt` 的按钮
- 搜索结果携带锚点信息

**文档卡片：**
- L0/L1/L2 按钮保持现有交互
- L1 按钮内部提供 md/dt 格式切换（默认 md）
- 增加处理器选择下拉（auto/docling/native）
- 移除实体关联面板

---

## 六、知识复利/图谱禁用

### 6.1 禁用模块清单

| 模块 | 文件 | 处置 |
|------|------|------|
| Agent 自动 compound | `src/services/agent/agent-runner.ts:424-483` | 条件化禁用 |
| EntityExtractor | `src/wiki/entity-extractor.ts` | 保留代码，调用点注释 |
| Linker | `src/wiki/linker.ts` | 保留代码，调用点注释 |
| L0Linker | `src/wiki/l0-linker.ts` | 已禁用，保持 |
| KnowledgeCompounder | `src/wiki/knowledge-compound.ts` | 保留代码，调用点注释 |
| graph_build 工具 | `src/services/agent/tool-setup.ts` | 注释注册 |
| wiki_browse 链接 | `src/services/agent/tool-setup.ts` | 移除 followLinks |
| 编译中实体提取 | `src/wiki/compiler.ts` | 跳过 extractAndUpdateLinks |
| 路由中实体提取 | `src/server/routes/knowledge.ts` | 跳过 extractEntitiesAndLinks |
| 前端实体导航 | `frontend/src/components/knowledge/KnowledgePanel.tsx` | 隐藏入口 |
| 前端图谱组件 | `frontend/src/components/knowledge/KnowledgeGraph.tsx` | 隐藏入口 |

### 6.2 保留的代码文件（不修改）

- `src/wiki/entity-extractor.ts` — 完整保留
- `src/wiki/linker.ts` — 完整保留
- `src/wiki/l0-linker.ts` — 完整保留
- `src/wiki/knowledge-compound.ts` — 完整保留
- `frontend/src/components/knowledge/KnowledgeGraph.tsx` — 完整保留
- `frontend/src/components/knowledge/EntityPage.tsx` — 完整保留

---

## 七、文件变更总览

### 主要修改文件

| 文件 | 改动范围 |
|------|----------|
| `src/services/document-processors/processor-factory.ts` | 重构路由：Docling 优先 |
| `src/services/document-processors/docling-processor.ts` | 扩展支持的文件类型 |
| `src/services/document-processors/types.ts` | `ParsedContent` 增加 `markdown` 字段 |
| `src/wiki/compiler.ts` | 重构编译管线：Raw → L1_md+dt → L0，禁用实体/链接 |
| `src/wiki/modality-compilers/image-structure.ts` | 双格式输出 |
| `src/wiki/modality-compilers/audio-structure.ts` | 双格式输出 |
| `src/wiki/modality-compilers/video-structure.ts` | 双格式输出 |
| `src/wiki/retriever.ts` | 更新层级映射 |
| `src/wiki/expander.ts` | 新增 raw 层访问、format 参数 |
| `src/services/agent/tool-setup.ts` | 工具注册更新 |
| `src/services/agent/agent-runner.ts` | 禁用自动 compound |
| `src/server/routes/knowledge.ts` | 禁用实体提取，增加处理器参数 |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | 处理器选择，隐藏图谱/实体入口 |
| `frontend/src/components/knowledge/DocumentCard.tsx` | L1 md/dt 切换 |
| `frontend/src/components/search/LevelSwitcher.tsx` | 支持 structure_md/structure_dt |

### 不需要 DB Migration

`wiki_pages.page_type` 是 TEXT 类型，直接新增 `structure_md` 和 `structure_dt` 值。旧 `overview`/`structure` 数据保持兼容。

---

## 八、实施优先级建议

按依赖关系排序：

1. **阶段一：类型与路由** — `ParsedContent` 扩展、`ProcessorFactory` 重构、`DoclingProcessor` 扩展
2. **阶段二：编译管线** — `WikiCompiler` 重构、双格式 L1、L0 生成
3. **阶段三：检索与工具** — `Retriever` 映射更新、`Expander` 增强、Agent 工具更新
4. **阶段四：禁用知识复利** — 注释调用点、隐藏前端入口
5. **阶段五：前端** — 处理器选择、L1 格式切换、搜索结果展示
6. **阶段六：验证** — 端到端测试：上传 → 解析 → 编译 → 索引 → 检索 → Agent 调用
