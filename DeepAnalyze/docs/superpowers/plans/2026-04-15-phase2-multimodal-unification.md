# 阶段 2：多模态处理统一

> **给执行代理的说明：** 必须使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 来逐步实施本计划。

**目标：** 统一所有模态的处理器（图片、音频、视频、Excel），使其输出相同的三层结构（Raw→Structure→Abstract）并携带锚点，实现跨模态统一检索。

**架构方案：** 每种处理器在 ParsedContent 中填充 modality 专属的 raw 数据和 doctags 文本。WikiCompiler 新增模态感知的编译方法，Structure 层根据模态采用不同的分块策略。锚点生成器支持各模态的锚点生成。所有数据库操作通过 Phase 0 的 Repository 接口层执行。

**技术栈：** TypeScript、Python（Docling/ASR）、LLM（视觉模型用于图片描述）

**前置条件：** 阶段 0（PostgreSQL 基础设施 + Repository 层）、阶段 1（ParsedContent 扩展、三层编译器、锚点系统）

**设计规格：** `docs/superpowers/specs/2026-04-15-three-layer-architecture-redesign.md` 第 6 章

**冻结范围：** 图谱和正反向关联系统（linker.ts、l0-linker.ts、GraphTool）不修改，详见设计规格 1.4 节。

---

## 文件清单

| 操作 | 文件路径 | 职责说明 |
|------|---------|---------|
| 新建 | `src/services/document-processors/modality-types.ts` | 各模态的原始数据类型定义 + DocTags 格式常量 |
| 修改 | `src/services/document-processors/image-processor.ts` | 输出 raw 结构描述 + doctags |
| 修改 | `src/services/document-processors/audio-processor.ts` | 输出 ASR 转写 + 发言者/时间戳 doctags |
| 修改 | `src/services/document-processors/video-processor.ts` | 输出时间轴描述 + doctags |
| 修改 | `src/wiki/anchor-generator.ts` | 新增音频/视频/图片的锚点生成方法 |
| 修改 | `tests/anchor-generator.test.ts` | 新增多模态锚点测试 |
| 修改 | `src/wiki/compiler.ts` | 新增模态感知的 Structure 编译 |
| 新建 | `src/wiki/modality-compilers/image-structure.ts` | 图片 Structure 编译逻辑 |
| 新建 | `src/wiki/modality-compilers/audio-structure.ts` | 音频 Structure 编译逻辑 |
| 新建 | `src/wiki/modality-compilers/video-structure.ts` | 视频 Structure 编译逻辑 |
| 新建 | `tests/multimodal-compilation.test.ts` | 多模态编译集成测试 |

---

## 任务 1：模态类型定义

**涉及文件：** `src/services/document-processors/modality-types.ts`（新建）

- [ ] **步骤 1：创建模态类型文件**

新建 `src/services/document-processors/modality-types.ts`：

```typescript
/**
 * 各模态的原始数据接口定义
 */

/** 图片原始数据 */
export interface ImageRawData {
  description: string;
  ocrText?: string;
  width?: number;
  height?: number;
  format?: string;
  exif?: Record<string, unknown>;
}

/** 音频发言者分段 */
export interface SpeakerTurn {
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
}

/** 音频原始数据 */
export interface AudioRawData {
  duration: number;
  speakers: Array<{
    id: string;
    label: string;
  }>;
  turns: SpeakerTurn[];
}

/** 视频关键帧 */
export interface VideoKeyframe {
  time: number;
  description: string;
}

/** 视频原始数据 */
export interface VideoRawData {
  duration: number;
  resolution?: string;
  fps?: number;
  keyframes: VideoKeyframe[];
  transcript: AudioRawData;
}

/** Excel Sheet 表格摘要 */
export interface ExcelTableSummary {
  sheetName: string;
  tableIndex: number;
  headers: string[];
  rowCount: number;
  colCount: number;
}

/**
 * 各模态 DocTags 格式生成工具
 */
export const DocTagsFormatters = {
  image(raw: ImageRawData): string {
    const parts: string[] = [];
    parts.push(`[img] 视觉描述: ${raw.description}`);
    if (raw.ocrText) {
      parts.push(`[ocr] 文本内容: ${raw.ocrText}`);
    }
    if (raw.width && raw.height) {
      parts.push(`[meta] ${raw.width}x${raw.height}${raw.format ? `, ${raw.format}` : ''}`);
    }
    return parts.join('\n');
  },

  audioTurn(turn: SpeakerTurn): string {
    const timeStr = `${formatTime(turn.startTime)}-${formatTime(turn.endTime)}`;
    return `[p](speaker=${turn.speaker};time=${timeStr}) ${turn.text}`;
  },

  videoScene(keyframe: VideoKeyframe, turns: SpeakerTurn[]): string {
    const parts: string[] = [];
    parts.push(`[scene](time=${formatTime(keyframe.time)}) ${keyframe.description}`);
    for (const turn of turns) {
      parts.push(`[dialog](speaker=${turn.speaker};time=${formatTime(turn.startTime)}) ${turn.text}`);
    }
    return parts.join('\n');
  },
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
```

- [ ] **步骤 2：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 3：提交**
```bash
git add src/services/document-processors/modality-types.ts
git commit -m "feat: 新增各模态的原始数据类型定义和 DocTags 格式工具"
```

---

## 任务 2：图片处理器增强

**涉及文件：** `src/services/document-processors/image-processor.ts`

- [ ] **步骤 1：通读当前 image-processor.ts**

理解现有的 `parse()` 方法签名和返回格式。

- [ ] **步骤 2：更新 parse() 方法**

在 `parse()` 返回中新增三个字段：
```typescript
// 在构造 ParsedContent 的返回值中新增：
raw: {
  description: visionDescription,  // 现有的视觉描述
  ocrText: extractedText,          // OCR 提取的文本（如果有）
  width: imageMetadata?.width,
  height: imageMetadata?.height,
  format: imageMetadata?.format,
  exif: imageMetadata?.exif,
} as ImageRawData,
doctags: DocTagsFormatters.image({
  description: visionDescription,
  ocrText: extractedText,
  width: imageMetadata?.width,
  height: imageMetadata?.height,
  format: imageMetadata?.format,
}),
modality: 'image',
```

- [ ] **步骤 3：添加导入**
```typescript
import { ImageRawData, DocTagsFormatters } from './modality-types';
```

- [ ] **步骤 4：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 5：提交**
```bash
git add src/services/document-processors/image-processor.ts
git commit -m "feat: 图片处理器输出 raw 结构化数据 + doctags + modality"
```

---

## 任务 3：音频处理器增强

**涉及文件：** `src/services/document-processors/audio-processor.ts`

- [ ] **步骤 1：通读当前 audio-processor.ts**

理解现有的 ASR 转写逻辑和声纹分离输出格式。

- [ ] **步骤 2：更新 parse() 方法**

在 `parse()` 返回中新增三个字段：
```typescript
raw: {
  duration: audioDuration,
  speakers: speakerList.map(s => ({ id: s.id, label: s.label })),
  turns: transcriptionSegments.map(seg => ({
    speaker: seg.speakerId,
    startTime: seg.start,
    endTime: seg.end,
    text: seg.text,
  })),
} as AudioRawData,
doctags: transcriptionSegments
  .map(seg => DocTagsFormatters.audioTurn({
    speaker: seg.speakerId,
    startTime: seg.start,
    endTime: seg.end,
    text: seg.text,
  }))
  .join('\n'),
modality: 'audio',
```

如果当前 ASR 输出不含发言者分段（无 `speakerId`），则按 30 秒窗口分块：
```typescript
// 无发言者时的回退逻辑
doctags: splitByTimeWindow(plainTranscript, 30)
  .map((chunk, i) => `[p](time=${formatTime(i*30)}-${formatTime((i+1)*30)}) ${chunk}`)
  .join('\n'),
```

- [ ] **步骤 3：添加导入**
```typescript
import { AudioRawData, DocTagsFormatters } from './modality-types';
```

- [ ] **步骤 4：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 5：提交**
```bash
git add src/services/document-processors/audio-processor.ts
git commit -m "feat: 音频处理器输出 raw 转写 + 发言者标记 doctags + modality"
```

---

## 任务 4：视频处理器增强

**涉及文件：** `src/services/document-processors/video-processor.ts`

- [ ] **步骤 1：通读当前 video-processor.ts**

理解现有的关键帧提取和转写逻辑。

- [ ] **步骤 2：更新 parse() 方法**

在 `parse()` 返回中新增三个字段：
```typescript
raw: {
  duration: videoDuration,
  resolution: videoResolution,
  fps: videoFps,
  keyframes: extractedKeyframes.map(kf => ({
    time: kf.timestamp,
    description: kf.description,
  })),
  transcript: audioTranscript, // 复用 AudioRawData 格式
} as VideoRawData,
doctags: generateVideoDocTags(extractedKeyframes, audioTranscript),
modality: 'video',
```

其中 `generateVideoDocTags()` 实现：
```typescript
function generateVideoDocTags(keyframes: VideoKeyframe[], transcript: AudioRawData): string {
  const parts: string[] = [];
  for (const kf of keyframes) {
    // 找出该关键帧时间范围内的对话段落
    const relatedTurns = transcript.turns.filter(
      t => t.startTime >= kf.time && t.startTime < (kf.time + sceneDuration)
    );
    parts.push(DocTagsFormatters.videoScene(kf, relatedTurns));
  }
  return parts.join('\n');
}
```

- [ ] **步骤 3：添加导入**
```typescript
import { VideoRawData, DocTagsFormatters } from './modality-types';
```

- [ ] **步骤 4：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 5：提交**
```bash
git add src/services/document-processors/video-processor.ts
git commit -m "feat: 视频处理器输出 raw 时间轴 + 组合 doctags + modality"
```

---

## 任务 5：锚点生成器 — 多模态锚点

**涉及文件：** `src/wiki/anchor-generator.ts`、`tests/anchor-generator.test.ts`

Phase 1 已创建 `AnchorGenerator` 类（含 `generateAnchors` 和 `generateExcelAnchors`）。本任务新增三个模态的锚点生成方法。

- [ ] **步骤 1：编写测试**

在 `tests/anchor-generator.test.ts` 中新增测试用例：

```typescript
describe('AnchorGenerator 多模态', () => {
  const generator = new AnchorGenerator();

  test('generateImageAnchors — 单张图片生成一个锚点', () => {
    const raw: ImageRawData = {
      description: '系统架构图，展示了微服务的组件关系',
      ocrText: '用户服务 → API网关 → 数据处理',
      width: 1920,
      height: 1080,
      format: 'PNG',
    };
    const anchors = generator.generateImageAnchors('doc1', 'kb1', raw);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].id).toBe('doc1:image:0');
    expect(anchors[0].element_type).toBe('image');
    expect(anchors[0].section_path).toBe('image');
    expect(anchors[0].content_preview).toContain('系统架构图');
  });

  test('generateAudioAnchors — 按发言段落生成锚点', () => {
    const raw: AudioRawData = {
      duration: 120,
      speakers: [{ id: 'A', label: '主持人' }, { id: 'B', label: '嘉宾' }],
      turns: [
        { speaker: 'A', startTime: 0, endTime: 15, text: '大家好' },
        { speaker: 'B', startTime: 15, endTime: 45, text: '谢谢邀请' },
        { speaker: 'A', startTime: 45, endTime: 90, text: '请介绍一下' },
      ],
    };
    const anchors = generator.generateAudioAnchors('doc2', 'kb1', raw);
    expect(anchors).toHaveLength(3);
    expect(anchors[0].id).toBe('doc2:turn:0');
    expect(anchors[0].section_title).toBe('主持人');
    expect(anchors[1].id).toBe('doc2:turn:1');
    expect(anchors[1].section_title).toBe('嘉宾');
    // pageNumber 存储时间范围（秒）
    expect(anchors[0].page_number).toBe(0);
    expect(anchors[1].page_number).toBe(15);
  });

  test('generateVideoAnchors — 场景和对话锚点', () => {
    const raw: VideoRawData = {
      duration: 180,
      keyframes: [
        { time: 0, description: '开场白，主持人站在屏幕前' },
        { time: 60, description: '幻灯片展示，显示数据图表' },
      ],
      transcript: {
        duration: 180,
        speakers: [{ id: 'A', label: '旁白' }],
        turns: [
          { speaker: 'A', startTime: 5, endTime: 30, text: '今天我们来讨论...' },
          { speaker: 'A', startTime: 65, endTime: 90, text: '从图表可以看出...' },
        ],
      },
    };
    const anchors = generator.generateVideoAnchors('doc3', 'kb1', raw);
    // 2 个场景锚点 + 2 个对话锚点
    expect(anchors.filter(a => a.element_type === 'scene')).toHaveLength(2);
    expect(anchors.filter(a => a.element_type === 'turn')).toHaveLength(2);
    expect(anchors[0].id).toBe('doc3:scene:0');
    expect(anchors[2].id).toBe('doc3:turn:0');
  });
});
```

- [ ] **步骤 2：实现多模态锚点生成**

在 `src/wiki/anchor-generator.ts` 中新增三个方法：

```typescript
/** 图片锚点：单张图片一个锚点 */
generateImageAnchors(docId: string, kbId: string, raw: ImageRawData): AnchorDef[] {
  return [{
    id: `${docId}:image:0`,
    doc_id: docId,
    kb_id: kbId,
    element_type: 'image',
    element_index: 0,
    section_path: 'image',
    section_title: undefined,
    page_number: undefined,
    raw_json_path: '#/image',
    structure_page_id: undefined,
    content_preview: raw.description?.slice(0, 200),
    content_hash: undefined,
    metadata: {
      format: raw.format,
      width: raw.width,
      height: raw.height,
    },
  }];
}

/** 音频锚点：每个发言段落一个锚点 */
generateAudioAnchors(docId: string, kbId: string, raw: AudioRawData): AnchorDef[] {
  return raw.turns.map((turn, index) => ({
    id: `${docId}:turn:${index}`,
    doc_id: docId,
    kb_id: kbId,
    element_type: 'turn',
    element_index: index,
    section_path: turn.speaker,
    section_title: raw.speakers.find(s => s.id === turn.speaker)?.label ?? turn.speaker,
    page_number: Math.floor(turn.startTime), // 用页码字段存起始秒数
    raw_json_path: `#/turns/${index}`,
    structure_page_id: undefined,
    content_preview: turn.text.slice(0, 200),
    content_hash: undefined,
    metadata: {
      startTime: turn.startTime,
      endTime: turn.endTime,
      speaker: turn.speaker,
    },
  }));
}

/** 视频锚点：场景锚点 + 对话锚点 */
generateVideoAnchors(docId: string, kbId: string, raw: VideoRawData): AnchorDef[] {
  const sceneAnchors = raw.keyframes.map((kf, index) => ({
    id: `${docId}:scene:${index}`,
    doc_id: docId,
    kb_id: kbId,
    element_type: 'scene',
    element_index: index,
    section_path: `scene_${index}`,
    section_title: `场景${index + 1}`,
    page_number: Math.floor(kf.time), // 起始秒数
    raw_json_path: `#/keyframes/${index}`,
    structure_page_id: undefined,
    content_preview: kf.description.slice(0, 200),
    content_hash: undefined,
    metadata: { time: kf.time },
  }));

  const turnAnchors = raw.transcript.turns.map((turn, index) => ({
    id: `${docId}:turn:${index}`,
    doc_id: docId,
    kb_id: kbId,
    element_type: 'turn',
    element_index: index,
    section_path: turn.speaker,
    section_title: raw.transcript.speakers.find(s => s.id === turn.speaker)?.label ?? turn.speaker,
    page_number: Math.floor(turn.startTime),
    raw_json_path: `#/transcript/turns/${index}`,
    structure_page_id: undefined,
    content_preview: turn.text.slice(0, 200),
    content_hash: undefined,
    metadata: {
      startTime: turn.startTime,
      endTime: turn.endTime,
      speaker: turn.speaker,
    },
  }));

  return [...sceneAnchors, ...turnAnchors];
}
```

- [ ] **步骤 3：添加导入**
```typescript
import { ImageRawData, AudioRawData, VideoRawData } from '../services/document-processors/modality-types';
```

- [ ] **步骤 4：运行测试确认通过**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run tests/anchor-generator.test.ts
```

- [ ] **步骤 5：提交**
```bash
git add src/wiki/anchor-generator.ts tests/anchor-generator.test.ts
git commit -m "feat: 锚点生成器新增图片/音频/视频模态支持"
```

---

## 任务 6：模态 Structure 编译器（图片 + 音频 + 视频）

**涉及文件：** `src/wiki/modality-compilers/image-structure.ts`（新建）、`src/wiki/modality-compilers/audio-structure.ts`（新建）、`src/wiki/modality-compilers/video-structure.ts`（新建）

- [ ] **步骤 1：创建目录**
```bash
mkdir -p /mnt/d/code/deepanalyze/deepanalyze/src/wiki/modality-compilers
```

- [ ] **步骤 2：实现图片 Structure 编译器**

新建 `src/wiki/modality-compilers/image-structure.ts`：

```typescript
import { WikiPageRepo, AnchorRepo, FTSSearchRepo } from '../../store/repos/interfaces';
import { ImageRawData } from '../../services/document-processors/modality-types';
import { AnchorGenerator } from '../anchor-generator';

/**
 * 图片 Structure 编译 — 单块：描述 + OCR + 元数据
 */
export async function compileImageStructure(
  params: {
    kbId: string;
    docId: string;
    raw: ImageRawData;
    doctags: string;
    wikiPageRepo: WikiPageRepo;
    anchorRepo: AnchorRepo;
    ftsRepo: FTSSearchRepo;
    anchorGenerator: AnchorGenerator;
  }
): Promise<string[]> {
  const { kbId, docId, raw, doctags, wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator } = params;

  // 1. 生成锚点
  const anchors = anchorGenerator.generateImageAnchors(docId, kbId, raw);
  await anchorRepo.batchInsert(anchors);

  // 2. 创建单个 Structure 页面
  const title = '图片内容';
  const page = await wikiPageRepo.create({
    kb_id: kbId,
    doc_id: docId,
    page_type: 'structure',
    title,
    content: doctags,
    file_path: `${kbId}/documents/${docId}/structure/image.md`,
    metadata: {
      anchorIds: anchors.map(a => a.id),
      modality: 'image',
      elementTypes: ['image'],
      format: raw.format,
      dimensions: raw.width && raw.height ? `${raw.width}x${raw.height}` : undefined,
    },
  });

  // 3. 更新锚点的 structure_page_id
  await anchorRepo.updateStructurePageId(anchors.map(a => a.id), page.id);

  // 4. 建立全文索引
  await ftsRepo.upsertFTSEntry(page.id, title, doctags);

  return [page.id];
}
```

- [ ] **步骤 3：实现音频 Structure 编译器**

新建 `src/wiki/modality-compilers/audio-structure.ts`：

```typescript
import { WikiPageRepo, AnchorRepo, FTSSearchRepo } from '../../store/repos/interfaces';
import { AudioRawData, DocTagsFormatters } from '../../services/document-processors/modality-types';
import { AnchorGenerator } from '../anchor-generator';

/**
 * 音频 Structure 编译 — 按发言者分组
 * 同一发言者的连续段落归为一个块
 */
export async function compileAudioStructure(
  params: {
    kbId: string;
    docId: string;
    raw: AudioRawData;
    doctags: string;
    wikiPageRepo: WikiPageRepo;
    anchorRepo: AnchorRepo;
    ftsRepo: FTSSearchRepo;
    anchorGenerator: AnchorGenerator;
  }
): Promise<string[]> {
  const { kbId, docId, raw, doctags, wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator } = params;

  // 1. 生成锚点
  const anchors = anchorGenerator.generateAudioAnchors(docId, kbId, raw);
  await anchorRepo.batchInsert(anchors);

  // 2. 按发言者分组连续段落
  const chunks = groupBySpeaker(raw.turns);
  const pageIds: string[] = [];

  for (const chunk of chunks) {
    const title = formatChunkTitle(chunk, raw);
    const content = chunk
      .map(t => DocTagsFormatters.audioTurn(t))
      .join('\n');
    const chunkAnchors = anchors.filter(a =>
      chunk.some(t => `${docId}:turn:${raw.turns.indexOf(t)}` === a.id)
    );

    const page = await wikiPageRepo.create({
      kb_id: kbId,
      doc_id: docId,
      page_type: 'structure',
      title,
      content,
      file_path: `${kbId}/documents/${docId}/structure/${sanitizeFilename(title)}.md`,
      metadata: {
        anchorIds: chunkAnchors.map(a => a.id),
        modality: 'audio',
        elementTypes: ['turn'],
        speaker: chunk[0].speaker,
        timeRange: `${formatTime(chunk[0].startTime)}-${formatTime(chunk[chunk.length - 1].endTime)}`,
        turnCount: chunk.length,
      },
    });

    await anchorRepo.updateStructurePageId(chunkAnchors.map(a => a.id), page.id);
    await ftsRepo.upsertFTSEntry(page.id, title, content);
    pageIds.push(page.id);
  }

  return pageIds;
}

/** 将同一发言者的连续段落归为一组 */
function groupBySpeaker(turns: AudioRawData['turns']): AudioRawData['turns'][] {
  if (turns.length === 0) return [];
  const groups: AudioRawData['turns'][] = [];
  let current = [turns[0]];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].speaker === turns[i - 1].speaker) {
      current.push(turns[i]);
    } else {
      groups.push(current);
      current = [turns[i]];
    }
  }
  groups.push(current);
  return groups;
}

function formatChunkTitle(chunk: AudioRawData['turns'], raw: AudioRawData): string {
  const speaker = raw.speakers.find(s => s.id === chunk[0].speaker)?.label ?? chunk[0].speaker;
  return `${speaker} (${formatTime(chunk[0].startTime)}-${formatTime(chunk[chunk.length - 1].endTime)})`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 100);
}
```

- [ ] **步骤 4：实现视频 Structure 编译器**

新建 `src/wiki/modality-compilers/video-structure.ts`：

```typescript
import { WikiPageRepo, AnchorRepo, FTSSearchRepo } from '../../store/repos/interfaces';
import { VideoRawData, DocTagsFormatters } from '../../services/document-processors/modality-types';
import { AnchorGenerator } from '../anchor-generator';

/**
 * 视频 Structure 编译 — 按场景边界分块
 * 每块 = 场景描述 + 该时段内的对话文本
 */
export async function compileVideoStructure(
  params: {
    kbId: string;
    docId: string;
    raw: VideoRawData;
    doctags: string;
    wikiPageRepo: WikiPageRepo;
    anchorRepo: AnchorRepo;
    ftsRepo: FTSSearchRepo;
    anchorGenerator: AnchorGenerator;
  }
): Promise<string[]> {
  const { kbId, docId, raw, doctags, wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator } = params;

  // 1. 生成锚点
  const anchors = anchorGenerator.generateVideoAnchors(docId, kbId, raw);
  await anchorRepo.batchInsert(anchors);

  const sceneAnchors = anchors.filter(a => a.element_type === 'scene');
  const turnAnchors = anchors.filter(a => a.element_type === 'turn');
  const pageIds: string[] = [];

  // 2. 按关键帧场景分块
  for (let i = 0; i < raw.keyframes.length; i++) {
    const kf = raw.keyframes[i];
    const nextTime = i < raw.keyframes.length - 1 ? raw.keyframes[i + 1].time : raw.duration;

    // 找出该场景时间范围内的对话
    const sceneTurns = raw.transcript.turns.filter(
      t => t.startTime >= kf.time && t.startTime < nextTime
    );
    const sceneTurnAnchors = turnAnchors.filter(a =>
      sceneTurns.some(t => a.raw_json_path === `#/transcript/turns/${raw.transcript.turns.indexOf(t)}`)
    );

    const title = `场景${i + 1} (${formatTime(kf.time)}-${formatTime(nextTime)})`;
    const content = DocTagsFormatters.videoScene(kf, sceneTurns);

    const page = await wikiPageRepo.create({
      kb_id: kbId,
      doc_id: docId,
      page_type: 'structure',
      title,
      content,
      file_path: `${kbId}/documents/${docId}/structure/scene_${i + 1}.md`,
      metadata: {
        anchorIds: [sceneAnchors[i]?.id, ...sceneTurnAnchors.map(a => a.id)].filter(Boolean),
        modality: 'video',
        elementTypes: ['scene', ...sceneTurns.map(() => 'turn')],
        timeRange: `${kf.time}-${nextTime}`,
        keyframeDescription: kf.description,
      },
    });

    // 更新锚点关联
    const anchorIds = [sceneAnchors[i]?.id, ...sceneTurnAnchors.map(a => a.id)].filter(Boolean) as string[];
    await anchorRepo.updateStructurePageId(anchorIds, page.id);
    await ftsRepo.upsertFTSEntry(page.id, title, content);
    pageIds.push(page.id);
  }

  return pageIds;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
```

- [ ] **步骤 5：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 6：提交**
```bash
git add src/wiki/modality-compilers/
git commit -m "feat: 新增图片/音频/视频模态 Structure 编译器"
```

---

## 任务 7：WikiCompiler 模态分发集成

**涉及文件：** `src/wiki/compiler.ts`

Phase 1 已将 WikiCompiler 重构为 Raw→Structure→Abstract 三层编译。本任务在 `compileStructure()` 中新增模态分发逻辑。

- [ ] **步骤 1：通读 compiler.ts 中 compileStructure() 方法**

理解 Phase 1 实现的文档/Excel 编译逻辑。

- [ ] **步骤 2：添加模态分发**

在 `compileStructure()` 方法中，根据 `parsedContent.modality` 分发到不同的编译器：

```typescript
// 在 compileStructure() 的开头添加模态分发
switch (parsedContent.modality) {
  case 'image':
    return compileImageStructure({
      kbId, docId,
      raw: parsedContent.raw as unknown as ImageRawData,
      doctags: parsedContent.doctags!,
      wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator,
    });
  case 'audio':
    return compileAudioStructure({
      kbId, docId,
      raw: parsedContent.raw as unknown as AudioRawData,
      doctags: parsedContent.doctags!,
      wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator,
    });
  case 'video':
    return compileVideoStructure({
      kbId, docId,
      raw: parsedContent.raw as unknown as VideoRawData,
      doctags: parsedContent.doctags!,
      wikiPageRepo, anchorRepo, ftsRepo, anchorGenerator,
    });
  default:
    // document / excel — Phase 1 已实现的逻辑
    return compileStructureDocument(kbId, docId, parsedContent, ...);
}
```

- [ ] **步骤 3：添加导入**
```typescript
import { compileImageStructure } from './modality-compilers/image-structure';
import { compileAudioStructure } from './modality-compilers/audio-structure';
import { compileVideoStructure } from './modality-compilers/video-structure';
import { ImageRawData, AudioRawData, VideoRawData } from '../services/document-processors/modality-types';
```

- [ ] **步骤 4：更新 compileAbstract()**

在 `compileAbstract()` 中，当 modality 为 image/audio/video 时，调整 LLM 提示词使其理解不同模态的内容：

```typescript
// 根据 modality 调整 Abstract 提示词
const modalityHints: Record<string, string> = {
  image: '这是一个图片文件。请根据视觉描述和 OCR 文本生成摘要。',
  audio: '这是一个音频转写文件。请根据对话内容生成主题摘要和关键观点。',
  video: '这是一个视频文件。请根据场景描述和对话内容生成摘要。',
  document: '', // 默认
  excel: '这是一个 Excel 表格文件。请根据表格内容生成摘要。',
};
const hint = modalityHints[parsedContent.modality ?? 'document'] ?? '';
```

- [ ] **步骤 5：运行类型检查**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **步骤 6：提交**
```bash
git add src/wiki/compiler.ts
git commit -m "feat: WikiCompiler 集成模态分发，支持图片/音频/视频编译"
```

---

## 任务 8：集成测试

**涉及文件：** `tests/multimodal-compilation.test.ts`（新建）

- [ ] **步骤 1：编写多模态编译测试**

```typescript
import { describe, test, expect, beforeEach } from 'vitest';
// mock Repository 接口
// 测试 AnchorGenerator 的多模态锚点生成

describe('多模态编译集成测试', () => {
  test('图片 — 完整三层编译流程', async () => {
    const parsedContent = {
      text: '系统架构图',
      metadata: { fileName: 'arch.png' },
      success: true,
      raw: {
        description: '系统架构图，展示了微服务的组件关系',
        ocrText: '用户服务 → API网关',
        width: 1920,
        height: 1080,
        format: 'PNG',
      },
      doctags: '[img] 视觉描述: 系统架构图\n[ocr] 文本内容: 用户服务 → API网关\n[meta] 1920x1080, PNG',
      modality: 'image' as const,
    };

    // 调用编译器（使用 mock repos）
    // 验证：
    // 1. raw JSON 已保存
    // 2. 1 个 structure 页面已创建（page_type='structure'）
    // 3. 1 个锚点已写入（docId:image:0）
    // 4. FTS 索引已建立
  });

  test('音频 — 按发言者分块', async () => {
    const parsedContent = {
      text: '大家好，谢谢邀请...',
      metadata: { fileName: 'interview.mp3', duration: 120 },
      success: true,
      raw: {
        duration: 120,
        speakers: [
          { id: 'A', label: '主持人' },
          { id: 'B', label: '嘉宾' },
        ],
        turns: [
          { speaker: 'A', startTime: 0, endTime: 15, text: '大家好' },
          { speaker: 'B', startTime: 15, endTime: 45, text: '谢谢邀请' },
          { speaker: 'A', startTime: 45, endTime: 90, text: '请介绍一下' },
        ],
      },
      doctags: '[p](speaker=A;time=00:00-00:15) 大家好\n[p](speaker=B;time=00:15-00:45) 谢谢邀请',
      modality: 'audio' as const,
    };

    // 验证：
    // 1. 2 个 structure 页面（A一段、B一段、A又一段 → 3 个块）
    // 2. 3 个锚点（docId:turn:0, docId:turn:1, docId:turn:2）
    // 3. 每个 structure 页面关联正确的锚点
  });

  test('视频 — 按场景分块', async () => {
    const parsedContent = {
      text: '开场白...',
      metadata: { fileName: 'demo.mp4', duration: 180 },
      success: true,
      raw: {
        duration: 180,
        resolution: '1920x1080',
        fps: 30,
        keyframes: [
          { time: 0, description: '开场白' },
          { time: 60, description: '数据图表' },
        ],
        transcript: {
          duration: 180,
          speakers: [{ id: 'A', label: '旁白' }],
          turns: [
            { speaker: 'A', startTime: 5, endTime: 30, text: '今天讨论' },
            { speaker: 'A', startTime: 65, endTime: 90, text: '从图表看' },
          ],
        },
      },
      doctags: '[scene](time=00:00) 开场白\n[dialog](speaker=A;time=00:05) 今天讨论',
      modality: 'video' as const,
    };

    // 验证：
    // 1. 2 个 structure 页面（2 个场景）
    // 2. 4 个锚点（2 scene + 2 turn）
    // 3. 每个场景包含对应的对话锚点
  });
});
```

- [ ] **步骤 2：运行测试**
```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx vitest run tests/multimodal-compilation.test.ts
```

- [ ] **步骤 3：提交**
```bash
git add tests/multimodal-compilation.test.ts
git commit -m "test: 新增多模态编译集成测试（图片/音频/视频）"
```

---

## 执行顺序

任务 1-4 可并行（独立的处理器和类型定义修改）。
任务 5 依赖任务 1（使用模态类型定义）。
任务 6 依赖任务 1（使用模态类型定义和 Repository 接口）。
任务 7 依赖任务 6（集成模态编译器到主编译器）。
任务 8 依赖任务 7（测试完整流程）。

```
任务 1（类型定义）─────┬── 任务 5（锚点生成）──┐
任务 2（图片处理器）───┤                       ├── 任务 7（编译器集成）── 任务 8（集成测试）
任务 3（音频处理器）───┤── 任务 6（Structure）─┘
任务 4（视频处理器）───┘
```

任务 1、2、3、4 可并行。
任务 5、6 依赖任务 1。
任务 7 依赖任务 5、6。
任务 8 依赖任务 7。
