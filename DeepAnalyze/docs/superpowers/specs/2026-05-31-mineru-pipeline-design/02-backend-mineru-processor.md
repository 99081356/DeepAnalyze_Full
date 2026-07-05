# MinerU 管线集成设计 — 后端实现

## 一、MinerU API 客户端

### 1.1 部署架构

MinerU 以独立 API 服务运行，DA 后端作为 HTTP 客户端调用：

```bash
# 启动 MinerU API 服务（独立进程或 Docker 容器）
mineru-api --host 127.0.0.1 --port 8001
```

配置项存储在 `settings` 表中，key 为 `mineru_config`：

```typescript
interface MinerUConfig {
  /** MinerU API 服务地址 */
  apiUrl: string;           // 默认 "http://127.0.0.1:8001"
  /** 默认后端类型 */
  defaultBackend: "hybrid-auto-engine" | "pipeline" | "vlm-auto-engine";
  /** 默认语言 */
  defaultLang: string;      // 默认 "ch"
  /** 是否启用公式识别 */
  formulaEnable: boolean;   // 默认 true
  /** 是否启用表格识别 */
  tableEnable: boolean;     // 默认 true
  /** 是否启用图片分析 */
  imageAnalysis: boolean;   // 默认 true
  /** 请求超时（秒） */
  timeout: number;          // 默认 300
  /** 是否启用（总开关） */
  enabled: boolean;         // 默认 false
}
```

### 1.2 MinerU 客户端实现

**文件**: `src/services/document-processors/mineru-client.ts`

```typescript
export interface MinerUParseOptions {
  backend?: string;         // "hybrid-auto-engine" | "pipeline" | "vlm-auto-engine"
  parseMethod?: string;     // "auto" | "txt" | "ocr"
  lang?: string;            // "ch" | "en" | "japan" | "korean" 等
  formulaEnable?: boolean;
  tableEnable?: boolean;
  imageAnalysis?: boolean;
  startPageId?: number;
  endPageId?: number;
}

export interface MinerUParseResult {
  /** Markdown 内容 */
  mdContent: string;
  /** 结构化中间 JSON（MinerU 的 middle_json） */
  middleJson: Record<string, unknown> | null;
  /** 内容列表（MinerU 的 content_list） */
  contentList: unknown[] | null;
  /** 提取的图片（文件名 → base64） */
  images: Record<string, string>;
  /** 任务 ID */
  taskId: string;
  /** 使用的后端 */
  backend: string;
}

export class MinerUClient {
  private apiUrl: string;
  private timeout: number;

  constructor(config: MinerUConfig) {
    this.apiUrl = config.apiUrl;
    this.timeout = config.timeout * 1000;
  }

  /** 健康检查 */
  async healthCheck(): Promise<boolean>;

  /** 同步解析（适合小文件） */
  async parseSync(filePath: string, options?: MinerUParseOptions): Promise<MinerUParseResult>;

  /** 异步解析（适合大文件，提交任务后轮询） */
  async parseAsync(filePath: string, options?: MinerUParseOptions): Promise<MinerUParseResult>;

  /** 提交异步任务 */
  private async submitTask(filePath: string, options?: MinerUParseOptions): Promise<string>;

  /** 轮询任务状态直到完成 */
  private async pollTaskResult(taskId: string): Promise<MinerUParseResult>;
}
```

**关键实现要点**：

1. **文件传输**：使用 `multipart/form-data` POST 上传文件到 MinerU API
2. **大文件策略**：文件 > 20MB 或页数未知时使用异步模式（`POST /tasks` → 轮询 `GET /tasks/{id}` → 获取结果 `GET /tasks/{id}/result`）
3. **小文件策略**：文件 ≤ 20MB 使用同步模式（`POST /file_parse`）
4. **图片提取**：设置 `return_images=true` 获取提取的图片（base64），保存到磁盘
5. **中间 JSON**：设置 `return_middle_json=true` 获取结构化数据，用于 L2 存储

---

## 二、MinerU 处理器

### 2.1 处理器实现

**文件**: `src/services/document-processors/mineru-processor.ts`

```typescript
export class MinerUProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set([
    // MinerU 支持的格式
    "pdf",
    "docx", "pptx", "xlsx",
    "jpg", "jpeg", "png", "bmp", "tiff", "webp", "gif",
  ]);

  canHandle(fileType: string): boolean;
  getStepLabel(): string;  // 返回 "mineru_parsing"

  async parse(filePath: string, options?: Record<string, unknown>): Promise<ParsedContent>;
}
```

**核心逻辑**：

```
parse(filePath, options):
  1. 读取 MinerU 配置
  2. 构造 MinerUParseOptions（从 options 和全局配置合并）
  3. 确定后端类型：
     - options.mineruBackend → 用户指定的后端
     - 根据文件类型推断默认后端（PDF 默认 hybrid，Office 默认 pipeline）
  4. 调用 MinerUClient.parse()
  5. 转换 MinerU 结果为 ParsedContent：
     - mdContent → text + markdown
     - middleJson → raw（作为 L2 原始数据）
     - images → 保存到磁盘，记录路径
     - 从 contentList 提取表格数据
  6. 返回 ParsedContent
```

### 2.2 结果转换：MinerU → ParsedContent

MinerU 的输出格式与 Docling 不同，需要统一转换：

| MinerU 输出 | ParsedContent 字段 | 转换逻辑 |
|------------|-------------------|---------|
| `md_content` | `text`, `markdown` | 直接使用 |
| `middle_json` | `raw` | JSON 解析后存入 |
| `content_list` | `tables` | 过滤 `type=table` 的条目，提取表格数据 |
| `images` | (保存到磁盘) | base64 解码 → 保存到 `{dataDir}/{kbId}/documents/{docId}/images/` |
| (无对应) | `doctags` | 设为空字符串（MinerU 不输出 DocTags） |
| (推断) | `modality` | 根据文件类型推断 |

### 2.3 L2 数据存储策略

当前 L2 存储的是 Docling 的 `DoclingDocument` JSON。新增 MinerU 后：

- **统一 L2 格式**：不强制统一。按 `metadata.sourceType` 区分来源
  - Docling 管线：`sourceType = "docling"`，L2 存 `docling.json`
  - MinerU 管线：`sourceType = "mineru"`，L2 存 `mineru.json`（middle_json）
- **前端按 sourceType 渲染**：Raw 标签页根据 sourceType 选择渲染方式
- **现有数据不受影响**：已处理的文档保持 `sourceType = "docling"`

---

## 三、管线编排器

### 3.1 核心设计

**文件**: `src/services/document-processors/pipeline-orchestrator.ts`

```typescript
export interface PipelineStrategy {
  /** 文件类型匹配规则 */
  fileType: string;           // "pdf" | "docx" | "image" | "audio" | ...
  /** 优先管线列表（按顺序尝试） */
  pipelines: PipelineEntry[];
}

export interface PipelineEntry {
  /** 管线标识 */
  pipeline: "docling" | "mineru" | "native" | "asr";
  /** MinerU 后端（仅 pipeline=mineru 时有效） */
  mineruBackend?: "hybrid-auto-engine" | "pipeline" | "vlm-auto-engine";
  /** 文件类型过滤（可选，在同一策略内进一步区分） */
  fileSubtype?: string;       // "scanned" | "has-tables" | "has-seals" | ...
  /** 优先级数字（越小越优先） */
  priority: number;
}

export interface PipelineResult extends ParsedContent {
  /** 使用的管线 */
  usedPipeline: string;
  /** 管线是否降级过 */
  degraded: boolean;
  /** 原始管线（降级前的管线） */
  originalPipeline?: string;
  /** 降级原因 */
  degradationReason?: string;
}

export class PipelineOrchestrator {
  /** 根据文件类型和配置选择管线并解析 */
  async parse(
    filePath: string,
    fileType: string,
    options?: Record<string, unknown>,
  ): Promise<PipelineResult>;

  /** 使用指定管线解析（用于手动选择） */
  async parseWithPipeline(
    filePath: string,
    fileType: string,
    pipeline: string,
    options?: Record<string, unknown>,
  ): Promise<PipelineResult>;

  /** 获取当前策略配置 */
  getStrategies(): PipelineStrategy[];

  /** 更新策略配置 */
  updateStrategies(strategies: PipelineStrategy[]): void;
}
```

### 3.2 默认策略

**文件**: `src/services/document-processors/pipeline-strategies.ts`

```typescript
const DEFAULT_STRATEGIES: PipelineStrategy[] = [
  {
    fileType: "pdf",
    pipelines: [
      { pipeline: "mineru", mineruBackend: "hybrid-auto-engine", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  {
    fileType: "docx",
    pipelines: [
      { pipeline: "mineru", mineruBackend: "pipeline", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  {
    fileType: "pptx",
    pipelines: [
      { pipeline: "mineru", mineruBackend: "pipeline", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  {
    fileType: "image",  // png, jpg, jpeg, etc.
    pipelines: [
      { pipeline: "mineru", mineruBackend: "hybrid-auto-engine", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  {
    fileType: "audio",  // mp3, wav, etc.
    pipelines: [
      { pipeline: "docling", priority: 1 },
      // MinerU 不支持音频
    ],
  },
  {
    fileType: "video",  // mp4, etc.
    pipelines: [
      { pipeline: "docling", priority: 1 },
      // MinerU 不支持视频
    ],
  },
  {
    fileType: "spreadsheet",  // xlsx, xls, csv
    pipelines: [
      { pipeline: "native", priority: 1 },
      // 保持现有 NativeTableProcessor
    ],
  },
  {
    fileType: "text",  // md, html, latex, xml, etc.
    pipelines: [
      { pipeline: "docling", priority: 1 },
      // MinerU 不支持这些格式
    ],
  },
];
```

### 3.3 降级逻辑

```
parse(filePath, fileType, options):
  1. 获取文件类型对应的策略
  2. 检查 MinerU 是否启用且可用（healthCheck）
  3. 如果 MinerU 不可用 → 跳过所有 mineru 管线
  4. 按优先级尝试每条管线：
     a. 调用管线的 parse()
     b. 如果成功且内容不为空 → 返回结果
     c. 如果失败或内容为空 → 记录失败原因，尝试下一个
  5. 所有管线都失败 → 返回最后一个错误
  6. 如果使用了非首选管线 → 标记 degraded=true
```

**降级触发条件**：
- MinerU API 不可达（连接失败、超时）
- MinerU 解析返回错误
- MinerU 解析结果为空（`text.trim().length === 0`）
- MinerU 解析超时（独立于整体超时，设为全局超时的 70%）

### 3.4 对 ProcessorFactory 的修改

**文件**: `src/services/document-processors/processor-factory.ts`

**最小化修改**：在 `parseWithFallback` 中集成 PipelineOrchestrator。

```typescript
// 新增 import
import { PipelineOrchestrator } from "./pipeline-orchestrator.js";

export class ProcessorFactory {
  private orchestrator: PipelineOrchestrator;

  private constructor() {
    this.orchestrator = new PipelineOrchestrator();
    // 现有 processors 数组保持不变（用于指定管线时的直接调用）
    this.processors = [
      new NativeTableProcessor(),
      new VideoProcessor(),
      new ImageProcessor(),
      new DocConverterProcessor(),
      new DoclingProcessor(),
      new MinerUProcessor(),    // 新增
      new AudioProcessor(),
      new TextProcessor(),
    ];
  }

  /**
   * Auto 模式：通过 PipelineOrchestrator 选择管线
   * 替代原来的 parseWithFallback 逻辑
   */
  async parseWithFallback(filePath: string, fileType: string): Promise<ParsedContent> {
    // 检查是否是 NativeTableProcessor 独占类型（xlsx/xls/csv）
    // 这些类型不走管线编排，直接用原生处理器
    const nativeHandler = this.processors.find(
      p => p instanceof NativeTableProcessor && p.canHandle(fileType)
    );
    if (nativeHandler) {
      return nativeHandler.parse(filePath);
    }

    // 其他类型通过编排器处理
    return this.orchestrator.parse(filePath, fileType);
  }

  /**
   * 指定管线模式：新增 "mineru" 通道
   */
  async parseWithChannel(filePath: string, fileType: string, channel: string): Promise<ParsedContent> {
    if (channel === "auto") {
      return this.parseWithFallback(filePath, fileType);
    }

    const channelMap: Record<string, (p: DocumentProcessor) => boolean> = {
      docling: (p) => p instanceof DoclingProcessor,
      mineru:  (p) => p instanceof MinerUProcessor,   // 新增
      native:  (p) => p instanceof TextProcessor || p instanceof NativeTableProcessor,
      asr:     (p) => p instanceof AudioProcessor,
    };

    // ... 其余逻辑不变
  }
}
```

### 3.5 对 ProcessingQueue 的修改

**文件**: `src/services/processing-queue.ts`

**最小化修改**：`parseDocument` 方法记录使用的管线信息。

```typescript
// 在 ProcessingJob 接口中新增字段
interface ProcessingJob {
  // ... 现有字段 ...
  /** 解析后记录使用的管线 */
  usedPipeline?: string;
}

// stepParsing 中记录管线信息
private async stepParsing(job, abortController) {
  const parsedContent = await this.parseDocument(job, abortController);

  // 记录管线来源（用于编译步骤的 sourceType 判断）
  if (parsedContent.metadata?.sourceType) {
    (job as any)._pipelineSource = parsedContent.metadata.sourceType;
  }

  // ... 其余不变
}
```

---

## 四、配置 API

### 4.1 新增设置端点

**文件**: `src/server/routes/settings.ts`（扩展）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/settings/mineru-config` | GET | 获取 MinerU 配置 |
| `/api/settings/mineru-config` | PUT | 保存 MinerU 配置 |
| `/api/settings/mineru-status` | GET | 检查 MinerU API 连通性 |
| `/api/settings/pipeline-strategies` | GET | 获取管线策略配置 |
| `/api/settings/pipeline-strategies` | PUT | 保存管线策略配置 |

### 4.2 MinerU 配置持久化

使用现有的 `settings` 表，新增两个 key：

| Key | 内容 |
|-----|------|
| `mineru_config` | JSON 格式的 MinerUConfig 对象 |
| `pipeline_strategies` | JSON 格式的 PipelineStrategy[] 数组 |

---

## 五、MinerU 管线对 XLSX 的处理

MinerU 支持 XLSX 格式（通过 Office 后端），但当前 DA 的 `NativeTableProcessor` 已经很好地处理了 XLSX/CSV。

**策略**：XLSX/CSV/XLS 继续走 `NativeTableProcessor`，**不**经过管线编排。原因：
1. NativeTableProcessor 对结构化表格的处理已经足够好
2. MinerU 的 Office 后端对 XLSX 没有额外优势
3. 避免不必要的复杂度

如果用户手动选择 "MinerU" 管线重建 XLSX，则走 MinerUProcessor。

---

## 六、MinerU 服务部署

### 6.1 开发环境

```bash
# 安装 MinerU
pip install mineru

# 启动 API 服务
mineru-api --host 127.0.0.1 --port 8001
```

### 6.2 Docker 部署（生产环境）

在 `docker-compose.dev.yml` 中新增 MinerU 服务：

```yaml
mineru:
  image: mineru/mineru-api:latest  # 或自建镜像
  ports:
    - "8001:8000"
  environment:
    - MINERU_DEVICE_MODE=cuda
    - MINERU_API_MAX_CONCURRENT_REQUESTS=3
    - MINERU_FORMULA_ENABLE=true
    - MINERU_TABLE_ENABLE=true
  volumes:
    - model-data:/models
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
```

### 6.3 健康检查与自动发现

- DA 后端启动时检查 `mineru_config.enabled` 和 API 连通性
- 如果 MinerU API 不可达，自动跳过 MinerU 管线，全部走 Docling
- 每 30 秒后台检查一次 MinerU API 可用性，恢复后自动重新启用

---

## 七、MinerU 管线对 Docling VLM 的关系

当前 Docling 有 VLM 管线模式（`use_vlm=true` 时启用）。分析报告中指出 Docling VLM + Qwen3.6-27B 在以下场景仍有优势：

- 手写体识别
- 复杂排版/语义理解
- 网页截图/拍照
- MinerU 效果不佳时的兜底

**策略**：
- Docling VLM 管线保持不变，作为独立管线可用
- Auto 模式下降级链：MinerU → Docling Standard → Docling VLM（需要 GPU）
- 用户可手动选择 Docling VLM 管线重建
