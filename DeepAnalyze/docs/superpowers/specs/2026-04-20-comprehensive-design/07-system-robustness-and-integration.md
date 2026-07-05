# 第 7 册：系统健壮性与模块联动

> **文档日期**: 2026-04-20
> **来源**: 综合 04-13 Phase C（事件总线/通信渠道）、04-14 系统重设计、04-18 子项目 5

---

## 1. 事件总线系统 (04-13 Phase C 提出)

### 1.1 设计目标

解耦各模块之间的直接依赖，通过事件总线进行异步通信。

### 1.2 核心事件

| 事件 | 发布者 | 订阅者 | 说明 |
|------|--------|--------|------|
| `document.uploaded` | 上传路由 | ProcessingQueue | 文档上传完成，入队处理 |
| `document.processing.progress` | ProcessingQueue | WebSocket Handler | 处理进度更新 |
| `document.processing.complete` | ProcessingQueue | Indexer, Linker | 文档处理完成 |
| `document.deleted` | 删除路由 | 级联清理 | 文档删除触发 |
| `wiki.page.created` | WikiCompiler | Indexer | 新 Wiki 页面创建 |
| `wiki.page.updated` | Expander | Indexer | 页面内容更新 |
| `embedding.stale` | EmbeddingManager | Auto-Dream | 嵌入需要重索引 |
| `agent.task.started` | AgentRunner | 任务面板 | Agent 任务开始 |
| `agent.task.completed` | AgentRunner | 任务面板, 报告 | 任务完成 |
| `agent.task.failed` | AgentRunner | 任务面板 | 任务失败 |
| `settings.changed` | SettingsStore | 所有相关模块 | 配置变更 |
| `provider.healthcheck` | ModelRouter | CapabilityDispatcher | Provider 健康状态 |

### 1.3 事件格式

```typescript
interface SystemEvent {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
  source: string;  // 发布者模块名
}
```

---

## 2. 通信渠道 (04-12 提出)

### 2.1 前后端通信方式

| 方式 | 用途 | 协议 |
|------|------|------|
| **REST API** | CRUD 操作、配置管理 | HTTP/JSON |
| **SSE** | Agent 流式响应、工具调用可视化 | Server-Sent Events |
| **WebSocket** | 文档处理进度实时推送、系统通知 | WS (Bun 原生) |

### 2.2 WebSocket 消息类型

```typescript
type WSMessageType =
  | 'processing.progress'     // 文档处理进度
  | 'processing.level_ready'  // L0/L1/L2 编译完成
  | 'processing.complete'     // 处理完成
  | 'processing.error'        // 处理失败
  | 'system.notification'     // 系统通知
  | 'capability.change';      // 系统能力变更
```

### 2.3 SSE 事件格式（Agent 流式响应）

```
event: token
data: {"content": "正在分析..."}

event: tool_call
data: {"tool": "kb_search", "input": {"query": "...", "kbId": "..."}}

event: tool_result
data: {"tool": "kb_search", "output": {...}}

event: thinking
data: {"content": "让我先搜索相关的知识库内容..."}

event: subtask
data: {"type": "started", "agent": "explore", "description": "搜索相关文档"}

event: done
data: {"summary": "分析完成..."}
```

---

## 3. 定时任务系统 (04-12 提出)

### 3.1 功能

- 用户可配置定时执行的任务（如定期重索引、定期摘要更新）
- 支持 Cron 表达式
- 任务执行结果持久化

### 3.2 数据模型

```typescript
interface CronJobRepo {
  create(job: NewCronJob): Promise<CronJob>;
  get(id: string): Promise<CronJob | undefined>;
  list(): Promise<CronJob[]>;
  update(id: string, fields: Partial<CronJob>): Promise<void>;
  delete(id: string): Promise<boolean>;
  getDueJobs(now: Date): Promise<CronJob[]>;       // 获取到期任务
  markCompleted(id: string, nextRun: Date): Promise<void>;
  markFailed(id: string, error: string, nextRun: Date): Promise<void>;
}
```

### 3.3 前端 UI

- Header `Clock` 按钮打开定时任务面板
- 显示任务列表、执行历史、下次执行时间
- 支持暂停/恢复/立即执行

---

## 4. 插件与技能系统

### 4.1 插件 (Plugin)

```typescript
interface PluginRepo {
  upsert(plugin: NewPlugin): Promise<void>;
  get(id: string): Promise<Plugin | undefined>;
  list(): Promise<Plugin[]>;
  updateEnabled(id: string, enabled: boolean): Promise<void>;
  updateConfig(id: string, config: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<boolean>;
}
```

### 4.2 技能 (Skill)

```typescript
interface SkillRepo {
  create(skill: NewSkill): Promise<Skill>;
  get(id: string): Promise<Skill | undefined>;
  list(pluginId?: string): Promise<Skill[]>;
  delete(id: string): Promise<boolean>;
}
```

### 4.3 前端 UI

- Header `Puzzle` 按钮打开插件管理面板
- Header `Wand2` 按钮打开技能库面板
- 支持安装、启用/禁用、配置插件

---

## 5. 模块联动设计 (04-13 Phase C 提出)

### 5.1 文档上传 → Agent 可用

```
上传文件 → ProcessingQueue → Processor → WikiCompiler
    → Indexer → 嵌入就绪 → kb_search 工具可用
    → Agent 可检索到新文档内容
```

### 5.2 聊天上传 → 知识库自动关联

```
聊天页上传文件
  → 检查当前 session 关联的 KB
    → 无 KB → 自动创建临时 KB (session ID 命名)
    → 有 KB → 上传到关联 KB
  → 上传完成 → 更新 AnalysisScope
  → Agent 可立即检索到上传的文档
```

### 5.3 设置变更 → 实时生效

```
设置面板修改 Provider 配置
  → SettingsStore.saveProviderSettings()
  → ModelRouter 重新加载配置
  → 新请求使用新配置（无需重启）
  → 旧请求完成后再切换
```

### 5.4 Provider 故障 → 自动降级

```
主模型连续 3 次调用失败
  → CircuitBreaker 熔断
  → 自动切换到辅助模型
  → 记录故障日志
  → 60s 后 half-open 尝试恢复
```

### 5.5 Agent 报告 → 知识库积累

```
Agent 完成深度分析
  → 生成分析报告
  → 报告关联到当前 session
  → 报告内容可被后续 Agent 检索引用
  → 知识复利积累
```

---

## 6. 双重 Compounding 修复 (04-18)

**问题**: `agents.ts` 路由中执行了一次 compounding，`AgentRunner.run()` 中又执行了一次。

**方案**: 移除路由中的 compounding，仅在 `AgentRunner.run()` 中执行。

---

## 7. 错误处理原则

| 原则 | 说明 |
|------|------|
| 不静默失败 | 所有多媒体处理器不可用时，降级但不静默 |
| 明确错误信息 | ProcessorFactory 对不支持的文件类型抛出明确错误 |
| 重试机制 | 上传自动重试 3 次，指数退避 |
| 部分成功 | 多文档处理时，一个失败不影响其他 |
| 降级链 | 增强模型 → 询问用户 → Skill → 明确不可用 |
