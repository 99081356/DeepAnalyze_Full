# DeepAnalyze 深度分析系统 - 架构设计文档

**项目名称**：DeepAnalyze（深度分析系统）
**文档版本**：V1.0
**日期**：2026-04-08
**状态**：已确认

---

## 目录

1. [项目定位与核心目标](#1-项目定位与核心目标)
2. [整体架构](#2-整体架构)
3. [Agent Service层（Claude Code改造核心）](#3-agent-service层claude-code改造核心)
4. [Wiki知识引擎](#4-wiki知识引擎)
5. [React前端界面](#5-react前端界面)
6. [工具系统与数据流](#6-工具系统与数据流)
7. [存储层与数据模型](#7-存储层与数据模型)
8. [项目代码结构与改造清单](#8-项目代码结构与改造清单)
9. [分阶段实施路线图](#9-分阶段实施路线图)

---

## 1. 项目定位与核心目标

### 1.1 项目定位

通用型Agent驱动深度文档分析与报告生成平台。通过Plugin/Skill体系适配不同垂直场景（公检法、金融审计、研究分析等），底层Agent引擎和知识系统完全通用。

### 1.2 核心目标

1. **Agent驱动的多轮深度分析**：基于Claude Code的harness实现多轮推理、父子Agent调度、自动上下文压缩的长程任务处理能力
2. **知识预编译与复利积累**：参考Karpathy LLM Wiki理念，文档摄入时即完成分层编译，知识持续增长而非一次性RAG
3. **无损可溯源**：所有分析结论可逐层展开追溯到原始文档精确位置
4. **通用可扩展**：通过Plugin/Skill机制适配不同场景，核心系统与领域逻辑解耦
5. **单机一体化部署**：单进程启动，SQLite存储，支持离线运行

### 1.3 技术决策汇总

| 决策项 | 选择 | 理由 |
|--------|------|------|
| Agent引擎 | 基于Claude Code TS代码保留大部分+增加新工具 | 复用成熟的harness工程能力 |
| 知识系统 | TS实现L0/L1/L2分层Wiki | Agent自身作为知识编译器，统一技术栈 |
| 前端 | 全新React+TypeScript+Tailwind | 自由设计，参考AIE专业风格 |
| Docling | Python子进程，主程序管理生命周期 | 解耦但同步启停 |
| LLM接入 | 多模型统一接入（本地+远端API） | 灵活适配不同部署环境 |
| 向量检索 | SQLite-vec+BGE-M3本地优先，支持外部服务 | 本地化优先，可扩展 |
| 场景适配 | 通用平台+Plugin/Skill体系 | 核心通用，场景可插拔 |
| 部署 | 单进程一体化 | 便携易部署 |

### 1.4 代码来源与复用策略

| 来源 | 复用方式 | 复用范围 |
|------|----------|----------|
| Claude Code | 代码级复用+改造 | Agent harness核心(query loop、tool system、context management、parent-child dispatch、compaction) |
| OpenViking | 设计参考+部分代码参考 | L0/L1/L2分层抽象的TS实现思路、Semantic DAG的异步编译流程 |
| lossless-claw-enhanced | 设计参考+部分代码参考 | DAG无损压缩的摘要树结构、CJK Token估算、expand/grep工具设计 |
| Docling | 作为Python子进程调用 | 文档解析pipeline，不改其代码 |
| Karpathy LLM Wiki | 理念指导 | 摄入时编译、知识复利积累、正反向链接、Ingest/Query/Lint三大操作 |
| AIE | 前端设计参考 | 参考其专业UI风格，不直接复用代码 |

---

## 2. 整体架构

### 2.1 架构总览

```
+---------------------------------------------------------------------+
|                        DeepAnalyze 单进程                            |
|                                                                     |
|  +-- React SPA 前端 ----------------------------------------------+ |
|  |  聊天对话 | 知识库浏览器 | 文档管理 | 报告查看 | 任务面板      | |
|  +------------------------------+---------------------------------+ |
|                                 | WebSocket + REST API              |
|  +-- Agent Service (TS/Bun) ----+--------------------------------+  |
|  |                                                             |  |
|  |  +-- 1. 核心Harness (来自Claude Code，保留+改造) ----------+|  |
|  |  |  Query Loop (TAOR)                                     ||  |
|  |  |  Tool Registry & Orchestration                         ||  |
|  |  |  Parent-Child Agent Dispatch                           ||  |
|  |  |  Context Compaction & Memory                           ||  |
|  |  |  Streaming Response Pipeline                           ||  |
|  |  +--------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- 2. 模型接入层 (改造Claude Code) ---------------------+|  |
|  |  |  多模型统一路由 (OpenAI兼容协议)                        ||  |
|  |  |  支持本地ONNX/远端API多种LLM后端                        ||  |
|  |  +--------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- 3. 服务层 (新增) -------------------------------------+|  |
|  |  |  HTTP/WS Server (Hono, 替代CLI)                        ||  |
|  |  |  Session Manager                                        ||  |
|  |  |  Auth Module                                            ||  |
|  |  +--------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- 4. Wiki知识引擎 (新增，参考OpenViking+lossless-claw) -+|  |
|  |  |  L0/L1/L2 分层编译器                                    ||  |
|  |  |  正反向链接管理器                                        ||  |
|  |  |  向量索引引擎 (SQLite-vec + BGE-M3)                    ||  |
|  |  |  全文检索引擎 (SQLite FTS5)                             ||  |
|  |  |  融合排序器 (RRF)                                       ||  |
|  |  +--------------------------------------------------------+|  |
|  |                                                             |  |
|  |  +-- 5. 工具集 (Claude Code全部保留+新增) -----------------+|  |
|  |  |  保留: Read/Grep/Glob/WebSearch/Bash/FileEdit/...     ||  |
|  |  |  新增: kb_search/kb_ingest/wiki_browse/expand/...     ||  |
|  |  |  新增: report_generate/timeline_build/graph_build      ||  |
|  |  |  新增: docling_parse/vlm_analyze                       ||  |
|  |  +--------------------------------------------------------+|  |
|  |                                                             |  |
|  +-------------------------------------------------------------+  |
|                                                                     |
|  +-- 子进程管理 --------------------------------------------------+ |
|  |  Docling Parser (Python) -- 进程池管理，主程序启停             | |
|  |  VLM Service (可选) -- 本地模型或远端API                       | |
|  +---------------------------------------------------------------+ |
|                                                                     |
|  +-- 存储层 ------------------------------------------------------+ |
|  |  SQLite数据库 (单文件)                                         | |
|  |    +-- 元数据表 (文档、会话、用户)                              | |
|  |    +-- 向量索引 (sqlite-vec)                                    | |
|  |    +-- 全文索引 (FTS5)                                          | |
|  |    +-- Wiki页面表 + 链接关系表                                  | |
|  |    +-- 审计日志表                                               | |
|  |  文件系统                                                       | |
|  |    +-- original/ (原始文档，不可变)                              | |
|  |    +-- wiki/ (L0/L1/L2编译后的Wiki页面)                         | |
|  |    +-- reports/ (生成的分析报告)                                 | |
|  +---------------------------------------------------------------+ |
+---------------------------------------------------------------------+
```

### 2.2 运行模型

- **单进程启动**：`deepanalyze` 命令启动Bun主进程，自动拉起Docling Python子进程
- **前端服务**：内嵌静态文件服务，浏览器访问 `http://localhost:21000`
- **数据目录**：可通过配置指定，支持外部存储/U盘迁移
- **模型配置**：首次配置LLM/嵌入模型端点，支持本地ONNX或远端API

---

## 3. Agent Service层（Claude Code改造核心）

### 3.1 改造策略

从Claude Code的代码中识别三个层级的代码：

| 级别 | 说明 | 处理方式 |
|------|------|----------|
| **核心保留** | Agent harness的骨架代码 | 保留原样，仅做最小改动适配 |
| **需要改造** | 与CLI/权限/Anthropic API耦合的部分 | 修改接口，适配新需求 |
| **去掉替换** | CLI显示层 | 删除，替换为HTTP/WS服务 |

### 3.2 核心保留模块

**a) Query Loop** (`src/query.ts` -> `deepanalyze/src/core/query.ts`)

- TAOR循环：Think -> Act -> Observe -> Repeat
- 流式响应处理：`queryModelWithStreaming()`
- 自动压缩触发：token用量达到阈值时触发compaction
- 改动：仅替换API调用层，从Anthropic专有改为统一模型接入

**b) Tool Registry & Orchestration** (`src/services/tools/`)

- 工具注册表：Tool接口定义(name, inputSchema, call, isConcurrencySafe)
- 工具编排：只读工具并发执行(最多10个)，写工具串行执行
- 工具执行：`toolExecution.ts` 的执行+结果收集流程
- 改动：去掉权限检查中的审核确认逻辑，改为自动批准

**c) Parent-Child Agent Dispatch** (`src/tools/AgentTool/`)

- `runAgent.ts`：核心子Agent运行器，创建隔离的ToolUseContext，调用query()
- `forkSubagent.ts`：共享父上下文的fork模式，利用prompt cache
- `builtInAgents.ts`：内置Agent类型定义
- 改动：增加新的内置Agent类型(ExploreAgent、CompileAgent、VerifyAgent等)

**d) Context Compaction** (`src/services/compact/`)

- 自动压缩：上下文窗口 - 13K buffer 触发
- 压缩操作：按API轮次分组摘要
- 微压缩：针对大工具结果的定向压缩
- 紧急压缩：处理prompt_too_long错误
- 改动：集成lossless-claw的CJK Token估算修正

**e) Memory System** (`src/services/SessionMemory/` + `src/services/autoDream/`)

- 会话记忆提取、Agent输出摘要
- autoDream后台整合：空闲时自动整理对话记忆，提取长期知识模式
- 用户偏好画像：基于记忆系统积累用户分析习惯、关注重点、常用检索模式，作为后续检索和分析的个性化辅助
- 长程任务支持：通过记忆系统在上下文压缩后保留关键信息，确保长任务不丢失目标
- 改动：无，完整保留包括autoDream

### 3.3 需要改造的模块

**a) API接入层** (`src/services/api/`)

```
改造前:
  claude.ts -> Anthropic SDK -> Claude API

改造后:
  modelRouter.ts -> 多种后端适配器
    +-- OpenAI兼容适配器 (Claude API / 本地模型 / 其他)
    +-- Anthropic原生适配器 (保留，用于Claude特有能力)
    +-- 配置化的模型路由 (按任务类型选择模型)
```

核心改造点：
- 定义统一的 `ModelProvider` 接口：`chat(messages, options)` / `stream(messages, options)`
- 支持配置多个模型端点，通过YAML配置文件管理
- 工具调用格式做统一适配（不同模型的tool_call格式不同）

**b) 权限系统** (`src/utils/permissions.ts` 等)

- 移除所有需要用户交互确认的权限检查点
- 工具调用全部自动批准，不阻塞Agent执行
- 保留权限的概念但降级为日志记录（审计用途）

**c) CLI层** (`src/` 根目录的CLI入口)

去掉整个CLI交互层，替换为HTTP/WebSocket服务：
- 新增 `src/server/` 目录：Hono轻量HTTP框架
- WebSocket端点用于流式输出
- REST API端点用于会话管理、知识库操作、文件上传
- 静态文件服务托管React前端

**d) Context Assembly** (`src/context.ts`)

改造上下文组装：
- 组装当前知识库的概览上下文
- 组装当前分析任务的上下文（用户选定的文档范围、分析目标）
- 组装Wiki的index.md作为导航入口
- 保留CLAUDE.md类似机制，改名为 `SYSTEM.md`，定义系统行为规范

### 3.4 保留的并行多Agent能力

Claude Code支持通过Coordinator模式/Swarm机制并行启动多个子Agent进行分布式分析，这一能力对深度分析系统至关重要：

**a) Coordinator模式** (`src/utils/swarm/`)

- 主Agent可以将大任务拆解为多个独立子任务，同时启动多个子Agent并行执行
- 每个子Agent拥有独立的上下文和工具集，互不干扰
- 典型应用场景：用户提出复杂问题 → 主Agent分析后同时启动多组检索任务（按不同关键词、不同文档范围、不同检索策略分组并行）→ 各子Agent独立完成后聚合结果
- 优势：大幅缩短多文档检索时间，提升分析效率

**b) 并行调度策略**

```
用户: "全面分析张三与李四的关系"
        |
        v
  主Agent拆解为多个并行方向:
    ├── 并行Agent-1: 检索"张三+李四+转账"相关的L0/L1
    ├── 并行Agent-2: 检索"张三+李四+通话"相关的L0/L1
    ├── 并行Agent-3: 检索"张三+李四+共同活动"相关的L0/L1
    ├── 并行Agent-4: 通过链接遍历发现间接关联
    └── 并行Agent-5: 在Excel表格中搜索两人共同出现的记录
        |
        v
  各Agent完成后聚合 → 去重 → 构建完整关系图 → 生成报告
```

### 3.5 去掉的模块

| 原模块 | 处理 |
|--------|------|
| CLI显示层 (ink/react TUI) | 删除，替换为HTTP API |
| Bridge (Claude.ai连接) | 删除 |

注意：所有Claude Code原有工具（Bash、FileEdit、FileWrite、Git、LSP等）、完整记忆系统（SessionMemory、autoDream）、并行多Agent能力（Coordinator/Swarm）全部原样保留，不做功能裁减。能力越完整，系统通用性越强。

### 3.6 内置Agent类型（通用基础，不含领域逻辑）

内置Agent只提供与领域无关的基础能力抽象，所有场景特定的Agent行为通过Plugin注入：

```typescript
// 探索Agent: 只读，在知识库中多轮检索探索
ExploreAgent: {
  tools: [kb_search, wiki_browse, read, grep, glob],
  readOnly: true,
  systemPrompt: "你负责在知识库中进行多轮深度检索..."
}

// 执行Agent: 可读写，执行具体子任务
WorkerAgent: {
  tools: [全量工具集],
  readOnly: false,
  systemPrompt: "你负责执行主Agent分配的子任务..."
}

// 验证Agent: 只读，对结果做交叉校验
VerifyAgent: {
  tools: [kb_search, read, grep, glob],
  readOnly: true,
  systemPrompt: "你负责验证结论是否有据可查..."
}

// 编译Agent: 可写，负责文档到Wiki的分层编译
CompileAgent: {
  tools: [read, write, wiki_edit, embedding_generate],
  readOnly: false,
  systemPrompt: "你负责将文档内容编译为分层Wiki页面..."
}
```

### 3.7 Plugin/Skill体系（领域扩展机制）

**Plugin**：定义Agent的行为规范和流程约束。

```yaml
# plugins/judicial-evidence/plugin.yaml
name: judicial-evidence
version: 1.0
description: 司法证据分析场景插件

# 注册场景特定的Agent定义
agents:
  evidence-search:
    extends: ExploreAgent
    systemPrompt: |
      你是司法证据检索专家...
    tools: [kb_search, wiki_browse, read, grep]

  contradiction-check:
    extends: VerifyAgent
    systemPrompt: |
      你是证据矛盾校验专家...

  timeline-builder:
    extends: WorkerAgent
    tools: [...parentTools, timeline_build, graph_build]

# 场景特定的Prompt增强
promptEnhancements:
  mainAgent: |
    在分析司法案件时，请注意：
    - 所有结论必须100%基于卷宗内容
    - 区分客观证据与推理结论

# 场景特定的工具注册
tools:
  - evidence-chain-builder
  - legal-reference-search

# 场景特定的报告模板
reportTemplates:
  - name: 证据分析报告
    template: reports/evidence-analysis.md
```

**Skill**：定义具体的原子能力，可以被任何Agent调用。

```yaml
# skills/xlsx-analyzer/skill.yaml
name: xlsx-analyzer
description: 大表格实时分析能力
triggers:
  - fileTypes: [xlsx, csv]
  - keywords: [统计, 汇总, 分析表格, 流水]

tools:
  - name: xlsx_query
    description: 对Excel文件执行SQL查询
    inputSchema:
      filePath: string
      sql: string
      description: string

execution:
  type: python-subprocess
  script: skills/xlsx-analyzer/executor.py
```

**加载机制**：
- 系统启动时扫描 `plugins/` 和 `skills/` 目录
- 根据用户创建项目时选择的场景类型，自动加载对应的Plugin
- Skill按需加载，Agent根据任务内容判断是否需要调用特定Skill
- 用户可在前端界面管理Plugin/Skill的启用/禁用

**核心区别**：
- **内置Agent** 是骨架（通用能力抽象）
- **Plugin** 塑造行为（领域流程规范、角色定义、提示词增强）
- **Skill** 赋予能力（具体工具、处理逻辑）

### 3.8 Agent执行流程示例

以"分析这批文档中张三的所有资金往来"为例：

```
1. 主Agent接收用户请求
   -> 理解任务，制定检索计划

2. 主Agent利用并行调度能力，同时派发多组子Agent:
   -> 并行ExploreAgent-1: 搜索包含"张三"的L0摘要，锁定候选文档
   -> 并行ExploreAgent-2: 在候选文档的L1概览中搜索"转账|汇款|支付"
   -> 并行ExploreAgent-3: 搜索与张三关联的实体(通过正反向链接)
   -> 并行ExploreAgent-4: 在Excel大表格中搜索张三相关记录

3. 多组子Agent并行完成后，主Agent聚合结果
   -> 去重、交叉验证、判断信息完整性
   -> 发现银行流水未覆盖 -> 派发新子Agent补充检索

4. 信息充足后，派发WorkerAgent(报告合成)
   -> 整合所有证据片段，构建时间线
   -> 生成带溯源标注的结构化报告

5. 派发VerifyAgent验证
   -> 对报告中每条结论反向检索验证

6. 主Agent返回最终报告给用户
   -> 记忆系统提取关键信息，更新用户偏好画像
```

---

## 4. Wiki知识引擎

### 4.1 核心理念

- **AOT预编译**：文档摄入时即完成分层抽象、关联构建，查询时直接检索已编译的Wiki
- **知识复利**：每次有价值的分析结果可以回写为新的Wiki页面，知识持续增长
- **无损可溯**：任何摘要节点都可逐层展开到原始文档的精确位置

### 4.2 Wiki三层结构

每份文档经Docling解析后，由CompileAgent编译为三层内容：

```
L0 - 摘要 (.abstract.md)     ~100 tokens
 +-- 一句话核心摘要
 +-- 5-10个关键实体标签
 +-- 文档类型标签

L1 - 概览 (.overview.md)     ~2000 tokens
 +-- 文档结构导航(章节标题+各节核心摘要)
 +-- 关键实体列表(人物、机构、地点、时间、金额等)
 +-- 正向链接: "本文档提到了哪些外部实体/事件"
 +-- 反向链接: "哪些其他文档引用了本文档的内容"
 +-- 数据摘要(如果是表格: Schema+统计摘要+前N行样例)

L2 - 全文 (原始结构化文档)    无限制
 +-- Docling输出的完整Markdown
 +-- 保留完整的结构信息(标题层级、表格、图片引用)
 +-- 每个段落绑定溯源元数据(来源文件、页码、位置)
```

### 4.3 存储结构

```
data/
  wiki/
    {knowledge-base-id}/
      index.md                  # 知识库全局索引
      log.md                    # 操作时间日志
      documents/
        {doc-id}/
          original.ext          # 原始文件(不可变)
          parsed.md             # Docling解析输出(L2)
          .overview.md          # L1概览
          .abstract.md          # L0摘要
          metadata.json         # 溯源元数据
      entities/
        {entity-name}.md        # 实体页面(自动生成)
      concepts/
        {concept-name}.md       # 概念页面(自动生成)
      reports/
        {report-id}.md          # 分析报告(可回写为Wiki页面)
```

### 4.4 文档摄入流程

```
用户上传文档
      |
      v
  文件类型分流
      |
      +-- PDF/Word/PPT/图片 --> Docling解析(Python子进程)
      |                              |
      |                              v
      |                        DoclingDocument
      |                        (结构化Markdown + 元数据)
      |
      +-- Excel/CSV --> Docling提取元数据+Schema
      |                 原始文件保留不动
      |                 (大表格不入库全量内容)
      |
      +-- 纯文本/Markdown --> 直接作为L2内容
                                    |
                                    v
                            CompileAgent接收解析结果
                                    |
                            +-------+--------+
                            v                v
                     生成L2全文          记录溯源元数据
                     (parsed.md)        (metadata.json)
                            |
                            v
                     生成L1概览
                     (.overview.md)
                      Agent读取L2全文
                      提取结构导航、实体、摘要
                            |
                            v
                     生成L0摘要
                     (.abstract.md)
                      Agent读取L1概览
                      压缩为一句话+标签
                            |
                            v
                     更新索引和链接
                      +-- 更新 index.md
                      +-- 扫描现有Wiki页面，发现关联实体->更新正反向链接
                      +-- 生成/更新实体页面 (entities/{name}.md)
                      +-- 向量嵌入(L0+L1)
                      +-- FTS5全文索引(L2)
                            |
                            v
                     写入 log.md 操作记录
```

关键设计点：
- 编译过程由Agent驱动，Agent用自己的推理能力做摘要和实体提取，不需要专门的NER模型
- L0->L1->L2逐层编译，每层有明确的token预算约束
- 大表格特殊处理：仅入库元数据+Schema+样例行，原始文件保留供Skill按需分析
- 图片经VLM生成内容描述，描述文本纳入L0/L1层参与检索

### 4.5 正反向链接机制

- **正向链接**：文档A中提及的实体/概念，在文档B中有详细描述 -> A中生成指向B的链接
- **反向链接**：在B的页面中标注"被哪些文档引用" -> 形成双向关联
- 链接在L1概览层维护（L0太精简）
- 链接存储为结构化数据（SQLite表），同时渲染到.md文件中
- 链接粒度：文档级 + 实体级

### 4.6 检索引擎

三路融合检索，Agent通过 `kb_search` 工具调用：

**a) 向量语义检索**
- 对L0摘要和L1概览生成BGE-M3向量嵌入
- 存储在SQLite-vec扩展中
- 查询时先搜L0快速过滤候选文档，再搜L1做重排序

**b) BM25精确检索**
- 对L2全文建FTS5索引
- 用于专有名词、编号、精确标识符的匹配
- 支持CJK分词

**c) 关联遍历检索**
- 基于正反向链接表，从命中文档出发遍历关联文档

**融合排序**：RRF（倒数排名融合）合并三路结果。

检索流程：
```
Agent检索请求
    |
    v
  L0向量检索 --> 候选文档集 (Top-50)
  L1向量检索 --> 在候选集内重排序
  L2 BM25检索 -> 精确匹配补充
  链接遍历 ---> 关联文档扩展
    |
    v
  RRF融合排序 -> Top-K结果
    |
    v
  返回(含L0摘要+L1概览+L2定位)
  Agent可按需通过expand工具逐层展开细节
```

### 4.7 Wiki健康检查（参考Karpathy Lint）

定期由Agent执行Wiki健康维护：

- **矛盾检测**：不同文档中同一实体的描述是否冲突
- **孤儿页面**：没有任何链接指向的Wiki页面
- **缺失链接**：提及了某实体但该实体没有独立页面
- **陈旧摘要**：L0/L1摘要是否还准确反映L2内容
- **索引同步**：index.md与实际页面是否一致

可作为后台定时任务运行，也可由用户手动触发。

### 4.8 expand工具（参考lossless-claw）

Agent在检索到摘要后，可通过expand工具逐层展开到原始细节：

```
Agent检索 -> 命中某文档的L0摘要
  |
  v expand(doc-id, level=L1)
  展开到L1概览 -> 看到更详细的结构和实体
  |
  v expand(doc-id, level=L2, section="第3章")
  展开到L2全文的特定章节 -> 看到原文内容
  |
  v expand(doc-id, level=raw, position="page:5,para:2")
  展开到原始文件的精确位置 -> 查看原始文档
```

---

## 5. React前端界面

### 5.1 技术栈

| 选型 | 说明 |
|------|------|
| React 19 + TypeScript | 核心框架 |
| Tailwind CSS | 样式 |
| Zustand | 状态管理 |
| React Router | 页面路由 |
| Socket.IO Client | WebSocket实时通信 |
| Recharts / D3 | 图表可视化（时间线、关系图谱） |
| Vite | 构建工具 |

设计风格参考AIE前端界面，保持专业、美观、统一的设计语言。

### 5.2 页面结构

```
+---------------------------------------------------------------------+
|  DeepAnalyze                                      [用户] [设置]     |
+----------+----------------------------------------------------------+
|          |                                                          |
| 侧边栏   |              主内容区                                     |
|          |                                                          |
| v 项目A  |   (根据左侧选择展示不同内容)                              |
|   对话   |                                                          |
|   知识库 |                                                          |
|   报告   |                                                          |
|   任务   |                                                          |
|          |                                                          |
| v 项目B  |                                                          |
|   ...    |                                                          |
|          |                                                          |
| -------- |                                                          |
| 插件管理 |                                                          |
| 系统设置 |                                                          |
+----------+----------------------------------------------------------+
```

### 5.3 核心页面

**a) 对话页面**（主工作区）

- 子任务实时进度展示（Agent派发子Agent时的进度流）
- 工具调用过程可视化（展开/收起每个工具调用的输入输出）
- 溯源链接可点击（跳转到原文档对应位置并高亮）
- 支持上传文件作为对话附件
- "范围"选择器：限定当前对话检索的知识库/文档范围

**b) 知识库浏览页面**

- 按文档类型/标签筛选浏览
- L0->L1->L2逐层展开查看
- 实体页面和概念页面浏览（类维基百科的链接跳转）
- 知识库搜索（语义+精确混合检索）
- 文档上传入口（拖拽上传，触发后台编译）

**c) 报告页面**

- 报告在线查看和编辑
- 时间线和关系图谱的交互式可视化
- 溯源链接全部可点击跳转
- 导出为PDF/Word/Markdown

**d) 任务面板**

- 正在执行的Agent任务树（主Agent -> 子Agent的层级关系）
- 每个子任务的状态（等待/执行中/完成/失败）
- 文档编译队列进度
- Wiki健康检查状态
- 历史任务记录

**e) 设置与插件页面**

- LLM模型配置（添加/管理多个模型端点）
- 嵌入模型配置
- 插件管理（安装/启用/禁用/配置场景插件）
- Skill管理（浏览/启用/禁用/自定义）
- 知识库管理（创建/删除/权限设置）
- 系统参数配置

### 5.4 实时通信设计

Agent执行时通过WebSocket向前端推送事件流：

```typescript
type AgentEvent =
  | { type: 'thinking', content: string }
  | { type: 'tool_call', tool: string, input: any }
  | { type: 'tool_result', tool: string, output: any }
  | { type: 'subtask_start', taskId: string, agent: string }
  | { type: 'subtask_progress', taskId: string, progress: any }
  | { type: 'subtask_complete', taskId: string, result: any }
  | { type: 'text_stream', content: string }
  | { type: 'complete', result: any }
  | { type: 'error', error: string }
```

前端根据事件类型渲染不同的UI组件（思考状态、工具卡片、子任务进度条、流式文本等）。

---

## 6. 工具系统与数据流

### 6.1 工具体系

**保留工具**（来自Claude Code，全部原样保留）：

| 工具 | 说明 |
|------|------|
| Read | 读取文件、图片、PDF、Notebook |
| FileEdit | 文件内容精确编辑 |
| FileWrite | 文件写入 |
| Grep | 内容搜索 |
| Glob | 文件模式匹配 |
| Bash | Shell命令执行 |
| WebSearch | 联网搜索 |
| WebFetch | URL内容抓取 |
| AgentTool | 父子Agent调度 |
| Task系列 | 任务管理 |
| Skill | Skill调用 |
| MCPTool | MCP扩展 |
| LSP | 语言服务协议 |
| Git相关 | Git操作 |

**新增工具**（知识系统与分析能力）：

| 工具 | 说明 |
|------|------|
| kb_search | 知识库统一检索（向量+BM25+链接融合） |
| wiki_browse | Wiki页面和链接浏览 |
| expand | 摘要逐层展开到细节 |
| kb_ingest | 文档摄入和编译 |
| wiki_edit | Wiki页面编辑 |
| wiki_lint | Wiki健康检查 |
| report_generate | 报告生成 |
| timeline_build | 时间线构建 |
| graph_build | 关系图谱构建 |
| docling_parse | 调用Docling解析文档 |
| vlm_analyze | 调用VLM分析图片 |

### 6.2 新增工具接口定义

**知识检索工具组**：

```typescript
// kb_search: 知识库统一检索入口
kb_search: {
  input: {
    query: string,
    scope?: {
      knowledgeBases?: string[],
      documentIds?: string[],
      tags?: string[],
    },
    mode: 'semantic' | 'exact' | 'hybrid' | 'linked',
    topK?: number,
    levels?: ('L0' | 'L1' | 'L2')[],
  },
  output: {
    results: [{
      docId: string,
      level: string,
      content: string,
      score: number,
      metadata: object,
    }],
    totalFound: number,
  }
}

// wiki_browse: 浏览Wiki页面和链接关系
wiki_browse: {
  input: {
    path: string,
    direction?: 'forward' | 'backward' | 'both',
    depth?: number,
  },
  output: {
    page: { content: string, metadata: object },
    links: { forward: Link[], backward: Link[] },
  }
}

// expand: 从摘要逐层展开到细节
expand: {
  input: {
    docId: string,
    currentLevel: 'L0' | 'L1' | 'L2',
    targetLevel: 'L1' | 'L2' | 'raw',
    section?: string,
    position?: string,
    tokenBudget?: number,
  },
  output: {
    content: string,
    level: string,
    metadata: object,
    expandable: boolean,
  }
}
```

**知识编译工具组**：

```typescript
// kb_ingest: 触发文档摄入和编译
kb_ingest: {
  input: {
    filePaths: string[],
    knowledgeBaseId: string,
    options?: { priority: 'normal' | 'high', skipVLM?: boolean }
  },
  output: { taskId: string, status: 'queued' | 'processing' }
}

// wiki_edit: 编辑Wiki页面内容
wiki_edit: {
  input: {
    path: string,
    operation: 'create' | 'update' | 'append',
    content: string,
    metadata?: object,
  }
}

// wiki_lint: 触发Wiki健康检查
wiki_lint: {
  input: {
    knowledgeBaseId: string,
    checks?: ('contradiction' | 'orphans' | 'missing_links' | 'stale_summaries' | 'index_sync')[],
  }
}
```

**分析与报告工具组**：

```typescript
// report_generate: 生成结构化分析报告
report_generate: {
  input: {
    title: string,
    templateId?: string,
    evidenceIds: string[],
    analysisContext: string,
    format: 'markdown' | 'pdf' | 'docx',
  }
}

// timeline_build: 从证据中构建时间线
timeline_build: {
  input: {
    events: Array<{
      timestamp: string,
      description: string,
      sourceId: string,
      sourceLocation: string,
      confidence: 'confirmed' | 'inferred',
    }>,
    groupBy?: 'day' | 'month' | 'entity',
  }
}

// graph_build: 从实体和关系中构建关系图谱
graph_build: {
  input: {
    entities: Array<{ name: string, type: string }>,
    relations: Array<{
      from: string, to: string,
      relation: string,
      sourceId: string,
      confidence: 'confirmed' | 'inferred',
    }>,
  }
}
```

**文档处理工具组**：

```typescript
// docling_parse: 调用Docling解析文档
docling_parse: {
  input: {
    filePath: string,
    options?: { ocr: boolean, vlm: boolean, extractTables: boolean }
  },
  output: {
    parsedContent: string,
    metadata: object,
    tables: Table[],
    images: ImageRef[],
  }
}

// vlm_analyze: 调用VLM分析图片内容
vlm_analyze: {
  input: {
    imagePaths: string[],
    prompt?: string,
  },
  output: {
    descriptions: Array<{
      imagePath: string,
      description: string,
      extractedText?: string,
    }>,
  }
}
```

### 6.3 核心数据流

**数据流1：文档摄入与编译**

```
前端上传文件 -> POST /api/documents/upload
  -> 保存原始文件到 original/
  -> 主Agent收到上传事件
  -> 调用 docling_parse 工具
     -> IPC发送给Docling子进程 -> 返回解析结果
  -> 派发 CompileAgent
     -> 生成L2全文(parsed.md)
     -> 生成L1概览(.overview.md)
     -> 生成L0摘要(.abstract.md)
     -> 更新实体页面和链接
     -> 生成向量嵌入
     -> 更新FTS5索引
     -> 更新index.md和log.md
  -> 前端通过WebSocket收到编译完成通知
```

**数据流2：用户提问与Agent检索**

```
前端发送消息 -> WebSocket /ws/chat
  -> 主Agent接收消息
     -> 组装上下文(知识库概览+对话历史+SYSTEM.md)
     -> LLM推理(Think)
     -> 决定调用 kb_search(Act)
        -> L0向量检索 -> L1向量检索 -> L2 BM25检索 -> 链接遍历 -> RRF融合
  -> 主Agent观察检索结果(Observe)
     -> 信息不足 -> 调整查询再次检索
     -> 需要展开细节 -> 调用expand
     -> 需要并行探索 -> 派发多个ExploreAgent
  -> 信息充足 -> 生成分析结论
     -> 可选：report_generate / timeline_build
  -> 流式返回结果给前端（含溯源标注）
```

**数据流3：知识复利回写**

```
Agent完成分析任务
  -> 主Agent判断分析结果是否有持久化价值
  -> 有价值时调用 wiki_edit 创建新的Wiki页面
     -> 生成分析摘要页面
     -> 更新相关实体页面
     -> 更新index.md和正反向链接
     -> 生成向量嵌入
     -> 写入log.md
  -> 该分析结果成为知识库的一部分，后续检索可被引用
```

### 6.4 多模型路由设计

```yaml
# model-config.yaml
models:
  # 主推理模型(用于Agent的Think阶段)
  main:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: deepseek-r1
    maxTokens: 128000
    supportsToolUse: true

  # 备用主模型
  main-fallback:
    provider: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    model: claude-sonnet-4-20250514

  # 嵌入模型(用于向量检索)
  embedding:
    provider: local-onnx
    modelPath: ./models/bge-m3.onnx
    dimension: 1024

  # VLM模型(用于图片分析)
  vlm:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: qwen2.5-vl-7b

  # 摘要模型(用于L0/L1生成，可用较小模型)
  summarizer:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: qwen2.5-7b
```

路由逻辑：
- Agent主循环 -> `main` 模型
- 文档编译(L0/L1生成) -> `summarizer` 模型
- 向量嵌入 -> `embedding` 模型
- 图片分析 -> `vlm` 模型
- 所有模型接口统一为OpenAI兼容协议，Anthropic原生作为可选适配器

---

## 7. 存储层与数据模型

### 7.1 存储架构

```
data/                              # 数据根目录(可配置)
  deepanalyze.db                   # SQLite主数据库(单文件)
  original/                        # 原始文档(不可变)
    {kb-id}/{doc-id}/{filename.ext}
  wiki/                            # Wiki编译产物
    {kb-id}/
      index.md
      log.md
      documents/{doc-id}/parsed.md|.overview.md|.abstract.md|metadata.json
      entities/{entity-name}.md
      concepts/{concept-name}.md
  reports/                         # 生成的报告
  uploads/                         # 临时上传目录
  models/                          # 本地模型权重(可选)
    bge-m3.onnx
  cache/                           # 缓存(LLM响应缓存等)
```

### 7.2 SQLite数据库Schema

```sql
-- ============ 知识库管理 ============
CREATE TABLE knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_id TEXT NOT NULL,
  visibility TEXT DEFAULT 'private',  -- private | team | public
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ 文档管理 ============
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,            -- MD5不可变
  file_size INTEGER,
  file_type TEXT,
  status TEXT DEFAULT 'uploaded',     -- uploaded | parsing | compiling | ready | error
  metadata TEXT,                      -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id)
);

-- ============ Wiki页面 ============
CREATE TABLE wiki_pages (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  doc_id TEXT REFERENCES documents(id),
  page_type TEXT NOT NULL,            -- abstract | overview | fulltext | entity | concept | report
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT,
  token_count INTEGER,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ Wiki链接关系 ============
CREATE TABLE wiki_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id TEXT NOT NULL REFERENCES wiki_pages(id),
  target_page_id TEXT NOT NULL REFERENCES wiki_pages(id),
  link_type TEXT NOT NULL,            -- forward | backward | entity_ref | concept_ref
  entity_name TEXT,
  context TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ 标签系统 ============
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id),
  name TEXT NOT NULL,
  category TEXT,                       -- auto | custom
  UNIQUE(kb_id, name)
);

CREATE TABLE document_tags (
  doc_id TEXT NOT NULL REFERENCES documents(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (doc_id, tag_id)
);

-- ============ 向量索引(sqlite-vec) ============
CREATE VIRTUAL TABLE vec_embeddings USING vec0(
  id INTEGER PRIMARY KEY,
  page_id TEXT,
  level TEXT,
  embedding FLOAT[1024]
);

-- ============ 全文索引(FTS5) ============
CREATE VIRTUAL TABLE fts_content USING fts5(
  page_id,
  kb_id,
  level,
  content,
  tokenize 'unicode61'
);

-- ============ 会话管理 ============
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  kb_scope TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ 用户 ============
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ 审计日志 ============
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============ Agent任务 ============
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT,
  session_id TEXT REFERENCES sessions(id),
  agent_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  input TEXT,
  output TEXT,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

-- ============ Plugin/Skill注册 ============
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  enabled INTEGER DEFAULT 1,
  config TEXT
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  plugin_id TEXT REFERENCES plugins(id),
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  config TEXT
);

-- ============ 系统配置 ============
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 7.3 关键数据操作

**文档编译状态流转**：
```
uploaded -> parsing(Docling处理中) -> compiling(Agent编译L0/L1/L2中)
         -> ready(可检索) -> error(处理失败)
```

**向量嵌入更新策略**：
- 文档编译完成时，对L0摘要和L1概览生成嵌入并写入vec_embeddings
- 文档更新时，先删除旧嵌入再写入新嵌入
- 嵌入模型切换时，全量重建嵌入（后台异步任务）

**FTS5索引更新策略**：
- 文档编译完成时，对L2全文写入fts_content
- 利用SQLite触发器保证wiki_pages与fts_content的同步

---

## 8. 项目代码结构与改造清单

### 8.1 目录结构

```
deepanalyze/
  package.json
  tsconfig.json
  bunfig.toml

  src/
    main.ts                          # 程序入口
    config/
      default.yaml
      model-schema.yaml

    # 核心Harness(来自Claude Code，保留改造)
    core/
      query.ts
      context.ts
      permissions.ts
      types.ts
      state.ts

    # 工具系统(保留+新增)
    tools/
      ReadTool/
      FileEditTool/
      FileWriteTool/
      GrepTool/
      GlobTool/
      BashTool/
      WebSearchTool/
      WebFetchTool/
      AgentTool/
        runAgent.ts
        forkSubagent.ts
        builtInAgents.ts
      TaskCreateTool/
      TaskGetTool/
      TaskUpdateTool/
      TaskListTool/
      SkillTool/
      MCPTool/
      KBSearchTool/
      WikiBrowseTool/
      ExpandTool/
      KBIngestTool/
      WikiEditTool/
      WikiLintTool/
      ReportGenerateTool/
      TimelineBuildTool/
      GraphBuildTool/
      DoclingParseTool/
      VLMAnalyzeTool/

    # 模型接入层(改造)
    models/
      router.ts
      provider.ts
      openai-compatible.ts
      anthropic.ts
      embedding.ts
      token-estimate.ts

    # 服务层
    services/
      compact/
        compact.ts
        micro-compact.ts
      memory/
        SessionMemory/            # 会话记忆(来自Claude Code)
        autoDream/                # 后台记忆整合(来自Claude Code)
        user-profile.ts           # 用户偏好画像(新增)
      agent-summary/
      tools/
        toolOrchestration.ts
        toolExecution.ts
        StreamingToolExecutor.ts
    # 并行调度(来自Claude Code，保留)
    swarm/
      coordinator.ts              # Coordinator模式
      parallel-dispatch.ts        # 并行Agent调度

    # HTTP/WS服务(新增)
    server/
      app.ts
      routes/
        chat.ts
        documents.ts
        knowledge.ts
        wiki.ts
        reports.ts
        tasks.ts
        settings.ts
        plugins.ts
      websocket.ts
      auth.ts
      static.ts

    # Wiki知识引擎(新增)
    wiki/
      compiler.ts
      linker.ts
      indexer.ts
      retriever.ts
      expander.ts
      linter.ts
      page-manager.ts
      entity-extractor.ts

    # 存储层(新增)
    store/
      database.ts
      migrations/
        001_init.ts
      documents.ts
      wiki-pages.ts
      wiki-links.ts
      sessions.ts
      tasks.ts
      audit.ts

    # 子进程管理(新增)
    subprocess/
      manager.ts
      docling-client.ts
      vlm-client.ts

    # Plugin/Skill系统(保留)
    plugins/
      loader.ts
      registry.ts
    skills/
      loader.ts
      registry.ts

    # 工具函数
    utils/
      streaming.ts
      hash.ts
      format.ts

    # 类型定义
    types/
      index.ts
      wiki.ts
      document.ts
      agent.ts
      api.ts

  # Docling解析服务(Python子进程)
  docling-service/
    main.py
    parser.py
    requirements.txt
    models/

  # React前端
  frontend/
    package.json
    vite.config.ts
    tsconfig.json
    index.html
    src/
      App.tsx
      main.tsx
      api/
        client.ts
        endpoints.ts
        websocket.ts
      store/
        chat.ts
        knowledge.ts
        documents.ts
        wiki.ts
        reports.ts
        tasks.ts
        settings.ts
        plugins.ts
      pages/
        Chat/
        Knowledge/
        Documents/
        Wiki/
        Reports/
        Tasks/
        Settings/
        Plugins/
      components/
        ChatWindow/
        MessageList/
        ToolCallCard/
        SubtaskProgress/
        TimelineView/
        GraphView/
        DocumentViewer/
        WikiBrowser/
        SearchBar/
        FileUpload/
        Sidebar/
        Header/
      styles/
      hooks/
      types/

  # 默认插件目录
  plugins/
    judicial-evidence/
      plugin.yaml
      agents/
      prompts/
      report-templates/
    financial-audit/
      plugin.yaml

  # 默认Skill目录
  skills/
    xlsx-analyzer/
      skill.yaml
      executor.py
    pdf-extractor/
      skill.yaml
    image-analyzer/
      skill.yaml

  # 配置文件
  config/
    default.yaml
    model-schema.yaml

  # 启动脚本
  scripts/
    start.ts
    dev.ts

  # 数据目录(运行时生成，不入版本控制)
  data/
    deepanalyze.db
    original/
    wiki/
    reports/
    uploads/
    models/
    cache/
```

### 8.2 Claude Code代码改造清单

| 优先级 | 模块 | 改造内容 | 影响范围 |
|--------|------|----------|----------|
| P0 | 程序入口 | 新建main.ts，启动HTTP/WS服务替代CLI | 1个新文件 |
| P0 | API调用层 | 将Anthropic SDK调用替换为统一模型路由 | ~5个文件 |
| P0 | 权限系统 | 去掉所有用户交互确认，改为自动批准+日志 | ~10个文件 |
| P0 | 上下文组装 | 去掉git状态/CLAUDE.md编码上下文，改为知识库上下文+SYSTEM.md | context.ts |
| P1 | CLI层 | 删除ink/react TUI相关代码 | ~20个文件 |
| P1 | Bridge层 | 删除Claude.ai桥接代码 | ~5个文件 |
| P1 | 记忆系统 | 保留autoDream和SessionMemory，增加用户偏好画像提取逻辑 | SessionMemory/ |
| P1 | 并行调度 | 保留Swarm/Coordinator模式，适配新Agent类型 | swarm/ |
| P1 | 特定工具默认行为 | 调整Bash等工具的默认提示词，适应分析场景 | 各工具目录 |
| P2 | 内置Agent | 增加Explore/Compile/Verify等Agent类型 | builtInAgents.ts |
| P2 | 父子调度 | 适配新的Agent类型到调度系统 | AgentTool/ |
| P2 | 压缩系统 | 集成CJK Token估算修正 | compact/ |

**需要从Claude Code中复制的核心文件**（约50-60个关键文件）：

```
src/query.ts                          # Agent主循环
src/context.ts                        # 上下文组装(需改造)
src/Tool.ts                           # Tool接口定义
src/tools/                            # 全部工具实现
src/services/compact/                 # 上下文压缩
src/services/tools/                   # 工具编排与执行
src/services/SessionMemory/           # 会话记忆
src/services/autoDream/               # 后台记忆整合(保留)
src/services/AgentSummary/            # Agent摘要
src/utils/swarm/                      # 并行多Agent调度(保留)
src/utils/                            # 工具函数
src/types/                            # 类型定义
src/state/                            # 状态管理
```

**不需要复制的文件**：

```
src/bridge/                           # Claude.ai桥接
src/commands/                         # CLI斜杠命令(改造为Plugin命令)
src/services/lsp/                     # LSP(保留但初期不激活)
```

### 8.3 技术依赖

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0",
    "sqlite-vec": "^0.1",
    "hono": "^4.0",
    "zod": "^3.0",
    "yaml": "^2.0",
    "onnxruntime-node": "^1.20",
    "ws": "^8.0",
    "eventsource": "^2.0",
    "pino": "^9.0"
  }
}
```

---

## 9. 分阶段实施路线图

### 阶段0：项目骨架搭建

**目标**：建立项目结构，跑通基本构建和启动流程。

- 初始化项目目录结构、package.json、tsconfig
- 从Claude Code复制核心Harness文件(query.ts、Tool.ts、工具目录、compact目录等)
- 编译通过，确保Bun能加载所有TS模块
- 新建main.ts作为入口，启动一个最简HTTP服务返回"ok"
- 搭建React前端项目骨架(Vite + React + Tailwind)，显示空白页面
- SQLite数据库初始化(migration脚本)

**验收标准**：`bun run dev` 启动后，浏览器访问看到空白前端页面，后端健康检查接口返回200。

### 阶段1：最小Agent对话

**目标**：跑通Agent主循环，前端能发消息、收到流式回复。

- 改造API调用层：实现模型路由器(openai-compatible适配器)，替换Anthropic SDK
- 改造权限系统：去掉确认机制，自动批准
- 改造上下文组装：用SYSTEM.md替代CLAUDE.md
- 新增WebSocket端点，实现消息收发
- 前端实现聊天界面：消息列表、输入框、流式文本显示
- 会话管理：新建/切换/删除会话

**验收标准**：前端发送消息 -> 后端Agent调用LLM -> 流式返回文本 -> 前端实时显示。工具调用暂不需要工作。

### 阶段2：工具系统就绪

**目标**：保留的Claude Code工具全部可用，新增文档处理工具。

- 确保所有保留工具(Read、FileEdit、FileWrite、Bash、Grep、Glob等)在新项目中正常工作
- 实现工具调用流式事件推送(tool_call、tool_result事件)
- 前端实现工具调用卡片展示
- 新增Docling子进程管理：启动Python进程、IPC通信
- 新增docling_parse工具：调用Docling解析文档
- 前端实现文件上传功能
- 前端实现工具调用过程的可视化(展开/收起)

**验收标准**：上传PDF -> Docling解析 -> Agent读取解析结果 -> 回复用户文件内容摘要。Bash工具可以执行命令。

### 阶段3：Wiki知识引擎核心

**目标**：文档摄入后自动编译为L0/L1/L2，支持基础检索。

- 实现Wiki编译器：L2全文保存 -> L1概览生成(Agent驱动) -> L0摘要生成
- 实现嵌入模型集成：ONNX Runtime加载BGE-M3，生成向量
- 实现SQLite-vec向量索引写入和查询
- 实现FTS5全文索引写入和查询
- 新增kb_search工具：向量语义+BM25精确的融合检索
- 新增expand工具：从L0逐层展开到L2
- 实现正反向链接：编译时自动提取实体，构建链接关系
- 新增wiki_browse工具：浏览页面和链接
- 数据库migration：wiki_pages、wiki_links、vec_embeddings、fts_content等表

**验收标准**：上传5份测试文档 -> 自动编译为三层 -> 用kb_search检索 -> expand展开细节 -> 看到正反向链接。

### 阶段4：父子Agent与多轮检索

**目标**：实现Agent派发子Agent并发检索，多轮迭代完成复杂分析任务。

- 确保AgentTool(父子调度)在新项目中正常工作
- 新增内置Agent类型：ExploreAgent、CompileAgent、VerifyAgent
- 主Agent能根据任务拆解子任务，派发子Agent并发执行
- 子Agent结果汇总，主Agent判断是否需要继续迭代
- 新增TaskCreate等任务工具，Agent能追踪子任务进度
- 前端实现子任务进度面板：显示Agent任务树、状态流转
- 上下文压缩系统确认可用：长对话自动触发compaction

**验收标准**：用户提出复杂分析请求 -> 主Agent拆解为3+子任务 -> 并发派发子Agent检索 -> 多轮迭代 -> 汇总返回完整分析结果。

### 阶段5：报告与分析能力

**目标**：Agent能生成结构化报告、时间线、关系图谱。

- 新增report_generate工具：按模板生成Markdown/PDF报告
- 新增timeline_build工具：从证据构建时间线
- 新增graph_build工具：从实体关系构建图谱
- 新增wiki_lint工具：Wiki健康检查
- 实现知识复利回写：有价值的分析结果自动生成Wiki页面
- 前端实现报告页面：在线查看、编辑、导出
- 前端实现时间线可视化(Recharts或D3)
- 前端实现关系图谱可视化(力导向图)
- 前端实现溯源链接跳转

**验收标准**：Agent完成分析 -> 自动生成带溯源标注的报告 -> 前端展示时间线和关系图谱 -> 溯源链接可点击跳转到原文。

### 阶段6：Plugin/Skill系统与场景适配

**目标**：Plugin/Skill体系可用，内置司法场景示例插件。

- 实现Plugin加载器：扫描plugins/目录，解析plugin.yaml
- 实现Skill加载器：扫描skills/目录，解析skill.yaml
- Plugin能注册自定义Agent定义、提示词增强、报告模板
- 前端实现插件管理页面：安装、启用、禁用、配置
- 前端实现Skill管理页面
- 实现judicial-evidence示例插件
- 实现xlsx-analyzer示例Skill
- 新增模型配置前端页面：多模型端点管理
- 新增知识库浏览前端页面：文档列表、L0/L1/L2展开、实体跳转

**验收标准**：安装judicial-evidence插件后，Agent的行为和报告格式自动适配司法场景。xlsx-analyzer Skill能处理大表格。

### 阶段7：打磨与生产化

**目标**：系统稳定可靠，可交付使用。

- VLM集成：图片内容描述和OCR增强
- CJK Token估算修正（参考lossless-claw）
- 审计日志完善：全操作留痕
- 用户认证与权限（基础版）
- 错误处理与恢复：子进程崩溃自动重启、任务失败重试
- 前端UI打磨：参考AIE专业风格，统一设计语言
- 性能优化：大文档批量编译、检索缓存
- 部署打包：单可执行文件或单目录打包
- 使用文档和示例

**验收标准**：系统能稳定处理100+文档的知识库，支持多用户并发使用，可单机部署交付。

### 阶段依赖关系

```
阶段0 (骨架)
  |
  v
阶段1 (Agent对话)
  |
  v
阶段2 (工具就绪)
  |
  v
阶段3 (Wiki知识引擎) <-- 核心阶段
  |
  v
阶段4 (多轮检索)     <-- 核心阶段
  |
  v
阶段5 (报告分析)
  |
  v
阶段6 (Plugin/Skill)
  |
  v
阶段7 (生产化)
```
