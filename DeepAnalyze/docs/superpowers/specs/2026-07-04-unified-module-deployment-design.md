# 统一模块部署设计

**Date**: 2026-07-04
**Status**: Approved (4 sections)
**Scope**: 个人版 DA 4 个基础设施模块（Embedding / ASR / MinerU / Docling）的本地部署与远端 API 调用统一化

---

## 1. 背景与目标

### 1.1 现状

DeepAnalyze 当前 4 个基础设施模块的部署能力极不一致：

| 模块 | 本地部署 | 远端 API | 运行时切换 | 问题 |
|------|----------|----------|-----------|------|
| Embedding (BGE-M3) | ✅ | ✅ | ✅ hot-swap | 缺少统一 UX 入口 |
| ASR (Whisper) | ✅ | ✅ | ❌ | `capability-dispatcher.ts:486-549` 硬编码本地优先 |
| VLM 通用 | ✅ | ✅ | ✅ | — |
| PaddleOCR-VL | ✅ Docker only | ❌ | ❌ | 完全无远端支持 |
| **Docling** | ✅ subprocess | **❌ 完全没有** | ❌ | 只有 stdin/stdout JSON-line 协议 |
| **MinerU** | **❌ 完全没有** | ✅ HTTP REST | ❌ | 只有远端客户端 |

此外：
- `src/server/model-supervisor.ts` 已损坏，`SERVICE_CONFIGS.embedding.scriptPath` 指向不存在的 `src/services/embedding/server.py`，实际服务在仓库根 `embedding_server.py`
- 本地 Provider 未注册到 `PROVIDER_REGISTRY`，由 `main.ts` 启动时动态注入
- `/api/health` 只报告 embedding + LLM 状态，缺少 ASR/VLM/Docling/MinerU
- `start.py:655-735` 硬编码"目录存在则启动"，缺乏单一数据源

### 1.2 用户诉求

明确不要新增抽象层。给 4 个模块每个一个"本地部署"按钮，统一支持：
- 本地部署（自动下载权重、按 GPU/CPU 自动分配）
- 远端 API 调用
- 运行时切换两种模式

目的是压缩个人版安装包尺寸，让用户根据资源灵活搭配，逐步把模块点击本地部署。

LLM/VLM 通用调度保持现有 Provider 抽象不变。

### 1.3 设计目标

1. **4 模块对称**：每个模块的本地/远端/模式切换接口一致
2. **单一数据源**：模块状态、配置、生命周期完全由 SQLite `module_states` 表驱动
3. **GPU 自适应**：自动检测 GPU 档位并推荐合适模型
4. **双轨发布**：500 MB 小核心 + 10 GB 全量合集，UI 体验一致
5. **向后兼容**：现有 `da:base` / `da:full` 用户自动迁移
6. **最小入侵**：复用现有 `bumpConfigVersion` 热更新机制，不重写主架构

---

## 2. 架构与模块生命周期

### 2.1 模块状态机

5 状态：

```
not_installed ──install──▶ installing ──success──▶ installed ──start──▶ running
     ▲                          │                     │                  │
     │                          │                     └──stop──┬─────────┘
     │                        fail                              │
     │                          ▼                                │
     └──────────────────────── error ◀──────────────────────────┘
```

| 状态 | 含义 | UI 标识 |
|------|------|--------|
| `not_installed` | 权重未就绪，模块不可用 | 灰色 + 安装按钮 |
| `installing` | 下载权重中 | 黄色 + 进度条 |
| `installed` | 权重就绪，进程未启动 | 灰色 + 启动按钮 |
| `running` | 进程运行中 | 绿色 + 停止按钮 |
| `error` | 启动/下载失败 | 红色 + 重试按钮 |

### 2.2 GPU 三档检测

新增 `src/server/gpu-detector.ts`：

```typescript
export type GpuTier = "none" | "low" | "high";

export interface GpuInfo {
  tier: GpuTier;
  hasNvidia: boolean;
  vramMB: number;
  deviceName?: string;
  cudaVersion?: string;
}

export async function detectGpu(): Promise<GpuInfo>;
```

判定规则：
- `none`：无 NVIDIA GPU 或 `nvidia-smi` 不可用
- `low`：VRAM < 8 GB
- `high`：VRAM ≥ 8 GB

无 NVIDIA GPU（AMD/Intel 集显等）统一归为 `none`，避免误判。

### 2.3 模块-档位推荐表

| 模块 | none | low | high |
|------|------|-----|------|
| Embedding (BGE-M3) | CPU 远端优先 | CPU 本地 | GPU 本地 |
| ASR (Whisper) | tiny CPU | base CPU | medium GPU |
| Docling（解析） | CPU 本地 | CPU 本地 | CPU 本地 |
| Docling VLM 后端 | none（仅 OCR） | 远端 OpenAI-VLM | PaddleOCR-VL 或 GLM-OCR（用户选） |
| MinerU | 远端 REST | 远端 REST | Docker 本地 |

### 2.4 安装源优先级

```
1. data/_bundled/<module>/   (全量包内置，硬链接秒级激活)
2. data/_cache/<module>/     (用户曾下载过)
3. 云端                       (hf-mirror.com 主源 + GitHub Release / 阿里云 OSS 备源)
```

云端下载统一封装在 `src/server/module-installer.ts`：
- HTTP Range 断点续传
- SHA256 校验失败自动重试
- 失败回退备源
- 进度持久化到 SQLite，重启后跳过已完成分片

### 2.5 单一数据源

新表 `module_states`：

```sql
CREATE TABLE module_states (
  module_id      TEXT PRIMARY KEY,           -- 'embedding' | 'asr' | 'docling' | 'mineru'
  status         TEXT NOT NULL,              -- 5 状态之一
  mode           TEXT NOT NULL,              -- 'local' | 'remote' | 'disabled'
  weights_path   TEXT,
  weights_size_mb INTEGER,
  gpu_required   BOOLEAN NOT NULL,
  process_type   TEXT NOT NULL,              -- 'subprocess' | 'docker'
  remote_endpoint TEXT,
  remote_api_key  TEXT,
  remote_protocol TEXT,                       -- 'openai' | 'mineru-rest' | 'docling-rest'
  vlm_backend    TEXT,                        -- 仅 docling: 'none' | 'paddleocr-vl-local' | 'glm-ocr-local' | 'remote-openai-vlm'
  last_error     TEXT,
  installed_at   TIMESTAMP,
  started_at     TIMESTAMP,
  config_version INTEGER NOT NULL DEFAULT 0
);
```

`start.py` 与 `model-supervisor.ts` 全部从此表读取决策，不再扫描磁盘目录。

### 2.6 配置热更新

复用现有 `bumpConfigVersion()` (`src/models/router.ts:41-51`)。模块 mode 切换、远端配置变更调用 `bumpConfigVersion(moduleId)`，下游 manager 监听 version 变化自动 reload，无需重启 DA。

---

## 3. 4 个模块详细设计

### 3.1 Embedding (BGE-M3)

**现有能力保留**：`EmbeddingManager`（`src/models/embedding.ts`）、`OpenAIEmbeddingProvider`（lines 55-143）、`HashEmbeddingProvider` 兜底（lines 157-233）、hot-swap 解析（lines 556-577）。

**改造点**：
- 前端 `EmbeddingModelConfig.tsx`（467 行）整体替换为统一 `ModuleCard` 组件
- 新增本地部署按钮 → 调用 `module-installer.install("embedding")`
- 安装完成后写入 `module_states.status='installed'`
- 启动按钮 → `model-supervisor.start("embedding")` → 启动 `embedding_server.py`
- mode 切换器（local/remote/disabled）→ `bumpConfigVersion("embedding")`
- `module-supervisor.ts` 重写：`SERVICE_CONFIGS.embedding.scriptPath` 修正为仓库根 `embedding_server.py`

**权重清单**（实测）：
- `pytorch_model.bin` 2,271,145,830 bytes ≈ 2.2 GB
- 可选 `model.safetensors`（同内容不同格式，按需）

### 3.2 ASR (Whisper)

**现有问题**：`capability-dispatcher.ts:486-549` 的 `transcribeAudio()` 硬编码"本地优先，远端兜底"，无法运行时切换。

**改造点**：
- 删除硬编码优先级逻辑
- 改为读取 `module_states.asr.mode`：
  - `local` → 调用本地 `whisper-service/main.py`
  - `remote` → 调用配置的远端 OpenAI-compatible Whisper API
  - `disabled` → 抛错
- 前端 `ASRModelConfig.tsx`（213 行）替换为 `ModuleCard`
- 新增模型尺寸选择器（tiny/base/medium/large）— 安装时由 GPU 档位推荐默认值
- mode 切换 `bumpConfigVersion("asr")` → `capability-dispatcher` reload

**权重清单**（实测 `/root/.cache/whisper/`）：
- `tiny.pt` 75 MB
- `base.pt` 145 MB
- `medium.pt` 165 MB
- 三档推荐：none→tiny / low→base / high→medium

### 3.3 Docling

**核心变化**：新增远端 HTTP 支持 + VLM 后端选择。

**3.3.1 远端客户端**（新增）

新建 `src/services/document-processors/docling-remote-client.ts`：

```typescript
export interface DoclingRemoteConfig {
  endpoint: string;       // e.g. https://docling.example.com
  apiKey?: string;
  protocol: "docling-rest";  // 暂定
}

export class DoclingRemoteClient {
  async parse(input: { filePath: string; options?: ParseOptions }): Promise<ParseResult>;
}
```

远端协议（暂定选项 A）：复用 MinerU `/file_parse` multipart 协议，详见开放决策 §6.1。

**3.3.2 VLM 后端选择**

```typescript
type DoclingVlmBackend =
  | "none"                    // 仅 OCR，不调用 VLM
  | "paddleocr-vl-local"      // 已有 paddleocr-vl-service
  | "glm-ocr-local"           // 新增 glm-ocr-service
  | "remote-openai-vlm";      // 远端 OpenAI-compatible VLM API
```

切换 VLM 后端 → `bumpConfigVersion("docling")` → `DoclingManager` reload。

**3.3.3 GLM-OCR 服务**（新增）

新建 `glm-ocr-service/`，仿 `paddleocr-vl-service/` 结构：
- `main.py` FastAPI 服务，端口 8601
- 加载 `data/models/docling/vlm/zai-org--GLM-OCR`（实测 2.5 GB）
- 暴露 `/predict` POST 接口，输入图片 base64，输出结构化 OCR 结果

新建 `src/server/glm-ocr-manager.ts`，仿 `paddleocr-vl-manager.ts:1-176` Docker 容器生命周期模式。

**3.3.4 本地 Docling 改造**

`docling-processor.ts:1-187` 的 `SubprocessManager` 保留，但增加：
- 接收 `vlm_backend` 参数，传给 `docling-service/main.py`
- service 进程根据 backend 转发到对应 VLM 端点（8600 PaddleOCR-VL / 8601 GLM-OCR / 远端）

**权重清单**：
- Docling 自身 layout/ocr/table 模型：~500 MB（默认下载）
- PaddleOCR-VL: 1.8 GB
- GLM-OCR: 2.5 GB

### 3.4 MinerU

**核心变化**：新增本地 Docker 部署。

**3.4.1 Docker 镜像**

新建 `mineru-service/Dockerfile`：
- CPU 变体：基于 `python:3.11-slim`，~2.5 GB
- GPU 变体：基于 `nvidia/cuda:12.4.0-runtime-ubuntu22.04`，~3.5 GB
- 内置 MinerU 完整依赖 + 预下载模型

镜像发布到 Docker Hub `da/mineru:0.7.6-cpu` / `da/mineru:0.7.6-gpu`。

**3.4.2 本地调度**

新建 `src/server/mineru-local-manager.ts`：
- 仿 `paddleocr-vl-manager.ts` Docker 容器生命周期
- 默认端口 8001（与现有 `mineru-client.ts` 一致）
- 启动/停止/状态查询接口
- 容器 health check 通过 `/health` 端点

**3.4.3 客户端统一**

`mineru-client.ts`（现有远端 HTTP 客户端）保留不变。
新增 dispatcher 层根据 `module_states.mineru.mode` 选择本地容器（同样 HTTP）或远端 endpoint。

由于本地和远端都是 HTTP REST，`mineru-client.ts` 实际可复用，只需切换 base URL。

### 3.5 跨模块新增文件清单

| 文件 | 用途 |
|------|------|
| `src/server/gpu-detector.ts` | GPU 三档检测 |
| `src/server/module-installer.ts` | 统一权重下载/校验/部署 |
| `src/server/module-supervisor.ts` | **重写**（当前文件已损坏）— 进程生命周期管理 |
| `src/server/glm-ocr-manager.ts` | GLM-OCR Docker 容器管理 |
| `src/server/mineru-local-manager.ts` | MinerU Docker 容器管理 |
| `src/server/routes/modules.ts` | 新增 `/api/modules/*` 路由 |
| `src/services/document-processors/docling-remote-client.ts` | Docling 远端 HTTP 客户端 |
| `glm-ocr-service/main.py` | GLM-OCR FastAPI 服务 |
| `mineru-service/Dockerfile` | MinerU Docker 镜像构建 |

### 3.6 修复现有 Bug

- `model-supervisor.ts` 修正所有 scriptPath
- `/api/health` (`src/server/app.ts:608-750`) 扩展，加入 ASR/VLM/Docling/MinerU 状态
- 本地 Provider 注册到 `PROVIDER_REGISTRY`（标记 `isLocal: true`）

---

## 4. UI/UX 设计

### 4.1 SettingsPanel 结构

保持现有 6 个 top-level tab 不变：
1. 模型配置 / 2. 渠道管理 / 3. MCP / 4. 通用 / 5. 鉴权 / 6. Hub

### 4.2 模型配置 Tab 改造

顶部新增 **4-pill 状态栏**：

```
┌────────────────────────────────────────────────────────────┐
│ 嵌入 ●  ASR ●  Docling ●  MinerU ○                         │
│ 运行中   运行中   运行中     未安装                          │
└────────────────────────────────────────────────────────────┘
```

- 绿点 = running
- 黄点 = installing
- 灰点 = installed / not_installed
- 红点 = error

点击 pill 跳转到对应子 Tab。

### 4.3 模型配置 9 个子 Tab 保持

保留：main / sub / embedding / vlm / video_understand / audio_transcribe / enhanced / docling / mineru

子 Tab 内的 4 个（embedding / audio_transcribe / docling / mineru）整体重写为 `ModuleCard`。

### 4.4 统一 ModuleCard 组件

```
┌─────────────────────────────────────────────────────────────┐
│ [图标] 嵌入模型 (BGE-M3)                       ● 运行中      │
│                                                             │
│ 模式: ( ) 本地部署  (•) 远端 API  ( ) 禁用                  │
│ ─────────────────────────────────────────────────────────── │
│                                                             │
│ ┌─ 本地部署 ──────────────────────────────────────────────┐ │
│ │ 状态: 已安装（2.2 GB / GPU: RTX 4090）                   │ │
│ │ 权重路径: data/models/bge-m3/                            │ │
│ │ 进程: PID 12345 (端口 8700)                              │ │
│ │ [▶ 启动]  [⏹ 停止]  [↻ 重新下载]                          │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─ 远端 API ──────────────────────────────────────────────┐ │
│ │ Endpoint: https://api.openai.com/v1                      │ │
│ │ API Key:  sk-****************************************    │ │
│ │ Model:    text-embedding-3-small                         │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 4.5 5 种状态视觉

| 状态 | 边框 | 图标颜色 | 主按钮 | 副信息 |
|------|------|---------|--------|--------|
| not_installed | 灰色虚线 | 灰 | "本地部署" | "未安装（点击下载 ~2.2 GB）" |
| installing | 黄色实线 | 黄 | "取消" | 进度条 45% + "下载中 1.0/2.2 GB" |
| installed | 灰色实线 | 灰 | "▶ 启动" | "已就绪（GPU 检测中…）" |
| running | 绿色实线 | 绿 | "⏹ 停止" | "PID 12345 · 端口 8700" |
| error | 红色实线 | 红 | "↻ 重试" | 错误信息 + "查看日志" |

### 4.6 安装确认 Modal

点击"本地部署"按钮后弹出：

```
┌─────────────────────────────────────────┐
│  安装嵌入模型 (BGE-M3)                  │
├─────────────────────────────────────────┤
│  检测到 GPU: NVIDIA RTX 4090 (24 GB)    │
│  推荐档位: GPU 加速                     │
│                                         │
│  下载大小: 2.2 GB                       │
│  磁盘占用: 2.2 GB                       │
│  来源:   hf-mirror.com (主)             │
│          GitHub Release (备)            │
│                                         │
│  [高级选项 ▼]                           │
│    ○ GPU 加速  ● CPU 模式              │
│                                         │
│  [取消]              [开始安装]         │
└─────────────────────────────────────────┘
```

### 4.7 首次启动向导（仅全量包）

```
┌─────────────────────────────────────────┐
│  欢迎使用 DeepAnalyze                   │
│  检测到 GPU: NVIDIA RTX 4090 (24 GB)    │
│  推荐"完整"档位                         │
├─────────────────────────────────────────┤
│ ○ 极简 (~500 MB 占用)                   │
│   • 嵌入: 远端（需配置）                │
│   • ASR:  Whisper tiny 本地             │
│   • Docling: CPU 本地（无 VLM）         │
│   • MinerU: 远端（需配置）              │
│                                         │
│ ○ 中等 (~3 GB 占用)                     │
│   • 嵌入: BGE-M3 本地（CPU）            │
│   • ASR:  Whisper base 本地             │
│   • Docling: CPU 本地 + 远端 VLM        │
│   • MinerU: 远端（需配置）              │
│                                         │
│ ● 完整 (~10 GB 占用) [推荐]             │
│   • 嵌入: BGE-M3 本地（GPU）            │
│   • ASR:  Whisper medium 本地（GPU）    │
│   • Docling: GPU 本地 + PaddleOCR-VL    │
│   • MinerU: Docker 本地（GPU）          │
└─────────────────────────────────────────┘
```

选择后 `start.py` 通过 `os.link()` 硬链接 `data/_bundled/<module>/` → `data/models/<module>/`，秒级完成，写入 `module_states` 表。

### 4.8 组件迁移清单

| 现有组件 | 操作 | 新组件 |
|---------|------|--------|
| `EmbeddingModelConfig.tsx` (467 行) | 重写 | `<ModuleCard moduleId="embedding" />` |
| `ASRModelConfig.tsx` (213 行) | 重写 | `<ModuleCard moduleId="asr" />` |
| Docling 配置（嵌入 SettingsPanel 内） | 重写 | `<ModuleCard moduleId="docling" />` |
| MinerU 配置（嵌入 SettingsPanel 内） | 重写 | `<ModuleCard moduleId="mineru" />` |
| `MainModelConfig.tsx` | 不变 | — |
| `SubModelConfig.tsx` | 不变 | — |
| `VLMModelConfig.tsx` | 不变 | — |
| `VideoUnderstandConfig.tsx` | 不变 | — |
| `EnhancedThinkingConfig.tsx` | 不变 | — |

### 4.9 关键交互细节

1. **运行中切换 mode**：弹确认对话框，提示"当前会话不受影响，新会话生效"
2. **下载可后台**：关闭浏览器后下载继续，进度持久化到 SQLite
3. **断点续传**：重开页面自动恢复下载
4. **磁盘空间预检**：安装前检查可用空间，不足时拒绝并提示
5. **网络失败重试**：3 次重试后回退备源，全部失败提示用户手动放置权重

---

## 5. 打包与发布

### 5.1 双轨发布

| 轨道 | 体积 | 内容 | 适用场景 |
|------|------|------|----------|
| `da-personal-core` 小核心 | ~500 MB | DA 主程序 + torch CPU + 基础 Python 依赖，无模型权重 | 已有远端 API / GPU 有限 / 增量部署 |
| `da-personal-full` 全量合集 | ~10 GB | 小核心 + `data/_bundled/` 预置全部权重 | 离线部署 / 首次安装 / 企业统一下发 |

两个包产出**完全一致的 UI 与能力边界**，差异只在首次启动时的"已就绪模块数"。

### 5.2 全量包目录结构

```
da-personal-full/
├── start.py
├── src/                                # 与小核心相同
├── embedding_server.py
├── whisper-service/
├── docling-service/
├── paddleocr-vl-service/
├── glm-ocr-service/                    # 新增
├── mineru-service/                     # 新增 Dockerfile
├── requirements/
│   ├── cpu.txt                         # CPU-only torch 路径（~200MB）
│   └── gpu.txt                         # CUDA torch 路径（~2GB）
└── data/_bundled/                      # 硬链接源，安装时不复制
    ├── bge-m3/
    │   └── pytorch_model.bin           # 2.2 GB
    ├── whisper/
    │   ├── tiny.pt                     # 75 MB
    │   └── base.pt                     # 145 MB
    ├── paddleocr-vl/                   # 1.8 GB
    ├── glm-ocr/                        # 2.5 GB
    └── mineru/
        └── model.tar.gz                # 模型包
```

### 5.3 云端模块仓库

| 模块 | 主源 | 备源 | 校验 |
|------|------|------|------|
| BGE-M3 | `hf-mirror.com/BAAI/bge-m3` | GitHub Release assets | SHA256 |
| Whisper | `hf-mirror.com/openai/whisper` | 同上 | SHA256 |
| PaddleOCR-VL | `hf-mirror.com/PaddlePaddle/PaddleOCR-VL-1.5` | 阿里云 OSS | SHA256 |
| GLM-OCR | `hf-mirror.com/zai-org/GLM-OCR` | 同上 | SHA256 |
| MinerU Docker 镜像 | Docker Hub `da/mineru:0.7.6` | 阿里云 ACR | digest |

### 5.4 Docker 镜像矩阵

| 镜像 | 基础 | 体积 | 用途 |
|------|------|------|------|
| `da:base` | 已有 | ~2 GB | 保留（向后兼容） |
| `da:full` | 已有 | ~5 GB | 保留（向后兼容） |
| `da:personal-core` | `da:base` | ~500 MB | 小核心，新增 |
| `da:personal-full` | `da:full` | ~10 GB | 全量合集，新增 |
| `da/mineru:0.7.6-cpu` | `python:3.11-slim` | ~2.5 GB | MinerU CPU 容器，新增 |
| `da/mineru:0.7.6-gpu` | `nvidia/cuda:12.4.0-runtime-ubuntu22.04` | ~3.5 GB | MinerU GPU 容器，新增 |
| `da/glm-ocr:0.7.6` | `nvidia/cuda:12.4.0-runtime-ubuntu22.04` | ~3 GB | GLM-OCR 服务，新增 |

### 5.5 start.py 重写

当前 `start.py:655-735` 硬编码"目录存在则启动"。新逻辑：

```python
states = sqlite_query("SELECT module_id, status, mode FROM module_states")
for module in ["embedding", "whisper", "docling", "paddleocr-vl", "glm-ocr", "mineru"]:
    state = states.get(module)
    if state and state.status == "running" and state.mode == "local":
        if module == "mineru":
            ensure_docker_container("da-mineru", state.gpu_required)
        else:
            ensure_subprocess(module, state.weights_path, state.gpu_required)
```

不再扫描磁盘目录做决策，单一数据源是 `module_states` 表。

### 5.6 版本对齐

- DA 主版本 `0.7.6` 与所有模块包版本号保持一致
- 模块包内嵌 `manifest.json` 声明兼容 DA 版本范围
- 升级 DA 时若模块版本不兼容，状态自动降级为 `not_installed` 并提示重新下载

### 5.7 现有用户迁移

- 现有 `da:full` 用户：自动迁移脚本检测 `data/models/bge-m3/` 等已有权重，写入 `module_states` 表对应行 `status=installed`
- 现有 `da:base` 用户：状态全部为 `not_installed`，UI 显示"检测到旧版本，点击本地部署以激活"

---

## 6. 开放决策

### 6.1 远端 Docling API 协议（待最终确认，推荐 A）

- **A（推荐）**：复用 MinerU `/file_parse` multipart 协议 — 实现成本最低，已有参考
- **B**：自定义 REST（POST `/parse` JSON body）— 协议清晰但需独立定义
- **C**：OpenAI Files 风格 — 与生态对齐但过度复杂

用户当前回复"可以后续再决定"，实施阶段先按 A 设计接口签名，具体 wire format 在第一个 Docling remote task 时定型。

---

## 7. 验收标准

1. 4 个模块（Embedding/ASR/Docling/MinerU）UI 都用统一 `ModuleCard`
2. 每个模块都支持 local/remote/disabled 三模式切换
3. 切换模式时无需重启 DA（复用 `bumpConfigVersion`）
4. `module_states` 表是唯一数据源（`start.py`、`model-supervisor.ts`、`/api/health` 都读它）
5. GPU 三档检测正确（nvidia-smi 解析 + 边界处理）
6. 小核心包 ≤ 600 MB，全量包 ≤ 12 GB
7. 首次启动向导正确推荐 GPU 档位
8. 现有 `da:full` 用户数据自动迁移
9. `model-supervisor.ts` 修复（scriptPath 正确）
10. `/api/health` 报告全部 5 类模块状态
