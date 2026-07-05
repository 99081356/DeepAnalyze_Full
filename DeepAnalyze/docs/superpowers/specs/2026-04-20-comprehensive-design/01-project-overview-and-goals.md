# DeepAnalyze 综合需求与架构设计文档

> **文档日期**: 2026-04-20
> **文档性质**: 综合整理（基于 2026-04-08 至 2026-04-19 共 11 份设计文档 + 多份实施计划）
> **时效性**: 本文档反映截至 2026-04-19 的最新设计决策，早期文档中已被后续版本覆盖的内容，以最新版本为准
> **文档结构**: 共 8 个分册，本文件为第 1 册

---

## 文档索引

| 册号 | 文件名 | 内容 |
|------|--------|------|
| 01 | `01-project-overview-and-goals.md` | 项目定位、核心目标、技术栈、演进历史（**本文件**） |
| 02 | `02-architecture-and-data-model.md` | 整体架构、三层数据模型、锚点系统、数据库基础设施 |
| 03 | `03-document-processing-pipeline.md` | 文档处理管线、多模态统一处理、Docling集成、文件格式策略 |
| 04 | `04-knowledge-retrieval-and-agent.md` | 知识检索系统、Agent体系、工具系统、记忆系统 |
| 05 | `05-provider-and-model-system.md` | Provider注册表、模型配置、增强模型、嵌入模型、Thinking支持 |
| 06 | `06-frontend-design.md` | 前端架构、知识库UI、多媒体播放器、设计系统、页面布局 |
| 07 | `07-system-robustness-and-integration.md` | 系统健壮性、模块联动、事件总线、定时任务、通信渠道 |
| 08 | `08-deployment-and-roadmap.md` | 部署方案、实施路线图、不在范围内的事项、风险与缓解 |

---

# 第 1 册：项目定位与核心目标

---

## 1. 项目定位

**通用型 Agent 驱动深度文档分析与报告生成平台。**

通过 Plugin/Skill 体系适配不同垂直场景（公检法、金融审计、研究分析等），底层 Agent 引擎和知识系统完全通用。

核心定位关键词：
- **深度分析** — 不是简单的文档问答，而是多轮推理、交叉验证、结构化报告生成
- **知识预编译** — 文档摄入时即完成分层编译，知识持续增长（复利积累），而非一次性 RAG
- **无损可溯源** — 所有分析结论可逐层展开追溯到原始文档精确位置（锚点级）
- **多模态** — 支持 PDF/Word/Excel/图片/音频/视频的统一处理和检索
- **多模型** — 支持 22+ LLM Provider，主模型/辅助模型/嵌入模型/增强模型灵活配置

---

## 2. 核心目标

| # | 目标 | 说明 | 提出日期 | 状态 |
|---|------|------|---------|------|
| 1 | Agent 驱动的多轮深度分析 | 基于 Claude Code harness 改造，TAOR 循环（Think-Act-Observe-Reflect）、父子 Agent 调度、自动上下文压缩 | 04-08 | 已实现基础版 |
| 2 | 知识预编译与复利积累 | 参考 Karpathy LLM Wiki 理念，文档摄入时完成分层编译，三层架构 Raw→Structure→Abstract | 04-08, 重构 04-15 | 部分实现，重构进行中 |
| 3 | 无损可溯源 | 所有分析结论可逐层展开追溯到原始文档精确位置（锚点级 `docId:type:index`） | 04-08, 增强 04-15 | 锚点系统设计中 |
| 4 | 通用可扩展 | 通过 Plugin/Skill 机制适配不同场景，核心系统与领域逻辑解耦 | 04-08 | 已实现 |
| 5 | 单机一体化部署 | 单进程启动，支持离线运行，Docker 部署 | 04-08 | 已实现（SQLite版） |
| 6 | 多模态统一处理 | 图片/音频/视频与文档统一三层结构，统一检索和展示 | 04-13, 增强 04-15, 重设计 04-18 | 进行中 |
| 7 | 企业级性能 | PostgreSQL + pgvector HNSW 索引，百万级向量毫秒检索，中文全文检索 | 04-15, 迁移计划 04-17 | 迁移进行中 |
| 8 | 多模型可配置 | 22+ Provider 注册表，Thinking 参数支持，增强模型（TTS/Image/Video/Music/ASR） | 04-12, 扩展 04-18 | 重构进行中 |
| 9 | 系统健壮性 | 能力感知调度，模型故障自动切换（熔断），跨知识库检索 | 04-18 | 设计完成 |
| 10 | 专业级前端 | 统一知识库页面，L0/L1/L2 按钮交互，多媒体预览播放 | 04-10, 重设计 04-18 | 重写进行中 |

---

## 3. 技术栈

### 3.1 当前技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| **前端** | React 19 + TypeScript + Tailwind CSS + Zustand + Vite | 单页应用，侧边栏导航 |
| **后端** | TypeScript + Hono | REST API + WebSocket + SSE |
| **运行时** | Bun（Node.js 兼容） | 单进程启动 |
| **数据库（当前）** | SQLite (better-sqlite3) | 向量暴力全表扫描，FTS5 unicode61 分词 |
| **数据库（目标）** | PostgreSQL + pgvector + zhparser | HNSW 向量索引，jieba 级中文分词 |
| **文档解析** | Docling (Python 子进程) | PDF/Word/Excel/PPT 解析 |
| **Agent 引擎** | 基于 Claude Code harness 改造 | TAOR 循环 + WorkflowEngine |
| **图标** | lucide-react | 统一图标风格 |
| **多媒体处理** | Sharp (图片) + ffmpeg/ffprobe (音视频) | 缩略图、元数据、音频轨提取 |

### 3.2 技术选型决策记录

| 决策 | 选择 | 理由 | 提出日期 |
|------|------|------|---------|
| Agent 引擎 | 基于 Claude Code TS 代码改造 | 复用成熟的 harness 工程能力 | 04-08 |
| 前端框架 | 全新 React + TypeScript + Tailwind | 自由设计，参考 AIE 专业风格 | 04-08 |
| Docling | Python 子进程，主程序管理生命周期 | 解耦但同步启停 | 04-08 |
| 数据库迁移 | SQLite → PostgreSQL + pgvector | 向量索引 + 中文FTS + 并发 + JSONB | 04-15 |
| 数据库抽象 | Repository 接口层 | 隔离底层实现，渐进迁移 | 04-15 |
| 嵌入模型 | bge-m3 (BAAI)，Ollama 本地运行 | CPU可用 + 多语言优秀 + 1024维 + 8K上下文 | 04-15 |
| Structure 层格式 | DocTags 按章节分块 | 结构丰富 + 轻量 + Agent友好 | 04-15 |
| 锚点 ID 格式 | `docId:elementType:index` | 稳定、可解析、同文档重编不变 | 04-15 |
| 知识图谱/链接 | 冻结不修改 | 锚点系统已覆盖核心追溯需求 | 04-15 |
| 视频处理 | 视频理解模型 + 音频轨转写 | 不再仅做帧采样，使用 VLM 深度理解 | 04-18 |

---

## 4. 设计演进历史

### 4.1 里程碑时间线

```
2026-04-08  初始设计文档
  └─ 定义 L0/L1/L2 分层 Wiki、Agent Service、React 前端、SQLite 存储
  └─ 核心理念：Agent驱动 + 知识预编译 + 无损可溯源 + 通用可扩展

2026-04-10  前端重构设计
  └─ 详细 UI 设计：6 个页面模块、18 个通用组件、双主题系统
  └─ 确定浅色白底为默认主题（参考 GitHub/Linear 风格）
  └─ 发现 XSS 漏洞、双发消息 Bug、死代码等问题

2026-04-12  AIE 功能迁移设计
  └─ 从参考项目 AIE 迁移：设置面板、通信渠道、定时任务、技能库
  └─ 建立模型角色体系：主模型/辅助模型/嵌入模型/增强模型
  └─ Header 按钮组设计、右侧滑出面板系统

2026-04-13  Phase A/B/C 三阶段修复设计
  └─ Phase A（紧急修复）：上传管线重构、WebSocket 进度推送、ProcessingQueue
  └─ Phase B（知识体系）：文件格式差异化处理、知识分层编译、Agent 互动工具
  └─ Phase C（体系增强）：事件总线、记忆系统分层策略、模块联动

2026-04-14  系统重新设计
  └─ 三层系统：输入层（上传+聊天）→ 核心引擎（搜索+Agent+报告）→ 展示层
  └─ 多 Agent 三层架构：底层 AgentRunner、中间层 WorkflowEngine、顶层分发入口
  └─ 并行 Agent 调度模式

2026-04-15  三层架构重新设计（重大架构变更）
  └─ ★ 核心变更：L0/L1/L2 → Raw/Structure/Abstract
  └─ 新增锚点系统（anchor），元素级追溯
  └─ DoclingDocument JSON 完整保留（零信息损失）
  └─ DocTags 作为 Structure 层主格式（不需要 LLM 生成中层）
  └─ 双名称体系（内部 UUID + 用户可见原始文件名）
  └─ 数据库迁移决策：SQLite → PostgreSQL + pgvector + zhparser
  └─ Repository 抽象层设计
  └─ 冻结图谱/链接系统

2026-04-17  Docling 模型可插拔管理 + PG 迁移设计
  └─ Docling 模型目录统一管理（layout/table/vlm/ocr）
  └─ 前端"文档处理"配置面板
  └─ Python 端动态模型选择
  └─ 完整 SQLite → PostgreSQL 迁移方案（17 个 Repository 接口）
  └─ 确定删除所有 SQLite 代码

2026-04-18  最新系统重构设计（5 个子项目）
  └─ ★ 子项目 1：Provider 重构 — 22 个 Provider 完整注册表、Thinking 参数、增强模型
  └─ ★ 子项目 2：文档处理流水线 — 并发控制修复、图片/音频/视频完整处理设计
  └─ ★ 子项目 3：知识库 UI 统一重写 — 文档/Wiki/搜索合并、多媒体播放器
  └─ ★ 子项目 4：Agent 体系优化 — Teams 迁移到 Header、主辅模型分离、WorkflowEngine 修复
  └─ ★ 子项目 5：系统健壮性 — 能力感知调度、熔断机制、跨知识库检索

2026-04-19  实施计划
  └─ 5 个子项目的详细实施计划文件（provider-refactor / document-pipeline-multimedia /
     knowledge-ui-unified-rewrite / agent-system-optimization / system-robustness）
```

### 4.2 关键架构变更对比

| 维度 | V1 (04-08) | V2 (04-15) | V3 (04-18) |
|------|-----------|-----------|-----------|
| 数据分层 | L0摘要/L1概览/L2全文 | Raw/Structure/Abstract | 同 V2 + 多模态统一 |
| 底层格式 | Markdown 文本 | DoclingDocument JSON | 同 V2 + 音视频原生 JSON |
| 中层生成 | LLM 生成 | Docling 导出 DocTags | 同 V2 |
| 追溯粒度 | 页面级 | 锚点级 | 同 V2 |
| 数据库 | SQLite | PostgreSQL (计划中) | PostgreSQL (迁移中) |
| Provider | 简单默认值 | 扩展元数据 | 22 Provider + Thinking |
| 多媒体 | 无 | 5 种处理器框架 | 完整实现（视频理解+ASR+发言人） |
| 前端知识库 | 文档/Wiki/搜索分离 | 三层预览 | 统一页面 + 多媒体播放器 |

---

## 5. 代码来源与复用策略

| 来源 | 复用方式 | 复用范围 |
|------|----------|----------|
| **Claude Code** | 代码级复用+改造 | Agent harness 核心（query loop、tool system、context management、parent-child dispatch、compaction） |
| **OpenViking** | 设计参考+部分代码参考 | L0/L1/L2 分层抽象的 TS 实现思路、Semantic DAG 的异步编译流程 |
| **lossless-claw-enhanced** | 设计参考+部分代码参考 | DAG 无损压缩的摘要树结构、CJK Token 估算、expand/grep 工具设计 |
| **AIE** | UI 模式参考+功能迁移 | 双主题设计系统、Header 功能按钮组、右侧面板系统、模型配置 Tab、通信渠道、定时任务 |
| **CountBot** | Provider 注册表参考 | 22 个 Provider 完整注册信息、Thinking profiles |
| **OpenClaw** | Provider 默认值参考 | 最新模型名称和接口地址 |
| **LightRAG** | 检索策略参考 | 融合检索（BM25 + 向量 + RRF）设计 |
