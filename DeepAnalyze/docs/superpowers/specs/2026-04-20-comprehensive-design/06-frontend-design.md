# 第 6 册：前端设计

> **文档日期**: 2026-04-20
> **来源**: 综合 04-10 前端重构设计、04-12 AIE 迁移（UI模式）、04-13 Phase A、04-18 子项目 3
> **最新状态**: 以 04-18 子项目 3（知识库 UI 统一重写）为准

---

## 1. 前端架构

### 1.1 技术选型

| 技术 | 用途 |
|------|------|
| React 19 | UI 框架 |
| TypeScript | 类型安全 |
| Tailwind CSS | 样式（已切换为 CSS 变量 + Design Tokens） |
| Zustand | 状态管理 |
| Vite | 构建工具 |
| lucide-react | 图标 |
| Marked + highlight.js + DOMPurify | Markdown 渲染 |
| HTML5 `<audio>` / `<video>` | 多媒体播放 |

### 1.2 页面结构

```
+------------------------------------------------------------------+
| Header (项目名 + 功能按钮组 + 搜索)                                |
+--------+---------------------------------------------------------+
| 左侧栏  |  主内容区                                               |
| (导航)  |                                                         |
|         |  根据当前视图切换:                                        |
| 聊天    |  - 聊天对话视图                                          |
| 知识库  |  - 知识库统一视图                                        |
| 报告    |  - 报告查看视图                                          |
| 任务    |  - 任务监控面板                                          |
|         |                                                         |
+--------+-----------------------------+---------------------------+
                                    | 右侧面板 (滑出 560px)      |
                                    | - 会话列表                 |
                                    | - 插件管理                 |
                                    | - 技能库                   |
                                    | - 定时任务                 |
                                    | - 设置面板                 |
                                    | - Teams 管理               |
                                    +---------------------------+
```

### 1.3 右侧面板系统 (04-12 提出)

Header 功能按钮组，点击打开右侧滑出面板：

| 按钮图标 | 面板内容 |
|---------|---------|
| `MessageSquare` | 会话列表 |
| `Puzzle` | 插件管理 |
| `Wand2` | 技能库 |
| `Clock` | 定时任务 |
| `Settings` | 设置面板（多 Tab） |
| `Users` | Teams 管理 (04-18 新增) |

### 1.4 设计系统

**主题**: 浅色白底为默认（参考 GitHub/Linear 风格），支持深色主题切换。

**设计 Token** (CSS 变量):
```css
--space-xs: 4px;    --space-sm: 8px;    --space-md: 16px;
--space-lg: 24px;   --space-xl: 32px;
--radius-sm: 4px;   --radius-md: 8px;   --radius-lg: 12px;
--font-sans: system-ui, -apple-system, sans-serif;
--font-mono: 'JetBrains Mono', monospace;
```

---

## 2. 知识库统一页面 (04-18 重写设计)

### 2.1 设计目标

将原来的文档、Wiki、搜索三个独立 Tab 合并为统一知识库管理页面。

### 2.2 页面布局

```
+------------------------------------------------------------------+
| [KB选择器 ▼]  [🔍 搜索...        ] [语义▼] [召回数▼] [层级▼]  |
|                                [上传文件] [上传文件夹] [+新建KB] |
+------------------------------------------------------------------+
|  文档列表 (DropZone - 支持所有文件类型)                            |
|                                                                    |
|  ┌── PDF/DOCX 文档卡片 ────────────────────────────────────────┐  |
|  │ 📄 合同文件.pdf          2024-01-15  2.3MB    [删除] [更多] │  |
|  │ [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓                      │  |
|  │   ┌── L0 摘要 ─────────────────────────────────────────┐   │  |
|  │   │ 本合同为XX公司与YY公司签署的技术服务协议...         │   │  |
|  │   └────────────────────────────────────────────────────┘   │  |
|  └────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌── 图片文件卡片 ────────────────────────────────────────────┐  |
|  │ 🖼️ 现场照片.jpg          1.8MB  1920x1080                 │  |
|  │ [缩略图预览 ▼] [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓     │  |
|  └────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌── 音频文件卡片 ────────────────────────────────────────────┐  |
|  │ 🎙️ 录音记录.mp3          12.4MB  03:25                    │  |
|  │ [▶ 播放原录音] [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓     │  |
|  └────────────────────────────────────────────────────────────┘  |
|                                                                    |
|  ┌── 视频文件卡片 ────────────────────────────────────────────┐  |
|  │ 🎬 监控录像.mp4          245MB  1920x1080 15:30            │  |
|  │ [▶ 播放原视频] [L0 🟢] [L1 🟢] [L2 🟢]   处理就绪 ✓     │  |
|  └────────────────────────────────────────────────────────────┘  |
+------------------------------------------------------------------+
```

### 2.3 DocumentCard 统一卡片

根据文件类型自动选择渲染模式：

```typescript
interface DocumentCardProps {
  document: Document;
  levels: {
    L0: { ready: boolean; pageId?: string };
    L1: { ready: boolean; pageId?: string };
    L2: { ready: boolean; pageId?: string };
  };
  expandedLevel?: 'L0' | 'L1' | 'L2' | 'media';
  fileType: 'document' | 'image' | 'audio' | 'video';
  thumbnailUrl?: string;
  originalFileUrl?: string;
  mediaDuration?: string;
  mediaResolution?: string;
}
```

### 2.4 L0/L1/L2 按钮交互

- **灰色** = 该层级尚未编译完成
- **绿色** = 已就绪，可点击展开预览
- 点击展开层级内容，再次点击折叠
- 编译过程中每完成一层立即变绿（WebSocket 实时推送）

### 2.5 各文件类型的层级预览内容

| 文件类型 | L0 (Abstract) | L1 (Structure) | L2 (Raw) |
|---------|--------------|---------------|---------|
| 文档 | 精简摘要 | DocTags/Markdown 结构内容 | 原始完整文本 |
| 图片 | 主题摘要 | VLM 描述 + OCR 文字 | 完整描述 + OCR + EXIF |
| 音频 | 主题摘要 + 发言人数 | 按发言人分段的转写文本 | 完整转写（含时间戳和标签） |
| 视频 | 主题摘要 + 场景数 | 按场景/时段分段（画面+对话） | 完整场景描述 + 完整转写 |

---

## 3. 多媒体播放器组件

### 3.1 ImagePreview (图片预览)

- 缩略图展示（点击放大到全屏查看器）
- EXIF 信息面板（拍摄时间、相机、GPS）
- 原图下载按钮

### 3.2 AudioPlayer (音频播放)

- HTML5 `<audio>` 播放器
- 播放时同步显示当前时段的转写文本（高亮当前发言人段落）
- 发言人标签颜色区分（S1=蓝色, S2=绿色, S3=橙色...）

```typescript
interface AudioPlayerProps {
  src: string;
  duration: number;
  speakers: { id: string; label: string }[];
  turns: { speaker: string; startTime: number; endTime: number; text: string }[];
}
```

### 3.3 VideoPlayer (视频播放)

- HTML5 `<video>` 播放器（支持 Range 请求 seek）
- 播放时同步显示当前场景的视频理解描述
- 当前时段的对话转写文本（带发言人标签）
- 关键帧时间线（缩略图条，点击跳转）
- 场景切换指示器

```typescript
interface VideoPlayerProps {
  src: string;
  duration: number;
  resolution: string;
  scenes: { startTime: number; endTime: number; description: string; thumbnailUrl?: string }[];
  transcript: {
    speakers: { id: string; label: string }[];
    turns: { speaker: string; startTime: number; endTime: number; text: string }[];
  };
}
```

---

## 4. 统一搜索栏

- 搜索输入框（防抖 300ms）
- 检索模式：语义检索 / 向量检索 / 混合检索
- 召回数量：5/10/20/50
- 检索层级多选：L0/L1/L2，默认勾选 L1
- 搜索结果替换文档列表，清空搜索恢复文档列表

---

## 5. 设置面板

### 5.1 设置 Tab 结构

| Tab | 内容 |
|-----|------|
| **主模型** | Provider 选择、API Key、模型选择、参数调优 |
| **辅助模型** | 同上（用于子 Agent） |
| **嵌入模型** | 嵌入 Provider 选择、维度、重索引 |
| **增强模型** | TTS/Image/Video/Music/ASR 模型配置 |
| **文档处理** | Docling 模型选择（布局/OCR/表格/VLM）(04-17 新增) |
| **通用** | 界面主题、语言、其他系统设置 |

### 5.2 设置 API

```
GET  /api/settings/providers          — 获取 Provider 配置
PUT  /api/settings/providers          — 更新 Provider 配置
GET  /api/settings/docling-config     — 获取 Docling 配置
PUT  /api/settings/docling-config     — 更新 Docling 配置
GET  /api/settings/docling-models     — 扫描可用模型列表
```

---

## 6. 聊天页文档上传

1. `MessageInput` 支持所有文件类型上传（文档 + 图片 + 音频 + 视频）
2. 上传时检查当前 session 是否有关联知识库：
   - 无 → 自动创建以 session ID 命名的临时知识库
   - 有 → 上传到关联的知识库
3. 上传完成后自动更新 `AnalysisScope` 包含该知识库
4. 知识库为永久性的，可在知识库页面中重命名

---

## 7. Teams UI (04-18 设计)

- Header 右侧新增 Teams 按钮（Users 图标）
- 点击打开右侧面板（560px），展示 TeamManager
- 从知识库页面移除 Teams Tab
- TeamEditor 增加完整字段配置：tools（多选）、dependsOn（Graph模式）、perspective（Council模式）、systemPrompt（可选）
