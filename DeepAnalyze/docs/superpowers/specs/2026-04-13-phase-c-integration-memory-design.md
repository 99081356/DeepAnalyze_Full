# Phase C: 体系增强 — 设计文档

**项目**: DeepAnalyze 知识库系统
**版本**: V1.0
**日期**: 2026-04-13
**状态**: 待讨论
**范围**: 问题 10(模块联动) + 11(记忆策略)
**前置依赖**: Phase A + Phase B

---

## 目录

1. [模块联动设计](#1-模块联动设计)
2. [记忆系统分层策略](#2-记忆系统分层策略)
3. [代码改动总清单](#3-代码改动总清单)
4. [实施顺序](#4-实施顺序)

---

## 1. 模块联动设计

### 1.1 当前割裂状态

四个模块各自独立运作:

| 模块 | 功能 | 与其他模块的连接 |
|------|------|----------------|
| 对话 | 用户与Agent交互 | 搜索KB时有 kb_search |
| 知识库 | 文档管理+Wiki | 被对话搜索，但不主动推送 |
| 报告 | 查看生成的报告 | 独立存在，不自动生成 |
| 任务 | Agent子任务状态 | 只显示 Agent 任务，不含文档处理 |

**核心问题**:
- 对话分析结果不会自动存入知识库（KnowledgeCompounder 已存在但未接入）
- 报告不会自动生成（需要用户手动操作）
- 知识库文档处理不在任务面板中显示
- 模块之间没有"事件驱动"的联动机制

### 1.2 联动架构: 事件驱动

新增一个轻量级事件总线，连接四个模块:

```
┌─────────┐    doc_processed     ┌──────────┐
│ 知识库   │ ───────────────────→ │ 任务面板  │
│         │    doc_ready          │          │
└────┬────┘                       └──────────┘
     │                                  ▲
     │ agent_task_complete              │
     ▼                                  │
┌─────────┐    report_generated        │
│  对话    │ ───────────────────────────┘
│  Agent  │    compound_written
└────┬────┘
     │
     │ analysis_result
     ▼
┌──────────┐
│  报告     │
│  (wiki)  │
└──────────┘
```

### 1.3 联动事件定义

```typescript
// src/services/event-bus.ts

export type SystemEvent =
  | { type: "doc_processed"; kbId: string; docId: string; filename: string; status: "ready" | "error" }
  | { type: "doc_processing_progress"; kbId: string; docId: string; step: string; progress: number }
  | { type: "agent_task_complete"; sessionId: string; taskId: string; agentType: string; output: string }
  | { type: "compound_written"; kbId: string; pageId: string; title: string }
  | { type: "report_generated"; kbId: string; reportId: string; title: string }
  | { type: "knowledge_search"; kbId: string; query: string; resultCount: number };

type EventHandler = (event: SystemEvent) => void | Promise<void>;

class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  on(eventType: string, handler: EventHandler): () => void;
  emit(event: SystemEvent): void;
}

export const eventBus = new EventBus();
```

### 1.4 各模块联动实现

#### 1.4.1 对话 → 知识库: 自动 compound

**当前**: KnowledgeCompounder (`knowledge-compound.ts`) 存在但从未被调用。

**改动**: 在 Agent 任务完成后自动触发 compound:

```typescript
// src/services/agent/agent-runner.ts (改动)

// Agent 任务完成后
eventBus.on("agent_task_complete", async (event) => {
  const { sessionId, agentType, output } = event;

  // 判断是否值得 compound
  if (!output || output.trim().length < 100) return;
  if (agentType === "coordinator") return; // coordinator 不产生直接分析结果

  // 获取当前会话关联的 KB
  const kbId = getSessionKbId(sessionId);
  if (!kbId) return;

  // 获取原始输入（用户问题）
  const input = getSessionLastUserMessage(sessionId);

  // Compound
  const compounder = new KnowledgeCompounder(DEEPANALYZE_CONFIG.dataDir);
  const linker = new Linker();
  const pageId = compounder.compoundWithEntities(kbId, output, input, linker);

  if (pageId) {
    eventBus.emit({ type: "compound_written", kbId, pageId, title: "..." });
  }
});
```

#### 1.4.2 知识库 → 任务面板: 文档处理可见

Phase A 的 ProcessingQueue 每步都发出事件:

```typescript
// ProcessingQueue 内部
this.emit({ type: "doc_processing_progress", kbId, docId, step, progress });
// 处理完成
this.emit({ type: "doc_processed", kbId, docId, filename, status: "ready" });
```

前端 TaskPanel 的 Queue tab 监听这些事件，显示文档处理进度。Phase A 中通过 WebSocket 传递这些事件即可，无需额外处理。

#### 1.4.3 对话 → 报告: 自动报告生成

**改动**: REPORT_AGENT 完成后自动注册报告:

REPORT_AGENT 已有 `report_generate` 工具。当 Agent 调用 `report_generate` 时，后端会创建报告记录。需要确保:

1. 报告同时保存为 wiki report page（已有）
2. 报告在报告面板中可见（已有）
3. Agent system prompt 引导 Agent 在完成深度分析后主动调用 `report_generate`

**system prompt 增加引导**（在 `agent-definitions.ts` 的 GENERAL_AGENT 中）:

```
## 报告生成
当你完成了一项复杂的深度分析（多文档对比、趋势分析、综合研究等），
主动使用 report_generate 工具生成结构化报告，而不是只在对话中输出。
报告会保存到知识库中，用户可以在报告面板查看和导出。
```

#### 1.4.4 任务面板统一

**当前 TaskPanel**: 三个 tab — Running / Queue / History
- Queue tab 手动遍历所有 KB 查找 parsing/compiling 状态文档
- Running tab 只显示 Agent 任务

**改动**:
- Queue tab 改为监听 `doc_processing_progress` WS 事件（Phase A 已提供）
- 新增 "全部" 视角，合并 Agent 任务 + 文档处理任务
- 统一任务类型:

```typescript
// 扩展 AgentTaskInfo
type UnifiedTaskType =
  | { kind: "agent"; agentType: string; sessionId: string }
  | { kind: "document_processing"; kbId: string; docId: string; filename: string; step: string; progress: number };
```

### 1.5 知识库 → 报告: 报告作为知识条目

KnowledgeCompounder 已经将 Agent 结果写为 `page_type="report"` 的 wiki page。这意味着:

- 报告自动进入知识库的 wiki 系统
- kb_search 能搜索到报告内容
- 报告与实体之间自动建链（compoundWithEntities）

**不需要额外改动** — 已有机制已覆盖。只需要确认 compoundWithEntities 被调用（1.4.1）。

### 1.6 前端联动导航

各模块之间需要快速跳转:

| 从 | 到 | 跳转方式 |
|----|----|---------|
| 对话中 Agent 提到文档 | 知识库该文档 | 点击文档名链接 → 切换到知识库视图并打开文档 |
| 报告面板 | 知识库 Wiki | 点击报告 → 打开 Wiki 浏览器显示该报告页 |
| 任务面板文档处理 | 知识库该文档 | 点击文档名 → 切换到知识库视图 |
| 知识库 Wiki 关联页面 | 另一文档 | 点击关联链接 → 跳转 |

实现方式:
- 统一使用 UI store 的 `setCurrentKbId()` + 视图切换
- 新增一个导航函数: `navigateToDoc(kbId, docId)` / `navigateToWikiPage(pageId)`

---

## 2. 记忆系统分层策略

### 2.1 当前三层记忆

| 层 | 实现 | 数据来源 | 存储 |
|----|------|---------|------|
| L1 工作记忆 | SessionMemory (`session-memory.ts`) | Agent 定期从对话提取 | SQLite session_memory 表 |
| L2 跨会话合成 | AutoDream (`autoDream/autoDream.ts`) | 直接从会话 transcript 扫描 | 文件系统 memdir |
| L3 知识回写 | KnowledgeCompounder (`knowledge-compound.ts`) | Agent 任务输出 | wiki report pages |

### 2.2 问题分析

**L2 AutoDream 的幻觉风险**:

`consolidationPrompt.ts` 显示 AutoDream 的工作方式:
1. 扫描 memdir 目录中已有记忆
2. **直接 grep 会话 transcript**（原始对话记录）
3. 用 LLM 从中发现"新信息"并写入记忆文件

问题:
- Transcript 包含 Agent 的推理过程、错误尝试、临时假设
- LLM 可能把这些当作"事实"提取
- 没有验证环节 — 写入的内容未经验证
- 中文 CJK 正则提取实体（`consolidationPrompt.ts` 中 2-4 字符的中文序列）过于宽泛

**L3 KnowledgeCompounder 的溯源缺失**:

`knowledge-compound.ts:89-145` 的 compoundAgentResult:
- 只保存 input 摘要和 output 全文
- 不记录引用了哪些文档/wiki 页面
- 无法追溯"这个分析结论来自哪里"

### 2.3 改进方案

#### 2.3.1 L1 工作记忆: 保持不变

SessionMemory 的工作方式合理 — 从当前会话提取关键信息，注入后续对话的 system prompt。风险低（同会话内，上下文清晰）。

唯一改进: 在 session_memory 表增加 `source_session_id` 字段用于追溯。

#### 2.3.2 L2 跨会话记忆: 增加验证门控

**核心改动**: AutoDream 不直接从 transcript 提取，改为从已 compound 的 wiki report 页面合成。

```
当前流程 (有风险):
  原始 transcript → LLM 提取 → 记忆文件

改进流程:
  wiki report pages (已验证的分析结果)
    → LLM 合成洞察
    → 标注来源 (哪些 report pages 支撑)
    → 写入记忆文件
    → 置信度评估
```

**具体改动**:

```typescript
// src/services/autoDream/consolidationPrompt.ts 改写

// 新 prompt 核心指令:
`
## Phase 2 — Gather signal (改进)

只从以下已验证来源合成:
1. Wiki report pages (page_type = 'report') — Agent 产出的分析结果
2. Session memory notes — 当前会话的工作记忆

不要从原始会话 transcript 中提取"新知识"。
Transcript 只用于理解上下文，不用于提取事实。

## Phase 3 — Consolidate (增加验证)

每条记忆必须包含:
- 来源标注: 哪个 report page 或 session 支撑这条记忆
- 置信度: high (直接来自文档) / medium (Agent 分析结论) / low (推测)
- 时间戳: 记忆产生的时间

格式:
- [HIGH] 事实内容 — 来源: [[report_page_title]]
- [MED] 分析结论 — 来源: [[report_page_title]], [[session:session_id]]
- [LOW] 推测性结论 — 来源: [[session:session_id]]
`
```

#### 2.3.3 L3 知识回写: 增加溯源链

**KnowledgeCompounder 改进**:

```typescript
// compoundWithEntities 增加溯源
compoundWithTracing(
  kbId: string,
  agentType: string,
  input: string,
  output: string,
  sources: Array<{ pageId: string; title: string }>,  // 新增: Agent 引用的来源
): string | null {
  // ... 现有逻辑 ...

  // 增加溯源部分
  const tracingSection = sources.length > 0
    ? `\n\n## 来源溯源\n${sources.map(s => `- [[${s.title}]]`).join("\n")}`
    : "";

  const content = [
    `# ${title}`,
    "",
    `> **Agent Type:** ${agentType}  `,
    `> **Generated:** ${timestamp}  `,
    `> **Confidence:** ${this.assessConfidence(output, sources)}`,
    "",
    "## Input Summary",
    "",
    inputSummary,
    "",
    "## Analysis Result",
    "",
    output,
    tracingSection,
  ].join("\n");

  // ... 保存逻辑 ...
}
```

**来源收集**: Agent 执行 kb_search / wiki_browse 时记录访问的 pageId，作为 sources 传入 compoundWithTracing。

实现方式: 在 AgentRunner 中维护一个 `accessedPages: Set<string>`，每次工具调用 kb_search/wiki_browse/expand 时收集返回的 pageId。任务完成时传给 KnowledgeCompounder。

#### 2.3.4 置信度评估

```typescript
// KnowledgeCompounder 中新增
private assessConfidence(
  output: string,
  sources: Array<{ pageId: string; title: string }>,
): "high" | "medium" | "low" {
  if (sources.length >= 3) return "high";    // 多来源支撑
  if (sources.length >= 1) return "medium";   // 单来源
  return "low";                                // 无来源（Agent 自身推理）
}
```

### 2.4 记忆系统的调用时机

```
┌───────────────────────────────────────────────┐
│              记忆写入时机                       │
├───────────────────────────────────────────────┤
│                                               │
│  实时 (每次对话):                              │
│    SessionMemory ← 对话上下文提取              │
│    触发条件: 消息数超过阈值 / token 超过阈值    │
│                                               │
│  任务完成时:                                   │
│    KnowledgeCompounder ← Agent任务输出         │
│    触发条件: Agent任务完成 + 输出>100字符       │
│    要求: 携带溯源信息                          │
│                                               │
│  定期 (后台):                                  │
│    AutoDream ← wiki report pages + session记忆│
│    触发条件: 距上次>24h 且 新report>=5         │
│    要求: 只从已验证来源合成, 标注置信度         │
│                                               │
└───────────────────────────────────────────────┘
```

```
┌───────────────────────────────────────────────┐
│              记忆读取时机                       │
├───────────────────────────────────────────────┤
│                                               │
│  新对话开始:                                   │
│    → 注入 AutoDream 的跨会话洞察到 system prompt│
│    → 按 kbId 过滤, 只注入相关的                │
│                                               │
│  Agent 执行 kb_search:                        │
│    → 搜索结果中包含 report 类型的 wiki pages   │
│    → 这些 pages 就是之前 compound 的结果       │
│                                               │
│  用户问 "之前分析过X吗":                       │
│    → kb_search 自动匹配 report pages          │
│    → 不需要特殊处理                            │
│                                               │
└───────────────────────────────────────────────┘
```

### 2.5 所有重要能力的保留

用户特别要求保留所有重要能力。三层记忆各司其职:

| 能力 | 保留方式 | 改进 |
|------|---------|------|
| 工作记忆 (同会话) | SessionMemory 不变 | — |
| 跨会话洞察 | AutoDream 改为从已验证来源合成 | 减少幻觉 |
| 分析结果持久化 | KnowledgeCompounder 增加溯源 | 增加置信度 |
| Agent 检索增强 | kb_search 已覆盖 report pages | — |
| 实体关联 | L0Linker + entity_ref 链接 | Phase B |
| 深度展开 | expand L0→L1→L2 | Phase B |
| 报告生成 | report_generate 工具 | 自动引导 |
| 时间轴 | timeline_build 工具 | 不变 |
| 知识图谱 | graph_build 工具 | 不变 |
| 网络搜索 | web_search 工具 | Phase B ScopeSelector |
| 子模型/增强模型 | 模型配置体系 | Phase A |
| Skills 编排 | Prompt模板 + 工具组合 | Phase B |

---

## 3. 代码改动总清单

### 新建文件

| 文件 | 用途 |
|------|------|
| `src/services/event-bus.ts` | 轻量级事件总线 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/services/agent/agent-runner.ts` | 任务完成后触发 compound + 事件 |
| `src/services/agent/agent-definitions.ts` | GENERAL_AGENT system prompt 增加报告引导 |
| `src/services/autoDream/consolidationPrompt.ts` | 改为从 wiki report pages 合成, 增加置信度标注 |
| `src/wiki/knowledge-compound.ts` | 增加 compoundWithTracing 方法和溯源链 |
| `frontend/src/components/tasks/TaskPanel.tsx` | 统一任务视图 (Agent + 文档处理) |
| `frontend/src/store/ui.ts` | 增加 navigateToDoc / navigateToWikiPage 导航函数 |
| `frontend/src/components/ChatWindow.tsx` | 文档链接可点击跳转 |
| `frontend/src/components/reports/ReportPanel.tsx` | 报告点击可跳转到 Wiki 浏览器 |

---

## 4. 实施顺序

```
Step 1: 事件总线
  └─ src/services/event-bus.ts

Step 2: KnowledgeCompounder 溯源
  ├─ compoundWithTracing 方法
  └─ AgentRunner 中收集 accessedPages

Step 3: 模块联动接入
  ├─ AgentRunner → eventBus.emit("agent_task_complete")
  ├─ ProcessingQueue → eventBus.emit("doc_processed") (Phase A)
  └─ compound 事件 → 报告面板刷新

Step 4: AutoDream 改进
  └─ consolidationPrompt.ts 改写

Step 5: 前端联动
  ├─ TaskPanel 统一视图
  ├─ 导航跳转函数
  └─ 各模块间的链接跳转

Step 6: System prompt 引导
  └─ agent-definitions.ts 增加报告生成引导
```
