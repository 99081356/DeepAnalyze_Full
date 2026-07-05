# Chat Media Upload 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DA 对话界面中支持上传图片/视频文件，用户基于媒体内容向 Agent 提问，Agent 可直接看图或降级使用 VLM 辅助分析。

**Architecture:** 会话级媒体文件独立存储（`data/sessions/{id}/media/`），消息通过 mediaId 引用媒体文件。主模型支持视觉时直接发送多模态内容，不支持时降级到 VLM 预处理。前端通过新 API 端点上传媒体，内联渲染缩略图。

**Tech Stack:** Sharp（缩略图生成）、Hono（后端 API）、Zustand（前端状态）、Anthropic SDK（多模态消息）

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/session/media-store.ts` | Create | 媒体文件存储/读取/清理 |
| `src/server/routes/sessions.ts` | Modify | 新增媒体上传/下载端点，消息加载扩展 |
| `src/server/routes/agents.ts` | Modify | RunRequest 扩展 mediaIds，上下文加载扩展 |
| `src/services/agent/agent-runner.ts` | Modify | buildMessages 支持多模态内容 |
| `src/services/agent/types.ts` | Modify | AgentRunOptions 新增 mediaAttachments |
| `src/models/provider-registry.ts` | Modify | 新增 getSupportsVision helper |
| `src/services/agent/tool-setup.ts` | Modify | image_analysis 工具支持 session-media:// |
| `frontend/src/types/index.ts` | Modify | 新增 MediaAttachment 类型 |
| `frontend/src/api/client.ts` | Modify | 新增 uploadSessionMedia，runAgentStream 扩展 |
| `frontend/src/components/chat/MessageInput.tsx` | Modify | 媒体上传预览 + 发送逻辑 |
| `frontend/src/components/chat/MessageItem.tsx` | Modify | 用户消息内联渲染媒体 |
| `frontend/src/components/chat/MediaPreview.tsx` | Create | 媒体缩略图/视频播放组件 |
| `frontend/src/components/chat/MediaLightbox.tsx` | Create | 大图查看弹窗 |
| `frontend/src/hooks/useChatMedia.ts` | Create | 聊天媒体上传状态管理 hook |

---

## Phase 1: 后端 — 媒体存储服务

### Task 1: 创建 MediaStore 服务

**Files:**
- Create: `src/services/session/media-store.ts`

- [ ] **Step 1: 创建 MediaStore 类**

```typescript
// src/services/session/media-store.ts
import { mkdir, writeFile, readFile, rm, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { randomUUID } from "crypto";

export interface MediaMeta {
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface MediaRef {
  mediaId: string;
  mimeType: string;
  fileName: string;
  size: number;
}

const MEDIA_DIR = "media";

function getMediaDir(sessionId: string): string {
  return join(process.cwd(), "data", "sessions", sessionId, MEDIA_DIR);
}

function getMediaItemDir(sessionId: string, mediaId: string): string {
  return join(getMediaDir(sessionId), mediaId);
}

export class MediaStore {
  /**
   * 保存上传的媒体文件，生成缩略图（图片），返回元数据。
   */
  static async save(
    sessionId: string,
    file: { name: string; type: string; data: Buffer },
  ): Promise<MediaMeta> {
    const mediaId = randomUUID();
    const itemDir = getMediaItemDir(sessionId, mediaId);
    await mkdir(itemDir, { recursive: true });

    // Determine extension
    const ext = file.name.includes(".") ? file.name.split(".").pop()! : "bin";
    const originalPath = join(itemDir, `original.${ext}`);

    // Write original file
    await writeFile(originalPath, file.data);

    const meta: MediaMeta = {
      mediaId,
      fileName: file.name,
      mimeType: file.type,
      size: file.data.length,
      createdAt: new Date().toISOString(),
    };

    // Generate thumbnail for images
    if (file.type.startsWith("image/")) {
      try {
        const thumbnailPath = join(itemDir, "thumbnail.webp");
        const image = sharp(file.data);
        const metadata = await image.metadata();
        meta.width = metadata.width;
        meta.height = metadata.height;

        await image
          .resize(400, undefined, { withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(thumbnailPath);
      } catch {
        // Thumbnail generation failed — non-fatal
      }
    }

    // Write metadata
    await writeFile(join(itemDir, "meta.json"), JSON.stringify(meta, null, 2));

    return meta;
  }

  /**
   * 读取媒体元数据。
   */
  static async getMeta(sessionId: string, mediaId: string): Promise<MediaMeta | null> {
    const metaPath = join(getMediaItemDir(sessionId, mediaId), "meta.json");
    if (!existsSync(metaPath)) return null;
    const content = await readFile(metaPath, "utf-8");
    return JSON.parse(content);
  }

  /**
   * 读取原始文件。
   */
  static async readOriginal(
    sessionId: string,
    mediaId: string,
  ): Promise<{ data: Buffer; mimeType: string; fileName: string } | null> {
    const itemDir = getMediaItemDir(sessionId, mediaId);
    const meta = await this.getMeta(sessionId, mediaId);
    if (!meta) return null;

    // Find the original file (extension may vary)
    const files = await readdir(itemDir);
    const originalFile = files.find((f) => f.startsWith("original."));
    if (!originalFile) return null;

    const data = await readFile(join(itemDir, originalFile));
    return { data, mimeType: meta.mimeType, fileName: meta.fileName };
  }

  /**
   * 读取缩略图。
   */
  static async readThumbnail(
    sessionId: string,
    mediaId: string,
  ): Promise<Buffer | null> {
    const thumbnailPath = join(getMediaItemDir(sessionId, mediaId), "thumbnail.webp");
    if (!existsSync(thumbnailPath)) return null;
    return readFile(thumbnailPath);
  }

  /**
   * 检查媒体是否存在。
   */
  static exists(sessionId: string, mediaId: string): boolean {
    return existsSync(getMediaItemDir(sessionId, mediaId));
  }

  /**
   * 将媒体转为 base64 data URI（用于发送给模型）。
   */
  static async toDataUri(
    sessionId: string,
    mediaId: string,
  ): Promise<string | null> {
    const result = await this.readOriginal(sessionId, mediaId);
    if (!result) return null;
    const base64 = result.data.toString("base64");
    return `data:${result.mimeType};base64,${base64}`;
  }

  /**
   * 清理会话的所有媒体文件。
   */
  static async cleanupSession(sessionId: string): Promise<void> {
    const dir = getMediaDir(sessionId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/session/media-store.ts
git commit -m "feat: add MediaStore service for session media files"
```

---

### Task 2: 新增媒体 API 端点

**Files:**
- Modify: `src/server/routes/sessions.ts`

- [ ] **Step 1: 在 sessions.ts 顶部添加 MediaStore 导入**

在 `src/server/routes/sessions.ts` 文件顶部的导入区域添加：

```typescript
import { MediaStore } from "../../services/session/media-store.js";
```

- [ ] **Step 2: 添加媒体上传端点**

在 `src/server/routes/sessions.ts` 中，找到现有的 sessionRoutes 定义，在 session 创建端点之后（约 line 50 之前，即 `sessionRoutes.get("/:id/messages"` 之前）添加三个新端点：

```typescript
// POST /:id/media - Upload media file for a session
sessionRoutes.post("/:id/media", async (c) => {
  const id = c.req.param("id");
  const repos = await getRepos();
  const session = await repos.session.get(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const meta = await MediaStore.save(id, {
    name: file.name,
    type: file.type,
    data: buffer,
  });

  return c.json({
    mediaId: meta.mediaId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    size: meta.size,
  }, 201);
});

// GET /:id/media/:mediaId - Serve media file
sessionRoutes.get("/:id/media/:mediaId", async (c) => {
  const sessionId = c.req.param("id");
  const mediaId = c.req.param("mediaId");
  const type = c.req.query("type") || "original";

  if (type === "thumbnail") {
    const thumbnail = await MediaStore.readThumbnail(sessionId, mediaId);
    if (!thumbnail) {
      return c.json({ error: "Thumbnail not found" }, 404);
    }
    return new Response(thumbnail, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  // Original file
  const result = await MediaStore.readOriginal(sessionId, mediaId);
  if (!result) {
    return c.json({ error: "Media not found" }, 404);
  }

  return new Response(result.data, {
    headers: {
      "Content-Type": result.mimeType,
      "Cache-Control": "public, max-age=86400",
      "Content-Disposition": `inline; filename="${result.fileName}"`,
    },
  });
});
```

- [ ] **Step 3: 扩展消息加载端点以包含媒体信息**

在 `src/server/routes/sessions.ts` 的 `GET /:id/messages` 处理器中（约 line 58），消息列表获取后（`const messages = await repos.message.list(id);`），在 enrichment 循环中添加媒体解析。找到现有的 enrichment 循环（约 line 61），在返回前添加媒体解析逻辑：

在 enrichment 处理中（`const enriched = await Promise.all(...)` 之前或其 map 函数内部），对每条用户消息尝试解析 content 中的媒体信息：

在 `const enriched = await Promise.all(messages.map(async (msg) => {` 内部、return 语句之前，添加：

```typescript
    // Parse media attachments from content
    let mediaAttachments = undefined;
    if (msg.role === "user" && msg.content && typeof msg.content === "string") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.media && Array.isArray(parsed.media)) {
          mediaAttachments = parsed.media;
        }
      } catch {
        // Not JSON — plain text message, no media
      }
    }

    // Include media in result if present
    if (mediaAttachments) {
      result.media = mediaAttachments;
    }
```

并在 enrichment 循环最后的 return 语句中，将 `media` 包含在返回对象中。修改：
```typescript
return Object.keys(result).length > 0 ? { ...msg, ...result } : msg;
```
确保 `media` 字段通过 `result` 传递。

- [ ] **Step 4: 在会话删除中添加媒体清理**

在 `src/server/routes/sessions.ts` 的 `DELETE /:id` 处理器中（约 line 186-206），找到 `rm(sessionDir, ...)` 调用。因为 media 目录在 `data/sessions/{id}/media/` 下，而 `sessionDir` 是 `data/sessions/{id}`，所以 `rm(sessionDir, { recursive: true })` 已经会清理 media 目录。确认这一点即可，无需额外代码。但如果 sessionDir 不包含 media 子目录，需添加：

找到删除处理中的 `rm(sessionDir, { recursive: true, force: true })` 调用之前，添加注释确认 media 目录已被包含：
```typescript
// media/ directory is under sessionDir, so it's cleaned up automatically
```

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/sessions.ts
git commit -m "feat: add media upload/serve API endpoints to sessions"
```

---

## Phase 2: 后端 — 消息流转扩展

### Task 3: 扩展 RunRequest 和消息保存

**Files:**
- Modify: `src/server/routes/agents.ts`

- [ ] **Step 1: 扩展 RunRequest 类型**

在 `src/server/routes/agents.ts` 找到 `RunRequest` 接口定义（约 line 44-49），添加 mediaIds 字段：

```typescript
interface RunRequest {
  sessionId: string;
  input: string;
  mediaIds?: string[];  // 新增
  agentType?: string;
  maxTurns?: number;
  scope?: Record<string, unknown>;
}
```

- [ ] **Step 2: 验证 mediaIds 并保存带媒体引用的消息**

在 `POST /run-stream` 处理器中，找到保存用户消息的代码（约 line 298）：
```typescript
await repos.message.create(body.sessionId, "user", body.input);
```

将其替换为：

```typescript
// Build message content — include media references if present
let messageContent: string = body.input;
if (body.mediaIds && body.mediaIds.length > 0) {
  // Validate all mediaIds exist
  const mediaRefs: Array<{ mediaId: string; mimeType: string; fileName: string; size: number }> = [];
  for (const mediaId of body.mediaIds) {
    const meta = await MediaStore.getMeta(body.sessionId, mediaId);
    if (!meta) {
      return c.json({ error: `Media file not found: ${mediaId}` }, 400);
    }
    mediaRefs.push({
      mediaId: meta.mediaId,
      mimeType: meta.mimeType,
      fileName: meta.fileName,
      size: meta.size,
    });
  }
  messageContent = JSON.stringify({ text: body.input, media: mediaRefs });
}
await repos.message.create(body.sessionId, "user", messageContent);
```

同时在文件顶部添加导入：
```typescript
import { MediaStore } from "../../services/session/media-store.js";
```

- [ ] **Step 3: 将媒体信息传递给 Agent Runner**

在 `POST /run-stream` 处理器中，找到构建 runOptions 的位置（约 line 603），添加 mediaAttachments：

```typescript
const runOptions = {
  input: body.input,
  agentType: body.agentType || "general",
  taskId,
  sessionId: body.sessionId,
  mediaIds: body.mediaIds,  // 新增
  // ... 其余现有字段
};
```

- [ ] **Step 4: JSONL 记录用户消息时包含媒体**

在 agents.ts 中找到 JSONL 写入用户消息的位置。如果 JSONL writer 在 agent-runner 的 run() 方法中写入用户消息，需要在那里也传入媒体信息。具体位置：在 `jsonlWriter?.append({ type: "user", content: ..., sessionId })` 调用处，扩展为包含 media 字段。

如果用户消息的 JSONL 写入在 agents.ts 路由层（而非 agent-runner），则在 agents.ts 中追加 JSONL user entry 时包含 media：

找到 agents.ts 中写入 JSONL user entry 的位置（如果存在），修改 content 为包含 media 的完整内容。如果 JSONL writer 只在 agent-runner 中写入，则在 agent-runner 的 run() 方法中处理。

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/agents.ts
git commit -m "feat: extend RunRequest with mediaIds, save media refs in messages"
```

---

### Task 4: 扩展 AgentRunOptions 和上下文加载

**Files:**
- Modify: `src/services/agent/types.ts`
- Modify: `src/server/routes/agents.ts` (loadContextMessages)

- [ ] **Step 1: 扩展 AgentRunOptions**

在 `src/services/agent/types.ts` 找到 `AgentRunOptions` 接口（约 line 187-220），添加 mediaIds 和 mediaAttachments 字段：

```typescript
export interface AgentRunOptions {
  // ... 现有字段 ...
  mediaIds?: string[];      // 新增：上传的媒体 ID 列表
  // ... 其余现有字段 ...
}
```

- [ ] **Step 2: 扩展 loadContextMessages 以解析多媒体消息**

在 `src/server/routes/agents.ts` 中找到 `loadContextMessages` 函数（约 line 98-188）。此函数从 DB 加载消息并返回 `Array<{ role: "user" | "assistant"; content: string }>`。

需要修改返回类型以支持多模态内容，并在解析消息时处理媒体引用。

修改函数签名和返回类型：

```typescript
async function loadContextMessages(
  orchestrator: Orchestrator,
  sessionId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>>
```

在消息遍历逻辑中（DB fallback 部分），对每条消息尝试解析媒体：

```typescript
// 在遍历消息构建 contextMessages 的循环中，对 user 消息：
if (msg.role === "user") {
  try {
    const parsed = JSON.parse(msg.content);
    if (parsed.media && Array.isArray(parsed.media)) {
      // 多媒体消息 — 暂时传递完整 JSON 字符串，由 agent-runner 解析
      // 因为需要知道当前模型是否支持视觉才能决定如何构建
      contextMessages.push({ role: "user", content: msg.content });
      continue;
    }
  } catch {}
  contextMessages.push({ role: "user", content: msg.content });
}
```

注意：实际的媒体到 ContentPart 转换在 AgentRunner.buildMessages 中完成，因为那时才知道模型能力。loadContextMessages 只需保留完整的 content（JSON 字符串或纯文本）。

- [ ] **Step 3: Commit**

```bash
git add src/services/agent/types.ts src/server/routes/agents.ts
git commit -m "feat: extend AgentRunOptions and context loading for media"
```

---

### Task 5: Agent Runner 多模态消息构建 + VLM 降级

**Files:**
- Modify: `src/services/agent/agent-runner.ts`
- Modify: `src/models/provider-registry.ts`

- [ ] **Step 1: 在 provider-registry 添加 getSupportsVision helper**

在 `src/models/provider-registry.ts` 中（约 line 416-433 区域，已有 `getContextWindowForModel` 等函数的位置），添加：

```typescript
export function getSupportsVision(modelId: string): boolean {
  const model = PROVIDER_REGISTRY[modelId];
  return model?.supportsVision ?? false;
}
```

- [ ] **Step 2: 在 AgentRunner.run() 中解析媒体附件**

在 `src/services/agent/agent-runner.ts` 的 `run()` 方法中（约 line 1152 起），在调用 `buildMessages()` 之前，解析 options 中的媒体信息。

找到 run() 方法中调用 `buildMessages()` 的位置（约 line 1399-1404 附近）。在调用之前添加媒体解析逻辑：

```typescript
// Resolve media attachments if present
let mediaRefs: Array<{ mediaId: string; mimeType: string; dataUri: string }> = [];
if (options.sessionId && options.mediaIds && options.mediaIds.length > 0) {
  const { MediaStore } = await import("../session/media-store.js");
  for (const mediaId of options.mediaIds) {
    const dataUri = await MediaStore.toDataUri(options.sessionId, mediaId);
    if (dataUri) {
      const meta = await MediaStore.getMeta(options.sessionId, mediaId);
      mediaRefs.push({ mediaId, mimeType: meta!.mimeType, dataUri });
    }
  }
}
```

将 `mediaRefs` 传递给 `buildMessages()` 调用。

- [ ] **Step 3: 修改 buildMessages 支持多模态输入**

修改 `buildMessages` 方法签名，添加 mediaRefs 参数：

```typescript
private buildMessages(
  systemPrompt: string,
  input: string,
  contextMessages: Array<{ role: "user" | "assistant"; content: string }> | undefined,
  lang: DetectedLanguage = "zh",
  mediaRefs?: Array<{ mediaId: string; mimeType: string; dataUri: string }>,
  modelId?: string,
): ChatMessage[]
```

在构建用户消息的位置（约 line 3384-3393），如果 mediaRefs 非空且模型支持视觉，构建多模态消息：

```typescript
// Build user input message
const userContentParts: ContentPart[] = [];

// Add media content if present and model supports vision
if (mediaRefs && mediaRefs.length > 0 && modelId) {
  const { getSupportsVision } = await import("../../models/provider-registry.js");
  const hasVision = getSupportsVision(modelId);

  if (hasVision) {
    // Model supports vision — send media inline
    for (const ref of mediaRefs) {
      if (ref.mimeType.startsWith("image/")) {
        // Convert data URI to base64 block for Anthropic API
        const base64Data = ref.dataUri.split(",")[1];
        userContentParts.push({
          type: "image",
          source: {
            type: "base64",
            media_type: ref.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: base64Data,
          },
        } as any);  // ContentPart 扩展前需要 as any
      }
      // Video support: if model supports video, add video blocks
    }
  } else {
    // Model doesn't support vision — VLM fallback handled below
  }
}

// Add text content
const textContent = framedInput || input;
if (userContentParts.length > 0) {
  userContentParts.push({ type: "text", text: textContent });
  messages.push({ role: "user", content: userContentParts as any });
} else {
  messages.push({ role: "user", content: textContent });
}
```

- [ ] **Step 4: 添加 VLM 降级处理**

在 buildMessages 中的 `else` 分支（模型不支持视觉时），调用 VLM 预处理：

```typescript
if (!hasVision && mediaRefs && mediaRefs.length > 0) {
  // VLM fallback: analyze images with VLM and inject descriptions
  const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
  const dispatcher = new CapabilityDispatcher();
  const descriptions: string[] = [];

  for (const ref of mediaRefs) {
    if (ref.mimeType.startsWith("image/")) {
      try {
        const result = await dispatcher.analyzeImage(
          ref.dataUri,
          "请详细描述这张图片的内容，包括所有可见的文本、数据、图表、物体等。",
          { signal: AbortSignal.timeout(60_000) },
        );
        descriptions.push(`[图片 ${ref.mediaId.slice(0, 8)} 描述]: ${result.content}`);
      } catch (err) {
        descriptions.push(`[图片 ${ref.mediaId.slice(0, 8)} 描述获取失败]`);
      }
    }
  }

  if (descriptions.length > 0) {
    const enrichedInput = `${descriptions.join("\n\n")}\n\n用户问题：${textContent}`;
    messages.push({ role: "user", content: enrichedInput });
  } else {
    messages.push({ role: "user", content: textContent });
  }
}
```

- [ ] **Step 5: 扩展 JSONL 用户消息记录**

在 `src/services/agent/agent-runner.ts` 中找到 JSONL writer 写入用户消息的位置（run() 方法开头附近，`jsonlWriter?.append({ type: "user", ...})`）。扩展以包含媒体信息：

```typescript
jsonlWriter?.append({
  type: "user",
  content: options.input,
  media: options.mediaIds?.map(id => ({ mediaId: id })),
  sessionId: options.sessionId,
});
```

- [ ] **Step 6: Commit**

```bash
git add src/services/agent/agent-runner.ts src/models/provider-registry.ts
git commit -m "feat: agent runner multimodal message building with VLM fallback"
```

---

### Task 6: image_analysis 工具支持 session-media://

**Files:**
- Modify: `src/services/agent/tool-setup.ts`

- [ ] **Step 1: 在 image_analysis 工具的 execute 函数中添加 session-media:// 支持**

在 `src/services/agent/tool-setup.ts` 中找到 `image_analysis` 工具的注册代码（约 line 857-960）。在 execute 函数内部的图片引用解析区域（约 line 899-949），在现有的 `kb://` 检测之前添加 `session-media://` 的处理：

```typescript
// session-media://{sessionId}/{mediaId} — chat session media
if (imageRef.startsWith("session-media://")) {
  const path = imageRef.slice("session-media://".length);
  const [sessionId, mediaId] = path.split("/");
  if (!sessionId || !mediaId) {
    return { content: `无效的 session-media 引用格式: ${imageRef}` };
  }
  const { MediaStore } = await import("../../services/session/media-store.js");
  const dataUri = await MediaStore.toDataUri(sessionId, mediaId);
  if (!dataUri) {
    return { content: `找不到媒体文件: ${imageRef}` };
  }
  imageDataUrl = dataUri;
}
```

- [ ] **Step 2: 更新工具描述**

在 image_analysis 工具的 description 字符串中，在支持的引用格式列表中添加 `session-media://{sessionId}/{mediaId}`。

- [ ] **Step 3: Commit**

```bash
git add src/services/agent/tool-setup.ts
git commit -m "feat: image_analysis tool supports session-media:// references"
```

---

## Phase 3: 前端 — 类型、API、上传交互

### Task 7: 扩展前端类型和 API Client

**Files:**
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: 添加 MediaAttachment 类型到 frontend/src/types/index.ts**

在 `frontend/src/types/index.ts` 中（约 line 57 之后，`MessageInfo` 接口之后），添加：

```typescript
export interface MediaAttachment {
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
}
```

修改 `MessageInfo` 接口，添加 `media` 字段：

```typescript
export interface MessageInfo {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  report?: ChatReportData;
  pushedContents?: PushedContent[];
  thinkingContent?: string;
  media?: MediaAttachment[];  // 新增
}
```

- [ ] **Step 2: 扩展 API Client**

在 `frontend/src/api/client.ts` 中：

**2a. 添加 uploadSessionMedia 方法**

在现有方法区域（约 line 448 之后）添加：

```typescript
uploadSessionMedia: async (sessionId: string, file: File): Promise<{
  mediaId: string;
  fileName: string;
  mimeType: string;
  size: number;
}> => {
  const formData = new FormData();
  formData.append("file", file);
  const resp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media`, {
    method: "POST",
    body: formData,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Media upload failed: ${err}`);
  }
  return resp.json();
},
```

**2b. 扩展 runAgentStream 的请求体**

在 `runAgentStream` 函数中（约 line 120-124），修改 body 构建以包含 mediaIds：

```typescript
runAgentStream: (
  sessionId: string,
  input: string,
  agentType?: string,
  callbacks?: { /* 现有 callbacks */ },
  scope?: AnalysisScope,
  mediaIds?: string[],  // 新增参数
) => {
  // ...
  body: JSON.stringify({ sessionId, input, agentType, scope, mediaIds }),
```

注意：这需要调整整个 `runAgentStream` 的参数签名。如果改参数签名影响面太大，也可以通过 options 对象传递。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/api/client.ts
git commit -m "feat: extend frontend types and API client for media support"
```

---

### Task 8: 创建 useChatMedia Hook

**Files:**
- Create: `frontend/src/hooks/useChatMedia.ts`

- [ ] **Step 1: 创建 useChatMedia hook**

```typescript
// frontend/src/hooks/useChatMedia.ts
import { useState, useCallback } from "react";
import { api } from "../api/client.js";

export interface PendingMedia {
  id: string;
  file: File;
  previewUrl: string;  // 本地 blob URL for 预览
  status: "pending" | "uploading" | "done" | "error";
  mediaId?: string;    // 上传成功后的服务器端 ID
  error?: string;
  progress?: number;
}

let nextId = 0;

export function useChatMedia() {
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newMedia: PendingMedia[] = Array.from(files).map((file) => ({
      id: `pending-${nextId++}`,
      file,
      previewUrl: URL.createObjectURL(file),
      status: "pending" as const,
    }));
    setPendingMedia((prev) => [...prev, ...newMedia]);
  }, []);

  const remove = useCallback((id: string) => {
    setPendingMedia((prev) => {
      const item = prev.find((m) => m.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((m) => m.id !== id);
    });
  }, []);

  const uploadAll = useCallback(async (sessionId: string): Promise<string[]> => {
    const toUpload = pendingMedia.filter((m) => m.status === "pending" || m.status === "error");

    for (const media of toUpload) {
      setPendingMedia((prev) =>
        prev.map((m) => m.id === media.id ? { ...m, status: "uploading" as const } : m),
      );
      try {
        const result = await api.uploadSessionMedia(sessionId, media.file);
        setPendingMedia((prev) =>
          prev.map((m) => m.id === media.id ? { ...m, status: "done" as const, mediaId: result.mediaId } : m),
        );
      } catch (err) {
        setPendingMedia((prev) =>
          prev.map((m) => m.id === media.id ? { ...m, status: "error" as const, error: String(err) } : m),
        );
      }
    }

    // Return mediaIds of successfully uploaded items
    return pendingMedia
      .filter((m) => m.status === "done" && m.mediaId)
      .map((m) => m.mediaId!);
  }, [pendingMedia]);

  const clearDone = useCallback(() => {
    setPendingMedia((prev) => {
      const done = prev.filter((m) => m.status === "done");
      done.forEach((m) => URL.revokeObjectURL(m.previewUrl));
      return prev.filter((m) => m.status !== "done");
    });
  }, []);

  const clearAll = useCallback(() => {
    pendingMedia.forEach((m) => URL.revokeObjectURL(m.previewUrl));
    setPendingMedia([]);
  }, [pendingMedia]);

  const hasPending = pendingMedia.some(
    (m) => m.status === "pending" || m.status === "uploading",
  );
  const mediaIds = pendingMedia
    .filter((m) => m.status === "done" && m.mediaId)
    .map((m) => m.mediaId!);

  return {
    pendingMedia,
    addFiles,
    remove,
    uploadAll,
    clearDone,
    clearAll,
    hasPending,
    mediaIds,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useChatMedia.ts
git commit -m "feat: add useChatMedia hook for media upload state management"
```

---

### Task 9: 改造 MessageInput 组件

**Files:**
- Modify: `frontend/src/components/chat/MessageInput.tsx`

- [ ] **Step 1: 集成 useChatMedia hook**

在 `MessageInput.tsx` 中，替换现有的 `useFileUpload` hook 为 `useChatMedia`，或两者并存（如果 KB 文件上传功能仍需保留）。

在组件内部（约 line 19），添加 `useChatMedia` hook：

```typescript
const { pendingMedia, addFiles, remove, uploadAll, clearDone, clearAll, hasPending, mediaIds } = useChatMedia();
```

- [ ] **Step 2: 修改回形针按钮只接受图片/视频**

修改现有的回形针按钮（约 line 125-152），将 `selectFiles(...)` 的 accept 参数从当前的广泛格式改为：

```typescript
selectFiles("image/*,video/*,.mp4,.webm,.mov,.avi,.mkv")
```

或者如果用 `useChatMedia`，直接用新的 addFiles：

```typescript
// 回形针按钮的 onClick
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.multiple = true;
fileInput.accept = "image/*,video/*,.mp4,.webm,.mov,.avi,.mkv";
fileInput.onchange = (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files) addFiles(files);
};
fileInput.click();
```

- [ ] **Step 3: 修改发送逻辑**

修改 `handleSend` 回调（约 line 44-86）。在发送前先上传所有待发送媒体：

```typescript
const handleSend = useCallback(async () => {
  const content = text.trim();
  if (!content && pendingMedia.length === 0) return;

  setText("");

  // Upload pending media first
  let uploadedMediaIds: string[] = [];
  if (pendingMedia.length > 0 && currentSessionId) {
    uploadedMediaIds = await uploadAll(currentSessionId);
    if (uploadedMediaIds.length === 0 && pendingMedia.some(m => m.status === "error")) {
      // All uploads failed — show error, don't send
      setText(content);
      return;
    }
  }

  clearDone();

  if (isAgentRunning) {
    injectMessage(content);
  } else {
    sendMessage(content, scope, uploadedMediaIds.length > 0 ? uploadedMediaIds : undefined);
  }
}, [text, pendingMedia, currentSessionId, scope, isAgentRunning, sendMessage, injectMessage, uploadAll, clearDone]);
```

- [ ] **Step 4: 修改预览区域**

将现有的 `<FilePreview>` 区域（约 line 253-269）替换为媒体缩略图预览：

```tsx
{pendingMedia.length > 0 && (
  <div className="flex gap-2 p-2 overflow-x-auto">
    {pendingMedia.map((media) => (
      <div key={media.id} className="relative group flex-shrink-0">
        {media.file.type.startsWith("image/") ? (
          <img
            src={media.previewUrl}
            alt={media.file.name}
            className="h-20 w-20 object-cover rounded border border-border"
          />
        ) : (
          <div className="h-20 w-20 flex items-center justify-center rounded border border-border bg-muted text-xs text-center p-1">
            {media.file.name}
          </div>
        )}
        {media.status === "uploading" && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center rounded">
            <span className="text-white text-xs">上传中...</span>
          </div>
        )}
        {media.status === "error" && (
          <div className="absolute inset-0 bg-red-500/30 flex items-center justify-center rounded">
            <span className="text-white text-xs">失败</span>
          </div>
        )}
        <button
          onClick={() => remove(media.id)}
          className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ×
        </button>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/chat/MessageInput.tsx
git commit -m "feat: MessageInput supports media upload and inline preview"
```

---

### Task 10: 扩展 Chat Store 的 sendMessage

**Files:**
- Modify: `frontend/src/store/chat.ts`

- [ ] **Step 1: 修改 sendMessage 签名**

在 `frontend/src/store/chat.ts` 中找到 `sendMessage` 定义（约 line 311），扩展参数：

```typescript
sendMessage: async (content: string, scope?: AnalysisScope, mediaIds?: string[]) => {
```

- [ ] **Step 2: 传递 mediaIds 到 API 调用**

在 `sendMessage` 实现中找到调用 `api.runAgentStream(...)` 的位置，添加 `mediaIds` 参数。

现有调用类似：
```typescript
api.runAgentStream(id, content, undefined, callbacks, scope);
```

修改为：
```typescript
api.runAgentStream(id, content, undefined, callbacks, scope, mediaIds);
```

- [ ] **Step 3: 构建乐观用户消息时包含媒体信息**

在 `sendMessage` 中创建乐观用户消息的地方，如果有 mediaIds，将 content 格式化为包含 media 引用的结构。注意：乐观消息的 content 在前端展示时需要特殊处理（显示图片而不是 JSON）。

建议：乐观用户消息直接存储原始文本，media 信息存到单独字段。在消息对象中添加临时 `pendingMediaIds` 字段，待服务端确认后替换为完整 media 对象。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/store/chat.ts
git commit -m "feat: chat store sendMessage supports mediaIds parameter"
```

---

## Phase 4: 前端 — 媒体渲染

### Task 11: 创建 MediaPreview 和 MediaLightbox 组件

**Files:**
- Create: `frontend/src/components/chat/MediaPreview.tsx`
- Create: `frontend/src/components/chat/MediaLightbox.tsx`

- [ ] **Step 1: 创建 MediaPreview 组件**

```tsx
// frontend/src/components/chat/MediaPreview.tsx
import { useState } from "react";
import type { MediaAttachment } from "../../types/index.js";

interface MediaPreviewProps {
  media: MediaAttachment[];
  sessionId: string;
}

export function MediaPreview({ media, sessionId }: MediaPreviewProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (!media || media.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2">
        {media.map((item, index) => {
          const thumbnailUrl = `/api/sessions/${sessionId}/media/${item.mediaId}?type=thumbnail`;
          const originalUrl = `/api/sessions/${sessionId}/media/${item.mediaId}?type=original`;

          if (item.mimeType.startsWith("image/")) {
            return (
              <img
                key={item.mediaId}
                src={thumbnailUrl}
                alt={item.fileName}
                className="max-w-[200px] max-h-[150px] object-cover rounded cursor-pointer hover:opacity-80 transition-opacity border border-border"
                onClick={() => setLightboxIndex(index)}
                loading="lazy"
              />
            );
          }

          if (item.mimeType.startsWith("video/")) {
            return (
              <video
                key={item.mediaId}
                src={originalUrl}
                controls
                className="max-w-[300px] max-h-[200px] rounded border border-border"
                preload="metadata"
              />
            );
          }

          // Fallback for other types
          return (
            <div
              key={item.mediaId}
              className="px-3 py-2 rounded border border-border bg-muted text-sm"
            >
              {item.fileName}
            </div>
          );
        })}
      </div>

      {lightboxIndex !== null && (
        <MediaLightbox
          media={media}
          sessionId={sessionId}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: 创建 MediaLightbox 组件**

```tsx
// frontend/src/components/chat/MediaLightbox.tsx
import { useState, useEffect } from "react";
import type { MediaAttachment } from "../../types/index.js";

interface MediaLightboxProps {
  media: MediaAttachment[];
  sessionId: string;
  initialIndex: number;
  onClose: () => void;
}

export function MediaLightbox({ media, sessionId, initialIndex, onClose }: MediaLightboxProps) {
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      if (e.key === "ArrowRight" && index < media.length - 1) setIndex(index + 1);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [index, media.length, onClose]);

  const item = media[index];
  if (!item) return null;

  const originalUrl = `/api/sessions/${sessionId}/media/${item.mediaId}?type=original`;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-white text-2xl hover:text-gray-300"
        >
          ×
        </button>

        {/* Image or Video */}
        {item.mimeType.startsWith("image/") ? (
          <img
            src={originalUrl}
            alt={item.fileName}
            className="max-w-full max-h-[85vh] object-contain"
          />
        ) : item.mimeType.startsWith("video/") ? (
          <video
            src={originalUrl}
            controls
            autoPlay
            className="max-w-full max-h-[85vh]"
          />
        ) : null}

        {/* Navigation */}
        {media.length > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 items-center">
            <button
              onClick={() => setIndex(Math.max(0, index - 1))}
              disabled={index === 0}
              className="px-3 py-1 bg-white/20 text-white rounded disabled:opacity-30"
            >
              ←
            </button>
            <span className="text-white text-sm">{index + 1} / {media.length}</span>
            <button
              onClick={() => setIndex(Math.min(media.length - 1, index + 1))}
              disabled={index === media.length - 1}
              className="px-3 py-1 bg-white/20 text-white rounded disabled:opacity-30"
            >
              →
            </button>
          </div>
        )}

        {/* Filename */}
        <div className="absolute bottom-4 right-4 text-white/70 text-sm">
          {item.fileName}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/chat/MediaPreview.tsx frontend/src/components/chat/MediaLightbox.tsx
git commit -m "feat: add MediaPreview and MediaLightbox components"
```

---

### Task 12: MessageItem 渲染媒体

**Files:**
- Modify: `frontend/src/components/chat/MessageItem.tsx`

- [ ] **Step 1: 在 MessageItem 中导入并使用 MediaPreview**

在 `MessageItem.tsx` 中：

**1a. 添加导入**

```typescript
import { MediaPreview } from "./MediaPreview.js";
```

**1b. 修改用户消息渲染区域**

找到用户消息的渲染区域（约 line 139-154），当前只渲染 `{message.content}`。修改为：

```tsx
{/* User message content */}
<div className="...">
  {/* Text content — if message has media, extract text from JSON */}
  {message.media ? (
    // Multimedia message — content is JSON { text, media: [...] }
    // The API already returns the parsed text separately or we parse it
    <p className="...">{message.content}</p>
  ) : (
    <p className="...">{message.content}</p>
  )}

  {/* Media attachments */}
  {message.media && message.media.length > 0 && currentSessionId && (
    <MediaPreview media={message.media} sessionId={currentSessionId} />
  )}
</div>
```

需要从 chat store 获取 `currentSessionId`。在组件顶部添加：

```typescript
const currentSessionId = useChatStore((s) => s.currentSessionId);
```

- [ ] **Step 2: 处理多媒体消息的文本显示**

由于后端将多媒体消息的 content 存为 JSON 字符串 `{"text":"...","media":[...]}`, 前端显示时需要提取 text 部分。

两种方案：
1. 后端在返回消息时已经将 content 拆分为纯文本 + media 字段（推荐）
2. 前端解析 content JSON

如果 Task 2 的 Step 3 中后端已经正确拆分了 content，则 `message.content` 应该是纯文本，`message.media` 是媒体数组。

如果后端没有拆分 content，前端需要解析：

```tsx
// Extract display text
let displayText = message.content;
if (message.media) {
  try {
    const parsed = JSON.parse(message.content);
    if (parsed.text) displayText = parsed.text;
  } catch {}
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/chat/MessageItem.tsx
git commit -m "feat: MessageItem renders media attachments inline"
```

---

## Phase 5: 集成与端到端验证

### Task 13: 后端 content 解析一致性检查

**Files:**
- Review: `src/server/routes/agents.ts`
- Review: `src/server/routes/sessions.ts`

- [ ] **Step 1: 确认消息加载时 content 拆分逻辑**

确认 `sessions.ts` 的 `GET /:id/messages` 端点：
- 多媒体消息的 `content` 字段返回纯文本（`text` 部分）
- `media` 字段独立返回媒体数组

如果 Task 2 Step 3 中 `result.media = mediaAttachments` 是附加在 result 上的，需确认前端能正确接收到 `media` 字段。

具体地，在 enrichment 循环中：
```typescript
// 对于有多媒体的消息，content 应该返回纯文本而非 JSON
if (mediaAttachments && mediaAttachments.length > 0) {
  try {
    const parsed = JSON.parse(msg.content);
    result.content = parsed.text || msg.content;  // 提取纯文本
    result.media = parsed.media;                   // 提取媒体数组
  } catch {}
}
```

- [ ] **Step 2: 确认 loadContextMessages 正确传递多媒体消息**

确认 `agents.ts` 的 `loadContextMessages` 在加载历史消息时，多媒体消息的 content（JSON 字符串）被完整保留传递给 agent runner。

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/agents.ts src/server/routes/sessions.ts
git commit -m "fix: ensure content parsing consistency for multimedia messages"
```

---

### Task 14: 端到端测试

**Files:**
- Create: `tests/e2e/test-media-upload.mjs`

- [ ] **Step 1: 创建端到端测试脚本**

```javascript
// tests/e2e/test-media-upload.mjs
import { writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";

const BASE_URL = "http://localhost:21000";

let passCount = 0;
let failCount = 0;
const results = [];

function pass(name, detail = "") {
  passCount++;
  results.push({ name, status: "PASS", detail });
  console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail = "") {
  failCount++;
  results.push({ name, status: "FAIL", detail });
  console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
}

async function createSession(title) {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return await resp.json();
}

async function deleteSession(id) {
  await fetch(`${BASE_URL}/api/sessions/${id}`, { method: "DELETE" });
}

async function createTestImage() {
  // Create a minimal 10x10 red PNG
  const { default: sharp } = await import("sharp");
  const buffer = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  return buffer;
}

async function main() {
  console.log("\n============================================================");
  console.log("  Media Upload E2E Tests");
  console.log("============================================================\n");

  const session = await createSession("test-media-upload");
  const sessionId = session.id;

  try {
    // Test 1: Create test image and upload
    console.log("📋 Group 1: Media Upload");
    const imageBuffer = await createTestImage();
    const formData = new FormData();
    formData.append("file", new Blob([imageBuffer], { type: "image/png" }), "test-image.png");

    const uploadResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media`, {
      method: "POST",
      body: formData,
    });

    if (uploadResp.ok) {
      const uploadResult = await uploadResp.json();
      pass("Media upload", `mediaId: ${uploadResult.mediaId?.slice(0, 8)}, size: ${uploadResult.size}`);
      const mediaId = uploadResult.mediaId;

      // Test 2: Read original file
      console.log("\n📋 Group 2: Media Retrieval");
      const originalResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${mediaId}?type=original`);
      if (originalResp.ok) {
        const contentType = originalResp.headers.get("content-type");
        const buffer = Buffer.from(await originalResp.arrayBuffer());
        pass("Original file served", `type: ${contentType}, size: ${buffer.length}`);
      } else {
        fail("Original file served", `HTTP ${originalResp.status}`);
      }

      // Test 3: Read thumbnail
      const thumbResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${mediaId}?type=thumbnail`);
      if (thumbResp.ok) {
        const contentType = thumbResp.headers.get("content-type");
        const buffer = Buffer.from(await thumbResp.arrayBuffer());
        pass("Thumbnail served", `type: ${contentType}, size: ${buffer.length}`);
      } else {
        fail("Thumbnail served", `HTTP ${thumbResp.status}`);
      }

      // Test 4: Send message with media
      console.log("\n📋 Group 3: Message with Media");
      const runResp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          input: "描述一下这张图片",
          mediaIds: [mediaId],
        }),
      });

      if (runResp.ok) {
        pass("Run stream with media accepted");
        // Read the SSE stream
        const reader = runResp.body.getReader();
        const decoder = new TextDecoder();
        let events = [];
        let done = false;
        while (!done) {
          const { value, done: d } = await reader.read();
          done = d;
          if (value) {
            const text = decoder.decode(value);
            for (const line of text.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  events.push(JSON.parse(line.slice(6)));
                } catch {}
              }
            }
          }
        }
        pass("Agent responded", `${events.length} SSE events`);
      } else {
        fail("Run stream with media", `HTTP ${runResp.status}`);
      }

      // Test 5: Verify message saved with media
      console.log("\n📋 Group 4: Message Verification");
      const messagesResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages`);
      if (messagesResp.ok) {
        const messages = await messagesResp.json();
        const userMsg = messages.find(m => m.role === "user");
        if (userMsg) {
          if (userMsg.media && userMsg.media.length > 0) {
            pass("User message has media", `${userMsg.media.length} attachments`);
          } else {
            fail("User message has media", "no media field found");
          }
          // Content should be plain text, not JSON
          if (userMsg.content && !userMsg.content.startsWith("{")) {
            pass("Content is plain text", userMsg.content);
          } else {
            fail("Content format", `expected plain text, got: ${userMsg.content?.slice(0, 50)}`);
          }
        } else {
          fail("User message", "not found in messages");
        }
      } else {
        fail("Messages endpoint", `HTTP ${messagesResp.status}`);
      }

      // Test 6: Verify media files on disk
      console.log("\n📋 Group 5: Disk Verification");
      const mediaDir = join(process.cwd(), "data", "sessions", sessionId, "media", mediaId);
      const metaExists = existsSync(join(mediaDir, "meta.json"));
      const originalExists = existsSync(join(mediaDir, "original.png"));
      const thumbExists = existsSync(join(mediaDir, "thumbnail.webp"));

      if (metaExists) pass("meta.json exists on disk");
      else fail("meta.json", "not found");

      if (originalExists) pass("original.png exists on disk");
      else fail("original.png", "not found");

      if (thumbExists) pass("thumbnail.webp exists on disk");
      else fail("thumbnail.webp", "not found");

    } else {
      fail("Media upload", `HTTP ${uploadResp.status}`);
    }

  } catch (err) {
    fail("Test error", err.message);
  } finally {
    await deleteSession(sessionId);
    pass("Session deleted");
  }

  // Summary
  console.log("\n============================================================");
  console.log(`  Summary: ${passCount} PASS / ${failCount} FAIL / ${passCount + failCount} TOTAL`);
  console.log("============================================================");

  for (const r of results) {
    console.log(`  ${r.status === "PASS" ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(console.error);
```

- [ ] **Step 2: Run the test**

```bash
# 确保服务器运行在 port 21000
node tests/e2e/test-media-upload.mjs
```

Expected: All tests PASS. Media upload, retrieval, message saving, and disk storage all work.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/test-media-upload.mjs
git commit -m "test: add E2E test for media upload feature"
```

---

### Task 15: 构建前端并验证完整流程

- [ ] **Step 1: 构建前端**

```bash
cd frontend && npm run build
```

- [ ] **Step 2: 手动端到端验证**

启动服务器（`python3 start.py --no-docker --port 21000`），在浏览器中：
1. 打开对话界面
2. 拖入或通过回形针按钮上传一张图片
3. 确认缩略图预览显示在输入框上方
4. 输入文字"描述这张图片"并发送
5. 确认消息中内联显示缩略图
6. 确认 Agent 回复包含图片描述
7. 点击缩略图确认 Lightbox 弹出大图
8. 刷新页面确认历史消息中的图片缩略图正常加载

- [ ] **Step 3: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: chat media upload — complete integration"
```
