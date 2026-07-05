# Phase A: 紧急可用性修复 — 设计文档

**项目**: DeepAnalyze 知识库系统
**版本**: V1.0
**日期**: 2026-04-13
**状态**: 待讨论
**范围**: 问题 1,2,3,5 (上传管线) + 12,14,15,16 (UI/UX) + 17,18 (模型配置)

---

## 目录

1. [问题总览与优先级](#1-问题总览与优先级)
2. [文档上传与处理管线重构](#2-文档上传与处理管线重构)
3. [UI/UX 修复](#3-uiux-修复)
4. [嵌入模型与子模型配置修复](#4-嵌入模型与子模型配置修复)
5. [代码改动总清单](#5-代码改动总清单)
6. [数据模型变更](#6-数据模型变更)
7. [实施顺序](#7-实施顺序)

---

## 1. 问题总览与优先级

| # | 问题 | 严重度 | 类别 | 用户影响 |
|---|------|--------|------|---------|
| 1 | 上传文档很慢，转圈无进度 | P0 | 上传 | 用户不知道是否在工作 |
| 2 | 不支持批量/文件夹上传 | P0 | 上传 | 重复操作，效率极低 |
| 3 | 文档处理进度不可见 | P0 | 上传 | 用户无法判断何时可用 |
| 5 | 刷新后上传记录丢失 | P0 | 上传 | 数据丢失感，不可信 |
| 16 | 顶部搜索框无效 | P1 | UI | 功能看似存在但无用 |
| 17 | 嵌入模型配置不完善 | P1 | 配置 | 语义搜索可能失效 |
| 18 | Qwen 子模型 404 | P1 | 配置 | 无法使用国产模型 |
| 12 | Plugin/Skills 入口重复 | P2 | UI | 困惑，多一级导航 |
| 14 | 会话历史页面闪动 | P2 | UI | 视觉干扰 |
| 15 | 定时任务入口重复 | P2 | UI | 困惑 |

---

## 2. 文档上传与处理管线重构

### 2.1 问题根因

**当前流程 (knowledge.ts:299-517)**:

```
前端选择文件 → useFileUpload 串行上传 (for...of)
    → POST /upload 保存文件 → 返回 documentId
    → 前端需手动调用 process-all 或单个 process
    → POST /process/:docId 同步阻塞: docling解析 + wiki编译 + 向量化 + 实体提取
    → 期间前端一直转圈，无法中断，无法查看进度
```

核心问题:
1. **上传串行**: `useFileUpload.ts:48` 用 `for...of` 逐个上传
2. **进度假**: `useFileUpload.ts:49` 只有 `progress: 10` 和 `progress: 100`
3. **处理同步阻塞**: `knowledge.ts:348-517` 所有处理步骤在一个请求内同步完成
4. **状态不持久**: documents 表只有 `status` 字段 (uploaded/parsing/compiling/ready/error)，刷新后如果处于中间状态则丢失上下文

### 2.2 目标流程

```
前端选择文件(支持多文件+文件夹)
    → 并行上传 (XMLHttpRequest, 真实 upload.onprogress)
    → POST /upload 只存文件, 立即返回 {documentId, status:"uploaded"}
    → 自动入队 ProcessingQueue (可配置关闭)
    → ProcessingQueue 逐步处理, 每步更新DB + 通过 WebSocket 推送进度
    → 前端实时显示每个文档的处理状态和进度

处理步骤:
  uploaded → parsing → compiling → indexing → linking → ready
                                                       → error (任何步骤可失败)
```

### 2.3 WebSocket 进度推送

**新建 `src/server/ws.ts`**

使用 Bun native WebSocket。独立路径 `/ws`，通过 HTTP upgrade 握手。

```typescript
// 服务端消息类型
type WsServerMessage =
  | { type: "doc_upload_progress"; kbId: string; docId: string; progress: number }
  | { type: "doc_processing_step"; kbId: string; docId: string; step: string; progress: number }
  | { type: "doc_ready"; kbId: string; docId: string; filename: string }
  | { type: "doc_error"; kbId: string; docId: string; error: string }
  | { type: "pong" };

// 客户端消息类型
type WsClientMessage =
  | { type: "subscribe"; kbIds: string[] }
  | { type: "unsubscribe"; kbIds: string[] }
  | { type: "ping" };
```

连接管理:
- 客户端连接后发送 `subscribe` 消息指定关注的 KB ID 列表
- 服务端按 KB 过滤广播消息，只推送给订阅了该 KB 的客户端
- 心跳: 客户端每 30s 发 ping，服务端回 pong，超时 60s 断开
- 断线后前端自动重连 (指数退避, 1s → 2s → 4s → 8s, 最大 30s)

**前端 hook `frontend/src/hooks/useWebSocket.ts`**

```typescript
interface UseWebSocketOptions {
  url: string;
  onMessage: (msg: WsServerMessage) => void;
  reconnect?: boolean;
}

function useWebSocket(opts: UseWebSocketOptions) {
  // 管理 WS 连接、自动重连、心跳
  // 返回 { connected, send, subscribe, unsubscribe }
}
```

**前端 hook `frontend/src/hooks/useDocProcessing.ts`**

```typescript
function useDocProcessing(kbId: string) {
  // 内部使用 useWebSocket
  // 收到 doc_processing_step 时更新本地文档列表状态
  // 收到 doc_ready 时刷新文档列表
  // 收到 doc_error 时显示错误 toast
  // WS 断线时 fallback 到轮询 GET /kbs/:kbId/documents
  // 返回 { processingDocs: Map<docId, ProcessingState> }
}
```

### 2.4 ProcessingQueue (后台处理队列)

**新建 `src/services/processing-queue.ts`**

```typescript
interface ProcessingJob {
  kbId: string;
  docId: string;
  filename: string;
  filePath: string;
  fileType: string;
  steps: ProcessingStep[];
}

interface ProcessingStep {
  name: string;           // "parsing" | "compiling" | "indexing" | "linking"
  status: "pending" | "running" | "done" | "error";
  progress: number;       // 0.0 - 1.0
  error?: string;
}

// 单例, 在 app.ts 启动时创建, 注入到路由处理函数
class ProcessingQueue {
  private concurrency: number;   // 可配置, 默认 1
  private queue: ProcessingJob[];
  private active: Set<ProcessingJob>;
  private wsBroadcaster: WsBroadcaster;

  enqueue(job: ProcessingJob): void;
  cancel(docId: string): void;
  setConcurrency(n: number): void;

  // 内部方法
  private processNext(): Promise<void>;
  private executeStep(job: ProcessingJob, step: ProcessingStep): Promise<void>;
  private updateProgress(job: ProcessingJob, step: string, progress: number): void;
}
```

处理步骤详解:

| 步骤 | 做什么 | 更新 DB 字段 |
|------|--------|-------------|
| parsing | Docling 解析 PDF/Word/图片；直接读取文本文件 | `processing_step="parsing"`, `status="parsing"` |
| compiling | 创建 L2 fulltext + L1 overview + L0 abstract wiki pages | `processing_step="compiling"`, `status="compiling"` |
| indexing | 生成向量 embeddings + FTS 索引 | `processing_step="indexing"` |
| linking | 提取实体 + 构建正反向链接 | `processing_step="linking"` |
| (完成) | — | `processing_step=null`, `status="ready"`, `processing_progress=1.0` |

每个步骤完成后通过 WebSocket 广播:
```json
{ "type": "doc_processing_step", "kbId": "...", "docId": "...", "step": "parsing", "progress": 1.0 }
```

### 2.5 上传端点改动

**`src/server/routes/knowledge.ts` — POST `/kbs/:kbId/upload`**

改动:
- 保存文件后检查系统设置 `autoProcess` (默认 true)
- 如果 true，将文档入队 ProcessingQueue
- 如果 false，只标记为 uploaded，等待手动触发
- 立即返回，不等待处理完成

```typescript
// 改后逻辑
knowledgeRoutes.post("/kbs/:kbId/upload", async (c) => {
  // ... 保存文件 (同现有逻辑) ...
  const doc = createDocument(kbId, file.name, tempPath, originalDir);

  // 新增: 自动入队处理
  const autoProcess = getAutoProcessSetting(); // 默认 true
  if (autoProcess) {
    processingQueue.enqueue({
      kbId, docId: doc.id, filename: doc.filename,
      filePath: doc.filePath, fileType: doc.fileType,
      steps: buildProcessingSteps(doc.fileType),
    });
  }

  return c.json(doc, 201); // 立即返回
});
```

**新增端点 POST `/kbs/:kbId/trigger-processing`**

手动模式使用，将所有 `status="uploaded"` 的文档入队。

### 2.6 前端上传重构

**`frontend/src/hooks/useFileUpload.ts` 重写**

改动点:
1. `uploadToKb` 内部用 `XMLHttpRequest` 替代 `fetch`，获取真实 `upload.onprogress`
2. 并行上传: 用 `Promise.allSettled` 包裹，限制并发数 3
3. 新增 `selectFolder()` 方法: 创建 input 元素设置 `webkitdirectory` 属性
4. 上传完成后不再等待处理，文档列表通过 `useDocProcessing` hook 实时更新

```typescript
// 上传核心改动
function uploadSingleFile(kbId: string, file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status === 201) {
        resolve(JSON.parse(xhr.responseText).id);
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.open("POST", `/api/knowledge/kbs/${kbId}/upload`);
    xhr.send(formData);
  });
}
```

```typescript
// 文件夹选择
function selectFolder(): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;     // 递归选择文件夹
    input.onchange = () => resolve(input.files);
    input.click();
  });
}
```

### 2.7 KnowledgePanel 文档列表改进

**`frontend/src/components/knowledge/KnowledgePanel.tsx`**

文档列表区域需要显示处理状态:

```
文档列表:
┌─────────────────────────────────────────────────┐
│ [上传文件] [上传文件夹] [开始处理(手动模式)]       │
├─────────────────────────────────────────────────┤
│ 📄 报告.pdf                     ✅ 就绪          │
│ 📄 分析.docx                    ✅ 就绪          │
│ 📄 数据.xlsx                    🔄 编译中 67%    │  ← 实时进度
│ 📄 备忘.txt                     🔄 索引中 30%    │
│ 📄 合同.pdf                     ⏳ 排队中         │
│ 📄 日志.pdf                     ❌ 解析失败 [重试] │
│ 📄 笔记.md                      ✅ 就绪          │
└─────────────────────────────────────────────────┘
```

状态图标:
- ✅ 就绪 (ready)
- 🔄 处理中 + 步骤名 + 进度百分比 (parsing/compiling/indexing/linking)
- ⏳ 排队中 (uploaded, 等待处理队列)
- ❌ 失败 + 错误信息 + 重试按钮 (error)

数据来源:
- 初次加载: GET `/kbs/:kbId/documents` 返回所有文档含 processing_step 和 processing_progress
- 实时更新: `useDocProcessing(kbId)` hook 通过 WebSocket 接收增量更新

---

## 3. UI/UX 修复

### 3.1 问题12: Plugin/Skills 入口整合

**当前**: Header 右侧 5 个按钮 (Header.tsx:17-23):
```
headerActions = [sessions, skills, plugins, cron, settings]
```

其中 `skills` 和 `plugins` 分开，但 PluginManager 内部已有 Skills tab。

**改动**:
- 从 `headerActions` 移除 `skills` 条目
- `RightPanel` 的 `PANEL_TITLES` 和 `PANEL_WIDTHS` 移除 `skills` 相关条目
- 只保留 `plugins` 按钮，点击后打开 PluginManager (内含 Skills tab)
- UI store 的 `PanelContentType` 类型移除 `'skills'`

**涉及文件**:
- `frontend/src/components/layout/Header.tsx`: 删除 `headerActions` 中 skills 条目 (第19行)
- `frontend/src/components/layout/RightPanel.tsx`: 删除 `PANEL_TITLES`、`PANEL_WIDTHS` 中 skills 条目，删除 `SkillBrowser` lazy import
- `frontend/src/store/ui.ts`: `PanelContentType` 移除 `'skills'`
- `frontend/src/types/index.ts`: `RightPanelId` 移除 `'skills'`

### 3.2 问题14: 会话历史页面闪动

**根因分析**: SessionsPanel 未做 memo 优化，且 chat store 的 SSE 流式更新触发父组件 re-render 时连带着 SessionsPanel 也重新渲染。

**改动**:
- `SessionsPanel` 用 `React.memo` 包裹，自定义比较函数只检查 `sessions` 和 `currentSessionId`
- 搜索过滤使用 `useMemo` 缓存结果，`searchQuery` 用 `useDeferredValue` 防止高频更新
- 确保 `loadSessions` 不会在 SSE 流式消息到达时被意外触发

**涉及文件**:
- `frontend/src/components/sessions/SessionsPanel.tsx`: React.memo 包裹 + useMemo/useDeferredValue

### 3.3 问题15: 定时任务重复入口

**当前**: Header 有 cron 按钮 + SettingsPanel 有 cron tab (SettingsPanel.tsx 中 `settingsTabs` 数组)。

**改动**:
- SettingsPanel 的 tab 列表移除 cron 条目
- 只保留 Header 的 cron 按钮作为唯一入口

**涉及文件**:
- `frontend/src/components/settings/SettingsPanel.tsx`: 删除 cron tab 定义

### 3.4 问题16: 顶部搜索框无效果

**当前** (Header.tsx:61-77): 搜索只匹配 session 标题和 KB 名称，不搜文档内容和 Wiki。

**改动**:
- 搜索逻辑改为并行搜索 3 个类别: 会话、文档、Wiki 页面
- 文档/Wiki 搜索: 调用已有 API `GET /api/knowledge/:kbId/search?query=xxx`
- 搜索结果分三组显示: 会话 / 文档 / Wiki
- 添加 300ms debounce
- 无结果显示"未找到匹配"
- 搜索结果支持点击跳转:
  - 会话 → 切换到该会话
  - 文档 → 切换到知识库视图并高亮文档
  - Wiki → 切换到知识库视图并打开 Wiki 浏览器

**涉及文件**:
- `frontend/src/components/layout/Header.tsx`: 重写搜索逻辑和结果展示

搜索结果 UI:
```
┌─────────────────────────────────┐
│ 🔍 [搜索框________________]     │
├─────────────────────────────────┤
│ 会话                            │
│   💬 2024年度财报分析           │
│   💬 市场调研讨论               │
│ 文档                            │
│   📄 年报.pdf  (KB: 财务分析)   │
│   📄 市场数据.xlsx (KB: 调研)   │
│ Wiki                            │
│   📝 概览: 年报.pdf            │
│   🏷️ 公司: XX集团              │
└─────────────────────────────────┘
```

---

## 4. 嵌入模型与子模型配置修复

### 4.1 嵌入模型配置 (问题17)

**当前** (`EmbeddingModelConfig.tsx`):
- 只能从已配置的 Provider 中选择一个作为嵌入模型
- 无法独立配置 endpoint / model / apiKey
- 如果没配置，fallback 到 HashEmbedding (基本无用)
- 不显示当前实际使用的嵌入策略

**实际后端能力** (`embedding.ts`):
- `OpenAIEmbeddingProvider` 已支持任意 OpenAI 兼容端点 (含 Ollama)
- `HashEmbeddingProvider` 作为 fallback
- 构造参数: `{ name, endpoint, apiKey?, model, dimension }`

**改动**: EmbeddingModelConfig 增加两种模式:
1. **复用已有 Provider**: 从下拉选择已配置的 Provider (现有逻辑)
2. **自定义配置**: 独立输入 endpoint + model + apiKey + dimension

新增显示:
- 当前嵌入策略状态: "使用 OpenAI API (dimension: 1024)" 或 "使用 Hash fallback (无语义搜索)"
- 测试按钮: 调用 `/v1/embeddings` 发送测试文本，验证端点可用性并返回实际 dimension

**涉及文件**:
- `frontend/src/components/settings/EmbeddingModelConfig.tsx`: 增加自定义模式 UI
- `src/models/embedding.ts`: 可能需要暴露当前 provider 信息给 API
- `src/server/routes/settings.ts`: 新增 GET 嵌入状态端点

### 4.2 Qwen 子模型 404 (问题18)

**根因**: 用户配置了错误的端点和模型名:
- 用户使用: `https://coding.dashscope.aliyuncs.com/v1` (代码补全专用)
- 用户使用模型: `qwen3.6-plus` (不存在)

**实际**: `provider-registry.ts:88-95` 已有正确的 qwen 配置:
```typescript
qwen: {
  defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultModel: "qwen-plus",
}
```

**改动**:
1. 在 Provider 配置 UI 中，当用户选择 "阿里云百炼 (Qwen)" 时，自动填入正确的默认 endpoint 和 model
2. 增加模型名验证: 对已知 Provider 的模型名做基本格式检查
3. 测试连接时，如果返回 404，提示用户检查 endpoint 和模型名

**涉及文件**:
- `frontend/src/components/settings/MainModelConfig.tsx`: 选择 Provider 时自动填入默认值
- `frontend/src/components/settings/SubModelConfig.tsx`: 同上
- `frontend/src/components/settings/ModelConfigCard.tsx`: 增加默认值自动填充逻辑

这不是代码 bug，是 UI 未引导用户使用正确的默认值。核心改动是: **用户选择 Provider 时自动填入 registry 中的默认 endpoint 和 model**。

---

## 5. 代码改动总清单

### 新建文件

| 文件 | 用途 |
|------|------|
| `src/server/ws.ts` | WebSocket 服务端 |
| `src/services/processing-queue.ts` | 后台文档处理队列 |
| `src/store/migrations/002_processing_steps.ts` | DB 迁移: 增加处理步骤字段 |
| `frontend/src/hooks/useWebSocket.ts` | WebSocket 连接管理 hook |
| `frontend/src/hooks/useDocProcessing.ts` | 文档处理进度 hook |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/server/routes/knowledge.ts` | 上传端点分离处理; 新增 trigger-processing 端点 |
| `src/server/app.ts` | 注册 WebSocket upgrade 处理 |
| `src/store/documents.ts` | 增加 processingStep/progress/error 字段读写 |
| `src/models/embedding.ts` | 暴露当前 provider 状态信息 |
| `frontend/src/hooks/useFileUpload.ts` | 重写: XHR并行上传 + 文件夹选择 |
| `frontend/src/components/knowledge/KnowledgePanel.tsx` | 文档列表显示处理状态 |
| `frontend/src/components/layout/Header.tsx` | 移除 skills 按钮; 重写搜索逻辑 |
| `frontend/src/components/layout/RightPanel.tsx` | 移除 skills panel 映射 |
| `frontend/src/components/settings/SettingsPanel.tsx` | 移除 cron tab |
| `frontend/src/components/settings/EmbeddingModelConfig.tsx` | 增加自定义嵌入配置模式 |
| `frontend/src/components/settings/ModelConfigCard.tsx` | Provider 选择时自动填入默认值 |
| `frontend/src/components/sessions/SessionsPanel.tsx` | React.memo + useMemo 优化 |
| `frontend/src/store/ui.ts` | PanelContentType 移除 'skills' |
| `frontend/src/api/client.ts` | 新增 WS 相关 API 方法 |

---

## 6. 数据模型变更

### documents 表增加字段

```sql
-- 迁移 002: 增加文档处理步骤跟踪
ALTER TABLE documents ADD COLUMN processing_step TEXT DEFAULT NULL;
  -- 值: NULL(未开始) | 'parsing' | 'compiling' | 'indexing' | 'linking'

ALTER TABLE documents ADD COLUMN processing_progress REAL DEFAULT 0.0;
  -- 值: 0.0 - 1.0

ALTER TABLE documents ADD COLUMN processing_error TEXT DEFAULT NULL;
  -- 值: 错误信息文本
```

### settings 表增加配置项

```sql
-- 文档处理设置
INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_process', 'true');
  -- true: 上传后自动处理; false: 手动触发

INSERT OR IGNORE INTO settings (key, value) VALUES ('processing_concurrency', '1');
  -- 并发处理数, 默认 1
```

---

## 7. 实施顺序

建议按依赖关系和风险排序:

```
Step 1: 数据模型 + 基础设施
  ├─ 002_processing_steps 迁移
  ├─ ProcessingQueue 类
  └─ WebSocket 服务端

Step 2: 后端 API 改动
  ├─ knowledge.ts 上传/处理端点改造
  ├─ settings.ts 嵌入状态端点
  └─ app.ts 注册 WS

Step 3: 前端核心 hooks
  ├─ useWebSocket hook
  ├─ useDocProcessing hook
  └─ useFileUpload 重写

Step 4: 前端 UI
  ├─ KnowledgePanel 文档列表改进
  ├─ Header 搜索重写 + 移除 skills
  ├─ SettingsPanel 移除 cron tab
  ├─ SessionsPanel memo 优化
  ├─ EmbeddingModelConfig 自定义模式
  └─ ModelConfigCard 默认值填充

Step 5: 测试与联调
  ├─ 上传 → 处理 → WS 推送 → 前端展示 全链路测试
  ├─ 模型配置端到端测试 (含 Qwen)
  └─ 搜索功能验证
```
