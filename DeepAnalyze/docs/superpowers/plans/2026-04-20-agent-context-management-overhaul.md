# DeepAnalyze Agent 上下文管理系统重构

> 日期：2026-04-20 | 状态：待实施

---

## 一、背景与问题

### 1.1 项目定位

DeepAnalyze 是一个通用型 Agent 驱动的深度文档分析与任务执行平台。其核心需求（C-02/C-22/C-27）要求 Agent 具备：
- TAOR 循环（Think-Act-Observe-Reflect）的持续工作能力
- 无限轮对话中的上下文自动管理
- 自动压缩、微压缩、会话记忆持久化
- **不限于知识库场景**——Agent 应能处理任何复杂长期任务

### 1.2 当前问题

当前 Agent 的上下文管理存在以下严重缺陷：

| 问题 | 现状 | 影响 |
|------|------|------|
| 上下文加载 | 硬编码最近20条消息，无 token 感知 | 短消息浪费空间，长消息超出窗口 |
| 无压缩边界标记 | 压缩后旧消息从 DB 重新加载，压缩失效 | 下一轮请求丢失压缩结果 |
| 压缩提示词粗糙 | "1000字以内的摘要"，无结构化章节 | 丢失关键上下文、任务状态、用户意图 |
| 工具结果无预算 | 简单 100K 字符截断，无 token 控制 | 大型工具输出占满整个上下文窗口 |
| 无 PTL 重试机制 | 压缩 API 调用本身过长时，回退到极差的截断摘要 | 质量严重下降 |
| 无压缩熔断器 | 压缩失败后无限重试，浪费 token 和时间 | 级联失败 |
| 会话记忆扁平 | 4个固定章节，无重要性标记，无边界关联 | 记忆质量低，无法精确控制保留内容 |

### 1.3 目标

参照 Claude Code 的多层上下文管理架构，构建一个 **通用场景适用的、支持无限轮持续工作的** Agent 上下文管理系统。关键设计原则：

1. **Token 驱动**：所有决策基于 token 预算，而非消息条数
2. **通用适用**：提示词和机制不绑定特定领域（知识库分析只是场景之一）
3. **多层管道**：压缩边界 → 工具结果预算 → 微压缩 → 自动压缩（SM优先/LLM后备）
4. **前后端分离**：前端展示完整会话历史，上下文管理仅影响 LLM 输入

---

## 二、整体架构设计

### 2.1 数据流总览

```
[路由处理器 /run-stream]
  1. 保存用户消息到 DB
  2. 查询压缩边界（compact boundary）
  3. 仅加载边界之后的消息（或全部，如无边界）
  4. Token 感知加载：从最新消息向前累积，到达预算时停止
  5. 传递 contextMessages 给 AgentRunner

[AgentRunner TAOR 循环 - 每轮]
  a. 取消/限制检查
  b. 调用 LLM（主模型↔辅助模型自动降级）
  c. 执行工具调用
  d. 应用工具结果预算（截断超大结果）
  e. 微压缩旧工具结果（token 感知，保留最近 N 个）
  f. 检查是否需要压缩（token 阈值）
  g. 如需要：检查熔断器
     → SM-compact（无API调用，使用会话记忆）
     → Legacy compact 后备（结构化摘要 + PTL 重试）
     → 插入压缩边界标记到消息数组 + DB
  h. 更新会话记忆（结构化章节，重要性标记）
  i. 完成检查
```

### 2.2 六层上下文管道

参照 Claude Code 的 `query()` 循环，每轮 LLM 调用前按序执行：

| 层级 | 操作 | 说明 |
|------|------|------|
| L0 | 压缩边界过滤 | 只取最后一次压缩边界之后的消息 |
| L1 | 工具结果预算 | 大型工具结果截断为预览 |
| L2 | 微压缩 | 清除旧工具结果内容 |
| L3 | 自动压缩检测 | token 超过阈值时触发 |
| L4 | SM-compact | 用会话记忆替换旧消息（无 API 调用） |
| L5 | Legacy compact | LLM 生成结构化摘要（有 API 调用） |

---

## 三、分阶段实施计划

### 阶段一：Token 感知加载 + 压缩边界检测

**对应 Claude Code 模式**：`getMessagesAfterCompactBoundary()` + token 感知加载

**修改文件**：

#### 3.1.1 `src/store/repos/message.ts` — 新增边界查询

```typescript
async getLatestCompactBoundary(sessionId: string): Promise<Message | undefined> {
  const { rows } = await this.pool.query(
    `SELECT * FROM messages WHERE session_id = $1
     AND role = 'user' AND content LIKE '[COMPACT_BOUNDARY:%'
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] ? this.mapRow(rows[0]) : undefined;
}
```

同步更新 `src/store/repos/interfaces.ts` 中的 `MessageRepo` 接口。

#### 3.1.2 `src/services/agent/context-manager.ts` — 新增 Token 感知加载

```typescript
interface ContextLoadResult {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  estimatedTokens: number;
}

loadContextMessages(
  allMessages: Array<{ role: string; content: string }>,
  maxTokens: number,
): ContextLoadResult
```

从最新消息向前累积 token，到达 `maxTokens` 时停止。仅包含 user/assistant 角色。

#### 3.1.3 `src/server/routes/agents.ts` — 替换固定 20 条上限

两个端点 `/run` 和 `/run-stream` 的上下文加载逻辑替换为：
1. 查询压缩边界
2. 仅加载边界之后的消息
3. Token 感知加载（预算 = `contextWindow * 0.5`）

需要将 `ModelRouter` 注入到 `createAgentRoutes()` 工厂函数中。

#### 3.1.4 `src/services/agent/types.ts` — 新增类型

```typescript
interface CompactBoundaryMeta {
  type: "compact_boundary";
  method: "sm-compact" | "legacy-compact" | "emergency-sm-compact" | "emergency-legacy-compact";
  preCompactTokens: number;
  turnNumber: number;
  timestamp: string;
}
```

---

### 阶段二：结构化压缩提示词

**对应 Claude Code 模式**：9 节摘要 + `<analysis>` 草稿板 + `formatCompactSummary()`

**修改文件**：

#### 3.2.1 `src/services/agent/compact-prompt.ts` — 新文件

通用场景适配的结构化摘要提示词（**不绑定知识库场景**）：

```
1. 用户请求与意图 — 用户的核心目标和分析需求
2. 关键信息与发现 — 分析中发现的重要事实、模式、异常
3. 工作内容与成果 — 具体执行了什么工作，产出了什么
4. 搜索与探索历史 — 执行了哪些搜索/查询，发现了什么
5. 错误与修正 — 遇到的问题及解决方案
6. 用户消息 — 所有非工具结果的用户消息（用于跟踪意图变化）
7. 未完成事项 — 尚未回答的问题或未完成的任务
8. 当前工作状态 — 压缩发生时正在做什么
9. 建议的下一步 — 基于当前进展应继续做什么（附原始对话引用）
```

同时包含：
- `NO_TOOLS_PREAMBLE`：明确告知模型不要调用工具
- `<analysis>` 草稿板要求：模型先分析后总结
- `<summary>` 包装要求：最终输出用此标签包裹
- `formatCompactSummary()`：去除 analysis 块，解包 summary 标签
- `getCompactUserSummaryMessage()`：构建延续消息 "本会话是从之前的对话继续的..."

#### 3.2.2 `src/services/agent/compaction.ts` — 使用新提示词

替换 `generateSummary()` 中的通用 "1000字摘要" 为结构化提示词：
- `maxTokens: 2000` 输出
- 使用 `formatCompactSummary()` 后处理
- 保留 `truncationSummary()` 作为最终后备

---

### 阶段三：工具结果预算管理

**对应 Claude Code 模式**：`applyToolResultBudget()`、`COMPACTABLE_TOOLS`、每结果 token 限制

**修改文件**：

#### 3.3.1 `src/services/agent/types.ts` — 新增设置

```typescript
// AgentSettings 新增：
toolResultMaxTokens: number;    // 默认: 4000（约 16K 字符）
toolResultKeepRecent: number;   // 默认: 5
```

#### 3.3.2 `src/services/agent/micro-compact.ts` — 增强

- Token 感知裁剪（替代当前基于轮次的二元判断）
- 可配置 `keepRecent` 数量（默认 5 个最近工具结果受保护）
- 每结果 token 限制：超过 `toolResultMaxTokens` 的结果截断为预览
- 返回 `MicroCompactResult { messages, prunedCount, tokensSaved }`

#### 3.3.3 `src/services/agent/agent-runner.ts` — 工具执行时应用预算

替换当前 100K 字符硬截断为 token 预算：
```typescript
// 超大结果生成预览：
resultContent.substring(0, previewChars)
  + `\n\n[... 结果已截断：共 ${resultTokens} tokens，显示前 ~${maxTokens}]`
```

---

### 阶段四：压缩熔断器

**对应 Claude Code 模式**：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，半开状态超时恢复

**修改文件**：

#### 3.4.1 `src/services/agent/compaction.ts` — 新增类

```typescript
class CompactionCircuitBreaker {
  canAttempt(): boolean      // 电路关闭或半开（60s后）返回 true
  recordSuccess(): void      // 重置失败计数，关闭电路
  recordFailure(): void      // 递增失败计数，3次后打开电路
}
```

集成到 `CompactionEngine.compact()`：
- 压缩前检查 `circuitBreaker.canAttempt()`
- 成功时 `recordSuccess()`
- 失败时 `recordFailure()`

---

### 阶段五：增强 SM-Compact + 压缩边界写入 + PTL 重试

**对应 Claude Code 模式**：`calculateMessagesToKeepIndex()`、`adjustIndexToPreserveAPIInvariants()`、压缩边界写入、PTL 重试循环

**修改文件**：

#### 3.5.1 `src/services/agent/compaction.ts`

**增强 SM-compact**：
- 替换 `keepRecentTokens = effectiveWindow * 0.6` 为预算制：
  - `minTokens = 10,000`（必须保留的最近上下文最小量）
  - `maxTokens = 40,000`（保留上限）
  - 从尾部向前累积 token，到达 maxTokens 或满足 minTokens 时停止
- 截断超大会话记忆内容（>3000 tokens）
- `adjustForToolPairs()`：确保不会拆分 tool_use/tool_result 配对

**压缩边界写入**：
- SM-compact 和 legacy compact 完成后，向消息数组插入边界标记
- 同时通过 `repos.message.create()` 持久化到 DB，使跨 HTTP 请求有效
- 边界消息携带 `CompactBoundaryMeta` 到 metadata JSON 字段

**PTL 重试循环（legacy compact）**：
- 包装 `generateSummary()` 在重试循环中（最多 3 次）
- 当摘要调用返回 PTL 错误时，截断最旧消息组并重试
- 使用 `groupMessages()` 找到组边界进行干净截断
- 最终后备：`truncationSummary()`

#### 3.5.2 `src/services/agent/types.ts` — 新增

```typescript
interface SMCompactConfig {
  minTokens: number;   // 默认: 10,000
  maxTokens: number;   // 默认: 40,000
}

// AgentSettings 新增：
smCompactMinTokens: number;   // 默认: 10,000
smCompactMaxTokens: number;   // 默认: 40,000
```

---

### 阶段六：增强会话记忆

**对应 Claude Code 模式**：结构化记忆章节、`truncateSessionMemoryForCompact()`、`lastSummarizedMessageId`

**修改文件**：

#### 3.6.1 `src/services/agent/session-memory.ts`

**增强记忆提取提示词**（通用场景）：
```
## 用户意图 — 用户想要完成什么（按时间优先级）
## 关键信息与发现 — 标记 [关键]/[重要]/[背景]
## 工作内容 — 执行了什么操作，产出了什么
## 分析决策 — 方法选择、范围变更、用户反馈
## 待解决问题 — 尚未完成的任务和问题
## 当前工作状态 — 提取记忆时正在做什么 + 逻辑下一步
```

**新增功能**：
- `lastSummarizedMessageId` 跟踪：SM-compact 后存储边界消息 ID，避免重复摘要已压缩内容
- `truncateSessionMemory()`：记忆超过 3000 tokens 时，从最低重要性章节开始截断，优先保留"用户意图"和"当前工作状态"

#### 3.6.2 数据库迁移

```sql
ALTER TABLE session_memory ADD COLUMN IF NOT EXISTS last_summarized_message_id TEXT;
```

新建迁移文件 `src/store/pg-migrations/009_session_memory_enhance.ts`

#### 3.6.3 `src/store/repos/session-memory.ts`

更新 `save()` 和 `load()` 方法以支持新字段。

---

## 四、实施顺序

依赖关系决定构建顺序：

```
阶段一（Token 加载 + 边界检测）     ← 独立，立即可修复
阶段二（结构化压缩提示词）           ← 独立，提升质量
阶段三（工具结果预算）               ← 独立
阶段四（熔断器）                     ← 独立
阶段五（增强 SM-compact + 边界写入） ← 依赖阶段 2、3、4
阶段六（增强会话记忆）               ← 依赖阶段 5
```

---

## 五、关键文件清单

| 文件 | 角色 | 阶段 |
|------|------|------|
| `src/services/agent/context-manager.ts` | Token 感知加载，窗口计算 | 1 |
| `src/services/agent/compaction.ts` | 核心压缩：SM、Legacy、熔断器、边界 | 1, 4, 5 |
| `src/services/agent/compact-prompt.ts` | **新文件** 结构化摘要提示词 + formatCompactSummary | 2 |
| `src/services/agent/micro-compact.ts` | Token 感知工具结果裁剪 | 3 |
| `src/services/agent/session-memory.ts` | 增强提取，重要性标记，截断 | 6 |
| `src/services/agent/types.ts` | 新接口、设置、CompactBoundaryMeta | 1-6 |
| `src/server/routes/agents.ts` | 边界感知 + Token 感知上下文加载 | 1 |
| `src/store/repos/message.ts` | getLatestCompactBoundary() | 1 |
| `src/store/repos/session-memory.ts` | lastSummarizedMessageId 持久化 | 6 |
| `src/services/agent/agent-runner.ts` | 工具结果预算，边界持久化 | 3, 5 |
| `src/store/pg-migrations/` | session_memory 表新列迁移 | 6 |

---

## 六、验证计划

1. **单元验证**：每个新方法独立测试（loadContextMessages、formatCompactSummary、熔断器、token 感知微压缩）

2. **集成验证**：创建会话，发送 10+ 条消息，验证：
   - 上下文加载遵守 token 预算（非消息条数）
   - 压缩后边界保存到 DB
   - 下一轮请求仅加载边界之后的消息
   - SM-compact 产出带重要性标记的结构化记忆
   - Legacy compact 产出 9 节结构化摘要
   - 熔断器在 3 次失败后打开
   - PTL 重试循环截断并重试

3. **长对话验证**：在会话中发送 50+ 条消息，验证 Agent 全程保持上下文不丢失。确认压缩在正确的 token 阈值触发。

4. **通用任务验证**：执行一个非知识库的复杂持续任务（如"帮我规划并撰写一份完整的市场分析报告"），验证 Agent 在无知识库绑定情况下也能持续工作。

5. **前端验证**：确认压缩边界消息不会出现在聊天 UI 中（过滤 `[COMPACT_BOUNDARY:` 前缀的内容）。

---

## 七、与 Claude Code 的关键差异说明

| 方面 | Claude Code | DeepAnalyze（本方案） |
|------|-------------|----------------------|
| API 缓存共享 | 使用 Anthropic 缓存前缀共享 + fork | 不适用（OpenAI 兼容 API） |
| 缓存编辑微压缩 | API 层面删除缓存工具结果 | 不适用 |
| 文件级上下文 | 跟踪已读/已改文件，压缩后重注入 | 仅跟踪 wiki 页面访问（用于溯源） |
| 环境 injection | 每轮注入工作目录、git 状态等 | 不适用（非 IDE 场景） |
| Compact prompt | 面向代码开发 | 面向通用任务执行 |
| Post-compact 附件 | 重注入文件内容、skill、plan | 重注入会话记忆 |
