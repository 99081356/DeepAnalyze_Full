# 对话多媒体上传问询功能设计

## 概述

为 DA 对话界面增加多媒体（图片/视频）上传能力。用户可以在对话中上传一张或多张图片/视频，基于媒体内容向 Agent 提问。Agent 可以直接观察图片（主模型视觉能力）、结合知识库检索做对比分析、或降级使用 VLM 辅助处理。

## 需求

1. 前端支持通过附件按钮或拖拽上传多媒体文件
2. 上传的媒体在消息中内联展示（缩略图），点击可放大/播放
3. 历史消息加载时显示缩略图
4. 主模型支持视觉时直接发送图片给模型
5. 主模型不支持视觉时优雅降级到 VLM 辅助
6. 视频同理：支持则直接处理，不支持则降级或报错提示
7. 不设硬性数量/大小上限，模型报错时引导用户走知识库上传流程
8. Agent 可在知识库中检索、对比、调用 VLM 做进一步分析
9. 媒体文件存储与会话生命周期绑定

## 架构

```
用户拖入/选择文件
  ↓
POST /api/sessions/:id/media → 存储文件 + 生成缩略图 → 返回 mediaId
  ↓
用户点发送（文字 + mediaIds[]）
  ↓
POST /api/agents/run-stream { input, mediaIds }
  ↓
后端：
  1. 验证 mediaId → 读取文件路径
  2. 保存消息到 DB（content 为 JSON { text, media[] }）
  3. 检查模型能力：
     - 支持视觉 → 构建 ContentPart[]（text + image blocks）→ 发给主模型
     - 不支持   → 调用 VLM 预处理 → 将描述文本注入消息 → 发给主模型
  ↓
Agent 回复（正常 SSE 流式）
  ↓
Agent 自主决定是否调用工具：
  - kb_search / doc_grep：检索知识库相关文档
  - expand：展开知识库中的图片，获取 VLM 预编译描述
  - image_analysis：对用户上传的图片做 VLM 精细分析（支持多次调用）
```

## 数据模型

### 媒体文件存储

```
data/sessions/{sessionId}/media/
  {mediaId}/
    original.{ext}        # 原始文件
    thumbnail.webp         # 缩略图（最大 400px，仅图片生成）
    meta.json              # { mediaId, fileName, mimeType, size, width, height, createdAt }
```

- 图片上传时通过 `sharp` 生成缩略图（复用 `image-processor.ts` 的缩略图逻辑）
- 视频文件不生成缩略图，存储原始文件
- 会话删除时 media 目录随会话目录一起清理

### 消息内容格式

现有 content 字段为纯文本字符串。多媒体消息扩展为 JSON 字符串：

```json
{
  "text": "用户输入的文字内容",
  "media": [
    {
      "mediaId": "uuid",
      "fileName": "photo.png",
      "mimeType": "image/png",
      "size": 123456
    }
  ]
}
```

向后兼容：纯文本消息 content 仍为普通字符串。判断逻辑为尝试 JSON.parse，成功且含 `media` 字段则为多媒体消息。

### JSONL 记录

`user` 条目扩展以记录媒体引用：

```json
{
  "type": "user",
  "content": "对比这张图片和知识库中的文档",
  "media": [
    { "mediaId": "uuid", "mimeType": "image/png", "fileName": "photo.png" }
  ],
  "sessionId": "...",
  "uuid": "...",
  "parentUuid": "..."
}
```

恢复上下文时通过 mediaId 找到磁盘文件，重建多模态消息。文件不存在则降级为纯文本并记录警告日志。

## API 端点

### 新增：媒体上传

```
POST /api/sessions/:sessionId/media
  Body: FormData { file: File }
  Response: { mediaId, fileName, mimeType, size }

GET /api/sessions/:sessionId/media/:mediaId?type=original|thumbnail
  Response: 文件流（Content-Type + Cache-Control）
```

### 扩展：消息发送

```
POST /api/agents/run-stream
  Body: { sessionId, input: string, mediaIds?: string[], agentType?, scope? }
```

mediaIds 中的文件必须已通过 `POST /media` 上传。后端验证 mediaId 对应文件存在，不存在返回 400。

### 扩展：消息加载

```
GET /api/sessions/:id/messages
  Response 中每条消息新增 media 字段：
  {
    ...现有字段,
    media?: [{ mediaId, fileName, mimeType, size }]
  }
```

## 前端

### MessageInput 改造

- 改造现有回形针按钮：点击弹出文件选择器，接受 `image/*, video/*` 格式
- 新增拖拽支持：拖拽文件到输入框区域触发上传
- 新增粘贴支持（可选）：Ctrl+V 粘贴剪贴板图片

**预览区域**：输入框上方水平排列缩略图预览条，每个缩略图右上角有 × 移除按钮。视频显示文件名占位符。

**发送流程**：
1. 点击发送 → 并行上传所有待发送媒体（`POST /media`）
2. 获取全部 mediaId → 与文字一起发送（`POST /run-stream { input, mediaIds }`）
3. 上传失败则提示用户，不发送消息

### 类型扩展

```typescript
interface MessageInfo {
  // 现有字段不变
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  toolCalls?: ToolCallInfo[];
  // ...

  // 新增
  media?: MediaAttachment[];
}

interface MediaAttachment {
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
}
```

缩略图 URL 在渲染时动态构建：`/api/sessions/${sessionId}/media/${mediaId}?type=thumbnail`

### 消息渲染

- 用户消息中：文本下方内联渲染媒体列表
- 图片：显示缩略图（max-width 300px），点击弹出 lightbox 查看大图
- 视频：显示 `<video>` 标签，支持内联播放
- 多张媒体水平排列，超出时横向滚动
- 历史消息缩略图懒加载（进入视口时请求）
- 助手消息不变，媒体只出现在用户消息中

## 后端消息流转

### loadContextMessages 改造

从 DB 加载消息后，对每条历史消息：

```
尝试 JSON.parse(content)
  成功且有 media 字段：
    检查模型 supportsVision / supportsVideo
      支持 → 读取文件 → base64 编码 → 构建 ContentPart[]
      不支持 → 调用 VLM 预处理 → 将描述文本作为替代
  否则：
    保持纯文本
```

### Agent Runner 改造

`buildMessages()` 的 `input` 参数扩展：

```typescript
// 现有
input: string

// 改为
input: string | { text: string; media: MediaRef[] }

interface MediaRef {
  mediaId: string;
  mimeType: string;
  filePath: string;
}
```

### 模型能力检测

在 `provider-registry.ts` 的 `ModelMeta` 中新增：

```typescript
interface ModelMeta {
  supportsVision: boolean;   // 已有
  supportsVideo: boolean;    // 新增
}
```

## 降级策略

```
用户消息携带媒体
  ↓
检查模型能力：
  图片 + supportsVision → 直接构建多模态消息
  视频 + supportsVideo  → 直接构建多模态消息
  不支持当前媒体类型 →
    1. 调用 VLM（CapabilityDispatcher.analyzeImage）预处理
    2. VLM 文字描述注入用户消息
    3. 主模型基于描述继续工作
    4. Agent 可通过 image_analysis 工具多次调用 VLM 进一步分析
  VLM 也不可用 →
    返回提示："当前模型不支持媒体处理，请检查模型配置或使用知识库上传"
```

模型 API 报错（内容过多等）时捕获错误，提示用户："媒体内容过多，建议将文件上传到知识库后再进行分析"

## Agent 工具联动

### 三层工作方式

1. **主模型直接理解**：视觉能力模型直接看到图片内容，无需额外工具
2. **知识库检索与对比**：Agent 使用现有工具链（kb_search, doc_grep, expand）检索知识库，与图片内容对比
3. **VLM 辅助分析**：Agent 通过 `image_analysis` 工具对图片做精细分析，支持多次调用不同 prompt

### image_analysis 工具扩展

新增输入格式 `session-media://{sessionId}/{mediaId}`，工具实现检测到此前缀时从 `data/sessions/{sessionId}/media/{mediaId}/` 读取文件。

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 模型不支持视觉 + VLM 不可用 | 返回提示，建议检查配置或使用知识库 |
| 模型不支持视频 + 无 video_understand | 返回提示，说明不支持视频处理 |
| VLM 调用超时/失败 | 告知用户分析失败，继续处理文字部分，不阻塞对话 |
| 模型报错（内容过大） | 提示用户走知识库上传流程 |
| mediaId 无效（文件不存在） | 返回 400 媒体文件不存在 |
| JSONL 恢复时文件丢失 | 降级为纯文本，日志警告 |

## 兼容性

- 无媒体消息：content 为纯字符串，完全向后兼容
- 旧会话：无 media 目录，不影响加载
- 前端旧版本：忽略 media 字段，只显示文字
- 不修改现有 SSE 事件格式
