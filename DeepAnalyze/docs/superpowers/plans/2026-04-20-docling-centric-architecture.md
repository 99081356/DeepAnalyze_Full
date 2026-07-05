# Docling 中心化架构改造 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将文档处理管线重构为 Docling 优先路由，编译管线改为 Raw→L1_md+L1_dt→L0 三层模型，禁用知识复利/图谱功能。

**Architecture:** ProcessorFactory 以 Docling 为首选处理器处理其支持的 16 种格式，不支持的格式（视频等）走自定义处理器。编译管线统一输出双格式 L1（structure_md + structure_dt），L0 由 LLM 从 L1 生成。所有知识图谱/实体提取/知识复利功能禁用但代码保留。

**Tech Stack:** TypeScript (Bun), Docling (Python subprocess), PostgreSQL, React (前端)

---

## 阶段一：类型与路由

### Task 1: 扩展 ParsedContent 类型

**Files:**
- Modify: `src/services/document-processors/types.ts:3-14`

当前 `ParsedContent` 没有 `markdown` 字段，需要新增以便编译管线区分 Markdown 和 DocTags。

- [ ] **Step 1:** 在 `ParsedContent` 接口中新增 `markdown` 字段

在 `doctags?: string;`（line 11）之后添加：
```typescript
  /** Markdown text representation (for L1_md pages). */
  markdown?: string;
```

- [ ] **Step 2:** 确认 TypeScript 编译通过

Run: `node /mnt/d/code/deepanalyze/deepanalyze/node_modules/typescript/bin/tsc -p /mnt/d/code/deepanalyze/deepanalyze/tsconfig.json --noEmit 2>&1 | grep "types.ts" | head -5`

Expected: 无新增错误（`ParsedContent` 的 `markdown` 是可选字段，不影响现有代码）

- [ ] **Step 3:** Commit

```bash
git add src/services/document-processors/types.ts
git commit -m "feat: add markdown field to ParsedContent for dual L1 format"
```

---

### Task 2: 扩展 DoclingProcessor 支持更多文件类型

**Files:**
- Modify: `src/services/document-processors/docling-processor.ts:59-63`

当前 `HANDLED_TYPES` 仅包含 `pdf, docx, doc, pptx, ppt`。需要扩展为 Docling 支持的全部格式。

- [ ] **Step 1:** 扩展 `HANDLED_TYPES` 集合

将 line 59 的 `HANDLED_TYPES` 替换为：
```typescript
private static readonly HANDLED_TYPES = new Set([
  // 文档
  "pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xlsm",
  // 网页
  "html", "htm",
  // 文本（Docling 的 MarkdownDocumentBackend 支持）
  "md", "txt", "csv", "asciidoc", "adoc", "asc", "latex", "tex",
  // 图片（Docling 的 ImageDocumentBackend）
  "jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp",
  // 音频（Docling 的 AsrPipeline）
  "wav", "mp3", "m4a", "aac", "ogg", "flac",
]);
```

- [ ] **Step 2:** 更新 `parse()` 方法的返回值

在 `parse()` 方法中，确认 Docling 返回的结果已经包含 `markdown`（当前 `result.content` 就是 Markdown）。在返回的 `ParsedContent` 中添加 `markdown` 字段：

找到返回 `ParsedContent` 的位置（约 line 130-146），在现有 `doctags` 字段之后添加：
```typescript
markdown: result.content || "",
```

- [ ] **Step 3:** 验证 TypeScript 编译

Run: `node /mnt/d/code/deepanalyze/deepanalyze/node_modules/typescript/bin/tsc -p /mnt/d/code/deepanalyze/deepanalyze/tsconfig.json --noEmit 2>&1 | grep "docling-processor" | head -5`

- [ ] **Step 4:** Commit

```bash
git add src/services/document-processors/docling-processor.ts
git commit -m "feat: expand DoclingProcessor to support all Docling formats"
```

---

### Task 3: 重构 ProcessorFactory 路由为 Docling 优先

**Files:**
- Modify: `src/services/document-processors/processor-factory.ts:14-42`

当前优先级：NativeExcel → Image → Audio → Video → Text → Docling（最后）。
需要改为：Docling（第一）→ Video → 回退链（NativeExcel/Image/Audio）→ Text。

- [ ] **Step 1:** 重写构造函数中的处理器优先级

替换 line 14-28 的 `this.processors = [...]` 为：
```typescript
this.processors = [
  new DoclingProcessor(),        // Priority 1: Docling handles all supported formats
  new VideoProcessor(),           // Priority 2: Video (not supported by Docling)
  new NativeExcelProcessor(),     // Fallback: Excel when Docling unavailable
  new ImageProcessor(),           // Fallback: Image with VLM enhancement
  new AudioProcessor(),           // Fallback: Audio with speaker diarization
  new TextProcessor(),            // Fallback: Plain text formats (json, xml, rtf, epub, etc.)
];
```

- [ ] **Step 2:** 更新 `getProcessor` 方法的 fallback 逻辑

当前 line 38-42 中 fallback 到最后一个处理器（原来是 Docling，现在是 TextProcessor）。需要修改为：找不到匹配时 fallback 到 DoclingProcessor（第一个），因为 Docling 可能支持但 canHandle 未覆盖的格式。

替换 `getProcessor` 方法为：
```typescript
getProcessor(fileType: string): DocumentProcessor {
  const processor = this.processors.find(p => p.canHandle(fileType));
  // Default to DoclingProcessor (first in list) for unknown types
  return processor ?? this.processors[0];
}
```

- [ ] **Step 3:** 验证路由正确性

Run: `node /mnt/d/code/deepanalyze/deepanalyze/node_modules/typescript/bin/tsc -p /mnt/d/code/deepanalyze/deepanalyze/tsconfig.json --noEmit 2>&1 | grep "processor-factory" | head -5`

- [ ] **Step 4:** Commit

```bash
git add src/services/document-processors/processor-factory.ts
git commit -m "feat: restructure ProcessorFactory to Docling-first routing"
```

---

## 阶段二：编译管线重构

### Task 4: 重构 WikiCompiler 编译管线

**Files:**
- Modify: `src/wiki/compiler.ts`

这是核心改动。需要修改 `compile()` 主方法（line 72-169）和 `compileStructureDocument()`（line 306-358）。

**关键改动点：**

1. `compile()` line 110-127 的新流程：在 `compileStructure()` 之后不再需要 `compileFulltext()`（Raw 层取代了 fulltext 的角色）
2. `compileStructureDocument()` line 342-353：每个 section 需要创建两个 page（`structure_md` + `structure_dt`）而非一个 `structure` page
3. `compile()` line 137：禁用 `extractAndUpdateLinks()`
4. `compile()` line 140-149：禁用 `buildForwardLinks()`

- [ ] **Step 1:** 修改 `compile()` 主方法，禁用实体提取和链接

在 line 136-149 的实体提取和链接代码外包裹条件判断：
```typescript
// Entity extraction and link creation — DISABLED per design decision
// Code preserved for potential future re-enablement
// await this.extractAndUpdateLinks(kbId, docId);
// try { ... linker.buildForwardLinks(kbId) ... } catch { ... }
```

- [ ] **Step 2:** 修改 `compileStructureDocument()` 为双格式输出

在 line 342-353 的 section 创建循环中，将每个 section 从创建一个 `"structure"` page 改为创建两个 page：

```typescript
for (const section of sections) {
  const sectionTitle = section.title || `Section ${section.sectionPath || "0"}`;

  // L1_dt: DocTags format page
  const doctagsContent = section.doctagsContent || section.content;
  await this.createWikiPageViaRepo(
    kbId, docId, "structure_dt", sectionTitle, doctagsContent, wikiDir,
  );

  // L1_md: Markdown format page
  const markdownContent = section.markdownContent || section.content;
  await this.createWikiPageViaRepo(
    kbId, docId, "structure_md", sectionTitle, markdownContent, wikiDir,
  );
}
```

- [ ] **Step 3:** 修改 section 切分逻辑以保留双格式内容

`splitDocTagsIntoSections()`（line 713-778）当前将 DocTags 转为 Markdown 后存入 `section.content`。需要修改 `StructureSection` 接口，增加 `doctagsContent` 和 `markdownContent` 两个字段：

在 line 713 之前的 `StructureSection` 接口定义处增加字段：
```typescript
doctagsContent?: string;  // Raw DocTags for this section
markdownContent?: string; // Markdown for this section
```

在 `splitDocTagsIntoSections()` 中，将原始 DocTags 行保存为 `doctagsContent`，转换后的 Markdown 保存为 `markdownContent`。

- [ ] **Step 4:** 更新 `compileAbstract()` 的 section 读取逻辑

`compileAbstract()`（line 364-445）通过 `getStructureSectionSummaries()` 读取 structure pages。需要更新该方法以同时搜索 `structure_md` 和 `structure` 类型的页面。

在 `getStructureSectionSummaries()` 方法中，将 `getManyByDocAndType(docId, "structure")` 改为先尝试 `structure_md`，再 fallback 到 `structure`（向后兼容旧数据）。

- [ ] **Step 5:** 验证编译通过

Run: `node /mnt/d/code/deepanalyze/deepanalyze/node_modules/typescript/bin/tsc -p /mnt/d/code/deepanalyze/deepanalyze/tsconfig.json --noEmit 2>&1 | grep "compiler.ts" | head -10`

- [ ] **Step 6:** Commit

```bash
git add src/wiki/compiler.ts
git commit -m "feat: refactor WikiCompiler for dual L1 format (structure_md + structure_dt) and disable entity extraction"
```

---

### Task 5: 更新多模态编译器为双格式输出

**Files:**
- Modify: `src/wiki/modality-compilers/image-structure.ts`
- Modify: `src/wiki/modality-compilers/audio-structure.ts`
- Modify: `src/wiki/modality-compilers/video-structure.ts`

每个 modality compiler 当前创建 `pageType: "structure"` 的页面。需要改为同时创建 `structure_md` 和 `structure_dt` 页面。

- [ ] **Step 1:** 更新 `image-structure.ts`

找到创建 wiki page 的代码（搜索 `"structure"` pageType），复制一份改为 `"structure_md"`（Markdown 内容）和 `"structure_dt"`（DocTags 内容）。

- [ ] **Step 2:** 更新 `audio-structure.ts`

同样方式，将每个音频段落的 structure page 改为双格式输出。

- [ ] **Step 3:** 更新 `video-structure.ts`

同样方式，将每个视频场景的 structure page 改为双格式输出。

- [ ] **Step 4:** Commit

```bash
git add src/wiki/modality-compilers/
git commit -m "feat: update modality compilers for dual L1 format output"
```

---

## 阶段三：检索与工具

### Task 6: 更新 Retriever 层级映射

**Files:**
- Modify: `src/wiki/retriever.ts:478-482`

当前映射：
```typescript
L0: ["abstract"],
L1: ["overview", "structure"],
L2: ["fulltext"],
```

需要改为包含新的 pageType 并保留旧类型兼容：
```typescript
L0: ["abstract"],
L1: ["structure_md", "structure_dt", "structure", "overview"],
L2: ["fulltext"],
```

- [ ] **Step 1:** 更新 `levelMap`

- [ ] **Step 2:** 验证编译通过

- [ ] **Step 3:** Commit

```bash
git add src/wiki/retriever.ts
git commit -m "feat: update Retriever level mapping for structure_md/structure_dt"
```

---

### Task 7: 更新 Expander 支持新 pageType 和 Raw 层访问

**Files:**
- Modify: `src/wiki/expander.ts`

**改动点：**

1. `pageTypeToLevel()`（line 457-473）：新增 `structure_md` → L1, `structure_dt` → L1 映射
2. `levelToPageType()`（line 478-493）：L1 默认返回 `structure_dt`（Agent 推荐 DocTags）
3. `expandToRaw()`（line 318-356）：确认现有 raw 层访问逻辑兼容
4. 新增 `format` 参数支持：L1 展开时可选择返回 `structure_md` 或 `structure_dt`

- [ ] **Step 1:** 更新 `pageTypeToLevel` 映射

在 switch 的 `case "structure":` 后面增加：
```typescript
case "structure_md":
case "structure_dt":
```

- [ ] **Step 2:** 更新 `levelToPageType` 方法

将 L1 的返回值改为 `"structure_dt"`（默认 DocTags）：
```typescript
case "L1":  return "structure_dt";
```

- [ ] **Step 3:** 新增 format 参数

在 `expandToLevel()` 方法签名中增加可选参数 `format?: "md" | "dt"`。当 `format === "md"` 时，`levelToPageType` 的 L1 返回 `"structure_md"`。

- [ ] **Step 4:** Commit

```bash
git add src/wiki/expander.ts
git commit -m "feat: update Expander for structure_md/structure_dt and format parameter"
```

---

### Task 8: 更新 Agent 工具注册

**Files:**
- Modify: `src/services/agent/tool-setup.ts`

**改动点：**

1. `graph_build` 工具注册（line 425-429）：注释掉
2. `wiki_browse` 的 `followLinks` 参数（line 163-167）：移除
3. `wiki_browse` 的链接遍历执行逻辑（line 204-231）：移除
4. `kb_search` 的 pageTypes schema：增加 `structure_md` 和 `structure_dt`
5. `expand` 工具：增加 `format` 参数

- [ ] **Step 1:** 注释掉 `graph_build` 注册（line 425-429）

```typescript
// DISABLED: Knowledge graph construction disabled per design decision
// registry.register(createGraphTool({ linker: deps.linker, retriever: deps.retriever, dataDir: deps.dataDir }));
```

- [ ] **Step 2:** 移除 `wiki_browse` 的 `followLinks` 参数和相关执行代码

- [ ] **Step 3:** 在 `kb_search` 的 `pageTypes` 枚举中添加 `"structure_md"` 和 `"structure_dt"`

- [ ] **Step 4:** 在 `expand` 工具的 input schema 中添加 `format` 参数

- [ ] **Step 5:** Commit

```bash
git add src/services/agent/tool-setup.ts
git commit -m "feat: update agent tools for dual L1 format, disable graph_build and followLinks"
```

---

## 阶段四：禁用知识复利

### Task 9: 禁用 Agent 自动 compound

**Files:**
- Modify: `src/services/agent/agent-runner.ts:430-492`

- [ ] **Step 1:** 将自动 compound 代码块条件化

在 line 433 的 guard 条件后添加 `&& false`：
```typescript
if (finalOutput && finalOutput.trim().length >= 100 && kbId && false) {
```

或者更优雅地用注释包裹整个 block 并在开头加说明。

- [ ] **Step 2:** Commit

```bash
git add src/services/agent/agent-runner.ts
git commit -m "feat: disable auto-compound in agent runner (code preserved)"
```

---

### Task 10: 禁用路由层实体提取

**Files:**
- Modify: `src/server/routes/knowledge.ts:113-178`

- [ ] **Step 1:** 在 `extractEntitiesAndLinks` 函数的开头添加早期返回

```typescript
async function extractEntitiesAndLinks(kbId: string, docId: string, filename: string): Promise<void> {
  // DISABLED: Entity extraction disabled per design decision
  return;
  // ... 原有代码保留 ...
```

- [ ] **Step 2:** Commit

```bash
git add src/server/routes/knowledge.ts
git commit -m "feat: disable entity extraction in knowledge routes (code preserved)"
```

---

## 阶段五：前端更新

### Task 11: 更新 LevelSwitcher 支持 structure_md/structure_dt

**Files:**
- Modify: `frontend/src/components/search/LevelSwitcher.tsx:52-56`

当前 `LEVEL_TO_PAGE_TYPE` 将 L1 映射到 `"overview"`（line 52-56）。需要改为优先使用 `"structure_md"`。

- [ ] **Step 1:** 更新映射

```typescript
const LEVEL_TO_PAGE_TYPE: Record<"L0" | "L1" | "L2", string> = {
  L0: "abstract",
  L1: "structure_md",   // Changed from "overview" to "structure_md"
  L2: "fulltext",
};
```

- [ ] **Step 2:** 更新标签文案

将 L1 的 label 从 `"L1 概述"` 改为 `"L1 结构"`。

- [ ] **Step 3:** Commit

```bash
git add frontend/src/components/search/LevelSwitcher.tsx
git commit -m "feat: update LevelSwitcher for structure_md page type"
```

---

### Task 12: DocumentCard 增加 L1 格式切换和处理器选择

**Files:**
- Modify: `frontend/src/components/knowledge/DocumentCard.tsx`

- [ ] **Step 1:** 在 L1 按钮区域添加 md/dt 格式切换按钮

当 L1 展开时，显示一个小型切换按钮组（`MD` | `DT`），默认选中 `MD`。切换时调用 `api.expandWiki(kbId, docId, "L1")` 并指定 format。

- [ ] **Step 2:** 添加处理器选择下拉

在文档卡片的操作区域添加下拉选择器（`auto` / `docling` / `native`），仅在 `isReady` 状态下显示。选项根据文件类型过滤（视频不显示 docling）。

- [ ] **Step 3:** Commit

```bash
git add frontend/src/components/knowledge/DocumentCard.tsx
git commit -m "feat: add L1 format toggle and processor selector to DocumentCard"
```

---

### Task 13: KnowledgePanel 隐藏实体和图谱入口

**Files:**
- Modify: `frontend/src/components/knowledge/KnowledgePanel.tsx:660-667`

- [ ] **Step 1:** 注释掉 EntityPage 渲染

将 line 660-667 的 `navigatingEntity` 条件分支注释掉，改为显示正常文档列表。

- [ ] **Step 2:** Commit

```bash
git add frontend/src/components/knowledge/KnowledgePanel.tsx
git commit -m "feat: hide entity navigation in KnowledgePanel"
```

---

## 阶段六：验证

### Task 14: 端到端验证

- [ ] **Step 1:** TypeScript 全量编译检查

Run: `node /mnt/d/code/deepanalyze/deepanalyze/node_modules/typescript/bin/tsc -p /mnt/d/code/deepanalyze/deepanalyze/tsconfig.json --noEmit 2>&1 | grep -v "node_modules" | head -30`

确认无新增错误。

- [ ] **Step 2:** 验证 Docling 路由覆盖

手动测试或写单元测试验证：
- `.pdf` 文件路由到 DoclingProcessor
- `.xlsx` 文件路由到 DoclingProcessor（新）
- `.html` 文件路由到 DoclingProcessor（新）
- `.mp4` 文件路由到 VideoProcessor
- `.json` 文件路由到 TextProcessor

- [ ] **Step 3:** 验证编译管线

上传一个 PDF 文档，检查生成的 wiki pages：
- `abstract` page（L0）
- `structure_md` pages（L1 Markdown）
- `structure_dt` pages（L1 DocTags）
- 磁盘上的 `docling.json`（Raw）

- [ ] **Step 4:** 验证检索

通过 API 调用 `GET /:kbId/search?query=test&level=L1`，确认能搜索到 `structure_md` 和 `structure_dt` 页面。

- [ ] **Step 5:** 验证 Agent 工具

通过 `/run-stream` 调用 Agent，使用 `kb_search(pageTypes=["structure_dt"])` 和 `expand(format="md")` 工具，确认正常工作。
