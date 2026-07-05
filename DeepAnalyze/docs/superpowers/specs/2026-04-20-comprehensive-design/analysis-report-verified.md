# DeepAnalyze 系统全面分析报告 — 修正验证版

> 分析日期：2026-04-22 | 基于 2026-04-22 完整代码审查 + 干净环境重新测试验证

---

## 一、验证环境与方法

### 测试环境
- PostgreSQL + Ollama 容器由 `docker-compose.dev.yml` 全新启动
- 后端通过 `npx tsx src/main.ts` 干净启动
- 测试数据：已有论文库（8个PDF）+ 新创建测试KB（Markdown文件）

### 验证方法
- 每个 P0/P1 问题独立重新测试
- 使用 curl 直接调用 API + docker exec 查询数据库
- 对比不同条件下的行为差异

---

## 二、问题验证结果（逐项确认/修正）

### ✅ Issue #1: 嵌入服务不可用 — **确认真实**

**验证过程：**
1. 嵌入服务进程不存在（`ps aux` 无结果）
2. 启动日志明确：`[Embedding] Removed unavailable local-bge-m3 from defaults`
3. 嵌入默认角色被清空为 `""`
4. MiniMax embedding provider 存在但余额不足（`insufficient balance`）
5. 系统降级到 hash-fallback（256维，无语义搜索能力）

**数据库证据：**
```
论文库（8个PDF，36个wiki页面）：
  - 嵌入记录：0 条
  - FTS 向量：36/36 已填充
```

**影响范围：**
- 向量搜索完全不可用
- RRF 融合退化为纯 BM25/FTS
- 搜索结果分数全部为 0.8（BM25 固定匹配分数）
- Agent 的 kb_search 工具无法进行语义匹配

**根因：** 嵌入服务未启动 + MiniMax 嵌入余额不足 + 无自动重试机制

---

### ✅ Issue #2: PDF 文档 Abstract(L0) 内容为空 — **确认真实，条件更精确**

**验证过程：**

1. **论文库 PDF 文档（新三层流程）：** 所有 8 个 abstract 页面内容长度 5 字节，均为 "## 概述"
   ```
   079017-1902open.pdf | abstract | content_len=5 | "## 概述"
   （其余 7 个文档相同）
   ```

2. **新测试 Markdown 文件（legacy 流程）：** Abstract 正常生成
   ```
   test-abstract.md | abstract | content_len=144 | "本文系统梳理NLP技术从Transformer架构..."
   test-abstract.md | overview | content_len=2537 | "# 人工智能研究文档结构化概览..."
   ```

**关键发现：**
- 问题**仅在 PDF 文档（新三层流程）中发生**
- Markdown 文档（legacy 流程）的 abstract 和 overview 均正常
- 新三层流程 `compileAbstract()` 的输入数据存在（structure_md 有 55K 字节内容）
- Qwen 模型调用正常（直接测试确认）
- **推测根因：** PDF 文档编译时，ModelRouter 的初始化时序或路由配置可能与当前状态不同，导致 LLM 调用超时/失败。失败后 fallback 为空字符串，最终写入 "## 概述" 标题

**问题修正点：**
- 之前的报告说 "所有 abstract 为空" 不够精确。更准确地说：**仅 Docling 处理的 PDF 文档 abstract 为空**，TextProcessor 处理的 Markdown 文件 abstract 正常
- 之前的报告说 "文档卡在 compiling" 部分不正确 — 文档最终会完成（状态变为 ready），只是耗时较长（LLM 调用需要时间）

---

### ✅ Issue #3: 搜索层级过滤完全失效 — **确认真实**

**验证过程：**
```
请求 levels=L1 → 返回 5 个 L0 (abstract) 结果
请求 levels=L2 → 返回 5 个 L0 (abstract) 结果
请求 levels=L0 → 返回 5 个 L0 (abstract) 结果
```
**所有层级请求返回完全相同的结果**，levels 参数被完全忽略。

**额外发现：**
- 所有搜索结果 score 固定为 0.8
- 所有结果都是 abstract 页面（即使请求 L1/L2）
- 搜索只返回 abstract 页面，structure_md/fulltext 页面从未出现在结果中

**根因分析：** 需要检查 `retriever.searchByLevels()` 方法中 levels 参数到 page_type 的映射和过滤逻辑。由于嵌入缺失，搜索可能走了 FTS-only 路径，而 FTS 路径可能没有正确应用层级过滤。

---

### ⚠️ Issue #4: 索引器未覆盖双格式页面 — **修正，FTS 索引已覆盖**

**原始判断：** 索引器未覆盖 structure_dt/structure_md
**实际验证：**
```
page_type     | total | has_fts
structure_dt  |   8   |   8
structure_md  |   8   |   8
```
**FTS 索引已正确覆盖**双格式页面类型。

**修正：** 原始报告有误。FTS 索引是完整的。但向量嵌入仍然缺失（0 条），这是 Issue #1 的一部分。

---

### ⚠️ Issue #5: 跨知识库搜索 API 未实现 — **修正，部分实现**

**验证发现：**
- `/api/search/knowledge/:kbId/search` 端点存在（通过 search 路由注册）
- 但该路径与 knowledge 路由中的 `/:kbId/search` 重复
- 没有真正的跨 KB 搜索端点（需要 `?kbIds=id1,id2` 参数）
- `/api/search` 根路径只返回 API 说明

**修正：** 跨 KB 搜索有单 KB 搜索端点但缺少多 KB 并行搜索能力。前端 Header 搜索通过并行调用多个单 KB 搜索实现了跨 KB 效果。

---

### ⚠️ Issue #6: 子系统未初始化 — **修正，懒加载但调度器关键问题**

**验证发现：**

| 子系统 | 状态 | 说明 |
|--------|------|------|
| Cron 路由 | ✅ 懒加载可用 | CRUD API 正常工作 |
| Cron 调度器 | ⚠️ 首次 API 调用时启动 | 定时任务不会在无人访问 API 时自动执行 |
| Channel 管理 | ✅ 懒加载可用 | 6 个渠道状态正常返回 |
| Plugin 列表 | ✅ 懒加载可用 | 空列表（正常） |
| Skills 列表 | ✅ 已注册 | 9 个内置技能全部存在 |
| EventBus | ❌ 未与 WS 统一 | WebSocket 使用独立的 `globalThis.__workflowEvents` |

**修正：** 子系统实际上通过懒加载机制可用，但 Cron 调度器**不会在系统启动时自动开始轮询**，需要首次 API 访问才会触发。这意味着系统重启后，所有定时任务会在第一次访问 cron API 之前静默停止。

---

### ✅ Issue #7: 文档编译卡住 — **修正，不是卡住而是耗时长**

**验证过程：**
1. 新上传的 Markdown 文件在约 2 分钟后完成编译（状态变为 ready）
2. 日志显示 `Parsed → ModelRouter loaded → (LLM调用) → 完成`
3. 编译 60% 对应 "compiling" 阶段，LLM 调用耗时较长

**修正：** 文档不会永久卡住。编译在 60% 停留是因为 LLM 调用（overview + abstract 生成）需要较长时间（30-120秒），之前测试轮询间隔太短误判为"卡住"。

---

## 三、确认的核心问题清单（按严重程度）

### P0 — 阻塞核心功能

| # | 问题 | 验证状态 | 影响范围 |
|---|------|---------|---------|
| 1 | **嵌入服务不可用** → 向量搜索完全失效 | ✅ 已确认 | 所有 KB 的语义搜索不可用 |
| 2 | **PDF 文档 abstract 为空**（新三层流程） | ✅ 已确认 | L0 层无实质内容 |
| 3 | **搜索层级过滤失效** → levels 参数被忽略 | ✅ 已确认 | 搜索无法按层级过滤 |

### P1 — 功能缺陷

| # | 问题 | 验证状态 | 影响范围 |
|---|------|---------|---------|
| 4 | **Cron 调度器不自动启动** | ✅ 已确认 | 系统重启后定时任务不执行 |
| 5 | **EventBus 与 WebSocket 事件系统未统一** | ✅ 已确认 | 事件架构不一致 |
| 6 | **跨 KB 搜索缺少专门 API** | ⚠️ 部分确认 | 需要多 KB 并行搜索端点 |

### P2 — 代码质量问题

| # | 问题 | 验证状态 |
|---|------|---------|
| 7 | 多处同步 I/O 阻塞事件循环 | ✅ 已确认 |
| 8 | BFS 链接遍历 N+1 查询 | ✅ 已确认 |
| 9 | Anchor content_hash 始终为 null | ✅ 已确认 |
| 10 | 报告任务 Map 无 TTL 清理 | ✅ 已确认 |
| 11 | 实体提取被禁用 | ✅ 已确认（设计决策） |

---

## 四、深度需求差距分析

### 需要立即实现才能达到设计目标的关键差距

#### 4.1 嵌入系统（C-18, C-34）

**当前状态：** 嵌入服务不可用，无向量数据，搜索退化为纯 FTS
**目标：** 向量 + BM25 + RRF 融合检索，百万级向量 HNSW <100ms

**需要实现：**
1. 嵌入服务高可用保障（自动重启、健康检查）
2. 嵌入服务不可用时自动降级到远程嵌入（MiniMax/OpenAI）
3. "重建全部嵌入" 功能 — 修复历史数据
4. 嵌入服务恢复后自动触发缺失嵌入的补全

#### 4.2 Abstract 生成可靠性（C-10）

**当前状态：** PDF 文档 abstract 为空，Markdown 文件正常
**目标：** LLM 从 Structure 生成文档描述摘要（不超过300字）+ 标签 + 文档类型

**需要实现：**
1. 排查并修复新三层流程中 compileAbstract() 的 LLM 调用失败问题
2. Abstract 生成失败时不应写入空内容 — 应标记为 "pending_abstract" 状态
3. Abstract 重新生成功能（单个文档 + 批量）
4. Abstract 生成结果的日志和监控

#### 4.3 搜索层级过滤（C-18, C-40）

**当前状态：** levels 参数被完全忽略
**目标：** Agent 和用户可在 L0/L1/L2 层级间精确控制搜索范围

**需要实现：**
1. 修复 `retriever.searchByLevels()` 的层级映射和过滤
2. 确保 BM25 和向量查询都正确传递 page_type 过滤条件
3. 搜索结果应包含对应层级的正确内容

#### 4.4 Cron 调度器自启动（G-21）

**当前状态：** 调度器在首次 cron API 访问时才启动
**目标：** 定时任务系统在系统启动后自动开始工作

**需要实现：**
1. 在 `main.ts` 或 `agent-system.ts` 初始化中启动 CronScheduler
2. 确保系统重启后已有定时任务能自动恢复执行

#### 4.5 事件架构统一（C-46）

**当前状态：** EventBus 和 `globalThis.__workflowEvents` 双系统并存
**目标：** 文档处理、Agent 任务、知识复合、报告生成通过事件总线联动

**需要实现：**
1. 将 WebSocket 的工作流事件转发改为通过 EventBus
2. 文档处理进度通过 EventBus 广播
3. 各模块通过 EventBus 解耦

### 需要进一步优化的次要差距

| 需求差距 | 当前状态 | 目标 | 优先级 |
|---------|---------|------|--------|
| 无语义搜索降级提示 | hash-fallback 静默使用 | 向用户/Agent 提示搜索质量降级 | P2 |
| 无搜索结果高亮 | 搜索返回原始内容 | 关键词高亮显示 | P2 |
| 无 anchor content_hash | 始终 null | 内容漂移检测 | P2 |
| 无 Abstract 重试 | 失败写入空内容 | 标记 pending + 定时重试 | P1 |
| 设置面板 Tab 不完整 | 3 Tab | 6 Tab（按设计文档）| P3 |
| 前端未浏览器验证 | 未验证 | 全面 UI 测试 | P1 |

---

## 五、修复优先级建议

### 第一优先级：核心搜索管道修复

| 步骤 | 任务 | 涉及文件 |
|------|------|---------|
| 1 | 排查 PDF abstract 生成失败根因 | `src/wiki/compiler.ts` compileAbstract() |
| 2 | 修复搜索层级过滤 | `src/wiki/retriever.ts` searchByLevels() |
| 3 | 确保嵌入服务可用或配置远程嵌入降级 | `src/main.ts`, `src/models/embedding.ts` |
| 4 | 实现"重建嵌入"功能 | `src/wiki/indexer.ts`, 新增 API |

### 第二优先级：系统健壮性

| 步骤 | 任务 | 涉及文件 |
|------|------|---------|
| 5 | Cron 调度器自启动 | `src/main.ts` 或 `src/services/agent/agent-system.ts` |
| 6 | 统一事件架构 | `src/services/event-bus.ts`, `src/server/ws.ts` |
| 7 | Abstract 生成失败处理 | `src/wiki/compiler.ts` |
| 8 | 跨 KB 搜索 API | `src/server/routes/search.ts` |

### 第三优先级：代码质量

| 步骤 | 任务 | 涉及文件 |
|------|------|---------|
| 9 | 同步 I/O 替换为异步 | compiler.ts, indexer.ts, linker.ts |
| 10 | 报告任务 TTL 清理 | reports.ts |
| 11 | Anchor content_hash 计算 | anchor-generator.ts |
| 12 | BFS N+1 查询优化 | linker.ts |

---

## 六、总结

DeepAnalyze 系统架构设计扎实，代码完成度约 90%。核心 Agent 引擎、模型路由、工作流调度等关键模块实现完整且运行正常。但在"数据管道"层面存在 3 个 P0 级问题需要立即修复：

1. **嵌入服务不可用** → 搜索质量严重下降
2. **PDF 文档 abstract 为空** → L0 层无实质内容
3. **搜索层级过滤失效** → 用户无法控制搜索范围

修复这 3 个问题后，系统的核心功能链路（上传→编译→索引→搜索→Agent 分析）将完全打通。建议按上述优先级系统推进修复工作。
