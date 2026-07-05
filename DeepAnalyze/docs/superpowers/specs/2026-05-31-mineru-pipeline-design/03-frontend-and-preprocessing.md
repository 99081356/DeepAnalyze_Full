# MinerU 管线集成设计 — 前端与深度预处理增强

## 一、前端改动

### 1.1 设置页面重构

当前 Docling 配置在 `ModelsPanel` 的 "文档处理" 标签页中。需要扩展为管线管理面板。

#### 新增组件：`MinerUConfig.tsx`

独立的 MinerU 配置面板，结构与 `DoclingConfig.tsx` 类似：

```
┌─────────────────────────────────────────────┐
│ 🔌 MinerU 解析服务                          │
├─────────────────────────────────────────────┤
│                                             │
│  API 服务地址                                │
│  ┌───────────────────────────────────────┐  │
│  │ http://127.0.0.1:8001                │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  [● 已连接] [检测连通性]                      │
│                                             │
│  默认后端                                    │
│  ┌───────────────────────────────────────┐  │
│  │ Hybrid (推荐)  ▼                      │  │
│  │   - Hybrid (VLM+OCR，推荐)            │  │
│  │   - Pipeline (纯 OCR，轻量)            │  │
│  │   - VLM (纯视觉模型)                   │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  语言          公式识别 [✓]    表格识别 [✓]    │
│  ┌─────┐                                    │
│  │ ch ▼│      图片分析 [✓]                   │
│  └─────┘                                    │
│                                             │
│  请求超时: ────●───── 300s                    │
│                                             │
│  ☐ 启用 MinerU 管线                          │
│                                             │
│  [保存配置]  [刷新]                           │
└─────────────────────────────────────────────┘
```

#### 新增组件：`PipelineConfig.tsx`

管线优先级策略配置面板：

```
┌─────────────────────────────────────────────┐
│ 🔀 管线策略                                  │
├─────────────────────────────────────────────┤
│                                             │
│  Auto 模式下按文件类型选择管线，失败时自动降级  │
│                                             │
│  ┌─ PDF 文件 ──────────────────────────────┐ │
│  │  1. MinerU Hybrid  [⇕] [✕]             │ │
│  │  2. Docling Standard [⇕] [✕]           │ │
│  │  [+ 添加管线]                           │ │
│  └─────────────────────────────────────────┘ │
│                                             │
│  ┌─ Office 文档 (DOCX/PPTX) ──────────────┐ │
│  │  1. MinerU Pipeline [⇕] [✕]            │ │
│  │  2. Docling Standard [⇕] [✕]           │ │
│  └─────────────────────────────────────────┘ │
│                                             │
│  ┌─ 图片文件 ──────────────────────────────┐ │
│  │  1. MinerU Hybrid  [⇕] [✕]             │ │
│  │  2. Docling VLM [⇕] [✕]               │ │
│  └─────────────────────────────────────────┘ │
│                                             │
│  ┌─ 音频/视频 ─────────────────────────────┐ │
│  │  1. Docling (Whisper) [⇕]              │ │
│  └─────────────────────────────────────────┘ │
│                                             │
│  ┌─ 表格文件 (XLSX/CSV) ──────────────────┐ │
│  │  1. Native (python-pptx/openpyxl)      │ │
│  └─────────────────────────────────────────┘ │
│                                             │
│  ┌─ 文本格式 (MD/HTML/LaTeX) ─────────────┐ │
│  │  1. Docling [⇕]                        │ │
│  └─────────────────────────────────────────┘ │
│                                             │
│  [恢复默认]  [保存策略]                       │
└─────────────────────────────────────────────┘
```

**交互说明**：
- 每个文件类型区域可拖拽排序（改变优先级）
- 可删除管线条目（至少保留一条）
- "恢复默认" 恢复到 `pipeline-strategies.ts` 中的默认策略
- 策略保存到后端 `pipeline_strategies` 设置

#### ModelsPanel 改动

当前 "文档处理" 标签页只包含 `DoclingConfig`。改为三个子面板：

```
文档处理
├── Docling 配置    → DoclingConfig（不变）
├── MinerU 配置     → MinerUConfig（新增）
└── 管线策略        → PipelineConfig（新增）
```

### 1.2 DocumentCard 处理器选择器扩展

当前处理器下拉框选项：`Auto / Docling / Native / ASR`

扩展为：

```
Auto                (管线编排器自动选择)
Docling Standard    (Docling 标准管线)
Docling VLM         (Docling VLM 管线)
MinerU Hybrid       (MinerU Hybrid 后端)
MinerU Pipeline     (MinerU Pipeline 后端)
Native              (原生解析)
ASR                 (语音转文字)
```

选项根据文件类型动态显示：
- PDF：全部选项（除 ASR）
- 图片：Auto / Docling Standard / Docling VLM / MinerU Hybrid / MinerU Pipeline
- Office：Auto / Docling / MinerU Pipeline / Native
- 音频：Auto / Docling / ASR
- 视频：Auto / Docling
- 表格：Auto / Native

### 1.3 文档卡片信息增强

在 DocumentCard 的 L1 预览区域下方，显示解析管线信息：

```
📄 document.pdf
   ✓ MinerU Hybrid · 2.3MB · 15页   ← 显示使用的管线
```

管线信息来源：`document.metadata` 中的 `sourceType` 和 `pipelineBackend` 字段。

### 1.4 前端类型扩展

**文件**: `frontend/src/types/index.ts`

```typescript
// 新增 MinerU 配置类型
export interface MinerUConfig {
  apiUrl: string;
  defaultBackend: "hybrid-auto-engine" | "pipeline" | "vlm-auto-engine";
  defaultLang: string;
  formulaEnable: boolean;
  tableEnable: boolean;
  imageAnalysis: boolean;
  timeout: number;
  enabled: boolean;
}

// 新增管线策略类型
export interface PipelineStrategy {
  fileType: string;
  pipelines: PipelineEntry[];
}

export interface PipelineEntry {
  pipeline: "docling" | "mineru" | "native" | "asr";
  mineruBackend?: string;
  priority: number;
}

// 扩展 DocumentInfo
export interface DocumentInfo {
  // ... 现有字段 ...
  /** 解析管线来源（"docling" | "mineru" | "native" | "asr"） */
  pipelineSource?: string;
}
```

---

## 二、深度预处理增强

### 2.1 当前预处理能力

当前的深度预处理（`builtin-skills.ts` 中的 "知识库预处理" 技能）包含 4 个能力：

1. 知识库全局概览
2. 多页表格智能还原
3. 图片内容质量校验与补全
4. 手写批注与噪声图片二次校正

### 2.2 需要增强的部分

分析报告中指出：**有些数据可能是图片，但实际上是表格的印刷体，或者其他各种格式的印刷体，需要还原数据本身**。

当前预处理对表格恢复的流程：
1. 检测含表格关键词的文档
2. 使用 L2 Docling JSON 结构数据
3. 用 python3 + pandas 对齐重建

**增强方向**：

#### 增强 1：利用 MinerU 表格 OCR 提升恢复质量

在预处理技能提示词中增加 MinerU 表格 OCR 能力的使用指导：

```
当检测到图片中包含印刷体表格（扫描件表格、拍照表格）时：
1. 先用 MinerU Pipeline 后端对图片进行表格 OCR
2. MinerU 的表格识别精度 95+，特别是对有线/无线表格
3. 将 MinerU 输出的表格数据与 Docling 输出交叉验证
4. 以 MinerU 结果为主，Docling 结果补充
```

#### 增强 2：印刷体图片的内容还原

新增预处理能力（能力 5）：**印刷体图片数据还原**

```
检测范围：
- 图片文件（PNG/JPG/TIFF）中包含印刷体文字/表格/图表
- PDF 中的扫描页面（无文字层）
- Office 文档中嵌入的图片

处理流程：
1. 用 glob + VLM 描述检测可能是印刷体的图片
   - VLM 描述中包含"表格"、"列"、"行"、"数据"等关键词
   - OCR 文本中含有大量数字和分隔符
2. 对检测到的图片调用 MinerU 进行专门处理
   - 表格图片：MinerU Hybrid 后端（VLM 布局 + OCR 文字）
   - 普通印刷体：MinerU Pipeline 后端（纯 OCR）
3. 将提取的结构化数据保存为 CSV/XLSX
4. 记录血缘关系到 manifest.json

输出路径：
  wiki/{kbId}/_preprocessing/extracted/
    ├── 表格_001.csv          (还原的表格数据)
    ├── 文字_001.txt          (还原的文字内容)
    └── manifest.json         (血缘追踪)
```

#### 增强 3：跨文档表格聚合

对分布在不同文档/不同图片中的同类型表格进行聚合：

```
场景：多张图片分别是同一张大表格的不同部分（多页扫描）
1. 预处理扫描所有提取的表格
2. 通过列头匹配检测可能属于同一表格的片段
3. 使用 python3 + pandas 进行行合并和去重
4. 输出完整还原的表格到 wiki/{kbId}/_preprocessing/tables/merged/
```

### 2.3 对 builtin-skills.ts 的修改

**文件**: `src/services/agent/builtin-skills.ts`

在 `getKBPreprocessingPrompt()` 中扩展能力列表，新增 "能力 5：印刷体图片数据还原"。

关键修改点：
1. 能力 2（表格恢复）增加 MinerU 工具的使用说明
2. 新增能力 5（印刷体还原）
3. 工具列表保持不变（MinerU 调用通过 bash + curl 实现，不需要新增工具）

> 注意：预处理是 Agent 驱动的，Agent 通过 bash 工具调用 MinerU API（curl 命令），不需要在 tool-setup.ts 中增加专门的 MinerU 工具。

### 2.4 对 scanPreprocessingDir 的增强

**文件**: `src/services/agent/tool-setup.ts`

扩展 `scanPreprocessingDir()` 函数，使其扫描新增的 `extracted/` 目录：

```typescript
// 新增扫描
const extractedDir = join(preprocessingDir, "extracted");
if (existsSync(extractedDir)) {
  // 扫描还原的数据文件
  // 记录到 preprocessingData 中
}
```

---

## 三、前端预览增强

### 3.1 管线结果对比查看

在 DocumentCard 展开时，如果文档曾经用不同管线解析过，显示管线对比标签：

```
┌─────────────────────────────────────────┐
│ 📄 document.pdf                         │
│    ✓ MinerU Hybrid · 15页               │
│                                         │
│  [L0] [L1] [L2]                         │
│                                         │
│  ┌── L1 Structure ─────────────────┐    │
│  │ ... content ...                 │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

**当前阶段不做历史版本对比**（过于复杂），仅显示当前使用的管线。如果用户想看不同管线的结果，可以手动选择管线重建。

### 3.2 LayerPreview 适配

**文件**: `frontend/src/components/preview/LayerPreview.tsx`

Raw 标签页需要根据 `sourceType` 适配：

- `sourceType === "docling"` → 显示 Docling JSON 树（现有逻辑不变）
- `sourceType === "mineru"` → 显示 MinerU middle_json 树（格式不同但用同一个 JSON 树渲染器）

无需修改代码——JSON 树渲染器是通用的，只是数据格式不同。

### 3.3 预处理产物展示

在 KnowledgePanel 的预处理区域，新增展示还原的印刷体数据：

- 显示已提取的表格/文字数量
- 可点击查看提取结果
- 下载为 CSV/XLSX

---

## 四、API 客户端扩展

### 4.1 前端 API 函数

**文件**: `frontend/src/api/client.ts`

新增：

```typescript
// MinerU 配置
getMinerUConfig: () => request<MinerUConfig>('/api/settings/mineru-config'),
saveMinerUConfig: (config: MinerUConfig) => request('/api/settings/mineru-config', { method: 'PUT', body: JSON.stringify(config) }),
checkMinerUStatus: () => request<{ connected: boolean; version?: string }>('/api/settings/mineru-status'),

// 管线策略
getPipelineStrategies: () => request<PipelineStrategy[]>('/api/settings/pipeline-strategies'),
savePipelineStrategies: (strategies: PipelineStrategy[]) => request('/api/settings/pipeline-strategies', { method: 'PUT', body: JSON.stringify(strategies) }),
```

### 4.2 reprocessDocument 扩展

现有的 `api.reprocessDocument(kbId, docId, processor)` 已经支持传入 processor 参数。只需要扩展 processor 的可选值：

```
现有: "auto" | "docling" | "native" | "asr"
扩展: + "mineru" | "mineru-hybrid" | "mineru-pipeline" | "docling-vlm"
```

后端 `knowledge.ts` 的 reprocess 端点已经会读取 body 中的 `processor` 并传入 `ProcessingJob`，不需要修改路由代码。只需要在 `ProcessorFactory.parseWithChannel` 中增加新通道的映射。
