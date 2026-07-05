# DeepAnalyze 系统全面分析报告（第一部分：需求符合度与核心问题）

> 分析日期：2026-04-21 | 分析范围：全系统代码审查 + 实际运行测试

---

## 一、执行摘要

### 总体评价

DeepAnalyze 系统在架构设计和功能广度上达到了较高水平，核心 Agent 引擎、多模型路由、三层数据模型、四种工作流调度模式等核心设计均已实现。但在**运行时质量**方面存在多个关键缺陷，部分核心功能在实际运行中无法正常工作，需要系统性修复。

### 整体完成度评估

| 模块 | 代码完成度 | 运行可用性 | 关键问题数 |
|------|-----------|-----------|-----------|
| Agent 引擎 | 95% | 85% | 3 |
| 知识库/Wiki 引擎 | 90% | 40% | 6 |
| 模型/Provider 系统 | 95% | 90% | 2 |
| 前端界面 | 90% | 80% | 5 |
| 搜索/检索系统 | 90% | 30% | 4 |
| 文档处理管道 | 90% | 70% | 3 |
| 基础设施/启动 | 80% | 70% | 4 |

### 测试发现的关键问题（按严重程度排序）

**P0 - 系统级故障：**
1. 向量嵌入完全缺失（嵌入服务 502 Bad Gateway，全库 0 条有效嵌入）
2. Abstract（L0 层）内容全部为空，仅包含 "## 概述" 标题
3. 搜索系统层级过滤失效：请求 L1 返回 L0 结果

**P1 - 功能严重缺陷：**
4. 文档编译卡在 compiling 状态不完成（Markdown 文件测试）
5. 跨知识库搜索 API 未实现（`/api/search` 仅返回 API 说明，无实际搜索功能）
6. 索引器未覆盖双格式页面类型（structure_dt/structure_md 未被索引）
7. 多个子系统（cron调度器、渠道管理器、插件加载器、事件总线）未在启动流程中初始化

**P2 - 功能不完整：**
8. 实体提取和跨文档链接在编译器中被禁用（代码存在但未调用）
9. 锚点 content_hash 始终为 null，无法检测内容漂移
10. Expand 预算模式不累积内容，仅返回最后匹配的层级
11. BM25 分数归一化使用 sigmoid 变换可能产生不合理分布
12. 报告任务追踪无 TTL 清理，可能导致内存泄漏

---

## 二、需求逐项核对清单

### 核心需求（C-01 ~ C-46）

#### 2.1 系统定位与能力

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-01 | 通用型 Agent | ✅ 已实现 | ✅ 通过 | Agent 系统完整，支持 general/explore/compile/verify/report/coordinator 六种内置 Agent |
| C-02 | TAOR 循环 + 父子调度 + 自动上下文管理 | ✅ 已实现 | ⚠️ 部分通过 | TAOR 循环完整，上下文三层压缩机制完善。但 Reflect 阶段为隐式（依赖模型自身），非结构化显式反思 |
| C-03 | 知识预编译：分层编译 | ✅ 已实现 | ❌ 故障 | Raw→Structure→Abstract 管道存在，但 Abstract 层 LLM 调用失败导致内容为空 |
| C-04 | 无损可溯源 | ✅ 已实现 | ⚠️ 部分通过 | 锚点系统完整（187个锚点/文档），但 content_hash 为 null、page_number 仅时间媒体填充 |
| C-05 | 通用可扩展 Plugin/Skill | ✅ 已实现 | ✅ 通过 | 插件和技能系统完整，9 个内置技能 + 清单式插件注册 |
| C-06 | 单机一体化部署 | ✅ 已实现 | ✅ 通过 | `start.py` 一键启动，Docker Compose 支持，端口 21000 |

#### 2.2 三层数据模型

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-07 | Raw(L2)/Structure(L1)/Abstract(L0) 三层存储 | ✅ 已实现 | ⚠️ 部分通过 | 层级映射正确：abstract=L0, structure_md/dt=L1, fulltext=L2, 原始JSON=Raw |
| C-08 | Raw 层：Docling JSON 完整保留 | ✅ 已实现 | ✅ 通过 | `compileRaw()` 保存 docling.json 和 metadata.json 到磁盘 |
| C-09 | Structure 层：DocTags+Markdown 双格式导出 | ✅ 已实现 | ⚠️ 部分通过 | 双格式页面创建正确（structure_dt + structure_md），但**索引器未覆盖这两种类型** |
| C-10 | Abstract 层：LLM 摘要+标签+类型 | ✅ 已实现 | ❌ 故障 | 代码完整，但 LLM 调用失败，所有 abstract 页面仅含 "## 概述" |
| C-11 | 信息零损失：标题/表格/图片/页码/阅读顺序 | ✅ 已实现 | ✅ 通过 | Docling JSON 保留完整结构信息，锚点跟踪 section_path |
| C-12 | 多模态统一三层结构 | ✅ 已实现 | ⚠️ 未测试 | 代码支持 PDF/Word/Excel/图片/音频/视频六种处理器，但仅测试了 Markdown |

#### 2.3 多模态处理

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-13 | 文档优先使用 Docling 解析 | ✅ 已实现 | ✅ 通过 | Docling 可用，27+ 文件格式支持 |
| C-14 | 图片增强 VLM | ✅ 已实现 | ⚠️ 未测试 | ImageProcessor 实现完整（Sharp + VLM + OCR），需要 VLM 模型配置 |
| C-15 | 音频增强 ASR | ✅ 已实现 | ⚠️ 未测试 | AudioProcessor 实现完整（ffprobe + ASR + 说话人分离） |
| C-16 | 视频理解模型解析 | ✅ 已实现 | ⚠️ 未测试 | VideoProcessor 实现完整（ffmpeg + VLM 场景分析 + ASR） |
| C-17 | 原文件预览/流式播放 | ✅ 已实现 | ⚠️ 未测试 | 前端有 ImagePreview/AudioPlayer/VideoPlayer 组件，后端有媒体服务路由 |

#### 2.4 知识检索

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-18 | 向量+BM25+RRF 融合检索 | ✅ 已实现 | ❌ 严重故障 | RRF 代码正确，但**向量嵌入完全缺失**（嵌入服务宕机），BM25 FTS 正常 |
| C-19 | Agent grep 检索 | ✅ 已实现 | ✅ 通过 | grep 工具通过 `execSync` 实现，支持正则 |
| C-20 | Raw 层按需访问 | ✅ 已实现 | ✅ 通过 | `expandToRaw()` 通过锚点 JSON Pointer 精确定位原始数据 |
| C-21 | 检索结果携带锚点 ID | ✅ 已实现 | ⚠️ 部分通过 | 搜索结果包含 pageId，但未直接返回锚点 ID，需要二次查询 |

#### 2.5 Agent 体系

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-22 | TAOR 循环 Agent 引擎 | ✅ 已实现 | ✅ 通过 | while(true) 循环 + think/finish 工具 + 自动模型回退 |
| C-23 | 主/辅模型分离 + 故障切换 | ✅ 已实现 | ✅ 通过 | Circuit Breaker 3次失败切换，关键词启发式排除非chat provider |
| C-24 | 四种调度模式 | ✅ 已实现 | ✅ 通过 | Pipeline/Parallel/Council/Graph(DAG) 全部实现 |
| C-25 | WorkflowEngine 取消/持久化 | ✅ 已实现 | ✅ 通过 | AbortController 取消，结果持久化到 agent_tasks 表 |
| C-26 | 工具集 | ✅ 已实现 | ✅ 通过 | kb_search/wiki_browse/expand/report_generate/web_search/grep/bash 等 17 个工具 |
| C-27 | 上下文自动管理 | ✅ 已实现 | ✅ 通过 | MicroCompact + SM-Compact + Legacy Compact 三层机制 |
| C-27a | 语言跟随 | ✅ 已实现 | ✅ 通过 | agent-runner/agent-definitions/tool-registry 中均包含中文跟随指令 |
| C-27b | Agent 自主阅读原则 | ✅ 已实现 | ✅ 通过 | 系统只提供信号（tokenCount/层级信息），不通过提示词限制行为 |

#### 2.6 Provider 与模型

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-28 | 22+ LLM Provider | ✅ 已实现 | ✅ 通过 | 注册 23 个 Provider（含 3 本地 + 2 自定义） |
| C-29 | 四类模型角色 | ✅ 已实现 | ✅ 通过 | 实际实现 10 个角色（main/summarizer/embedding + 7 增强角色） |
| C-30 | 8 种增强能力 | ✅ 已实现 | ⚠️ 部分可用 | CapabilityDispatcher 完整，但当前仅 text/embedding/webSearch 可用 |
| C-31 | Thinking 参数按厂商传递 | ✅ 已实现 | ✅ 通过 | 7 个 Provider 配置了 thinking profiles，4 种支持级别 |
| C-32 | 嵌入模型切换 + 异步重索引 | ✅ 已实现 | ⚠️ 未测试 | 代码完整，但当前嵌入服务不可用 |

#### 2.7 数据库

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-33 | PostgreSQL + pgvector + zhparser | ✅ 已实现 | ✅ 通过 | Docker 容器运行正常，10 个迁移全部完成 |
| C-34 | 百万级向量 HNSW <100ms | ✅ 已实现 | ⚠️ 无法测试 | HNSW 索引已创建，但无实际嵌入数据可测试 |
| C-35 | 中文全文检索 | ✅ 已实现 | ✅ 通过 | zhparser 扩展已启用，所有页面 FTS 向量已填充 |
| C-36 | Repository 抽象层 18 接口 | ✅ 已实现 | ✅ 通过 | RepoSet 恰好 18 个接口 |

#### 2.8 前端（核心）

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-37 | 知识库统一页面 | ✅ 已实现 | ⚠️ 未浏览器测试 | KnowledgePanel 组件集成文档/搜索/Wiki/实体 |
| C-38 | L0/L1/L2 按钮交互 | ✅ 已实现 | ⚠️ 未浏览器测试 | 三态按钮：灰色未就绪/绿色可预览/蓝色已展开 |
| C-39 | 多媒体播放器 | ✅ 已实现 | ⚠️ 未浏览器测试 | ImagePreview/AudioPlayer/VideoPlayer 独立组件 |
| C-40 | 统一搜索栏 | ✅ 已实现 | ⚠️ 未浏览器测试 | semantic/vector/hybrid 三模式 + topK + 层级选择 |
| C-41 | Agent SSE 流式+子任务可视化 | ✅ 已实现 | ✅ 通过 | SSE 测试通过，事件流完整（start/content/tool_call/complete/done） |
| C-42 | 报告嵌入+引用标记 | ✅ 已实现 | ⚠️ 未浏览器测试 | 报告徽章/文档引用/溯源链接组件完整 |

#### 2.9 系统健壮性

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| C-43 | 能力感知调度 | ✅ 已实现 | ✅ 通过 | `/api/capabilities` 动态返回系统能力 |
| C-44 | 熔断机制 3 次失败切换 | ✅ 已实现 | ✅ 通过 | CircuitBreaker 3-strike + 60s reset + half-open |
| C-45 | 降级链 | ⚠️ 部分实现 | ⚠️ 未测试 | 增强模型降级链代码存在，但未验证完整流程 |
| C-46 | 事件驱动架构 | ⚠️ 部分实现 | ❌ 未集成 | EventBus 代码完整但**未在启动流程中初始化**，WebSocket 使用独立的 `globalThis.__workflowEvents` |

### 一般需求（G-01 ~ G-27）

| ID | 需求 | 实现状态 | 测试结果 | 详情 |
|----|------|---------|---------|------|
| G-01 | 并发文档处理 | ✅ 已实现 | ⚠️ 未测试 | ProcessingQueue 支持可配置并发（默认1），slot 控制 |
| G-02 | 非阻塞上传+重试 | ✅ 已实现 | ✅ 通过 | 上传成功，但编译卡住说明后续处理存在问题 |
| G-03 | WebSocket 断线回退轮询 | ✅ 已实现 | ⚠️ 未测试 | 前端 useWebSocket hook 存在，3s 轮询回退 |
| G-04 | 文件夹上传 | ✅ 已实现 | ⚠️ 未测试 | webkitdirectory 支持 |
| G-05 | 文档删除完整级联 | ✅ 已实现 | ⚠️ 未测试 | 文档级6步级联完整；KB级级联可能依赖数据库外键 |
| G-06 | 精细化进度追踪 | ✅ 已实现 | ✅ 通过 | 解析→编译→索引→链接→就绪，WebSocket 推送 |
| G-07 | Docling 模型可插拔管理 | ✅ 已实现 | ⚠️ 未测试 | `/api/settings/docling-config` 可配置 |
| G-08 | 浅色/深色主题 | ✅ 已实现 | ⚠️ 未浏览器测试 | themes.css + useTheme hook + system detection |
| G-09 | Header 功能按钮组 | ✅ 已实现 | ⚠️ 未浏览器测试 | 6 个按钮：会话/插件/技能/团队/定时/设置 |
| G-10 | 右侧滑出面板 560px | ✅ 已实现 | ⚠️ 未浏览器测试 | 实际宽度 420-640px 按内容类型变化 |
| G-11 | 设置面板多 Tab | ✅ 已实现 | ⚠️ 未浏览器测试 | 3 个 Tab：模型/渠道/通用 |
| G-12 | Teams 管理在 Header 面板 | ✅ 已实现 | ⚠️ 未浏览器测试 | 右侧面板 lazy 加载 |
| G-13 | TeamEditor 完整字段 | ✅ 已实现 | ⚠️ 未浏览器测试 | role/task/tools/dependsOn/perspective/systemPrompt |
| G-14 | 聊天文件上传+自动临时KB | ✅ 已实现 | ⚠️ 未浏览器测试 | 自动创建 session-${id} KB |
| G-15 | 跨知识库搜索 | ❌ 未实现 | ❌ 失败 | Header 搜索跨KB但非专门面板，`/api/search` 无实际搜索功能 |
| G-16 | 报告 PDF/MD 导出 | ✅ 已实现 | ⚠️ 未浏览器测试 | 支持 MD/HTML/PDF 三种格式 |
| G-17 | localStorage 持久化 | ✅ 已实现 | ⚠️ 未浏览器测试 | theme/sidebar/kb/session/route 五项持久化 |
| G-18 | DOMPurify XSS 防护 | ✅ 已实现 | ⚠️ 未浏览器测试 | 4+ 文件使用 DOMPurify |
| G-19 | web_search SearXNG/Serper | ✅ 已实现 | ⚠️ 未测试 | 双后端支持 |
| G-20 | 通信渠道管理 | ✅ 已实现 | ❌ 未初始化 | 6 个平台代码完整，但**未在启动流程中初始化** |
| G-21 | 定时任务系统 | ✅ 已实现 | ❌ 未初始化 | 代码完整（CRUD+调度器），但**调度器未在启动流程中启动** |
| G-22 | REST+SSE+WebSocket 通信 | ✅ 已实现 | ✅ 通过 | 三种通信方式全部可用 |
| G-23 | 配置实时生效 | ✅ 已实现 | ✅ 通过 | version-counter 机制，无需重启 |
| G-24 | YAML 配置 fallback | ✅ 已实现 | ✅ 通过 | DB-first, YAML-fallback |
| G-25 | Docker Compose 一键部署 | ✅ 已实现 | ⚠️ 未测试 | docker-compose.yml + docker-compose.dev.yml 存在 |
| G-26 | 数据目录可配置 | ✅ 已实现 | ✅ 通过 | DATA_DIR 环境变量 |
| G-27 | 双名称体系 UUID+原始名 | ✅ 已实现 | ✅ 通过 | 文档存储使用 UUID，显示名通过 DisplayResolver 解析 |

---

## 三、测试验证详细记录

### 3.1 系统启动测试

| 步骤 | 结果 | 备注 |
|------|------|------|
| Docker 容器启动 (PG + Ollama) | ✅ | deepanalyze-postgres-1 和 deepanalyze-ollama-1 正常运行 |
| PostgreSQL 初始化 + 10个迁移 | ✅ | pgvector + zhparser 扩展启用 |
| 嵌入服务 (BGE-M3) | ❌ | 502 Bad Gateway，嵌入服务未运行 |
| HTTP 服务启动 (21000) | ✅ | 健康检查 `/api/health` 返回 ok |
| 前端静态文件服务 | ✅ | index.html 正常返回 |
| WebSocket 端点 | ✅ | `/ws` 端点可访问 |

### 3.2 知识库 CRUD 测试

| 操作 | 结果 | 备注 |
|------|------|------|
| 创建知识库 | ✅ | 返回完整 KB 对象 |
| 列出知识库 | ✅ | 返回 3 个已有 KB |
| 上传文档 (Markdown) | ✅ | 文件正确保存到 data/original/ |
| 文档处理状态查询 | ⚠️ | 进度可查，但卡在 compiling (60%) |
| 已有 PDF 处理状态 | ✅ | 8 个 PDF 文档状态为 ready |

### 3.3 Agent 流式对话测试

| 测试场景 | 结果 | 详情 |
|---------|------|------|
| 基础对话（无工具） | ✅ | SSE 事件流完整：start→content→progress→turn→complete→done |
| 中文响应 | ✅ | 正确使用中文回复 |
| 语言跟随 | ✅ | 用中文提问→中文回复 |
| 工具调用 (kb_search) | ✅ | 成功触发 tool_call 和 tool_result 事件 |
| 多轮工具调用 | ✅ | 一轮对话中触发 4 次工具调用 |
| Token 用量报告 | ✅ | done 事件包含 inputTokens/outputTokens/turnsUsed |

### 3.4 搜索系统测试

| 测试场景 | 结果 | 详情 |
|---------|------|------|
| KB 内搜索 (FTS) | ⚠️ | 搜索返回结果但全部是 L0 空摘要 |
| 层级过滤 (L1) | ❌ | 请求 levels=L1 返回 L0 结果，过滤失效 |
| 向量搜索 | ❌ | 嵌入数据为 0，向量搜索不可用 |
| 混合搜索 | ❌ | 无向量数据，无法执行混合搜索 |
| 跨 KB 搜索 | ❌ | `/api/search` 无实际搜索端点 |
| RRF 融合 | ❌ | 无法验证（缺少向量数据） |

### 3.5 数据质量检查

| 检查项 | 结果 | 详情 |
|--------|------|------|
| Abstract 页面内容 | ❌ | 8 个 abstract 页面全部仅含 "## 概述" 标题 |
| Structure MD 内容 | ✅ | Docling 解析内容完整，学术论文文本正确提取 |
| Structure DT 内容 | ✅ | DocTags 格式内容完整 |
| Fulltext 内容 | ✅ | 全文内容正确 |
| 嵌入覆盖率 | ❌ | 论文库 36 个页面仅 3 条嵌入记录，且均为 0 有效嵌入 |
| FTS 覆盖率 | ✅ | 36/36 页面均有 fts_vector |
| 锚点数量 | ✅ | 单文档 187 个锚点 |
| 报告页面 | ⚠️ | 4 个 report 类型页面存在（来自 agent 分析） |
