# DeepAnalyze 系统性问题修复计划

## 一、问题全景

经代码层面全链路追踪，当前存在以下系统性问题：

| # | 问题 | 根因 | 影响程度 |
|---|------|------|----------|
| 1 | 对话无流式输出，工具调用不可见 | 后端无WebSocket/SSE，前端有完整流式代码但未接入 | **P0 核心** |
| 2 | 知识库页面空白无内容 | kbId初始为空，API错误被静默吞掉，无错误反馈 | P1 |
| 3 | 视图切换失败（知识库→对话） | 可能与懒加载错误边界或session状态有关 | P1 |
| 4 | Session过多 | 功能正常但UX问题——每次点侧栏"新对话"都创建新session | P2 |
| 5 | Agent工具链严重缺失 | 只注册了wiki工具，缺少Read/Bash/Grep等基础工具 | **P0 核心** |
| 6 | SubtaskPanel冗余显示 | ChatWindow内嵌了SubtaskPanel，Agent完成后仍残留 | P2 |

---

## 二、各问题详细分析与修复方案

### 问题1: 无流式输出 + 工具调用不可见 (P0)

**根因分析：**

全链路追踪结果：
- 前端 `ChatWindow` → `sendMessage()` → `api.runAgent()` → `POST /api/agents/run` → **同步阻塞等待** → 整个Agent TAOR循环完成后才返回单个JSON
- 后端 `AgentRunner` 已有完整事件系统（`onEvent`回调），会发射 `start`、`turn`、`tool_call`、`tool_result`、`complete` 等事件，但 `agents.ts` 的 `/run` 路由**从未传入 onEvent 回调**，所有事件被丢弃
- 前端有完整的 WebSocket 基础设施（`useWebSocket.ts`、流式store actions、`ThinkingIndicator`），但**从未被任何组件import使用**
- 后端**没有WebSocket服务器**，`ws://host/ws/chat` 端点不存在

**修复方案：采用 SSE (Server-Sent Events)**

不选WebSocket的原因：前后端都需要较大改动。SSE更轻量，只需修改一个路由。

方案：
1. 新增 `POST /api/agents/run-stream` SSE端点——返回 `text/event-stream` 响应
2. 在路由中传入 `onEvent` 回调，将Agent事件实时写入SSE流
3. 前端 `sendMessage` 改用 `fetch` + `ReadableStream` 读取SSE事件
4. 将SSE事件分发到已有的流式store actions (`startStreaming`、`appendStreamContent`、`addStreamToolCall` 等)

**涉及文件：**
- 新建 `src/server/routes/agent-events.ts` — SSE事件格式化
- 修改 `src/server/routes/agents.ts` — 新增 `/run-stream` 路由
- 修改 `frontend/src/store/chat.ts` — `sendMessage` 改为SSE消费
- 修改 `frontend/src/components/ChatWindow.tsx` — 接入流式显示
- 修改 `frontend/src/api/client.ts` — 新增 `runAgentStream()` 方法

### 问题2: 知识库页面空白 (P1)

**根因分析：**
- `App.tsx` 中 `currentKbId` 初始为 `""`
- `KnowledgePanel` 的 `loadKnowledgeBases` 尝试自动选择第一个KB，但API调用失败时**空catch块静默吞掉错误**
- 用户看到的是"请选择或创建知识库"的空白状态，没有错误反馈
- 后端实际有3个KB（之前OpenClaw测试创建的），所以API应该能返回数据

**修复方案：**
1. 给 `loadKnowledgeBases` 添加错误状态显示
2. 在 `App.tsx` 初始化时预加载KB列表，自动设置默认 `kbId`
3. 确保API路径正确（前端调的是 `GET /api/knowledge/kbs`）

**涉及文件：**
- 修改 `frontend/src/components/knowledge/KnowledgePanel.tsx`
- 修改 `frontend/src/App.tsx`

### 问题3: 视图切换失败 (P1)

**根因分析：**
- 代码逻辑本身正确：`setActiveView('chat')` 切换后 ViewRouter 重新渲染 `ChatWindow`
- 可能原因1：懒加载 `ChatWindow` 时触发 `ViewErrorBoundary`，显示"页面加载失败"
- 可能原因2：切换后 `currentSessionId` 丢失（需验证）
- 可能原因3：CSS/布局问题导致 `ChatWindow` 渲染但不可见

**修复方案：**
1. 在 ErrorBoundary 中添加详细错误日志
2. 验证视图切换时 session 状态是否保留
3. 检查是否有 CSS z-index/overflow 问题遮挡内容

**涉及文件：**
- 修改 `frontend/src/App.tsx` — ErrorBoundary 添加 console.error
- 修改 `frontend/src/store/chat.ts` — 确保切换不丢失状态

### 问题4: Session管理 (P2)

**分析：**
- 代码审查发现session只在用户主动操作时创建（点击"新对话"按钮、Ctrl+N、快捷提示），不是自动创建
- 用户看到很多session可能是之前测试过程中多次点击创建的
- 真正的问题可能是侧栏"新对话"按钮太容易触发

**修复方案：**
- 添加"清理空会话"功能
- 侧栏只显示有消息的session

**涉及文件：**
- 修改 `frontend/src/components/layout/Sidebar.tsx`

### 问题5: Agent工具链缺失 (P0)

**根因分析：**

设计文档（Section 6.1）要求保留13类Claude Code工具 + 新增11个工具。当前 `tool-setup.ts` 只注册了：
- think, finish（基础工具）
- kb_search, wiki_browse, expand, report_generate, timeline_build, graph_build（wiki工具）

**缺失的工具（设计文档要求保留）：**
- `Read` — 读取文件/图片/PDF
- `FileEdit` — 文件编辑
- `FileWrite` — 文件写入
- `Grep` — 内容搜索
- `Glob` — 文件模式匹配
- `Bash` — Shell命令执行
- `WebSearch` — 网络搜索
- `WebFetch` — URL内容获取
- `AgentTool` — 父子Agent调度

这就是为什么Agent自己分析后说"缺少文件操作、代码执行、网络搜索能力"。

**修复方案：**
在 `tool-setup.ts` 中注册这些工具的实现。每个工具需要一个适配器将原有Claude Code工具逻辑桥接到新的工具接口。

但这个工作量巨大（每个工具都是一个完整的模块），建议分优先级：
- **立即**：注册 Read、Grep、Glob（只读工具，安全且最常用）
- **尽快**：注册 Bash、WebSearch、WebFetch
- **后续**：注册 FileEdit、FileWrite、AgentTool

**涉及文件：**
- 修改 `src/services/agent/tool-setup.ts`
- 可能需要创建 `src/tools/` 下的各工具适配器

### 问题6: SubtaskPanel冗余显示 (P2)

**分析：**
- `SubtaskPanel` 嵌入在 `ChatWindow` 中，当 `agentTasks` 非空时显示
- Agent完成后任务仍然保留在列表中
- 对于简单的单Agent对话，这个面板确实是冗余的

**修复方案：**
- SubtaskPanel 默认折叠/隐藏
- 只在有正在运行的任务时自动展开
- 或者添加一个关闭按钮

**涉及文件：**
- 修改 `frontend/src/components/chat/SubtaskPanel.tsx`

---

## 三、优先级排序与实施计划

### 第一批（核心功能修复）

| 步骤 | 任务 | 预期效果 |
|------|------|----------|
| 1 | 注册基础只读工具(Read/Grep/Glob) | Agent能读取文件、搜索内容 |
| 2 | 添加SSE流式端点 + 前端接入 | 对话实时流式输出，可见工具调用步骤 |
| 3 | 修复知识库页面 | 知识库正常展示KB列表和文档 |

### 第二批（体验优化）

| 步骤 | 任务 | 预期效果 |
|------|------|----------|
| 4 | 修复视图切换 | 知识库↔对话切换顺畅 |
| 5 | 注册Bash/WebSearch工具 | Agent有代码执行和网络搜索能力 |
| 6 | 优化Session和SubtaskPanel | 清理冗余session，折叠子任务面板 |

---

## 四、技术方案选型

### 流式输出：SSE vs WebSocket

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 实现复杂度 | 低（后端只需改1个路由） | 高（需要WebSocket服务器） |
| 前端适配 | fetch ReadableStream | 需连接ws库 |
| 双向通信 | 不需要（我们只需服务器→客户端） | 过度设计 |
| 断线重连 | 浏览器内置 | 需手动实现 |
| 代理/CDN兼容 | 好于WS | 可能被拦截 |

**选择SSE**。原因：
1. 我们只需要服务器→客户端的单向流，不需要双向通信
2. 前端已有流式store actions，只需接入SSE事件即可
3. 后端改动最小——只需在 `/run` 路由中返回 `text/event-stream` 响应
4. Hono原生支持流式响应
