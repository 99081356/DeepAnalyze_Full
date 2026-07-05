# DeepAnalyze 知识库系统 — 测试问题修复计划

**日期**: 2026-04-14
**基于**: OpenClaw 测试报告 + 设计文档对比分析
**目标**: 修复所有 P0/P1/P2 问题，确保端到端全链路可运行

---

## 一、问题分类与系统影响分析

### 问题全景 (12个问题，按依赖关系排列)

```
P0 (阻塞启动)
  └─ #1: processing-queue.ts import 路径错误
       ↓ 修复后解锁: 整个处理管线可运行

P1 (核心功能缺失)
  ├─ #2: WS subscribe 协议不一致 (kbId vs kbIds[])
  ├─ #3: 搜索端点不支持 docIds 过滤
  └─ #8: ChatWindow 无文档引用点击跳转

P2 (体验/功能不足)
  ├─ #4: indexing 步骤为 no-op
  ├─ #5: AudioProcessor 占位逻辑
  ├─ #6: VideoProcessor VLM base64 被截断
  ├─ #7: 知识图谱视图缺失
  └─ #9: TaskPanel 缺少"全部"tab

P3 (补充)
  ├─ #10: API Client 缺少 triggerProcessing
  └─ #11: KnowledgePanel 缺少手动处理触发按钮
```

---

## 二、问题依赖关系与修改顺序

修复顺序遵循依赖链: 先修基础设施，再修功能层，最后补体验层。

```
第一批 (基础设施修复 — 解锁启动和核心管线)
  ├─ Fix #1: processing-queue.ts import 路径
  ├─ Fix #2: WS subscribe 协议统一为 kbIds[]
  └─ Fix #6: VideoProcessor base64 截断 (简单修复)

第二批 (核心功能补全)
  ├─ Fix #3: 搜索端点 docIds 过滤
  ├─ Fix #4: indexing 步骤集成 Indexer
  ├─ Fix #5: AudioProcessor Whisper API 集成
  └─ Fix #8: ChatWindow 文档引用解析+跳转

第三批 (前端体验)
  ├─ Fix #7: 知识图谱视图组件
  ├─ Fix #9: TaskPanel "全部"tab
  ├─ Fix #10: API Client triggerProcessing
  └─ Fix #11: KnowledgePanel 手动处理按钮
```

---

## 三、各问题详细修改方案

### Fix #1: processing-queue.ts import 路径错误 [P0]

**文件**: `src/services/processing-queue.ts:9-10`

**当前 (错误)**:
```typescript
import { ModelRouter } from "./models/router.js";
import { WikiCompiler } from "./wiki/compiler.js";
```

**修改为**:
```typescript
import { ModelRouter } from "../models/router.js";
import { WikiCompiler } from "../wiki/compiler.js";
```

**影响**: 修复后整个 ProcessingQueue 可加载，解锁文档处理管线。

---

### Fix #2: WS subscribe 协议统一为 kbIds[] [P1]

**涉及文件**:
- `src/server/ws.ts` — WsClientMessage 类型 + handleMessage
- `frontend/src/hooks/useWebSocket.ts` — subscribe/unsubscribe 函数
- `frontend/src/hooks/useDocProcessing.ts` — subscribe 调用

**修改方案**:

**1. `src/server/ws.ts`**:
```typescript
// WsClientMessage 改为:
type WsClientMessage =
  | { type: "subscribe"; kbIds: string[] }
  | { type: "unsubscribe"; kbIds: string[] }
  | { type: "ping" };

// handleMessage subscribe 分支:
case "subscribe": {
  if (!Array.isArray(msg.kbIds)) {
    console.warn("[WS] Subscribe message missing kbIds array");
    return;
  }
  for (const kbId of msg.kbIds) {
    state.subscriptions.add(kbId);
  }
  break;
}

// handleMessage unsubscribe 分支:
case "unsubscribe": {
  if (!Array.isArray(msg.kbIds)) return;
  for (const kbId of msg.kbIds) {
    state.subscriptions.delete(kbId);
  }
  break;
}
```

**2. `frontend/src/hooks/useWebSocket.ts`**:
```typescript
// WsClientMessage 改为:
type WsClientMessage =
  | { type: "subscribe"; kbIds: string[] }
  | { type: "unsubscribe"; kbIds: string[] }
  | { type: "ping" };

// subscribe 内部: ws.send JSON 中用 kbIds 数组
// unsubscribe 同理
```

**3. `frontend/src/hooks/useDocProcessing.ts`**:
无需改动 — 它调用 `subscribe([kbId])`，已经是传数组，只是底层 send 的 JSON 字段名变了。

---

### Fix #3: 搜索端点 docIds 过滤 [P1]

**文件**: `src/server/routes/knowledge.ts` GET `/:kbId/search`

**修改方案**:

在搜索端点增加 `docIds` query 参数支持:

```typescript
knowledgeRoutes.get("/:kbId/search", async (c) => {
  const kbId = c.req.param("kbId");
  const query = c.req.query("query") || c.req.query("q") || "";
  const topK = parseInt(c.req.query("topK") || "10", 10);
  const docIdsParam = c.req.query("docIds"); // 新增

  // ... 现有搜索逻辑 ...

  // 在返回结果前，如果 docIds 有值，过滤结果
  if (docIdsParam) {
    const allowedDocIds = new Set(docIdsParam.split(","));
    // 过滤 titleRows 和 contentMatches: 只保留 doc_id 在 allowedDocIds 中的
    // 对 doc_id 为 null 的结果(如 entity 页面)也保留
  }
});
```

**前后端联动**: KBSearchTool 的 `scope.docIds` 参数需要传递到搜索端点。
在 `src/services/agent/tool-setup.ts` 中 kb_search 工具的 execute 函数中，
将 scope.docIds 附加到搜索请求。

---

### Fix #4: indexing 步骤集成 Indexer [P1]

**文件**: `src/services/processing-queue.ts` stepIndexing 方法

**修改方案**: 导入现有 Indexer 并调用:

```typescript
private async stepIndexing(job, abortController): Promise<void> {
  const { kbId, docId, filename } = job;

  this.updateDbStatus(docId, "indexing", "indexing", 0.0);
  this.broadcast(kbId, "kb", { ... });

  // 集成现有 Indexer
  try {
    const { Indexer } = await import("../wiki/indexer.js");
    const indexer = new Indexer();
    // 为该文档的 wiki pages 生成 embeddings
    await indexer.indexDocument(kbId, docId);
  } catch (err) {
    console.warn(`[ProcessingQueue] Indexing failed for ${docId}:`, err);
    // 索引失败不阻塞管线，仅记录警告
  }

  this.updateDbStatus(docId, "indexing", "indexing", 1.0);
  this.broadcast(kbId, "kb", { ... });
}
```

**注意**: 需要先检查 `src/wiki/indexer.ts` 的 Indexer 类接口，
确认是否有 `indexDocument(kbId, docId)` 方法，或需要适配。
如果没有精确方法，可能需要调用 `indexPage()` 逐页索引。

---

### Fix #5: AudioProcessor Whisper API 集成 [P2]

**文件**: `src/services/document-processors/audio-processor.ts`

**修改方案**: 使用 OpenAI Whisper API 兼容端点:

```typescript
async parse(filePath: string): Promise<ParsedContent> {
  const duration = this.getDuration(filePath);
  const format = filePath.split(".").pop() ?? "unknown";

  let transcription = "";

  try {
    // 1. 尝试通过 enhanced model (audio_transcribe) 调用 Whisper API
    const transcription = await this.callWhisperApi(filePath);
    // ...
  } catch {
    // 2. fallback: 占位文本
    transcription = `[音频转写不可用 ...]`;
  }
}

private async callWhisperApi(filePath: string): Promise<string> {
  // 读取配置中的 audio_transcribe enhanced model
  // 使用 FormData 发送文件到 /v1/audio/transcriptions 端点
  // 返回转写文本
}
```

**实现细节**:
- 优先使用配置的 `audio_transcribe` enhanced model 端点
- 调用 `/v1/audio/transcriptions` (OpenAI Whisper API 兼容格式)
- 使用 FormData 上传音频文件
- Fallback: 如果未配置 ASR，返回描述性占位文本（现有行为）

---

### Fix #6: VideoProcessor VLM base64 截断 [P2]

**文件**: `src/services/document-processors/video-processor.ts:65`

**当前 (错误)**:
```typescript
content: `描述这个视频关键帧的内容。\n\n[图片数据: data:image/jpeg;base64,${base64.slice(0, 100)}...]`,
```

**修改为**:
```typescript
content: [
  { type: "text", text: "描述这个视频关键帧的内容，包括场景、人物、动作和文字信息。" },
  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
],
```

**同时**: 检查 `router.chat()` 是否支持多模态 content (image_url 格式)。
如果不支持，需要确认 VLM 调用路径。

---

### Fix #7: 知识图谱视图 [P2]

**文件**: 新建 `frontend/src/components/knowledge/KnowledgeGraph.tsx`

**修改方案**: 从 ReportPanel 中提取已有的 Canvas 力导向图逻辑，
创建独立组件，嵌入到 WikiBrowser 或 KnowledgePanel 中。

**涉及修改**:
- 新建 `KnowledgeGraph.tsx` — Canvas 力导向图组件
- 修改 `WikiBrowser.tsx` — 添加"图谱"视图入口
- 或修改 `KnowledgePanel.tsx` — 在 tab 中添加"图谱"

**复用 ReportPanel 的图渲染逻辑**:
- `nodeTypeColors` 映射
- 力导向模拟算法 (repulsion/attraction/damping)
- Canvas 渲染

**新增**:
- 点击节点跳转到对应 wiki 页面 (调用 navigateToWikiPage)
- 支持从后端 `GET /:kbId/graph` 获取节点和边数据

---

### Fix #8: ChatWindow 文档引用点击跳转 [P2]

**文件**: `frontend/src/components/chat/MessageItem.tsx`

**当前状态**: 已有 `onClick` 事件委托处理 `[data-doc-id]` 属性点击，
但 Agent 输出中没有生成这种格式的标记。需要在消息渲染中解析文档引用。

**修改方案**:

在 MessageItem 的 markdown 渲染后处理中，识别文档引用模式:

```typescript
// 在 MessageItem 中，对 htmlContent 做后处理
// 匹配 [[doc:docId|文档名]] 或 [[文档名]] 格式
// 替换为 <span data-doc-id="xxx" class="doc-ref">文档名</span>
```

**实现方式**:
1. 在 `useMarkdown` hook 或 MessageItem 中，对渲染后的 HTML 做 regex 替换
2. 将 `[[doc:xxx|yyy]]` 替换为可点击的 span
3. 已有的 onClick 事件委托会处理点击

---

### Fix #9: TaskPanel "全部"tab [P2]

**文件**: `frontend/src/components/tasks/TaskPanel.tsx`

**修改方案**: 添加 "全部" tab，合并显示 Agent 任务和文档处理任务:

```typescript
// tab 类型扩展:
type TaskTab = "all" | "running" | "queue" | "history";

// "全部" tab 内容:
// 按时间倒序合并 Agent 任务和文档处理任务
// Agent 任务显示: 图标 + agentType + input摘要 + 状态
// 文档处理任务显示: 文件图标 + filename + step + 进度条 + 状态
```

---

### Fix #10: API Client triggerProcessing [P3]

**文件**: `frontend/src/api/client.ts`

**修改**: 添加方法:
```typescript
async triggerProcessing(kbId: string): Promise<void> {
  await fetch(`${API_BASE}/knowledge/kbs/${kbId}/trigger-processing`, {
    method: "POST",
  });
}
```

---

### Fix #11: KnowledgePanel 手动处理触发按钮 [P3]

**文件**: `frontend/src/components/knowledge/KnowledgePanel.tsx`

**修改**: 当 KB 设置 auto_process=false 时，显示"开始处理"按钮。
需要:
1. 从后端获取 auto_process 设置 (GET /settings 或 KB 配置)
2. 条件渲染按钮
3. 调用 api.triggerProcessing(kbId)

---

## 四、修改文件清单

### 按修改批次

**第一批 (3个问题, ~5个文件)**:
| 文件 | 修改 |
|------|------|
| `src/services/processing-queue.ts` | Fix #1: 2行 import 路径修复 |
| `src/server/ws.ts` | Fix #2: 协议改为 kbIds[] |
| `frontend/src/hooks/useWebSocket.ts` | Fix #2: 协议改为 kbIds[] |
| `src/services/document-processors/video-processor.ts` | Fix #6: 完整 base64 |

**第二批 (4个问题, ~6个文件)**:
| 文件 | 修改 |
|------|------|
| `src/server/routes/knowledge.ts` | Fix #3: docIds 过滤参数 |
| `src/services/processing-queue.ts` | Fix #4: 集成 Indexer |
| `src/services/document-processors/audio-processor.ts` | Fix #5: Whisper API |
| `frontend/src/components/chat/MessageItem.tsx` | Fix #8: 文档引用解析 |

**第三批 (4个问题, ~5个文件 + 1新文件)**:
| 文件 | 修改 |
|------|------|
| `frontend/src/components/knowledge/KnowledgeGraph.tsx` | Fix #7: 新建 |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | Fix #7: 添加图谱tab |
| `frontend/src/components/tasks/TaskPanel.tsx` | Fix #9: 全部 tab |
| `frontend/src/api/client.ts` | Fix #10: triggerProcessing |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | Fix #11: 手动处理按钮 |

---

## 五、关键风险与注意事项

1. **Indexer 接口**: Fix #4 需要先阅读 `src/wiki/indexer.ts` 确认可用方法。
   如果 Indexer 没有 `indexDocument()` 方法，需要适配或新增。

2. **Whisper API 兼容性**: Fix #5 需要确认用户的模型配置中有可用的
   audio_transcribe enhanced model 端点。实现时需要 graceful fallback。

3. **VLM 多模态支持**: Fix #6 需要确认 ModelRouter.chat() 支持多模态
   content (image_url 格式)。如果不支持，需要走 enhanced model 路径。

4. **知识图谱数据来源**: Fix #7 复用 ReportPanel 的力导向图，但数据源
   不同。ReportPanel 用 `GET /:kbId/graph`，知识图谱也用同一端点。

5. **WS 协议变更兼容**: Fix #2 改为 kbIds[] 后，useDocProcessing.ts
   已经传 `[kbId]` 数组，无需改动调用方式，只需改底层 JSON 字段名。
