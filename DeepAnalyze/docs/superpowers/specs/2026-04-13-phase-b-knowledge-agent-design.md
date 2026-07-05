# Phase B: 知识体系与 Agent 互动 — 设计文档

**项目**: DeepAnalyze 知识库系统
**版本**: V1.0
**日期**: 2026-04-13
**状态**: 待讨论
**范围**: 问题 4(文件格式) + 6(知识分层) + 7(知识关联) + 8(Agent互动) + 9(Skills编排)
**前置依赖**: Phase A (ProcessingQueue + WebSocket)

---

## 目录

1. [文件格式差异化处理策略](#1-文件格式差异化处理策略)
2. [知识分层编译改进](#2-知识分层编译改进)
3. [知识关联体系](#3-知识关联体系)
4. [Agent 与知识库深度互动](#4-agent-与知识库深度互动)
5. [Skills 编排能力](#5-skills-编排能力)
6. [代码改动总清单](#6-代码改动总清单)
7. [实施顺序](#7-实施顺序)

---

## 1. 文件格式差异化处理策略

### 1.1 当前问题

`knowledge.ts:378-430` 把文件分为 textTypes 和 doclingTypes 两类，所有非文本文件用同一套 Docling 参数处理。没有:
- Excel 的摘要/表结构描述
- 图片的视觉理解
- 音频的 ASR 转写
- 视频的关键帧分析

### 1.2 DocumentProcessor 接口

```typescript
// src/services/document-processors/types.ts

export interface ParsedContent {
  /** 提取的文本/结构化内容 */
  text: string;
  /** 内容元数据 (页数、行列数、时长等) */
  metadata: Record<string, unknown>;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

export interface DocumentProcessor {
  /** 判断是否能处理该文件类型 */
  canHandle(fileType: string): boolean;
  /** 解析文档 */
  parse(filePath: string, options?: Record<string, unknown>): Promise<ParsedContent>;
  /** 该处理器需要的处理步骤描述 */
  getStepLabel(): string;
}
```

### 1.3 各文件类型处理策略

| 文件类型 | 处理器 | 解析策略 | 生成 wiki pages | 依赖模型 |
|---------|--------|---------|----------------|---------|
| pdf, docx, doc, pptx, ppt | DoclingProcessor | Docling 全文提取+表格+OCR | L2全文→L1概览→L0摘要 | Docling (子进程) |
| xlsx, xls | ExcelProcessor | Docling提取 + LLM生成结构摘要 | L1表结构描述→L0摘要 | Docling + sub-model |
| txt, md, csv, json, html, xml | TextProcessor | 直接读取 | L2全文→L1概览→L0摘要 | 无 |
| png, jpg, jpeg, gif, bmp, tiff | ImageProcessor | VLM生成图片描述 + OCR文字叠加 | L1图片分析→L0摘要 | VLM (enhanced-model) |
| mp3, wav, flac, aac, ogg | AudioProcessor | ASR转写 + 说话人分离 | L2全文转写→L1分段→L0摘要 | ASR model |
| mp4, avi, mov, mkv, webm | VideoProcessor | 关键帧抽取 + VLM帧描述 + 时间轴 | L2帧详情→L1时间轴→L0摘要 | VLM + ffmpeg |

### 1.4 Processor 实现

**ProcessorFactory (`src/services/document-processors/processor-factory.ts`)**

根据 fileType 返回对应的 processor 实例。未知类型 fallback 到 DoclingProcessor。

**ExcelProcessor (`src/services/document-processors/excel-processor.ts`)**

```typescript
class ExcelProcessor implements DocumentProcessor {
  canHandle(ft: string) { return ["xlsx", "xls"].includes(ft); }
  getStepLabel() { return "excel_analysis"; }

  async parse(filePath: string): Promise<ParsedContent> {
    // 1. Docling 提取表格内容
    const doclingResult = await parseWithDocling(mgr, filePath);

    // 2. 用 LLM (sub-model) 生成结构摘要
    const summary = await this.router.chat([{
      role: "user",
      content: `分析以下Excel表格数据，生成结构化摘要：
1. 表格概述（用途、数据范围）
2. 列定义（列名、数据类型、示例值）
3. 数据统计（行数、关键统计值）
4. 数据特征（排序方式、缺失值、异常值）

原始数据（前20行）：
${doclingResult.content.slice(0, 4000)}`
    }], { model: this.router.getDefaultModel("summarizer") });

    return {
      text: summary.content,
      metadata: { sourceType: "excel", rawContent: doclingResult.content },
      success: true,
    };
  }
}
```

**ImageProcessor (`src/services/document-processors/image-processor.ts`)**

```typescript
class ImageProcessor implements DocumentProcessor {
  canHandle(ft: string) { return ["image"].includes(ft); }
  getStepLabel() { return "image_understanding"; }

  async parse(filePath: string): Promise<ParsedContent> {
    // 1. 图片编码为 base64
    const imageBuffer = readFileSync(filePath);
    const base64 = imageBuffer.toString("base64");
    const mimeType = `image/${extname(filePath).slice(1)}`;

    // 2. 调用 VLM (enhanced model, type=multimodal) 生成描述
    const vlmProvider = this.enhancedModels.getProvider("multimodal");
    const description = await vlmProvider.chat([{
      role: "user",
      content: [
        { type: "text", text: "详细描述这张图片的内容，包括：场景、人物、文字、数据、关键元素。" },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
      ],
    }]);

    // 3. 同时 Docling OCR 提取文字
    const ocrResult = await parseWithDocling(mgr, filePath, { ocr: true });

    return {
      text: `## 图像内容描述\n${description}\n\n## OCR提取文字\n${ocrResult.content}`,
      metadata: { sourceType: "image", hasOcrText: ocrResult.content.length > 0 },
      success: true,
    };
  }
}
```

**AudioProcessor (`src/services/document-processors/audio-processor.ts`)**

```typescript
class AudioProcessor implements DocumentProcessor {
  canHandle(ft: string) { return ["mp3", "wav", "flac", "aac", "ogg"].includes(ft); }
  getStepLabel() { return "transcription"; }

  async parse(filePath: string): Promise<ParsedContent> {
    // 1. 调用 ASR 模型 (enhanced model, type=audio_gen 的反向/独立类型, 或 Whisper API)
    //    优先使用 OpenAI Whisper API 端点
    //    或使用本地 Whisper 模型 (如果配置了)
    const transcription = await this.asrService.transcribe(filePath, {
      language: "zh",
      speakerDiarization: true,  // 说话人分离
    });

    // 2. 格式化转写结果
    const formatted = transcription.segments.map(seg =>
      `[${seg.speaker}] ${seg.startTime} - ${seg.endTime}\n${seg.text}`
    ).join("\n\n");

    return {
      text: formatted,
      metadata: {
        sourceType: "audio",
        duration: transcription.duration,
        speakers: transcription.speakers,
        language: transcription.language,
      },
      success: true,
    };
  }
}
```

**VideoProcessor (`src/services/document-processors/video-processor.ts`)**

```typescript
class VideoProcessor implements DocumentProcessor {
  canHandle(ft: string) { return ["mp4", "avi", "mov", "mkv", "webm"].includes(ft); }
  getStepLabel() { return "video_analysis"; }

  async parse(filePath: string): Promise<ParsedContent> {
    // 1. ffmpeg 抽取关键帧 (每10秒一帧, 或场景变化检测)
    const frames = await this.extractKeyframes(filePath, {
      interval: 10,        // 每10秒
      maxFrames: 30,       // 最多30帧
      sceneDetect: true,   // 场景变化时额外抽帧
    });

    // 2. VLM 逐帧描述
    const vlmProvider = this.enhancedModels.getProvider("multimodal");
    const frameDescriptions: string[] = [];
    for (const frame of frames) {
      const desc = await vlmProvider.describeImage(frame.base64, frame.mimeType,
        "描述这一帧的画面内容，包括场景、人物、动作、文字信息。");
      frameDescriptions.push(`### ${frame.timestamp}\n${desc}`);
    }

    // 3. LLM 生成时间轴摘要
    const timeline = await this.router.chat([{
      role: "user",
      content: `根据以下视频关键帧描述，生成时间轴摘要：\n\n${frameDescriptions.join("\n\n")}`,
    }], { model: this.router.getDefaultModel("summarizer") });

    return {
      text: timeline.content,
      metadata: {
        sourceType: "video",
        frameCount: frames.length,
        frameDetails: frameDescriptions,
      },
      success: true,
    };
  }
}
```

### 1.5 与模型配置的联动

各处理器通过 ModelRouter 和 EnhancedModels 获取所需模型:

| 处理器 | 使用的模型角色 | 获取方式 |
|--------|-------------|---------|
| ExcelProcessor | sub-model (summarizer) | `router.getDefaultModel("summarizer")` |
| ImageProcessor | VLM (enhanced, multimodal) | `enhancedModels.getProvider("multimodal")` |
| AudioProcessor | ASR | 新增 enhanced model type `audio_transcribe`, 或使用 OpenAI Whisper API |
| VideoProcessor | VLM + sub-model | 同上组合 |
| TextProcessor | sub-model (L1/L0 编译) | `router.getDefaultModel("summarizer")` |

ASR 模型需要新增一个 enhanced model type `audio_transcribe`:
- 在 `EnhancedModelsConfig.tsx` 的类型列表中增加 `"audio_transcribe"`
- 在 `types/index.ts` 的 `EnhancedModelType` 联合类型中增加

### 1.6 ProcessingQueue 集成

Phase A 的 ProcessingQueue 改用 ProcessorFactory:

```typescript
// Phase A 的 ProcessingQueue 中 executeStep("parsing") 改为:
const processor = processorFactory.getProcessor(job.fileType);
const parsed = await processor.parse(job.filePath);
// 后续 compiling 步骤调用 WikiCompiler.compile() 使用 parsed.text
```

---

## 2. 知识分层编译改进

### 2.1 当前问题

`knowledge.ts:459-485` 的 L0/L1/L2 创建是手动截取:
- L0: `content.split("\n\n")[0].slice(0, 200)` — 前200字符
- L1: `content.slice(0, 2000)` — 前2000字符
- L2: 完整内容

但 `wiki/compiler.ts` 已有完整的 LLM 驱动编译流程:
- L2: 保存完整内容 ✓
- L1: LLM 生成结构化概览 (2000字, 含章节导航+实体+要点) ✓
- L0: LLM 压缩为一句话摘要+标签 ✓
- 实体提取+链接 ✓

### 2.2 改动方案

**核心改动**: ProcessingQueue 的 `compiling` 步骤调用 `WikiCompiler.compile()` 替代手动截取。

```typescript
// ProcessingQueue 中 compiling 步骤:
async executeCompiling(job: ProcessingJob, parsedContent: ParsedContent): Promise<void> {
  const router = new ModelRouter();
  await router.initialize();
  const compiler = new WikiCompiler(router, DEEPANALYZE_CONFIG.dataDir);

  await compiler.compile(
    job.kbId,
    job.docId,
    parsedContent.text,
    parsedContent.metadata,
  );
}
```

**注意**: WikiCompiler.compile() 内部已包含 updateDocumentStatus("compiling") 和 updateDocumentStatus("ready")。ProcessingQueue 需要调整: 不在 compile 后再次更新状态。

### 2.3 WikiCompiler prompt 优化

当前 `compiler.ts:134-140` 的 L1 prompt 不够丰富。建议改进:

```
L1 prompt (改进后):
请为以下文档内容生成一份结构化概览，包含：
1. 文档类型判断（报告、会议纪要、合同、数据分析、学术论文等）
2. 文档结构导航（各章节标题和核心摘要）
3. 关键实体列表（人物、机构、地点、时间、金额、产品等）
4. 核心要点总结（3-5个关键发现或结论）
5. 数据亮点（如果有数字数据，列出关键数值及其含义）

请用 Markdown 格式输出，使用清晰的标题层级。

文档内容：
{content}
```

```
L0 prompt (改进后):
请将以下文档概览压缩为：
第一行：一句话摘要（不超过80字）
第二行：标签：标签1,标签2,...（5-10个关键标签）
第三行：类型：[文档类型]
第四行：日期：[文档中提到的关键日期，如无则留空]

文档概览：
{content}
```

---

## 3. 知识关联体系

### 3.1 当前现状

`linker.ts` 已有关联能力:
- `createBidirectionalLinks()`: 创建双向链接
- `buildForwardLinks()`: 基于实体共现自动构建跨文档链接
- `getLinkedPages()`: BFS 遍历关联页面
- `findRelatedByEntity()`: 按实体名查找关联页面

`WikiCompiler.extractAndUpdateLinks()` 已在 L1 概览上提取实体并创建 entity_ref 链接。

但存在两个问题:
1. `buildForwardLinks()` 只在 `compiler.ts` 中定义，但**从未被调用** — 没有触发跨文档关联的时机
2. 关联只在 L1(overview) 层构建，不在 L0(abstract) 层

### 3.2 改动方案

**只建 L0 关联** — 在用户确认的决策基础上:

1. ProcessingQueue 增加一个 `linking` 步骤
2. 当一个 KB 中所有待处理文档都完成后，触发 `buildL0Associations(kbId)`
3. 在 L0 (abstract) 页面之间构建关联，而非 L1

```typescript
// 新建 src/wiki/l0-linker.ts

class L0Linker {
  /**
   * 为 KB 内所有文档的 L0 abstract 页面构建跨文档关联。
   * 策略: 基于实体共现 + 标签重叠。
   */
  buildL0Associations(kbId: string): void {
    // 1. 获取该 KB 所有 abstract 页面
    const abstracts = this.getAbstractPages(kbId);

    // 2. 提取每个 abstract 的实体和标签
    const pageEntities = new Map<string, Set<string>>();
    for (const page of abstracts) {
      const content = getPageContent(page.filePath);
      const entities = this.parseL0Entities(content); // 解析"标签："行
      pageEntities.set(page.id, entities);
    }

    // 3. 基于实体交集构建关联
    const linker = new Linker();
    for (const [pageA, entitiesA] of pageEntities) {
      for (const [pageB, entitiesB] of pageEntities) {
        if (pageA === pageB) continue;
        const overlap = this.intersection(entitiesA, entitiesB);
        if (overlap.size >= 2) {
          // 共享2个以上实体则建链
          linker.createBidirectionalLinks(pageA, pageB);
        }
      }
    }
  }
}
```

**触发时机**: ProcessingQueue 中，当一个 KB 的所有入队文档处理完成后，调用 `l0Linker.buildL0Associations(kbId)`。

### 3.3 知识展示 UI 改进

**WikiBrowser 改进**:

当前 WikiBrowser 是简单的页面列表。改进:

1. **关联面板**: 点击任一 Wiki 页面时，右侧显示"关联页面"列表
   - 出站链接 (→)
   - 入站链接 (←)
   - 共享实体的其他文档

2. **实体索引页**: 知识库首页增加"实体"tab，显示所有提取的实体
   - 按类型分组 (人物/机构/地点/概念/...)
   - 每个实体显示提及次数和关联文档数
   - 点击展开查看所有提及该实体的文档

3. **知识图谱视图**: 复用 ReportPanel 中已有的 Canvas 力导向图
   - 节点类型: document(蓝), entity(绿), concept(紫)
   - 边类型: entity_ref, forward, backward
   - 点击节点跳转到对应 Wiki 页面

---

## 4. Agent 与知识库深度互动

### 4.1 增强的 ScopeSelector

**当前** (`ScopeSelector.tsx`): 只支持"全部"或"单个知识库"。

**改进**: 支持:
- 多个知识库同时选择
- 指定知识库内特定文档
- 网络搜索开关
- 混合选择

**UI 设计**:

```
┌─────────────────────────────────────────────┐
│ 📋 分析范围                            [编辑] │
├─────────────────────────────────────────────┤
│ ✅ 财务分析知识库 [全选▼]                    │
│    ├─ 年报.pdf ✓                            │
│    ├─ 季报Q3.pdf ✓                          │
│    └─ 审计报告.pdf ✓                        │
│ ☐ 竞品调研知识库 [全选▼]                     │
│    └─ (点击展开选择文档)                      │
│ ☐ 网络搜索                                  │
└─────────────────────────────────────────────┘
```

**交互**:
- 默认收起: 只显示选中的 KB 名称和文档数
- 点击 [编辑] 展开完整选择器
- 每个 KB 有 [全选] 下拉: 全部文档 / 取消全选 / 反选
- KB 名称可展开显示文档列表，每行有 checkbox
- 网络搜索是独立开关

**数据模型**:

```typescript
// frontend/src/types/index.ts 扩展
interface AnalysisScope {
  /** 选中的知识库及文档范围 */
  knowledgeBases: Array<{
    kbId: string;
    mode: "all" | "selected";
    documentIds?: string[];  // mode="selected" 时指定
  }>;
  /** 是否启用网络搜索 */
  webSearch: boolean;
}
```

**后端传递**: 消息发送时将 scope 附加到请求中:

```typescript
// api.runAgentStream 的参数扩展
{
  message: string;
  scope?: AnalysisScope;
  sessionId: string;
}
```

Agent 的 `kb_search` 工具读取 scope 参数，限制搜索范围。

### 4.2 kb_search 工具改进

当前 `kb_search` 工具接受 `query` 和 `kbId` 参数。改为:

```typescript
// src/tools/KbSearchTool 改进
{
  name: "kb_search",
  parameters: {
    query: { type: "string", description: "搜索查询" },
    scope: {
      type: "object",
      properties: {
        kbIds: { type: "array", items: { type: "string" } },
        docIds: { type: "array", items: { type: "string" } },
      },
      description: "搜索范围，由用户选择的分析范围决定"
    },
    topK: { type: "number", default: 10 },
    searchMode: { type: "string", enum: ["fusion", "vector", "bm25"], default: "fusion" },
  }
}
```

后端实现:
- 从 scope.kbIds 构建 Retriever 的 kbIds 参数
- 如果 scope.docIds 非空，搜索结果过滤只保留匹配的文档
- 调用 `retriever.search(query, { kbIds, topK })` 使用融合检索

### 4.3 kb_browse 工具

新增工具，让 Agent 可以浏览特定文档的 Wiki 页面:

```typescript
{
  name: "kb_browse",
  parameters: {
    docId: { type: "string", description: "文档ID" },
    level: { type: "string", enum: ["abstract", "overview", "fulltext"] },
    pageId: { type: "string", description: "直接浏览指定Wiki页面" },
  }
}
```

### 4.4 kb_expand 工具

已存在 expand 端点，需要注册为 Agent 工具:

```typescript
{
  name: "kb_expand",
  parameters: {
    pageId: { type: "string", description: "要展开的Wiki页面ID" },
    section: { type: "string", description: "要展开的章节" },
  }
}
```

---

## 5. Skills 编排能力

### 5.1 当前现状

Skills 是 prompt 模板 + 变量替换。Agent 工具系统中已有 `kb_search`、`report_generate` 等。

### 5.2 改进方向

不需要改变 Skills 的底层机制。只需要:
1. 确保 Agent 工具注册完整 (kb_search, kb_browse, kb_expand)
2. 通过 Skills 的 systemPrompt 引导 Agent 使用这些工具
3. 后续可通过 Skills 定义复杂的多步骤工作流

**示例 RAG 分析 Skill**:

```markdown
---
title: 深度文档分析
description: 对指定文档进行多角度深度分析
tools: kb_search, kb_browse, kb_expand, report_generate
---

你是一个深度文档分析专家。请按以下步骤工作：

1. **理解问题**: 分析用户的问题，确定需要查找的信息类型
2. **初步检索**: 使用 kb_search 搜索相关文档
3. **深入浏览**: 使用 kb_browse 查看文档概览，定位关键章节
4. **展开阅读**: 使用 kb_expand 展开关键段落获取完整内容
5. **关联分析**: 检查搜索结果中的关联页面，交叉验证信息
6. **生成报告**: 使用 report_generate 生成结构化分析报告

注意：始终基于文档原文进行分析，不要编造信息。
```

### 5.3 Agent 工具注册清单

Phase B 需要确保以下工具已注册到 Agent:

| 工具 | 来源 | 状态 |
|------|------|------|
| kb_search | 新建 `src/tools/KbSearchTool.ts` | 需新建 |
| kb_browse | 新建 `src/tools/KbBrowseTool.ts` | 需新建 |
| kb_expand | 新建 `src/tools/KbExpandTool.ts` | 需新建 |
| web_search | 已有 `src/tools/WebSearchTool.ts` | 检查确认 |
| report_generate | 已有 | 检查确认 |

---

## 6. 代码改动总清单

### 新建文件

| 文件 | 用途 |
|------|------|
| `src/services/document-processors/types.ts` | DocumentProcessor 接口定义 |
| `src/services/document-processors/processor-factory.ts` | 处理器工厂 |
| `src/services/document-processors/excel-processor.ts` | Excel 处理器 |
| `src/services/document-processors/image-processor.ts` | 图片处理器 |
| `src/services/document-processors/audio-processor.ts` | 音频处理器 |
| `src/services/document-processors/video-processor.ts` | 视频处理器 |
| `src/services/document-processors/docling-processor.ts` | Docling 通用处理器 |
| `src/services/document-processors/text-processor.ts` | 文本处理器 |
| `src/wiki/l0-linker.ts` | L0 层关联构建 |
| `src/tools/KbSearchTool.ts` | KB 搜索工具 |
| `src/tools/KbBrowseTool.ts` | KB 浏览工具 |
| `src/tools/KbExpandTool.ts` | KB 展开工具 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/services/processing-queue.ts` (Phase A) | parsing 步骤用 ProcessorFactory; compiling 步骤用 WikiCompiler; 新增 linking 步骤 |
| `src/wiki/compiler.ts` | 改进 L0/L1 prompt |
| `src/wiki/linker.ts` | 无大改动，L0Linker 独立 |
| `frontend/src/components/chat/ScopeSelector.tsx` | 重写: 多KB多文档选择 + 网络搜索开关 |
| `frontend/src/components/knowledge/WikiBrowser.tsx` | 增加关联面板、实体索引、知识图谱 |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | 增加实体 tab |
| `frontend/src/types/index.ts` | 增加 AnalysisScope 类型; EnhancedModelType 增加 audio_transcribe |
| `frontend/src/components/settings/EnhancedModelsConfig.tsx` | 类型列表增加 audio_transcribe |
| `frontend/src/api/client.ts` | runAgentStream 参数增加 scope |
| `src/server/routes/knowledge.ts` | 搜索端点支持 docIds 过滤 |

---

## 7. 实施顺序

```
Step 1: 文件格式处理器 (不依赖其他步骤)
  ├─ types.ts + processor-factory.ts
  ├─ text-processor.ts (最简单，先实现验证)
  ├─ docling-processor.ts (从 knowledge.ts 提取现有逻辑)
  ├─ excel-processor.ts
  ├─ image-processor.ts
  ├─ audio-processor.ts
  └─ video-processor.ts

Step 2: 知识编译改进
  ├─ WikiCompiler prompt 优化
  └─ ProcessingQueue 集成 WikiCompiler + ProcessorFactory

Step 3: 知识关联
  ├─ l0-linker.ts
  ├─ ProcessingQueue linking 步骤
  └─ 触发时机 (KB 批处理完成后)

Step 4: Agent 工具
  ├─ KbSearchTool (含 scope 过滤)
  ├─ KbBrowseTool
  ├─ KbExpandTool
  └─ 工具注册到 Agent

Step 5: 前端互动
  ├─ ScopeSelector 重写
  ├─ WikiBrowser 关联面板
  ├─ KnowledgePanel 实体 tab
  └─ 知识图谱视图

Step 6: Skills 示例
  └─ 创建 "深度文档分析" Skill 模板
```
