# 第 4 册：知识检索、Agent 体系与工具系统

> **文档日期**: 2026-04-20
> **来源**: 综合 04-08 Agent 设计、04-13 Phase B/C、04-14 多 Agent 架构、04-18 子项目 4/5

---

## 1. 知识检索系统

### 1.1 融合检索策略

参考 LightRAG 的混合检索思路，DeepAnalyze 使用三层融合检索：

```
查询文本
  ├─→ 向量检索 (pgvector HNSW, cosine similarity)
  ├─→ 全文检索 (PostgreSQL zhparser 中文分词, BM25)
  └─→ 合并排序 (RRF: Reciprocal Rank Fusion)
       ↓
  去重后的有序结果列表
```

### 1.2 按层级检索

| 层级 | 检索方式 | 用途 |
|------|---------|------|
| Abstract | 仅向量检索 | 文档级路由，判断哪些文档与查询相关 |
| Structure | 向量 + BM25 + grep | 核心检索层，章节级精度 |
| Raw | 不建索引，按需加载 | 通过锚点定位后直接读取 JSON 片段 |

### 1.3 跨知识库检索 (04-18 设计)

`kb_search` 工具支持传入多个 `kbId`：
- 各库独立检索，RRF 合并去重
- 搜索结果标注来源知识库
- 聊天页上传文档自动创建临时知识库，搜索时自动纳入范围

### 1.4 检索参数

```typescript
interface SearchOptions {
  query: string;
  kbIds: string[];              // 支持多知识库
  mode: 'semantic' | 'vector' | 'hybrid';  // 检索模式
  topK: number;                 // 召回数量 (5/10/20/50)
  levels: ('abstract' | 'structure' | 'raw')[];  // 检索层级
}
```

---

## 2. Agent 体系

### 2.1 Agent 引擎架构

基于 Claude Code harness 改造，核心循环为 **TAOR** (Think-Act-Observe-Reflect)：

```
用户提问
  ↓
AgentRunner.run()
  ├─ Think: 分析问题，规划下一步
  ├─ Act: 调用工具 (kb_search / Read / Grep / ...)
  ├─ Observe: 收集工具返回结果
  └─ Reflect: 评估进度，决定是否继续
  ↓
循环直到任务完成或达到 turn 上限
  ↓
上下文压缩 (超过窗口时自动触发)
  ↓
流式返回结果 (SSE)
```

### 2.2 Agent 类型与角色

| Agent 类型 | 职责 | 使用模型 |
|-----------|------|---------|
| `general` | 通用对话和知识问答 | 主模型 |
| `report` | 深度分析报告生成 | 主模型 |
| `explore` | 信息探索和收集 | 辅助模型 |
| `compile` | 信息汇总和编译 | 辅助模型 |
| `verify` | 结论验证和交叉检查 | 辅助模型 |
| `coordinator` | 多 Agent 协调 | 辅助模型 |

### 2.3 主/辅模型分离 (04-18 设计)

```typescript
const mainModel = await this.getModelForRole('main');
const subModel = await this.getModelForRole('summarizer');
const effectiveModel = this.useSubModel(agentType) ? subModel : mainModel;
```

- 主 Agent（general、report）→ 主模型（如 Claude Opus）
- 子 Agent（explore、compile、verify、coordinator）→ 辅助模型（如 GPT-4o）
- 故障时自动切换到另一个模型

### 2.4 多 Agent 调度模式 (WorkflowEngine)

来自 CountBot 移植的 WorkflowEngine，支持 4 种调度模式：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **Sequential** | 串行执行，前一个输出作为后一个输入 | 线性分析流程 |
| **Parallel** | 并行执行，结果汇总 | 独立子任务同时处理 |
| **Council** | 多 Agent 独立分析同一问题，投票/综合 | 需要多角度验证的问题 |
| **Graph** | DAG 依赖图，按依赖关系执行 | 复杂多步骤分析 |

Council 模式两轮：
- Round 1：所有 Agent 并行独立分析
- Round 2：并行 (`Promise.allSettled`) 综合各 Agent 结果

### 2.5 WorkflowEngine 修复 (04-18)

- 增加 `AbortController` 支持取消正在运行的工作流
- 结果持久化到 `agent_tasks` 表
- 进度估算基于已完成/总 Agent 数

### 2.6 上下文管理

| 机制 | 说明 |
|------|------|
| **自动压缩 (Compaction)** | 上下文超过窗口 75% 时触发，保留关键信息摘要 |
| **微压缩 (Micro-compact)** | 增量式压缩，避免一次性丢失过多信息 |
| **会话记忆 (Session Memory)** | 持久化到数据库，跨会话保留 |
| **分层策略** | 短期记忆（当前对话）+ 长期记忆（历史总结） |

### 2.7 Auto-Dream (后台处理)

系统空闲时自动执行的后台任务：
- 重新处理标记为 stale 的嵌入
- 知识库之间的交叉引用更新
- 定期重编译过时的摘要

---

## 3. 工具系统

### 3.1 保留的 Claude Code 工具

| 工具 | 用途 | 改动 |
|------|------|------|
| `Read` | 读取文件内容 | 保留 |
| `Grep` | 文件内容搜索 | 保留 |
| `Glob` | 文件模式匹配 | 保留 |
| `WebSearch` | 网络搜索 | 增强（见下） |
| `Bash` | 执行命令 | 保留（沙箱） |
| `FileEdit` | 编辑文件 | 保留 |

### 3.2 新增的知识库工具

| 工具 | 用途 | 说明 |
|------|------|------|
| `kb_search` | 知识库检索 | 支持语义/向量/混合模式，支持多知识库 |
| `kb_browse` | 浏览知识库内容 | 列出文档、Wiki 页面树 |
| `kb_expand` | 展开查看 Raw 层 | 通过锚点定位到原始内容 |
| `kb_ingest` | 手动触发知识摄入 | 处理队列外的特殊需求 |

### 3.3 web_search 实现 (04-18 设计)

支持两种后端：
- **SearXNG**（自部署）：`http://localhost:8888/search?q=...&format=json`
- **Serper API**（云端）：`https://google.serper.dev/search`

自动检测可用性，降级为"搜索不可用"提示。

### 3.4 工具注册与 Skill 系统

工具通过 Plugin/Skill 体系扩展：

```
Plugin
  ├── 元数据 (id, name, description, version)
  ├── Skills[]
  │   ├── 每个 Skill 定义触发条件
  │   ├── 工具函数实现
  │   └── Prompt 模板
  └── 配置 Schema
```

---

## 4. 记忆系统

### 4.1 分层记忆策略

```
┌─────────────────────────────────────┐
│ 工作记忆 (Working Memory)           │
│ - 当前对话上下文                     │
│ - 自动压缩 (超过窗口75%)             │
│ - 微压缩 (增量式)                    │
├─────────────────────────────────────┤
│ 会话记忆 (Session Memory)           │
│ - 持久化到 session_memory 表         │
│ - 跨轮对话的关键信息保留              │
│ - token 位置追踪                     │
├─────────────────────────────────────┤
│ 知识记忆 (Knowledge Memory)          │
│ - 知识库中的所有文档和 Wiki           │
│ - 三层结构：Raw/Structure/Abstract   │
│ - 通过 kb_search 工具访问            │
└─────────────────────────────────────┘
```

### 4.2 会话记忆持久化

```typescript
interface SessionMemoryRepo {
  load(sessionId: string): Promise<SessionMemory | undefined>;
  save(sessionId: string, content: string, tokenCount: number, lastTokenPosition: number): Promise<void>;
  listRecent(limit: number): Promise<Array<{sessionId: string; content: string}>>;
}
```

---

## 5. 报告系统

### 5.1 报告类型

| 类型 | 说明 |
|------|------|
| 分析报告 | Agent 深度分析后生成的结构化报告 |
| 时间线报告 | 从文档数据中提取的时序事件 |
| 知识图谱 | 力导向图可视化 |

### 5.2 报告引用

报告中的每个结论都关联到源文档的锚点，支持溯源：
- 报告 → 段落 → Structure 页面 → Raw 层锚点 → 原始文档

### 5.3 报告存储

```typescript
interface ReportRepo {
  create(data: CreateReportData): Promise<ReportWithReferences>;
  get(id: string): Promise<ReportWithReferences | undefined>;
  getByMessageId(messageId: string): Promise<ReportWithReferences | undefined>;
  list(limit?: number, offset?: number): Promise<Report[]>;
  listBySession(sessionId: string): Promise<Report[]>;
  delete(id: string): Promise<boolean>;
}
```
