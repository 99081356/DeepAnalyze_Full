# 第 3 册：文档处理管道

> **文档日期**: 2026-04-20
> **来源**: 综合 04-08 初始设计、04-13 Phase A/B、04-15 三层架构、04-18 子项目 2 设计
> **最新状态**: 以 04-18 子项目 2 设计为准

---

## 1. 文档处理总体流程

```
用户上传文件
  ↓
上传管道 (非阻塞, 30s超时, 最多3次重试)
  ↓
ProcessingQueue (slot并发控制, 支持多文档并行处理)
  ↓
ProcessorFactory (根据 MIME 类型选择处理器)
  ├─ NativeTableProcessor → XLSX/XLS/CSV（元数据描述）
  ├─ DoclingProcessor  → PDF/Word/PPT/TXT/MD/HTML 等
  ├─ ImageProcessor    → 图片
  ├─ AudioProcessor    → 音频
  └─ VideoProcessor    → 视频
  ↓
ParsedContent (统一输出格式)
  ↓
WikiCompiler
  ├─ Raw 层: 保存原始 JSON 到文件系统
  ├─ Structure 层: 生成 DocTags/Markdown 分块页面
  └─ Abstract 层: LLM 生成摘要+标签
  ↓
Indexer (向量化 + 全文索引)
  ↓
Linker (交叉引用, 已冻结)
  ↓
WebSocket 实时推送进度到前端
```

### 1.1 处理进度阶段（精细化追踪）

| 阶段 | 进度范围 | 子进度来源 |
|------|---------|-----------|
| 上传中 | 0-5% | HTTP 上传进度 |
| 排队 | 5% | 固定 |
| 解析 | 10-40% | 页数/帧数/音频时长进度 |
| 编译 | 40-60% | L2→L1→L0 逐步完成，按钮逐步变绿 |
| 索引 | 60-80% | 已索引页数/总页数 |
| 链接 | 80-95% | 已处理文档数/总文档数 |
| 就绪 | 100% | 完成 |

**关键交互**: 编译阶段中 Raw/Structure/Abstract 每完成一层，立即通过 WebSocket 通知前端，对应按钮立即变绿，无需等全部完成。

---

## 2. ProcessingQueue 并发控制

### 2.1 问题与解决方案

**问题**: 原实现使用布尔标志 `processing`，导致 `concurrency > 1` 无效。

**解决方案**: 基于槽位的并发控制。

```typescript
class ProcessingQueue {
  private active: Map<string, AbortController> = new Map();
  private queue: string[] = [];

  async enqueue(docId: string): Promise<void> {
    if (this.active.has(docId) || this.queue.includes(docId)) return;
    this.queue.push(docId);
    this.scheduleNext();
  }

  private scheduleNext(): void {
    while (this.queue.length > 0 && this.active.size < this.concurrency) {
      const docId = this.queue.shift()!;
      const controller = new AbortController();
      this.active.set(docId, controller);
      this.processJob(docId, controller.signal)
        .finally(() => {
          this.active.delete(docId);
          this.scheduleNext();
        });
    }
  }
}
```

### 2.2 上传管道增强

- 非阻塞上传：上传在后台运行，UI 保持可交互
- 每次上传尝试 30 秒超时
- 失败后自动重试 2 次（指数退避 1s, 2s）
- 轮询回退：WebSocket 断开时，每 3 秒轮询文档状态
- 失败的文件显示重试按钮

---

## 3. ProcessorFactory 文件类型路由

### 3.1 MIME 类型映射

| 类型 | 扩展名 | 处理器 |
|------|--------|--------|
| **文档** | pdf, docx, doc, xlsx, xls, pptx, ppt, txt, md, json, html | DoclingProcessor |
| **表格** | xlsx, xls, csv | NativeTableProcessor（元数据描述，Agent 用 pandas 分析源文件） |
| **图片** | png, jpg, jpeg, gif, bmp, tiff, webp, svg | ImageProcessor |
| **音频** | mp3, wav, flac, aac, ogg, m4a, wma | AudioProcessor |
| **视频** | mp4, avi, mov, mkv, webm, flv, wmv | VideoProcessor |

不支持的文件类型明确报错，不静默失败。

---

## 4. DoclingProcessor (文档处理)

### 4.1 Docling 子进程管理

- 主进程管理 Docling Python 子进程的生命周期（自动启动/停止）
- 进程池模式，支持并发处理多个文档
- 通过 stdin/stdout JSON 协议通信

### 4.2 模型可插拔管理 (04-17 设计)

模型目录结构：
```
data/models/docling/
├── layout/     — 布局模型 (Egret-XLarge, Heron)
├── table/      — 表格模型 (TableFormer)
├── vlm/        — VLM 模型 (GOT-OCR-2.0, PaddleOCR-VL-1.5)
└── ocr/        — OCR 模型 (RapidOCR)
```

配置接口：
```typescript
interface DoclingConfig {
  layout_model: string;       // e.g. "docling-project/docling-layout-egret-xlarge"
  ocr_engine: "rapidocr" | "easyocr" | "tesseract" | "auto";
  ocr_backend: "torch" | "onnxruntime";
  table_mode: "accurate" | "fast";
  use_vlm: boolean;
  vlm_model: string;          // e.g. "stepfun-ai/GOT-OCR-2.0-hf"
}
```

Python 端动态构建 DocumentConverter，基于配置哈希缓存。

前端添加"文档处理"配置面板在 Settings → Models 中。

---

## 5. ImageProcessor (图片处理)

### 5.1 处理流程

```
1. 读取图片文件
2. 提取基础信息: 宽度/高度/格式/文件大小 (Sharp)
3. 提取 EXIF 元数据 (Sharp metadata())
4. 生成缩略图 (Sharp resize 到 400px 宽, 保存为 WebP)
5. VLM 图片理解 (调用已配置的 VLM 模型)
6. OCR 文字提取 (通过 Docling)
7. 组合输出 ParsedContent
```

### 5.2 输出数据结构

```typescript
interface ImageRawData {
  description: string;       // VLM 详细描述
  ocrText?: string;          // OCR 提取的文字
  format: string;            // 图片格式
  width: number;             // 宽度
  height: number;            // 高度
  exif?: {
    make?: string;           // 相机制造商
    model?: string;          // 相机型号
    dateTime?: string;       // 拍摄时间
    gps?: { lat: number; lng: number };
    orientation?: number;
  };
  thumbnailPath?: string;    // 缩略图相对路径
}
```

### 5.3 DocTags 输出格式

```
[img](size=1920x1080;format=jpeg) 视觉描述: {description}
[ocr] 文本内容: {ocrText}
[meta] 拍摄时间: {dateTime}, 相机: {make} {model}, GPS: {lat},{lng}
```

---

## 6. AudioProcessor (音频处理)

### 6.1 处理流程

```
1. 读取音频文件
2. 提取基础信息: 时长/格式/采样率/声道数 (ffprobe)
3. 语言自动检测:
   - 优先使用 ASR API 的语言检测能力
   - 备选: 前 30 秒音频片段送 ASR 获取语言
4. ASR 转写 (带时间戳):
   - 调用 /audio/transcriptions, response_format="verbose_json"
5. 发言人分离 (Speaker Diarization):
   方案 A (推荐): 使用支持 diarization 的 ASR API
   方案 B (备选): 基于停顿的简单分割 (≥1.5秒静默 → S1, S2, S3...)
   方案 C (降级): 单一说话者 "未知说话者"
6. 组合输出
```

### 6.2 输出数据结构

```typescript
interface AudioRawData {
  duration: number;
  language?: string;          // "zh", "en", "ja" 等
  sampleRate?: number;
  channels?: number;
  speakers: [{
    id: string;               // "S1", "S2"
    label: string;            // "发言人 1"
    totalDuration?: number;
  }];
  turns: [{
    speaker: string;
    startTime: number;
    endTime: number;
    text: string;
  }];
  diarizationMethod: 'api' | 'silence' | 'none';
}
```

### 6.3 DocTags 输出格式

```
[p](speaker=S1;time=00:00-00:15) 第一位发言人的内容...
[p](speaker=S2;time=00:16-00:32) 第二位发言人的内容...
```

### 6.4 L1 Structure 页面

按发言人分组：页面标题 "发言人 1 (00:00-02:35)"

---

## 7. VideoProcessor (视频处理)

### 7.1 核心设计思路

不再仅做"关键帧采样 + 逐帧 VLM"，而是：
1. 使用**视频理解模型**对完整视频内容进行深度理解
2. 同时提取音频轨做 ASR 转写 + 发言人分离
3. 时间轴上对齐"画面描述"和"对话内容"

### 7.2 处理流程

```
1. 读取视频文件
2. 提取基础信息: 时长/分辨率/FPS/编码 (ffprobe)
3. 生成视频缩略图:
   - 每 30 秒提取 1 帧, 最多 120 帧
   - 保存到 {docId}/frames/ 目录 (JPEG, 320px宽)
4. 视频理解（核心）:
   方案 A: 调用支持视频输入的 VLM (GPT-4o / Gemini 2.5 / Qwen-VL-Max)
     - 将视频文件发送给 VLM
     - 获取完整的场景分析报告（按场景/时段分段描述）
   方案 B (降级): 帧采样 + 逐帧 VLM
     - 均匀采样关键帧（每 10-30 秒 1 帧）
     - 逐帧获取描述，差异大的标注为"场景转换"
5. 音频轨提取和转写:
   - ffmpeg 提取音频轨为临时 WAV
   - 复用 AudioProcessor 的 ASR + 发言人分离逻辑
6. 时间对齐与合并:
   - 场景描述（含时间段）+ ASR 转写（含时间戳和发言人）
   - 形成 "场景 = 画面 + 对话" 的完整结构
```

### 7.3 输出数据结构

```typescript
interface VideoRawData {
  duration: number;
  resolution?: string;        // "1920x1080"
  fps?: number;
  codec?: string;
  scenes: [{
    index: number;
    startTime: number;
    endTime: number;
    description: string;      // 视频理解模型的场景描述
    keyEvents?: string[];
    textOnScreen?: string;
    sceneTransition?: boolean;
    thumbnailPath?: string;
  }];
  transcript: {
    duration: number;
    language?: string;
    speakers: [{ id: string; label: string }];
    turns: [{
      speaker: string;
      startTime: number;
      endTime: number;
      text: string;
    }];
    diarizationMethod: 'api' | 'silence' | 'none';
  };
  videoUnderstandingMethod: 'vlm_video' | 'vlm_frames';
}
```

### 7.4 L1 Structure 页面

按时段分场景页面：
```
页面标题: "场景 3 (01:30-02:00)"
页面内容:
  ## 画面描述
  办公室内，三人在会议桌前讨论...

  ## 对话内容
  [S1]: 我认为这个方案需要调整...
  [S2]: 同意...
```

---

## 8. 文档删除级联

删除文档时的完整清理顺序：
```
1. 删除 embeddings (by page_id, 关联 wiki_pages.doc_id)
2. 删除 anchors (by doc_id)
3. 删除 wiki_links (source/target 关联 wiki_pages)
4. 删除 wiki_pages (by doc_id)
5. 删除磁盘文件:
   - {wikiDir}/{kbId}/documents/{docId}/ (递归)
   - {dataDir}/raw/{kbId}/{docId}/ (递归)
   - {dataDir}/original/{kbId}/{docId}/ (递归)
6. 删除 documents 记录
```

---

## 9. 原文件服务接口

为前端预览播放提供的后端接口：

```
GET /api/knowledge/kbs/:kbId/documents/:docId/original
  → 返回原始文件 (Content-Type 根据文件类型)
  → 支持 Range 请求 (视频/音频 seek)

GET /api/knowledge/kbs/:kbId/documents/:docId/thumbnail
  → 返回图片缩略图

GET /api/knowledge/kbs/:kbId/documents/:docId/frames/:index
  → 返回视频关键帧缩略图
```
