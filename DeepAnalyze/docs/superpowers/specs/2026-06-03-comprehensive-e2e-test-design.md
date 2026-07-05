# DeepAnalyze 全面端到端测试设计

> 日期：2026-06-03 | 覆盖需求 C-01 ~ C-220, G-01 ~ G-34

---

## 一、设计目标

1. **全面覆盖**：基于需求清单，覆盖所有已实现的功能特性、异常场景和边界情况
2. **双层验证**：API 功能正确性 + Playwright 截图视觉验证前端渲染
3. **可重复执行**：每个测试独立创建/清理数据，无跨测试依赖
4. **新特性覆盖**：ALS 多 Session 隔离、think 提取持久化、二进制文件保护、sanitizeJsonForPg 等近期修复
5. **替换旧测试**：替换散乱的 30+ 旧测试文件，统一到一个结构化的新测试套件

---

## 二、测试架构

### 2.1 文件结构

```
tests/e2e/
├── fixtures.ts                  # 共享测试数据常量
├── helpers/
│   ├── api.ts                   # API 请求封装（所有 /api/* 调用的 typed wrapper）
│   ├── visual.ts                # 截图 + VLM 视觉验证 helper
│   ├── wait.ts                  # 等待处理完成、任务完成等轮询工具
│   └── assertions.ts            # 自定义断言（内容质量、JSON 结构、错误检查）
├── 01-smoke.spec.ts             # 基础冒烟测试
├── 02-session.spec.ts           # Session 生命周期
├── 03-knowledge.spec.ts         # 知识库 + 文档处理
├── 04-search.spec.ts            # 检索系统
├── 05-agent.spec.ts             # Agent 执行引擎
├── 06-isolation.spec.ts         # 多 Session 并行隔离
├── 07-workflow.spec.ts          # Workflow 编排
├── 08-settings.spec.ts          # 设置面板
├── 09-panels.spec.ts            # 侧边面板（Teams/Skills/Plugins/Cron/MCP）
├── 10-robustness.spec.ts        # 异常与健壮性
└── 11-visual.spec.ts            # 全页面视觉遍历
```

### 2.2 Helper 设计

#### `helpers/api.ts`

封装所有 API 调用为 typed async 函数：

```typescript
export const api = {
  // Health
  health(): Promise<{ status: string; pg: boolean; ... }>,

  // Sessions
  listSessions(): Promise<Session[]>,
  createSession(title?: string, kbScope?: object): Promise<Session>,
  getSession(id: string): Promise<Session>,
  deleteSession(id: string): Promise<void>,
  getMessages(sessionId: string): Promise<Message[]>,
  patchScope(sessionId: string, kbScope: object): Promise<void>,
  uploadMedia(sessionId: string, file: Buffer, name: string, type: string): Promise<MediaMeta>,
  getMedia(sessionId: string, mediaId: string, type?: string): Promise<Response>,

  // Knowledge
  listKBs(): Promise<KB[]>,
  createKB(name: string): Promise<KB>,
  getKB(id: string): Promise<KB>,
  deleteKB(id: string): Promise<void>,
  uploadDocument(kbId: string, file: Buffer, name: string, type: string): Promise<Document>,
  listDocuments(kbId: string): Promise<Document[]>,
  getDocument(kbId: string, docId: string): Promise<Document>,
  deleteDocument(kbId: string, docId: string): Promise<void>,
  reprocessDocument(kbId: string, docId: string, channel: string): Promise<void>,
  getOriginalFile(kbId: string, docId: string): Promise<Response>,
  expandDocument(kbId: string, docId: string, level: string): Promise<any>,
  wikiBrowse(kbId: string, options?: object): Promise<any>,
  qualityReport(kbId: string): Promise<any>,

  // Search
  search(kbId: string, query: string, options?: SearchOptions): Promise<SearchResult>,
  crossKBSearch(query: string, options?: object): Promise<SearchResult>,
  searchTest(query: string, methods?: string[]): Promise<SearchTestResult>,

  // Agent
  runStream(input: string, sessionId: string, options?: AgentRunOptions): Promise<EventSource>,
  cancelTask(taskId: string): Promise<void>,
  getTaskStatus(taskId: string): Promise<TaskStatus>,
  injectMessage(taskId: string, message: string): Promise<void>,
  getCapabilities(): Promise<Capabilities>,

  // Settings
  getProviders(): Promise<Provider[]>,
  getDefaults(): Promise<Defaults>,
  setDefault(role: string, providerId: string): Promise<void>,
  getAgentSettings(): Promise<AgentSettings>,
  setAgentSettings(settings: Partial<AgentSettings>): Promise<void>,
  getFeatureFlags(): Promise<FeatureFlags>,

  // Panels
  listSkills(): Promise<Skill[]>,
  createSkill(skill: Partial<Skill>): Promise<Skill>,
  deleteSkill(id: string): Promise<void>,
  listPlugins(): Promise<Plugin[]>,
  listTeams(): Promise<Team[]>,
  createTeam(team: Partial<Team>): Promise<Team>,
  deleteTeam(id: string): Promise<void>,
  listCronJobs(): Promise<CronJob[]>,
  createCronJob(job: Partial<CronJob>): Promise<CronJob>,
  deleteCronJob(id: string): Promise<void>,
  listMCPServers(): Promise<MCPServer[]>,
  addMCPServer(server: Partial<MCPServer>): Promise<MCPServer>,
  deleteMCPServer(id: string): Promise<void>,

  // Reports
  listReports(sessionId?: string): Promise<Report[]>,
  getReport(id: string): Promise<Report>,
  deleteReport(id: string): Promise<void>,

  // Channels
  listChannels(): Promise<Channel[]>,
};
```

#### `helpers/visual.ts`

```typescript
export async function screenshotAndVerify(
  page: Page,
  name: string,
  options?: { selector?: string; fullPage?: boolean }
): Promise<{ path: string; vlmAnalysis?: string }>;

/** 用 VLM 分析截图，验证 UI 元素可见性、布局正确性 */
export async function verifyUISnapshot(
  page: Page,
  name: string,
  expectations: string[] // 如 ["sidebar 可见", "chat 输入框存在", "无错误提示"]
): Promise<boolean>;

/** 对比关键元素的可见性和文本内容 */
export async function checkElement(
  page: Page,
  selector: string,
  expectation: { visible?: boolean; text?: string; count?: number }
): Promise<boolean>;
```

#### `helpers/wait.ts`

```typescript
/** 轮询直到文档处理完成（status=ready 或 failed） */
export async function waitForDocumentReady(
  kbId: string, docId: string, timeout?: number
): Promise<Document>;

/** 轮询直到 Agent 任务完成 */
export async function waitForAgentTask(
  sessionId: string, taskId: string, timeout?: number
): Promise<TaskStatus>;

/** 轮询直到 session 消息数 >= expected */
export async function waitForMessages(
  sessionId: string, minCount: number, timeout?: number
): Promise<Message[]>;
```

### 2.3 Playwright 配置

使用现有 `playwright.config.ts`，仅调整：
- `timeout`: 120000（Agent 测试需要更长超时）
- 新增 `fullyParallel: false`（某些测试需要串行，避免资源竞争）

---

## 三、测试用例设计

### 3.1 冒烟测试 (`01-smoke.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 1.1 | 后端健康检查 `/api/health` 返回 200 + PG 连接正常 | C-06, C-33 | API GET |
| 1.2 | 前端页面加载 — React 根元素渲染完成，无白屏 | C-37 | Playwright 截图 + VLM 验证页面渲染 |
| 1.3 | 侧边栏显示 4 个导航项（Chat/Knowledge/Reports/Tasks） | C-37 | Playwright 截图验证 |
| 1.4 | 新建 Session 按钮可见且可点击 | C-41 | Playwright 点击 + API 验证 |
| 1.5 | WebSocket 连接建立成功 (`ws://localhost:21000/ws`) | G-22 | WebSocket 握手验证 |
| 1.6 | 静态资源加载无 404（JS/CSS bundles） | — | Playwright network 监听 |
| 1.7 | 前端无 console error（除已知无害 warning） | — | Playwright console 监听 |
| 1.8 | Agent 系统状态 — `/api/agents/capabilities` 返回有效数据 | C-43 | API GET |

### 3.2 Session 生命周期 (`02-session.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 2.1 | 创建 Session — 返回 201 + 包含 id/title/createdAt | C-41 | API POST + 验证字段 |
| 2.2 | 列出 Sessions — 包含刚创建的 Session | C-41 | API GET |
| 2.3 | 获取单个 Session — 返回正确数据 | C-41 | API GET |
| 2.4 | 发送用户消息 — 创建 assistant 回复 | C-41 | API SSE stream |
| 2.5 | 获取消息列表 — 包含 user + assistant 消息 | C-41 | API GET |
| 2.6 | 消息角色顺序 — user 在前，assistant 在后 | C-53 | API 验证 messages 数组顺序 |
| 2.7 | 删除 Session — 返回 200 + 级联清理验证 | G-05 | API DELETE + 验证 GET 404 |
| 2.8 | 删除 Session 清理媒体文件和输出目录 | G-05 | API 验证 media/output 路径不可访问 |
| 2.9 | Session scope 持久化 — PATCH scope 后刷新仍保留 | — | API PATCH + GET 验证 |
| 2.10 | Session 列表排除预处理 Session（`[预处理]` 前缀） | — | API 验证 |
| 2.11 | 多轮对话消息完整性 — 3 轮对话后消息数 = 6 | C-41 | API 发送 3 次消息 + 验证 |
| 2.12 | 聊天页面截图 — 输入框、消息列表、发送按钮正确渲染 | C-41 | Playwright 截图 + VLM |
| 2.13 | Session 切换 — 在两个 Session 间切换，消息不串 | C-41 | Playwright 操作 + 截图验证 |
| 2.14 | 媒体上传到 Session — 上传图片，返回 mediaId | G-33 | API POST + 验证 |
| 2.15 | 获取 Session 媒体文件 — 正确 Content-Type | C-17 | API GET + 验证 header |
| 2.16 | 媒体缩略图生成 — type=thumbnail 返回 webp | C-14 | API GET + 验证 Content-Type |

### 3.3 知识库与文档处理 (`03-knowledge.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 3.1 | 创建知识库 — 返回 id + name | C-03 | API POST |
| 3.2 | 列出知识库 — 包含新建 KB | C-37 | API GET |
| 3.3 | 获取知识库详情 — 含文档列表和统计 | C-37 | API GET |
| 3.4 | 删除知识库 — 级联清理（嵌入/锚点/页面/文件） | G-05 | API DELETE + 验证不可访问 |
| 3.5 | 上传 PDF 文档 — 处理完成后 status=ready | C-13 | API POST + 轮询等待 |
| 3.6 | PDF L0 内容验证 — 摘要非空、标签非空、类型正确 | C-10 | API expand L0 |
| 3.7 | PDF L1 内容验证 — DocTags/Markdown 格式，内容有意义（非纯页码） | C-09, C-11 | API expand L1 + 内容断言 |
| 3.8 | PDF L2 内容验证 — Docling JSON 结构完整 | C-08 | API expand L2 + JSON 结构断言 |
| 3.9 | 上传 XLSX 文档 — 处理完成后 status=ready | C-12 | API POST + 轮询 |
| 3.10 | XLSX 元数据描述验证 — 含 sheet 信息/列定义/样本行 | C-12 | API expand + 内容断言 |
| 3.11 | 上传图片（JPG） — VLM 描述 + OCR + EXIF | C-14 | API POST + L1 内容验证 |
| 3.12 | 图片缩略图生成 — 返回 webp 格式 | C-14 | API 验证 |
| 3.13 | 上传音频（MP3） — ASR 转写文本有意义 | C-15 | API POST + L1 内容验证 |
| 3.14 | 上传视频（MP4） — 视频理解模型处理 | C-16 | API POST + 内容验证 |
| 3.15 | 上传 DOCX 文档 — 处理正确 | C-13 | API POST + L1 验证 |
| 3.16 | 文档处理进度追踪 — 从 uploading → ready 状态流转 | G-06 | 轮询验证中间状态 |
| 3.17 | 文档删除 — 级联清理（嵌入+锚点+页面+文件） | G-05 | API DELETE + 验证 |
| 3.18 | 处理通道选择 — 下拉选择不同通道重新处理 | G-28 | API reprocess |
| 3.19 | 质量审计 — `/quality-report` 返回 KB 级汇总 | C-136 | API GET |
| 3.20 | Wiki browse — 返回知识库 Wiki 页面列表 | C-18 | API wikiBrowse |
| 3.21 | L1 预览 — 文档列表含 l1Preview 字段（前 300 字） | G-30 | API listDocuments 验证 |
| 3.22 | 知识库页面截图 — 文档树、搜索栏、Wiki 标签正确渲染 | C-37 | Playwright 截图 + VLM |
| 3.23 | 文档卡片 L0/L1/L2 按钮状态 — 灰色未就绪 → 绿色可预览 | C-38 | Playwright 截图验证 |
| 3.24 | 大内容虚拟滚动 — 大文档 L1 展开后不卡顿 | C-38 | Playwright 滚动 + 性能检查 |
| 3.25 | 原文件预览 — 图片直接渲染、音频带播放器 | C-17 | Playwright 截图 + VLM |
| 3.26 | 二进制文件上传保护 — read_file 拒绝 XLSX 等二进制文件 | C-217 | Agent 尝试 read_file 二进制文件 |

### 3.4 检索系统 (`04-search.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 4.1 | 语义搜索（向量） — 查询返回相关结果 | C-18 | API search(mode=vector) |
| 4.2 | 关键词搜索（BM25） — 中文分词正确 | C-35 | API search(mode=keyword) |
| 4.3 | 混合搜索（RRF 融合） — 结果优于单一方法 | C-18 | API search(mode=hybrid) |
| 4.4 | L0/L1/L2 层级搜索 — 不同层级返回对应内容 | C-18 | API search(level=L0/L1/L2) |
| 4.5 | topK 参数 — 不同 topK 值返回对应数量 | C-18 | API search(topK=5/10/20) |
| 4.6 | 搜索结果锚点 ID — 每条结果含 anchorId | C-04, C-21 | API 验证结果字段 |
| 4.7 | 跨知识库搜索 — 结果标注来源 KB | G-15 | API crossKBSearch |
| 4.8 | 中文搜索 — zhparser 分词准确 | C-35 | API 中文查询 + 结果验证 |
| 4.9 | 搜索测试工具 — RRF 融合对比多种搜索方法 | C-18 | API searchTest |
| 4.10 | 搜索栏 UI — 模式/层级/topK 选择器正确渲染 | C-40 | Playwright 截图 + VLM |
| 4.11 | 搜索结果高亮 — 匹配关键词高亮显示 | — | Playwright 截图验证 |
| 4.12 | 空搜索结果 — 优雅提示无结果 | — | API 搜索无匹配词 + 验证 |

### 3.5 Agent 执行引擎 (`05-agent.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 5.1 | 基础对话 — Agent 流式返回文本回复 | C-41 | SSE stream + 验证 content_delta 事件 |
| 5.2 | 工具调用 — Agent 调用工具并返回结果 | C-26 | SSE stream + 验证 tool_call 事件 |
| 5.3 | Thinking 内容 — thinking_delta 事件可见 | C-41, C-171 | SSE stream + 验证 thinking 事件 |
| 5.4 | Thinking 持久化 — 刷新后 thinking 内容仍在 | C-41 | 发送消息 → 刷新 → API 获取消息验证 metadata.thinkingContent |
| 5.5 | push_content 卡片 — Agent 推送结构化数据 | C-47, C-48 | SSE stream + 截图验证卡片渲染 |
| 5.6 | push_content 持久化 — 刷新后卡片仍在 | C-48 | 刷新页面 → 截图验证 |
| 5.7 | agent_todo 任务列表 — TodoPanel 实时更新 | C-58, C-59 | SSE stream + 截图验证 |
| 5.8 | Agent 取消 — cancel API 中止正在运行的任务 | C-25 | API cancel + 验证停止 |
| 5.9 | turn_usage 事件 — 每轮推送 token 用量 | C-82 | SSE stream + 验证事件字段 |
| 5.10 | 流式输出完整性 — 长输出不被截断 | C-51 | SSE 收集完整输出 + 验证 |
| 5.11 | 消息显示顺序 — 工具调用(上)→推理(中)→结果(下) | C-53 | Playwright 截图 + VLM 验证 |
| 5.12 | ask_user 交互 — Agent 提问，用户回复 | C-68 | SSE ask_user 事件 + inject API |
| 5.13 | Agent 截图 — 流式输出过程中 UI 正确渲染 | C-41 | Playwright 定时截图 |
| 5.14 | 多轮对话上下文 — Agent 记住前一轮内容 | C-50 | 发送 2 轮消息 + 验证上下文 |
| 5.15 | Agent 运行参数 — maxTurns/outputTokenBudget 配置 | C-125, G-34 | API 设置 + 验证 |

### 3.6 多 Session 并行隔离 (`06-isolation.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 6.1 | 并行 Session 上下文隔离 — 两个 Session 同时运行，Agent 不串台 | C-216 | 创建 2 Session + 并行 runStream + 验证各自回复内容独立 |
| 6.2 | 并行 Session scopeKbIds 隔离 — 不同 KB scope 的 Session 互不干扰 | C-216 | 不同 KB scope + 验证搜索结果 |
| 6.3 | inject 路由定向 — 消息只注入到目标 task | C-216 | 并行运行 + inject 到特定 taskId |
| 6.4 | 前端快速切换 — 在两个运行中 Session 间快速切换，无串台 | C-216 | Playwright 快速切换 + 截图验证 |
| 6.5 | 前端刷新持久化 — 刷新后两个 Session 内容都正确 | G-17 | Playwright 刷新 + 截图验证 |
| 6.6 | 预处理隔离 — 知识库预处理不影响正常对话 Session | C-216 | 并行预处理 + 对话 |
| 6.7 | 子 Agent 继承 — workflow 子 Agent 继承正确的 sessionId 和 scopeKbIds | C-216 | Workflow + 验证子 Agent 上下文 |

### 3.7 Workflow 编排 (`07-workflow.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 7.1 | Team 模板列表 — 7 个内置模板可用 | C-62 | API listTemplates |
| 7.2 | 创建 Team — 使用模板创建自定义 Team | C-24 | API createTeam |
| 7.3 | 执行 Workflow (sequential) — 顺序模式完成 | C-24 | API execute + 轮询结果 |
| 7.4 | 执行 Workflow (parallel) — 并行模式完成 | C-24 | API execute + 轮询 |
| 7.5 | 执行 Workflow (single) — 单 Agent 委托 | C-80 | API execute |
| 7.6 | Workflow 取消 — 执行中取消 | C-25 | API cancel + 验证 |
| 7.7 | workflow_run 工具 — Agent 内部调用 workflow_run | C-57 | Agent 对话触发 workflow_run |
| 7.8 | 子 Agent 信箱通信 — send_message 跨 Agent 通信 | C-77 | Agent 对话触发 |
| 7.9 | Workflow 面板截图 — 显示 Agent 状态和结果 | C-60 | Playwright 截图 + VLM |
| 7.10 | 删除 Team — 清理成功 | — | API deleteTeam |

### 3.8 设置面板 (`08-settings.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 8.1 | Provider 列表 — 返回所有已注册 provider | C-28 | API getProviders |
| 8.2 | 默认模型配置 — main/summarizer/embedding/vlm/asr/video/generation | C-29, C-30 | API getDefaults + 验证字段 |
| 8.3 | Agent 设置 — maxTurns/outputTokenBudget/subAgentMaxTurns | C-125 | API getAgentSettings |
| 8.4 | Feature Flags — 11 个标志正确返回 | G-34 | API getFeatureFlags |
| 8.5 | 设置面板截图 — 9 个 Tab 正确渲染 | G-11 | Playwright 截图 + VLM |
| 8.6 | 主模型配置 Tab — provider/model/temperature/maxTokens | C-28 | Playwright 截图验证 |
| 8.7 | 嵌入模型 Tab — provider/维度/状态 | C-32 | Playwright 截图验证 |
| 8.8 | VLM 配置 Tab — 独立配置入口 | C-30 | Playwright 截图验证 |
| 8.9 | 文档处理 Tab — Docling 并行度调整 (1-10) | G-01 | Playwright 操作 + API 验证 |
| 8.10 | maxTokens 无限制选项 — 值为 0 表示模型默认 | — | Playwright 验证下拉选项 |
| 8.11 | 设置持久化 — 保存后刷新仍保留 | G-23 | API 设置 → 刷新 → API 验证 |

### 3.9 侧边面板 (`09-panels.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 9.1 | Skills 列表 — 返回所有已注册技能 | C-72 | API listSkills |
| 9.2 | 创建自定义 Skill — 保存到 DB | C-72, C-100 | API createSkill + 验证 |
| 9.3 | 删除 Skill — 清理成功 | C-72 | API deleteSkill |
| 9.4 | Plugins 列表 — 显示已安装插件 | C-99 | API listPlugins |
| 9.5 | Teams 管理面板 — CRUD 操作 | G-12 | API + Playwright 截图 |
| 9.6 | TeamEditor 完整字段 — tools/dependsOn/perspective/systemPrompt | G-13 | Playwright 截图验证 |
| 9.7 | Cron Job 列表 — 返回定时任务 | G-21 | API listCronJobs |
| 9.8 | 创建 Cron Job — 表达式验证 | G-21 | API createCronJob + validate |
| 9.9 | 删除 Cron Job | G-21 | API deleteCronJob |
| 9.10 | MCP Server 列表 — 返回已配置的 MCP 服务器 | C-76 | API listMCPServers |
| 9.11 | 添加/删除 MCP Server | C-76, C-84 | API addMCPServer + deleteMCPServer |
| 9.12 | Header 按钮组截图 — Sessions/Skills/Plugins/Cron/Settings/Teams | G-09 | Playwright 截图 + VLM |
| 9.13 | 右侧滑出面板 — 560px 宽度正确 | G-10 | Playwright 截图验证 |
| 9.14 | Evolution 面板 — 7 个 toggle 开关 + 统计 | C-46 | Playwright 截图 + VLM |

### 3.10 异常与健壮性 (`10-robustness.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 10.1 | 二进制文件保护 — read_file 拒绝 .xlsx/.png/.mp3 等 | C-217 | Agent 尝试读取二进制文件 + 验证返回错误 |
| 10.2 | sanitizeJsonForPg — \u0000 null bytes 被清理 | C-218 | API 发送含 null bytes 的内容 + 验证不崩溃 |
| 10.3 | 空 Session 消息列表 — 返回空数组 | — | API GET 空 Session messages |
| 10.4 | 不存在的 Session 404 | — | API GET 无效 ID |
| 10.5 | 不存在的 KB 404 | — | API GET 无效 KB ID |
| 10.6 | 不存在的文档 404 | — | API GET 无效 doc ID |
| 10.7 | 无效 JSON body — API 返回 400 | — | API POST 无效 JSON |
| 10.8 | 路径遍历防护 — `/output/../etc/passwd` 被拒绝 | — | API GET + 验证 400 |
| 10.9 | XSS 防护 — DOMPurify 清理恶意 HTML | G-18 | Playwright 注入 script 标签 + 验证不执行 |
| 10.10 | 大文件上传 — 50MB 文件上传成功 | G-02 | API POST + 轮询等待 |
| 10.11 | 连续错误熔断 — 3 次失败后切换辅助模型 | C-44 | 模拟失败 + 验证切换 |
| 10.12 | Agent 输出截断恢复 — max_tokens 截断后续写 | C-89 | Agent 长输出 + 验证完整性 |
| 10.13 | 工具结果大结果持久化 — >50K 字符写入磁盘 | C-92 | Agent 触发大结果 + 验证 |
| 10.14 | 编辑文件唯一性检查 — old_string 多匹配报错 | C-93 | Agent edit_file 多匹配 |
| 10.15 | 无效文件上传 — 不支持的文件类型优雅失败 | G-02 | API POST + 验证错误信息 |
| 10.16 | Range 请求 — 音频/视频拖拽播放 | C-17 | API Range header + 验证 206 响应 |
| 10.17 | 中文文件名下载 — RFC 5987 编码正确 | C-220 | API 下载 + 验证 Content-Disposition |

### 3.11 全页面视觉遍历 (`11-visual.spec.ts`)

| # | 测试用例 | 覆盖需求 | 方法 |
|---|---------|---------|------|
| 11.1 | 聊天页面 — 空状态（无 Session） | C-37 | Playwright 截图 + VLM |
| 11.2 | 聊天页面 — 有消息状态 | C-41 | Playwright 截图 + VLM |
| 11.3 | 聊天页面 — Agent 流式输出中 | C-41 | Playwright 截图 |
| 11.4 | 聊天页面 — 工具调用展开/折叠 | C-41 | Playwright 操作 + 截图 |
| 11.5 | 聊天页面 — Thinking 内容显示 | C-41 | Playwright 截图 |
| 11.6 | 聊天页面 — TodoPanel 任务进度 | C-59 | Playwright 截图 |
| 11.7 | 聊天页面 — 文件上传按钮和预览 | G-14, G-33 | Playwright 截图 |
| 11.8 | 知识库页面 — 文档树视图 | C-37 | Playwright 截图 + VLM |
| 11.9 | 知识库页面 — 文档卡片（就绪/处理中/失败） | C-38 | Playwright 截图 |
| 11.10 | 知识库页面 — L0/L1/L2 展开预览 | C-38 | Playwright 截图 |
| 11.11 | 知识库页面 — 搜索栏和搜索结果 | C-40 | Playwright 截图 |
| 11.12 | 知识库页面 — 多媒体播放器 | C-39 | Playwright 截图 |
| 11.13 | 报告页面 — 报告列表和时间线 | C-42 | Playwright 截图 |
| 11.14 | 任务页面 — Agent 任务状态 | C-22 | Playwright 截图 |
| 11.15 | 设置页面 — 各 Tab 完整截图 | G-11 | Playwright 截图 |
| 11.16 | 设置页面 — 模型配置交互 | C-28 | Playwright 操作 + 截图 |
| 11.17 | 深色主题 — 切换后所有页面正确渲染 | G-08 | Playwright 主题切换 + 截图 |
| 11.18 | 侧边栏折叠/展开 | G-17 | Playwright 操作 + 截图 |
| 11.19 | 右侧面板 — Teams/Skills/Plugins/Cron/MCP | G-10 | Playwright 截图 |
| 11.20 | 侧边栏 Header 按钮组 — 所有面板入口 | G-09 | Playwright 截图 |
| 11.21 | 移动端视口（可选） — 基本布局不崩溃 | F-03 | Playwright mobile viewport 截图 |

---

## 四、测试数据策略

### 4.1 测试知识库

使用现有 fixtures 中的测试 KB（`3d7b3ebc-...`），同时每个测试 spec 可创建临时 KB 用于隔离测试。

### 4.2 测试文件

| 文件 | 用途 | 来源 |
|------|------|------|
| `antigravity-rag-2026.pdf` | PDF 处理验证 | 现有 fixtures |
| `athlete_events.xlsx` | XLSX 处理验证 | 现有 fixtures |
| `20260314-172020.jpg` | 图片 VLM 验证 | 现有 fixtures |
| MP3 音频 | 音频 ASR 验证 | 现有 fixtures |
| MP4 视频 | 视频理解验证 | 现有 fixtures |
| `test.docx` | DOCX 处理验证 | 测试用 |

### 4.3 数据隔离

- 每个 spec 的测试在 `beforeAll` 创建所需数据，`afterAll` 清理
- 不依赖其他 spec 的数据
- 并行安全：Session ID 和 KB ID 使用 UUID，无冲突

---

## 五、执行策略

### 5.1 执行顺序

按编号顺序执行（01-11），因为存在逻辑依赖：
- 01-smoke 确认系统可用
- 02-session 创建基础数据
- 03-knowledge 创建知识库数据
- 04-search 依赖知识库数据
- 05-06-07 依赖 Session + Agent 系统

### 5.2 超时策略

| 测试类型 | 超时时间 |
|---------|---------|
| API 级测试 | 30s |
| 文档处理等待 | 180s（大文件可能需要） |
| Agent 执行 | 300s（复杂 Agent 任务） |
| Playwright 截图 | 15s |
| VLM 视觉分析 | 30s |

### 5.3 失败处理

- 每个失败测试自动截图
- 保留 Playwright trace 用于调试
- 不自动重试（retries=0），方便定位真实问题

---

## 六、覆盖率映射

### 需求 → 测试用例映射

| 需求类别 | 测试文件 | 覆盖率 |
|---------|---------|--------|
| C-01 通用 Agent | 05-agent, 07-workflow | ✓ |
| C-02 TAOR 循环 | 05-agent | ✓ |
| C-03 知识预编译 | 03-knowledge | ✓ |
| C-04 锚点溯源 | 04-search (4.6) | ✓ |
| C-05 Plugin/Skill/MCP | 09-panels | ✓ |
| C-06 单机部署 | 01-smoke | ✓ |
| C-07~C-12 三层数据 | 03-knowledge (3.5-3.10) | ✓ |
| C-13~C-17 多模态 | 03-knowledge (3.5, 3.11-3.15, 3.25) | ✓ |
| C-18~C-21 检索 | 04-search | ✓ |
| C-22~C-27 Agent 体系 | 05-agent, 07-workflow | ✓ |
| C-28~C-32 模型/Provider | 08-settings | ✓ |
| C-33~C-36 数据库 | 01-smoke, 04-search | ✓ |
| C-37~C-42 前端核心 | 11-visual | ✓ |
| C-43~C-46 健壮性 | 10-robustness | ✓ |
| C-47~C-48 push_content | 05-agent (5.5-5.6) | ✓ |
| C-49 DocTags 乱码 | 10-robustness (隐含) | ✓ |
| C-50~C-55 Agent 优化 | 05-agent | ✓ |
| C-56~C-84 Agent 增强 | 05-agent, 07-workflow | ✓ |
| C-85~C-100 工具/缓存/Plugin | 05-agent, 09-panels | ✓ |
| C-101~C-145 后续需求 | 分布在多个文件 | ✓ |
| C-171 Thinking 持久化 | 05-agent (5.3-5.4) | ✓ |
| C-216 ALS 隔离 | 06-isolation | ✓ |
| C-217 二进制保护 | 10-robustness (10.1) | ✓ |
| C-218 sanitizeJsonForPg | 10-robustness (10.2) | ✓ |
| C-220 RFC 5987 | 10-robustness (10.17) | ✓ |
| G-01~G-07 文档处理 | 03-knowledge | ✓ |
| G-08~G-18 前端一般 | 11-visual, 08-settings | ✓ |
| G-19~G-22 工具通信 | 09-panels, 01-smoke | ✓ |
| G-23~G-34 配置部署 | 08-settings, 01-smoke | ✓ |
