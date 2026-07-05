# Per-Task 完全并行架构设计

**日期**：2026-06-19
**状态**：提案（待评审）
**关联**：替代 2026-06-19 初版"共享会话锁"方案；与 #10 修复（taskId 匹配）天然契合
**核心目标**：移除会话级互斥锁，实现同会话内多 Agent / 多 Skill 完全并行执行

---

## 1. 背景与设计转向

### 1.1 原始问题

`activeSessionRuns: Map<sessionId, taskId>`（`agents.ts:47`）是 DA 唯一的会话级互斥锁，但**只有 `/run-stream` 参与其中**。`/run-skill`（`agents.ts:1349`）和 `/run`（`agents.ts:477`）都不参与，造成跨端点并发风险。

### 1.2 为什么放弃"共享会话锁"方案

初版提案建议把 `/run-stream`、`/run-skill`、`/run` 统一纳入 `activeSessionRuns` 互斥。**该方案被否决**，原因：

1. **与 DA 已有能力自相矛盾**：子 Agent（workflow）早已支持同会话并行。主 Agent 并行是其自然延伸。
2. **违背"通用 Agent 平台"定位**：CLAUDE.md 明确要求 DA 不能弱于主流 Agent 产品（Claude Code、OpenClaw 等），这些都支持多任务并行。
3. **与 #10 刚做的 taskId 匹配机制相悖**：taskId 匹配**本就是为并行设计**——每个 task 独立 taskId、独立 draft、独立匹配。初版分析把因果关系搞反了。
4. **人为限制无法在技术上自圆其说**：DB 层 per-row 隔离、事件层 per-taskId 隔离、AsyncLocalStorage per-task 隔离——并发写不会破坏数据完整性。

### 1.3 新方向：Per-Task 完全隔离

**核心原则**：每个 Agent 调用是一个独立 task，可在任意会话、任意数量并行。

**保留的限制**：仅全局资源限制 `MAX_CONCURRENT_AGENT_RUNS = 8`（OOM 防护），不针对特定会话。

**移除的限制**：`activeSessionRuns` 整套机制。

---

## 2. 当前架构盘点

### 2.1 已经是 per-task 隔离的（无需改）

| 环节 | 位置 | 隔离机制 |
|------|------|---------|
| taskId | UUID 生成 | 天然唯一 |
| taskContext | `setActiveContext(taskId, ...)` + AsyncLocalStorage | per-task ALS |
| taskEventBuffer | 按 taskId 键值 | per-task 订阅 |
| 任务取消 | `orchestrator.cancel(taskId)` 按 taskId 查 AbortController | per-task |
| DB 消息行 | 每次插入独立 row + 独立 messageId | per-row |
| Agent 运行 | `orchestrator.runSingle()` 内部 `activeControllers: Map<taskId, AbortController>` | per-task |

### 2.2 阻碍并行的环节（需要改）

| 环节 | 风险 | 详情见 §3 |
|------|------|----------|
| `loadContextMessages` 不过滤 draft | 高 | §3.4 |
| 前端 `streamingMessageId` 单值 | 高 | §3.9 |
| `sendMessage` 回调不按 taskId 路由 | 高 | §3.10 |
| AskUserDialog 单值 `pendingQuestion` | 高 | §3.13 |
| Session memory 读-改-写全量覆盖 | 高 | §3.6 |
| Workflow 事件按 sessionId 过滤 | 中 | §3.5 |
| `/run-skill` 同步阻塞 HTTP | 中 | §3.2 |
| SkillBrowser `executingId` 单值 | 中 | §3.12 |
| `MAX_CONCURRENT_AGENT_RUNS` 无公平性 | 中 | §3.7 |
| 消息排序无 tiebreaker | 中 | §3.8 |
| JSONL 转录并发写 | 待查 | §3.11 |

---

## 3. 系统性影响分析与修改方案

### 3.1 删除 `activeSessionRuns`（后端）

**文件**：`src/server/routes/agents.ts`

**删除点**：
- 第 47 行：`const activeSessionRuns = new Map<string, string>();`
- 第 586-593 行：`/run-stream` 中的 mutex 检查
- 第 1048 行：`activeSessionRuns.set(body.sessionId, taskId);`
- 第 1179 行：`finally` 中的 `activeSessionRuns.delete(body.sessionId);`

**保留**：
- `activeAgentRuns++/--`（全局资源计数）
- `MAX_CONCURRENT_AGENT_RUNS = 8` 忙等循环

**注意**：删除互斥后，`/run-stream` 不再返回 409 Conflict。前端不再需要处理 409。

---

### 3.2 `/run-skill` 改造为 fire-and-forget + SSE（后端）

**当前问题**：
- 同步阻塞 HTTP（`agents.ts:1416` `await orchestrator.runSingle(...)`）
- 客户端必须等待整个 skill 执行完成才能拿到响应
- 长时间 skill（>60s）会被代理层超时切断
- 客户端断连后行为未定义
- 无流式事件，无法实时观察进展
- 直接 `repos.message.create()` 写最终消息，不走 draft 流程

**改造方案**：与 `/run-stream` 同构。差异仅在：
- 加载 skill 的 systemPrompt / toolsOverride
- 用户消息前缀 `[Skill: ${skillName}]`
- 调用 `runSingle()` 时传 `systemPromptOverride` 和 `toolsOverride`

**新流程**：
```
1. 校验 sessionId / skillId / 加载 skill
2. 预生成 taskId
3. 写 user 消息：`[Skill: ${name}] ${input}`
4. 写 draft assistant 消息：`repos.message.create(sessionId, "assistant", "", { draft: true, taskId })`
5. 设置 SSE 响应头
6. 构造 taskContext（与 /run-stream 同构，含 askUserCallback 等）
7. setActiveContext(taskId, taskContext)
8. fire-and-forget IIFE：
   - 等全局并发槽位
   - activeAgentRuns++
   - 包裹在 AsyncLocalStorage 中
   - 调用 orchestrator.runSingle({ ..., systemPromptOverride, toolsOverride })
   - 订阅 workflow 事件（按 parent taskId 过滤，见 §3.5）
   - 完成后 finalize draft：metadata = { draft: false, taskId }
   - finally: activeAgentRuns--, deleteActiveContext, 解绑事件
9. SSE 流：订阅 taskEventBuffer(taskId)，转发事件到客户端
```

**API 契约变化**（破坏性）：
- 请求不变：`POST /api/agents/run-skill { sessionId, skillId, variables, input, kbId, useAgentSkills }`
- 响应从 JSON 改为 SSE 流
- 事件类型与 `/run-stream` 一致：`start, content_delta, tool_call, tool_result, complete, done, error, ask_user, push_content, ...`

**事件载荷示例**：
```
event: start
data: {"taskId":"...","sessionId":"...","skillName":"报告生成器"}

event: content_delta
data: {"content":"正在分析..."}

event: done
data: {"taskId":"...","status":"completed","output":"...","turnsUsed":3}
```

---

### 3.3 `/run` 端点统一（后端）

**当前**：`/run` 是同步非流式端点（`agents.ts:477`），UI 不直接使用。

**方案 A（推荐）**：把 `/run` 也改成 fire-and-forget + SSE，与 `/run-stream` 完全同构。差异仅为 `/run` 不创建 draft 消息（保持纯 API 调用语义）。

**方案 B**：直接弃用 `/run`，外部调用方迁移到 `/run-stream`。后续移除。

**推荐 A**，保留 API 兼容性。

---

### 3.4 `loadContextMessages` 过滤 draft（后端）

**当前问题**（`agents.ts:108-318`）：
- DB 回退路径（第 264-269 行）按 role 过滤，**不检查 `metadata.draft`**
- 并行场景下，Task B 会读到 Task A 的半成品 draft，污染推理
- JSONL 主路径读磁盘文件，不读 messages 表，无此问题

**修改方案**：
```typescript
// 在 DB 回退路径的 filter 中加入 draft 排除
const contextCandidates = allMessages
  .slice(startIndex, -1)
  .filter((m) => {
    if (m.role !== "user" && m.role !== "assistant") return false;
    if (m.content.startsWith("[COMPACT_BOUNDARY:")) return false;
    // 新增：排除其他并行任务的未完成 draft
    const meta = typeof m.metadata === "string"
      ? safeJsonParse(m.metadata, {})
      : (m.metadata ?? {});
    if (meta.draft === true) return false;
    return true;
  });
```

**JSONL 路径**：无需修改（不读 messages 表）。

**额外清理**：增加后台任务定期清理"僵尸 draft"（task 崩溃后 `draft=true` 永远残留）。可选实现：
```typescript
// 定期清理：删除 1 小时前创建的 draft 消息
async function cleanupStaleDrafts(repos) {
  await repos.message.deleteStaleDrafts(60 * 60 * 1000);
}
```

---

### 3.5 Workflow 事件按 parent taskId 过滤（后端）

**当前问题**（`agents.ts:788-846`）：
- 全局 EventEmitter `globalThis.__workflowEvents`
- handler 按 **sessionId** 过滤 `workflow_start` 事件
- 同会话两个并行 task 都注册了 handler → 都接收同会话所有 workflow 事件 → 事件在两个 taskBuffer 中重复

**修改方案**：handler 改为按 **parent taskId** 过滤。

**前提**：`workflow_start` 事件载荷必须包含 `parentTaskId`（启动 workflow 的主 task 的 taskId）。需要在 workflow 启动处补充该字段。

```typescript
const handlerTaskId = taskId;  // 当前 /run-stream 或 /run-skill 的 taskId
const workflowEventHandler = (event: Record<string, unknown>) => {
  const etype = event.type as string;
  const eventWfId = event.workflowId as string | undefined;
  const eventParentTaskId = event.parentTaskId as string | undefined;

  if (etype === "workflow_start" && eventWfId) {
    // 只接受由当前 task 启动的 workflow
    if (eventParentTaskId === handlerTaskId) {
      sessionWorkflowIds.add(eventWfId);
    } else {
      return;
    }
  } else if (eventWfId) {
    if (!sessionWorkflowIds.has(eventWfId)) return;
  }
  // ... 转发到 taskEventBuffer.push(taskId, ...)
};
```

**配套修改**：workflow 启动代码（在 orchestrator 或 workflow service 中）发射 `workflow_start` 事件时，必须带上 `parentTaskId`。需要探查 workflow 启动点补充该字段。

---

### 3.6 Session memory 并发安全（后端）

**当前问题**（`src/store/repos/session-memory.ts`）：
- `save()` 是 `ON CONFLICT DO UPDATE SET content = $3` 全量覆盖
- caller 是读-改-写：`load()` → 传给 agent → 执行后 `save()` 新内容
- 两个并行 task 各自 load 同一份初始 memory，各自修改，后写者覆盖前写者 → 丢失更新

**修改方案 A（推荐：合并而非覆盖）**：
引入 merge 语义。Session memory 通常是"事实列表 / 关键观察"形式，可用 append + dedup。

```typescript
async mergeUpdate(sessionId: string, newContent: string, ...): Promise<void> {
  // 加 SELECT ... FOR UPDATE 行锁，读出当前内容，合并新内容，写回
  const client = await this.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT content FROM session_memory WHERE session_id = $1 FOR UPDATE',
      [sessionId]
    );
    const existing = rows[0]?.content ?? '';
    const merged = mergeMemory(existing, newContent);  // 应用层合并
    await client.query(
      'INSERT INTO session_memory (...) VALUES (...) ON CONFLICT (...) DO UPDATE SET content = $3, ...',
      [..., merged, ...]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

**修改方案 B（简化：加锁串行化）**：
用 advisory lock 让同 session 的 memory 更新串行化。仍可能丢失更新（除非用 FOR UPDATE），不推荐。

**修改方案 C（最简：接受丢失更新）**：
文档化"session memory 在并行场景下可能丢失部分更新"，作为已知限制。后续再优化。

**推荐 A**，但作为独立后续任务。本设计先实现 C（标注限制），避免阻塞主体改造。

---

### 3.7 MAX_CONCURRENT_AGENT_RUNS 公平性（后端）

**当前问题**（`agents.ts:1043-1048`）：
- 忙等 `setTimeout(r, 500)`，无队列排序
- 单会话提交 8 个 task 可占满全部槽位，饿死其他会话
- 解决并发问题的同时不能引入新的饥饿问题

**修改方案**：引入 per-session 配额。

```typescript
const MAX_CONCURRENT_AGENT_RUNS = 8;
const MAX_CONCURRENT_PER_SESSION = 3;  // 单会话最多同时 3 个 task
let activeAgentRuns = 0;
const activePerSession = new Map<string, number>();  // sessionId -> count

// 在 IIFE 中：
while (activeAgentRuns >= MAX_CONCURRENT_AGENT_RUNS ||
       (activePerSession.get(sessionId) ?? 0) >= MAX_CONCURRENT_PER_SESSION) {
  await new Promise((r) => setTimeout(r, 200));
}
activeAgentRuns++;
activePerSession.set(sessionId, (activePerSession.get(sessionId) ?? 0) + 1);

// finally:
activeAgentRuns--;
const newCount = (activePerSession.get(sessionId) ?? 1) - 1;
if (newCount > 0) activePerSession.set(sessionId, newCount);
else activePerSession.delete(sessionId);
```

**参数选择**：
- 全局 8（保持现状）
- 单会话 3（允许合理并行，防止单会话垄断）

**注意**：仍是忙等，可后续优化为事件驱动队列。当前简单实现可接受。

---

### 3.8 消息排序加 tiebreaker（后端）

**当前问题**（`src/store/repos/message.ts:28-31`）：
```sql
SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC
```
无 tiebreaker。并行插入若同毫秒，排序不确定。

**修改方案**：
```sql
SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC
```
或（若 id 是 UUID 非递增）：
```sql
ORDER BY created_at ASC, seq ASC
```
其中 `seq` 是新增的 BIGSERIAL 列（需 migration）。

**简化方案**：若 id 是 UUID，用 `created_at, id` 排序虽不保证插入顺序，但保证稳定（幂等）。可接受。

---

### 3.9 前端 store: `streamingMessageId` → `streamingTasks` Map

**当前问题**（`frontend/src/store/chat.ts`）：
- `streamingMessageId: string | null`（单值）
- 所有回调（`onContentDelta` 等）都向这单一消息写入
- `isStreaming = streamingMessageId !== null`（单值）
- `sendMessage` 入口 guard：`if (isSending || isStreaming) return;`（第 510 行）阻断并行

**修改方案**：

```typescript
interface ChatState {
  // 删除：
  // streamingMessageId: string | null;
  // streamingContent: string;
  // streamingThinking: string;
  // streamingToolCalls: ToolCallInfo[];
  // isStreaming: boolean;

  // 新增：
  streamingTasks: Record<string, {
    taskId: string;
    messageId: string;
    content: string;
    thinking: string;
    toolCalls: ToolCallInfo[];
    pushedContents: PushedContent[];
    error?: string;
  }>;
  // 派生 selector：
  // isStreaming = Object.keys(streamingTasks).length > 0
}
```

**selector 替代**：
```typescript
// 兼容旧代码的 selector
export const useIsStreaming = () => useChatStore(s => Object.keys(s.streamingTasks).length > 0);
export const useStreamingMessageIds = () => useChatStore(s => Object.keys(s.streamingTasks));
```

---

### 3.10 SSE 订阅与回调路由（前端）

**当前问题**：`api.runAgentStream()` 的所有回调不接收 taskId，无法路由到对应 streaming task。

**修改方案**：

1. **`api.runAgentStream` 的 `onStart` 回调已经接收 taskId**（用于存入 `activeSSEConnections`）。在此基础上，后续回调（`onContentDelta` 等）也需要携带 taskId。

   **修改 `api/client.ts`**：
   ```typescript
   // 所有回调签名加 taskId
   onContentDelta?: (taskId: string, delta: string) => void;
   onToolCall?: (taskId: string, toolCall: ...) => void;
   // ... 其他回调同理
   ```

   SSE 解析层把当前 taskId 注入每个事件回调。

2. **`sendMessage` 改造**：
   ```typescript
   sendMessage: async (content, scope, mediaIds) => {
     // 删除：if (isSending || isStreaming) return;
     // 改为：允许多次调用，每次创建独立 streaming task

     const messageId = uuid();  // 本地占位 ID
     const placeholderMsg: MessageInfo = {
       id: messageId,
       role: "assistant",
       content: "",
       createdAt: new Date().toISOString(),
       isStreaming: true,
     };
     set(s => ({ messages: [...s.messages, placeholderMsg] }));

     const stream = api.runAgentStream({
       sessionId, input: content, scope, mediaIds,
       onStart: (taskId) => {
         set(s => ({
           streamingTasks: {
             ...s.streamingTasks,
             [taskId]: { taskId, messageId, content: "", thinking: "", toolCalls: [], pushedContents: [] },
           },
           messages: s.messages.map(m =>
             m.id === messageId ? { ...m, metadata: { ...(m.metadata||{}), taskId } } : m
           ),
         }));
       },
       onContentDelta: (taskId, delta) => {
         set(s => {
           const task = s.streamingTasks[taskId];
           if (!task) return s;
           return {
             streamingTasks: {
               ...s.streamingTasks,
               [taskId]: { ...task, content: task.content + delta },
             },
           };
         });
       },
       // ... 其他回调同理，全部按 taskId 路由
       onDone: (taskId, data) => {
         // finalize：从 streamingTasks 移除，触发 reload 从服务器获取最终消息
         set(s => {
           const { [taskId]: _, ...rest } = s.streamingTasks;
           return { streamingTasks: rest };
         });
         // reload messages from server
       },
       onError: (taskId, err) => {
         set(s => {
           const task = s.streamingTasks[taskId];
           if (!task) return s;
           return {
             streamingTasks: {
               ...s.streamingTasks,
               [taskId]: { ...task, error: String(err) },
             },
           };
         });
       },
     });
   }
   ```

---

### 3.11 JSONL 转录并发写：已验证架构是并行安全的

**调查结论**（2026-06-19 完成）：DA 的 JSONL 架构**已经是 per-task 分片设计**，无需额外加锁或合并。

**文件布局**（`src/services/session/session-paths.ts:40`）：
```
{dataDir}/sessions/{sessionId}/transcripts/{taskId}.jsonl
{dataDir}/sessions/{sessionId}/transcripts/{anotherTaskId}.jsonl
{dataDir}/sessions/{sessionId}/transcripts/{subTaskId}.jsonl
```
每个 taskId 一个独立文件。磁盘实测：306 个 session 共 851 个 JSONL 文件，单 session 最多 22 个文件。

**写入路径**（`src/services/session/jsonl-writer.ts`）：
- `WriterRegistry` 单例按 `${sessionId}:${taskId}` 键返回唯一 `JsonlWriter` 实例
- 每个 writer 有自己的 buffer + 100ms flush 定时器 + max 50 条批量
- 不同 task 的写入互不干扰（不同文件、不同 writer 实例）

**读取路径**（`src/services/session/session-reader.ts:61`）：
- `readSession()` 列出 `{sessionId}/transcripts/` 下所有 `*.jsonl` 文件
- `Promise.all` 并行读取全部文件
- 按 `timestamp` 排序合并
- `parseJsonlFile` 跳过损坏行（容错）

**这正是用户提议的"分片 + 合并"设计，且更优**：
- 写入期：天然零竞争（不同文件）
- 读取期：聚合所有分片（lazy merge）
- 无合并失败模式：没有显式 merge 步骤
- 无孤儿分片：每个 task 的文件独立可读
- 无迁移成本：现有 851 个文件已按此布局

**真正需要修的：子 Agent fork/sub 模式的 RunState 字段共享 bug**

`agent-runner.ts:4756-4796`（fork 模式）和 `:4817-4857`（sub 模式）都有同一缺陷：

```typescript
// 当前实现（非原子 save/clear/restore）
const parentRs = this.getRunState(taskId);
const savedWriter = parentRs.jsonlWriter;
parentRs.jsonlWriter = undefined;  // 清空，让子 Agent 创建自己的
try {
  await this.run({...});  // 子 Agent 执行
} finally {
  parentRs.jsonlWriter = savedWriter;  // 恢复
}
```

**并行场景下的竞态**：
- T0：`parentRs.jsonlWriter = PARENT_WRITER`
- T1：Fork A 启动 → `savedA = PARENT_WRITER`；清空为 undefined
- T2：Fork B 启动 → `savedB = undefined`（已被清空！）；保持 undefined
- T3：Fork A 完成 → 恢复为 PARENT_WRITER
- T4：父 Agent 短暂写入正常
- T5：Fork B 完成 → 恢复为 undefined（错误！）
- T6：父 Agent 后续写入全部丢失

**修复方案：用 AsyncLocalStorage 取代共享字段**

不再用 `runState.jsonlWriter` 作为隐式上下文，改为通过 ALS 查询当前执行上下文的 writer：

```typescript
// 新增：writer 上下文通过 ALS 传递
const writerContext = agentAsyncContext.getStore()?.jsonlWriter;

// emitEvent 中：
const writer = agentAsyncContext.getStore()?.jsonlWriter;
if (writer) writer.append(entry);
// 不再读 runState.jsonlWriter
```

**子 Agent 启动时**：
```typescript
// 不再 save/clear/restore 父字段
// 而是为子 Agent 建立独立的 ALS 上下文
await agentAsyncContext.run(
  { ...agentAsyncContext.getStore(), jsonlWriter: undefined, jsonlTaskId: subTaskId },
  async () => {
    await this.run({...});  // 子 Agent 在自己的 ALS 上下文中，自然创建自己的 writer
  }
);
// 父 Agent 的 ALS 上下文未被动过，writer 一直是 PARENT_WRITER
```

**优势**：
- 完全消除共享可变状态
- 父子 Agent 上下文天然隔离
- 任意数量子 Agent 并行都安全
- 不需要文件级锁或合并步骤

**实施位置**：
- `agent-runner.ts:4756-4796`（fork 模式）—— 替换 save/clear/restore 为 ALS 上下文切换
- `agent-runner.ts:4817-4857`（sub 模式）—— 同上
- `agent-runner.ts:1997`（writer 创建点）—— 优先从 ALS 查询，不存在时才新建
- `agent-runner.ts:5551`（emitEvent）—— writer 引用从 ALS 取，不从 runState 取

**关联工作**：DA 已有 `agentAsyncContext`（taskContext ALS），本方案只是扩展其携带的字段。与 §3.1（删 activeSessionRuns）和 §3.5（workflow parentTaskId 过滤）天然契合——都是用 ALS 替代隐式共享状态。

---

### 3.12 SkillBrowser 并行执行（前端）

**当前**（`frontend/src/components/plugins/SkillBrowser.tsx`）：
- `executingId: string | null`（单值）
- 所有执行按钮在 `executingId !== null` 时 disabled（第 353 行）
- `handleExecute` 是 `await api.runAgentSkill(...)`，阻塞到完成

**修改方案**：

1. **状态改为 Set**：
   ```typescript
   const [executingSkillIds, setExecutingSkillIds] = useState<Set<string>>(new Set());
   // 每个技能卡片检查 executingSkillIds.has(skill.id)
   ```

2. **`handleExecute` 改为流式订阅**：
   ```typescript
   const handleExecute = async (skillId: string, input?: string) => {
     setExecutingSkillIds(prev => new Set(prev).add(skillId));
     try {
       // 调用新的流式 API（见 §3.13 前端 client 改造）
       const stream = api.runAgentSkillStream({
         sessionId, skillId, input,
         onStart: (taskId) => { /* 显示进度 */ },
         onContentDelta: (taskId, delta) => { /* 累积输出 */ },
         onDone: (taskId, data) => {
           success(`技能执行完成`);
           // 清理执行状态
         },
         onError: (taskId, err) => {
           toastError("执行失败: " + err);
         },
       });
     } finally {
       setExecutingSkillIds(prev => { const n = new Set(prev); n.delete(skillId); return n; });
     }
   };
   ```

3. **UI 显示**：增加"运行中技能"面板，展示每个正在执行的 skill 的进度。

---

### 3.13 前端 API client 改造

**新增**（`frontend/src/api/client.ts`）：

```typescript
runAgentSkillStream: (params: {
  sessionId: string;
  skillId: string;
  input?: string;
  kbId?: string;
  onStart?, onContentDelta?, onToolCall?, onToolResult?,
  onPushContent?, onComplete?, onDone?, onError?,
}): { abort: () => void; promise: Promise<void> }
```

实现模式与 `runAgentStream` 完全一致（`fetch` POST + 手动 SSE 解析 + 回调路由），仅 URL 改为 `/api/agents/run-skill`。

**保留**（兼容）：旧 `runAgentSkill` 保留一段时间作为 fallback，后续移除。

---

### 3.14 AskUserDialog 队列化（前端）

**当前**（`frontend/src/components/chat/AskUserDialog.tsx` + `chat.ts`）：
- `pendingQuestion: { taskId, question, options } | null`（单值）
- 第二个 `ask_user` 事件覆盖第一个 → 第一个 task 永久阻塞

**修改方案**：改为队列。

```typescript
interface ChatState {
  // 删除：pendingQuestion: ... | null
  // 新增：
  pendingQuestions: Array<{
    taskId: string;
    question: string;
    options: string[];
  }>;
}

// onAskUser:
onAskUser: (data) => {
  set(s => ({
    pendingQuestions: [...s.pendingQuestions, {
      taskId: data.taskId, question: data.question, options: data.options ?? []
    }],
  }));
},

// answerQuestion:
answerQuestion: (taskId, answer) => {
  api.answerQuestion(taskId, answer);
  set(s => ({
    pendingQuestions: s.pendingQuestions.filter(q => q.taskId !== taskId),
  }));
},
```

**AskUserDialog 渲染**：
- 显示队列中第一个问题（FIFO）
- 顶部提示"还有 N 个待答问题"
- 用户答完一个自动显示下一个
- 可选：横向标签切换不同 task 的问题

---

### 3.15 ScopeSelector 始终启用（前端）

**当前**：#10 修复中给 ScopeSelector 加了 `disabled` prop（`ChatWindow.tsx:267, 310`），在 `isSending || isStreaming` 时禁用。

**新方案**：恢复为始终启用。理由：
- 每个 task 在启动时把 `scopeKbIds` 烤进不可变的 `taskContext`（`agents.ts:677-687`）
- 运行中修改 ScopeSelector 不影响已启动的 task
- 仅影响**下一次**发送时的 scope
- 禁用是过度保护

**修改**：
- 移除 `ScopeSelector` 的 `disabled` prop（或保留但始终传 `false`）
- `ChatWindow.tsx` 移除 `disabled={isSending || isStreaming}`

---

### 3.16 ChatWindow 多任务指示器（前端）

**新增 UI**：会话头部显示"当前有 N 个任务执行中"。

```tsx
const runningCount = useChatStore(s => Object.keys(s.streamingTasks).length);
// 在 header 中：
{runningCount > 1 && (
  <span style={...}>
    {runningCount} 个任务并行中
  </span>
)}
```

可选增强：点击展开看到每个 task 的简要状态（"正在搜索知识库..."、"正在生成报告..."）。

---

### 3.17 MessageList 多流式消息渲染（前端）

**当前**：MessageList 假设最多一个 streaming 消息（按 `streamingMessageId` 查找）。

**修改**：
- 消息列表按 `createdAt` 排序，包含所有 streaming 占位消息（来自 `streamingTasks` 的 messageId）
- 每个 streaming 消息独立渲染：内容、工具调用、思考过程都从对应 `streamingTasks[taskId]` 取
- 视觉区分：streaming 消息加边框或 spinner

**selector**：
```typescript
// 把 streamingTasks 合并到 messages 列表
const messagesWithStreaming = useChatStore(s => {
  const streamingMsgs = Object.values(s.streamingTasks).map(t => ({
    id: t.messageId,
    role: "assistant" as const,
    content: t.content,
    createdAt: ..., // 需记录启动时间
    isStreaming: true,
    thinkingContent: t.thinking,
    toolCalls: t.toolCalls,
    pushedContents: t.pushedContents,
    metadata: { taskId: t.taskId },
  }));
  return [...s.messages, ...streamingMsgs]
    .filter(m => !s.messages.find(x => x.id === m.id) || m.isStreaming)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
});
```

---

### 3.18 前端消费者清单与 isSending/isStreaming 语义重定义

通过 grep 扫描发现的所有依赖单值 streaming 状态的代码点。**实施时必须逐一迁移**：

#### 3.18.1 `isSending` / `isStreaming` 语义重定义

**当前**：两者都是 boolean 单值。
- `isSending = true`：sendMessage 已发起，等 SSE 开始
- `isStreaming = true`：SSE 流式接收中

**新语义**：删除两个 boolean，统一改为派生 selector：
```typescript
// 从 streamingTasks 派生
useIsStreaming = () => useChatStore(s => Object.keys(s.streamingTasks).length > 0);
// isSending 不再需要独立状态——"sending" 是 sendMessage 函数局部的过渡态，
// 不写入 store。submit 按钮的 disabled 仅依赖 isStreaming（运行中不可重复发同一条）。
// 但并行发送不同消息是允许的——见 §3.18.2。
```

**决策**：MessageInput 允许在 streaming 中继续发送（并行）。submit 按钮**不再因 isStreaming 而 disabled**。仅在文本为空或 media 上传中时 disabled。

#### 3.18.2 受影响的代码点（逐一列出）

| 文件:行 | 当前代码 | 迁移方式 |
|---------|---------|---------|
| `chat.ts:88-89` | `isSending: boolean; isStreaming: boolean` | 删除两个字段 |
| `chat.ts:93-96` | `streamingMessageId/Content/Thinking/ToolCalls` | 删除，由 `streamingTasks` 替代 |
| `chat.ts:102` | `pendingQuestion: {...} \| null` | 改为 `pendingQuestions: Array<{...}>`（§3.14） |
| `chat.ts:169-176` | `SessionStreamingState` 接口 | 改为 `Record<taskId, StreamingTaskState>` |
| `chat.ts:179` | `sessionPendingQuestionCache` | 改为 `Map<sessionId, PendingQuestion[]>` |
| `chat.ts:186-202` | 5 分钟 watchdog 重置 isSending/isStreaming | 改为：遍历 `streamingTasks`，超过 5 分钟无活动的 task 逐个移除 |
| `chat.ts:286-398` | 会话切换 save/restore 单值 | 改为 save/restore 整个 `streamingTasks` Map 和 `pendingQuestions` 数组 |
| `chat.ts:510` | `if (isSending \|\| isStreaming) return;` | **删除**，允许并行 |
| `chat.ts:703-734` | onDone 中清理 isStreaming | 改为从 `streamingTasks` 删除对应 taskId |
| `chat.ts:913-947` | 流式接收失败回退 | 按 taskId 路由，仅清理失败的 task |
| `chat.ts:1051-1149` | `startStreaming/finishStreaming/appendStream*` 单值方法 | 全部改为按 taskId 操作 Map |
| `chat.ts:1603-1609` | `setPendingQuestion/clearPendingQuestion` | 改为 queue 操作（§3.14） |
| `chat.ts:1620` | `reconnectToRunningTask` guard `if (isStreaming) return` | 改为：允许同时有多个 task 在重连（或重连只针对最近的 task） |
| `chat.ts:1655-1682` | `reconnectToRunningTask` 内 startStreaming 单值 | 改为按 taskId 加入 `streamingTasks` |
| `chat.ts:1993-1996` | selectSession 时 finishStreaming 单值 | 改为遍历所有 streamingTasks 全部 finalize |
| `MessageList.tsx:10` | `isStreaming` selector | 改为 `Object.keys(streamingTasks).length > 0` |
| `MessageList.tsx:73` | `<ThinkingIndicator />`（单一） | 改为：每个 streaming message 自带 indicator（在 MessageItem 中渲染） |
| `MessageItem.tsx:134` | `streamingMessageId === message.id` | 改为：检查 message.id 是否在 `streamingTasks` 的 messageId 集合中 |
| `MessageInput.tsx:11-12,40` | `isAgentRunning = isSending \|\| isStreaming` | 删除。submit 按钮 disabled 仅依赖文本为空 / media 上传中 |
| `MessageInput.tsx:90` | deps 中 isSending/isStreaming | 移除 |
| `ChatWindow.tsx:30-31` | `isSending/isStreaming` 订阅 | 改为订阅 `streamingTasks`（仅用于多任务指示器，见 §3.16） |
| `ChatWindow.tsx:267,310` | `disabled={isSending \|\| isStreaming}` | **移除 disabled prop**（§3.15） |
| `AskUserDialog.tsx:9-15` | 单值 `pendingQuestion` | 改为读 `pendingQuestions[0]`（§3.14） |

#### 3.18.3 流式指标器的视觉迁移

**当前**：`MessageList.tsx:73` 全局一个 `<ThinkingIndicator />`（在消息列表底部）。

**新方案**：
- 删除全局 ThinkingIndicator
- 每个 streaming 消息**自带** indicator（在 MessageItem 内部，当 `isStreaming` 为 true 时渲染光标/spinner）
- 多个 streaming 消息同时显示各自的 indicator，视觉上清晰区分

---

### 3.19 任务失败与重试（前端）

**当前**：单流场景下，失败由 `onError` 处理，清理 isStreaming 并显示错误。

**新方案**：每个 task 独立失败处理。
- `streamingTasks[taskId].error` 存错误信息
- 失败 task 的占位消息**保留**在列表中，显示错误状态 + "重试"按钮
- 用户点"重试"→ 用相同输入重新调用 sendMessage（生成新 taskId）
- 其他并行 task 不受影响

**MessageItem 渲染**：
```tsx
{message.isStreaming && task?.error && (
  <div className="error-banner">
    执行失败：{task.error}
    <button onClick={() => retry(task.taskId)}>重试</button>
  </div>
)}
```

---

### 3.20 SubAgentPanel 多 workflow 支持（前端）

**当前**：`SubAgentPanel` 按 `workflowId` 渲染，`ChatWindow` 过滤当前 session 的 workflows。

**并行场景**：多个 task 各自启动 workflow，sessionWorkflowIds 会有多个。

**修改**：
- `ChatWindow.tsx:47-57` 的 `sessionWorkflowIds` 计算逻辑保持不变（按 sessionId 过滤）
- 每个 `SubAgentPanel` 已经按 `workflowId` 独立渲染，天然支持多个
- 视觉上：多个 panel 垂直堆叠或横向 tab 切换（UX 决策）

---

## 4. 实施阶段

### Phase 1：后端基础（无破坏性，可独立部署）

| 步骤 | 内容 | 验证 |
|------|------|------|
| 1.1 | `loadContextMessages` 加 draft 过滤 | 单元测试：并行场景下 context 不含 draft |
| 1.2 | 子 Agent fork/sub 模式的 RunState 字段共享 bug 修复（ALS 化） | 单元测试：并行子 Agent 不互相覆盖父 writer |
| 1.3 | Workflow 事件载荷补 `parentTaskId` 字段 | 验证 workflow_start 事件含 parentTaskId |
| 1.4 | `/run-stream` workflow handler 改按 parentTaskId 过滤 | 单元测试：并行 task 不互相接收 workflow 事件 |
| 1.5 | 消息排序加 tiebreaker | 验证并行插入排序稳定 |
| 1.6 | 引入 per-session 配额（`MAX_CONCURRENT_PER_SESSION`） | 验证单会话不超过配额 |

### Phase 2：后端端点统一（破坏性 API 变更，需配合 Phase 3）

| 步骤 | 内容 | 验证 |
|------|------|------|
| 2.1 | `/run-skill` 改造为 fire-and-forget + SSE | 端到端测试：skill 执行流式输出 |
| 2.2 | `/run` 端点同样改造 | API 兼容性测试 |
| 2.3 | 删除 `activeSessionRuns` | 确认无残留引用 |

### Phase 3：前端 store 重构

| 步骤 | 内容 | 验证 |
|------|------|------|
| 3.1 | `streamingMessageId` → `streamingTasks` Map | 单元测试：多 task 状态隔离 |
| 3.2 | `sendMessage` 入口移除 isStreaming guard | 测试：可连续发送 |
| 3.3 | 所有回调按 taskId 路由 | 测试：并行 task 内容不串 |
| 3.4 | `api.runAgentSkillStream` 新增 | 与后端 §3.2 联调 |

### Phase 4：前端 UI

| 步骤 | 内容 | 验证 |
|------|------|------|
| 4.1 | MessageList 渲染多个 streaming 消息 | 截图：3 个并行消息正常显示 |
| 4.2 | SkillBrowser `executingSkillIds` Set | 测试：多技能并行 |
| 4.3 | AskUserDialog 队列化 | 测试：多问题依次显示 |
| 4.4 | ScopeSelector 恢复始终启用 | 测试：执行中可修改 |
| 4.5 | ChatWindow 多任务指示器 | 截图：指示器正确 |

### Phase 5：边缘情况与测试

| 步骤 | 内容 |
|------|------|
| 5.1 | Session memory 并发更新（§3.6 方案 A 或 C） |
| 5.2 | 僵尸 draft 清理任务 |
| 5.3 | 单元测试：per-task 隔离、并行 context 加载、workflow 事件过滤 |
| 5.4 | E2E 测试：见 §5 |

---

## 5. 测试策略

### 5.1 单元测试

**新增** `tests/server/parallel-execution.test.ts`：

1. `loadContextMessages` 过滤 draft：
   - 创建 session，插入 user 消息 + draft=true 的 assistant 消息 + draft=false 的 assistant 消息
   - 调用 `loadContextMessages` → 断言只返回 draft=false 的

2. Workflow 事件按 parentTaskId 过滤：
   - 模拟两个 task，各自启动 workflow
   - 断言 task A 的 handler 不接收 task B 的 workflow 事件

3. Per-session 配额：
   - 单会话连续提交 5 个 task → 断言同时执行不超过 3 个
   - 多会话并行 → 断言总数不超过 8

4. 消息排序稳定性：
   - 并行插入同毫秒的消息 → 多次查询排序一致

### 5.2 E2E 测试

**新增** `tests/e2e/14-parallel-execution.spec.ts`：

1. **并行 chat + skill**：
   - UI 发送 chat 消息（触发 /run-stream）
   - 立即在 SkillBrowser 点击执行
   - 断言：两个 streaming 消息同时显示，内容不串
   - 断言：两个 task 都成功完成

2. **并行多 skill**：
   - UI 同时执行 3 个 skill
   - 断言：3 个执行中状态同时显示
   - 断言：3 个 task 都成功完成
   - 断言：消息列表按时间正确排序

3. **并行 ask_user**：
   - 触发两个都会 ask_user 的 task
   - 断言：第一个问题显示，答完后第二个显示
   - 断言：两个 task 都收到正确答案

4. **并行取消**：
   - 启动两个 task
   - 取消其中一个
   - 断言：被取消的 task 停止，另一个继续

5. **会话切换中的并行任务**：
   - 在 session A 启动 task，切到 session B，切回 A
   - 断言：A 的 task 状态正确恢复

6. **回归测试**：
   - 运行现有 `13-github-issues-fixes.spec.ts` 全部通过
   - 确认 #10 修复（taskId 匹配）在并行场景下仍然有效

---

## 6. 风险评估

### 6.1 破坏性变更

| 变更 | 影响范围 | 缓解 |
|------|---------|------|
| `/run-skill` 返回 SSE | 前端 SkillBrowser | 同步发布前后端；保留旧 `runAgentSkill` 一段时间 |
| `streamingMessageId` → Map | 前端所有用到该 selector 的组件 | 提供 `useIsStreaming` 兼容 selector |
| 删除 409 Conflict | 依赖该响应的处理逻辑 | 本设计前置无依赖（前端未处理 409） |

### 6.2 性能风险

| 风险 | 评估 | 缓解 |
|------|------|------|
| 多 task 并发 LLM 调用 | 成本上升 | per-session 配额限制 |
| 前端频繁 re-render | 中等（每个 chunk 触发） | selector 粒度细化（仅订阅当前 task） |
| JSONL 并发写磁盘 | 低（已序列化或加锁） | Phase 1.2 探查 |

### 6.3 回滚方案

每个 Phase 独立 commit，可单独 revert：
- Phase 1 是无破坏性优化，即使后续放弃也可保留
- Phase 2 + 3 + 4 必须同步发布（API 契约变更），作为一个原子单元
- 出问题时 revert Phase 2-4 这批 commit

---

## 7. 待决问题

1. **Session memory 并发更新**：方案 A（FOR UPDATE 合并）vs 方案 C（接受丢失）？建议先 C 后续优化。
2. **JSONL 写入并发安全性**：已调查确认——架构本就是 per-task 分片（`{taskId}.jsonl`），完全并行安全。真正需要修的是子 Agent fork/sub 模式的 RunState 字段共享 bug（见 §3.11），用 ALS 替代共享字段即可。
3. **SkillExecuteModal UI 重设计**：从"等待结果"改为"实时进度"，需要 UX 设计。
4. **是否合并 `/run` 和 `/run-stream`**：合并可减少代码重复，但破坏 API 兼容。建议保留独立。
5. **Per-session 配额值**：3 是否合理？可根据实际负载调整。

---

## 8. 决策点

请评审以下决策：

1. **整体方向**：采纳 Per-Task 完全隔离，删除 `activeSessionRuns`？（推荐 ✅）
2. **`/run-skill` 改造为 SSE**？（推荐 ✅，必须做）
3. **per-session 配额**：引入 `MAX_CONCURRENT_PER_SESSION = 3`？（推荐 ✅）
4. **Session memory**：先接受丢失更新（方案 C），后续再优化？（推荐 ✅）
5. **ScopeSelector 恢复始终启用**？（推荐 ✅）
6. **实施顺序**：按 Phase 1 → 5？（推荐 ✅）

---

## 附录 A：决策对比

| 维度 | 共享会话锁（已否决） | Per-Task 隔离（本方案） |
|------|------------------|---------------------|
| 并行能力 | 同会话串行 | 完全并行 |
| 实现成本 | 低 | 中-高（前端重构） |
| 符合 DA 定位 | ❌ 与"通用 Agent 平台"相悖 | ✅ 与子 Agent 并行能力一致 |
| 与 #10 fix 关系 | 冲突（假设单流） | 契合（taskId 天然多流） |
| UX | 简单但受限 | 灵活但需设计 |
| 风险 | 低 | 中（需系统性测试） |

## 附录 B：现有调用 `orchestrator.runSingle()` 的入口

| 入口 | 文件:行 | 当前模式 | 本方案处理 |
|------|---------|---------|----------|
| `POST /run-stream` | `agents.ts:573` | 流式 + fire-and-forget | 删 mutex，余不变 |
| `POST /run` | `agents.ts:477` | 同步阻塞 | 改为 SSE（§3.3） |
| `POST /run-skill` | `agents.ts:1349` | 同步阻塞 | 改为 SSE（§3.2） |
| 知识库预处理 | `knowledge.ts:2557` | fire-and-forget | 不动（独立会话） |
