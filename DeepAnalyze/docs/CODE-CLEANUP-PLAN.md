# DeepAnalyze 代码整理方案

> **状态：大部分已完成（2026-05-25 更新）**
> - CC 专用代码已移入 `old_code/`（1,321 文件）
> - DA 核心代码（src/）保持干净，279 个 TypeScript 源文件
> - 从 CC 迁移的通用工具已集成到 `src/utils/`（17 个工具文件 + 3 个 bash 解析器文件）
> - 高价值的 CC 通用模块已提取并适配到 DA，不再依赖 CC 内部基础设施
> - 以下原始方案细节保留作为历史参考

## 目标
为独立完整的软件发布做准备，只保留 DeepAnalyze 开发版完整代码，其他内容移到 old_code/ 目录。

## 原则
- 保留的文件后续构成 DeepAnalyze 软件完整源码
- 移走的文件在 old_code/ 下保持原始目录结构，方便恢复
- 文档（docs/, CLAUDE.md, README.md 等）不动
- refcode/ 目录不动
- 模型/组件（whisper-models/, whisper-service/, paddleocr-vl-service/, docling-service/, embedding_server.py, pip-wheels/）不动

---

## 一、顶层文件移动（old_code/）

### 移动到 old_code/ — 测试/调试脚本
| 文件 | 说明 |
|------|------|
| e2e-final.mjs | E2E 测试脚本 |
| e2e-full-test.mjs | E2E 测试脚本 |
| e2e-plugin-test.mjs | E2E 测试脚本 |
| e2e-retest-browser.mjs | E2E 测试脚本 |
| e2e-retest-evidence.mjs | E2E 测试脚本 |
| e2e-retest2.mjs | E2E 测试脚本 |
| e2e-test-evidence.mjs | E2E 测试脚本 |
| e2e-test-evidence2.mjs | E2E 测试脚本 |
| test-compaction-curl.sh | 测试脚本 |
| test-compaction.py | 测试脚本 |
| test-context-optimization.py | 测试脚本 |
| test-folder-structure.ts | 测试脚本 |
| test-multiagent.sh | 测试脚本 |
| test-phase2-audit.py | 测试脚本 |
| test-suite.md | 测试文档 |
| debug-page2.mjs.bak | 调试备份文件 |
| check-frontend.mjs | 开发辅助脚本 |
| playwright.config.ts | Playwright 配置（无实际测试用例引用） |
| vitest.config.ts | Vitest 配置（改用 bun test） |

### 移动到 old_code/ — 测试/基准数据目录
| 目录 | 说明 |
|------|------|
| benchmarks/ | Agent 基准测试套件 (115MB) |
| cc_test/ | 旧回归测试数据 |
| test-reports/ | 历史测试报告 |
| test-results/ | 测试结果 |
| tmp/ | 临时案例数据 |

### 移动到 old_code/ — data/tmp/ 内容
| 路径 | 说明 |
|------|------|
| data/tmp/*.md | 约 40 个历史 transcript 文件 |
| data/tmp/*.txt | 10万字小说测试文件 |
| data/tmp/lbctest_analysis/ | 测试分析目录 |
| data/tmp/transcripts/ | transcript 子目录 |

---

## 二、src/ 目录清理 — Claude Code 遗留代码

### 移动到 old_code/src/ — CC 核心文件
| 文件 | 说明 |
|------|------|
| src/Tool.ts | CC Tool 类型定义 |
| src/context.ts | CC 上下文模块 |
| src/tools.ts | CC 工具模块 |
| src/query.ts | CC 查询模块 |

### 移动到 old_code/src/ — CC 目录（整体移动）
| 目录 | 文件数 | 说明 |
|------|--------|------|
| src/assistant/ | 1 | CC 会话历史 |
| src/buddy/ | 6 | CC 伴侣精灵 UI |
| src/cli/ | 19 | CC CLI 终端 I/O |
| src/commands/ | ~96 | CC 斜杠命令 |
| src/ink/ | ~96 | CC 终端渲染框架 |
| src/components/ | ~389 | CC 终端 TUI 组件 |
| src/vim/ | 5 | CC Vim 模拟 |
| src/keybindings/ | ~2 | CC 快捷键配置 |
| src/remote/ | 4 | CC 远程会话 |
| src/upstreamproxy/ | 2 | CC 上游代理 |
| src/voice/ | 1 | CC 语音模式 |
| src/swarm/ | 24 | CC 多Agent swarm |
| src/subprocess/ | ~3 | CC 子进程管理 |
| src/migrations/ | 11 | CC 模型迁移 |
| src/types-claude/ | 11 | CC 生成类型 |
| src/native-ts/ | ~5 | CC 原生模块 |
| src/polyfills/ | 2 | CC polyfills |
| src/moreright/ | 1 | CC hook |
| src/outputStyles/ | 1 | CC 输出样式 |
| src/memdir/ | 8 | CC 记忆目录 |
| src/proactive/ | 0 | 空目录 |
| src/hooks/ | 94 | CC React hooks |
| src/context/ | 9 | CC React contexts |
| src/schemas/ | 1 | CC Zod schemas |
| src/shared/ | 0 | 空目录 |
| src/tasks/ | 12 | CC 任务系统 |

### src/utils/ — 整体移到 old_code，保留 7 个 DA 使用的文件
| 操作 | 文件 |
|------|------|
| 保留 | utils/shell/powershellDetection.ts |
| 保留 | utils/powershell/parser.ts |
| 保留 | utils/errors.ts |
| 保留 | utils/slowOperations.ts |
| 保留 | utils/lazySchema.ts |
| 保留 | utils/debug.ts |
| 保留 | utils/teleport/api.ts |
| 移到 old_code | 其余 ~193 个文件 |

### src/types/ — 保留 DA 文件，移走 CC 文件
| 操作 | 文件 |
|------|------|
| 保留 | types/index.ts, connectorText.ts, message.ts, notebook.ts, tools.ts, utils.ts, querySource.ts |
| 移到 old_code | types/command.ts, hooks.ts, ids.ts, logs.ts, permissions.ts, plugin.ts, textInputTypes.ts, generated/ |

### src/constants/ — 保留 1 个 DA 文件，移走其余
| 操作 | 文件 |
|------|------|
| 保留 | constants/querySource.ts |
| 移到 old_code | 其余 21 个文件 |

### src/services/ — 移走 CC 服务目录
| 移到 old_code | 说明 |
|---------------|------|
| services/analytics/ | CC 分析/遥测 |
| services/api/ | CC Anthropic API 客户端 |
| services/autoDream/ | CC 自动记忆 |
| services/awaySummary.ts | CC 离开摘要 |
| services/claudeAiLimits.ts | CC 订阅限制 |
| services/compact/ | CC 上下文压缩（空） |
| services/contextCollapse/ | CC 上下文折叠（空） |
| services/extractMemories/ | CC 记忆提取 |
| services/hub/ | CC Hub 客户端 |
| services/lsp/ | CC LSP 服务器 |
| services/mcp/ | CC MCP 管理 |
| services/memory/ | CC 会话记忆 |
| services/notifier.ts | CC 终端通知 |
| services/oauth/ | CC OAuth 认证 |
| services/plugins/ | CC 插件管理 |
| services/policyLimits/ | CC 策略限制 |
| services/remoteManagedSettings/ | CC 远程设置 |
| services/session/ | CC 会话 JSONL |
| services/skills/ | CC 内置技能 |
| services/teamMemorySync/ | CC 团队记忆同步 |
| services/tips/ | CC 提示系统 |
| services/tokenEstimation.ts | CC token 估算 |
| services/toolUseSummary/ | CC 工具使用摘要 |
| services/tools/ | CC 流式工具执行 |
| services/AgentSummary/ | CC Agent 摘要 |
| services/MagicDocs/ | CC 魔法文档 |
| services/PromptSuggestion/ | CC 提示建议 |
| services/SessionMemory/ | CC 会话记忆 |

### src/tools/ — 保留 DA 使用的，移走 CC 的
| 保留 | 说明 |
|------|------|
| tools/GraphTool/ | DA 图谱工具 |
| tools/ReportTool/ | DA 报告工具 |
| tools/TimelineTool/ | DA 时间线工具 |
| tools/PowerShellTool/ | 保留其中 destructiveCommandWarning.js 和 powershellSecurity.js |
| tools/index.ts | 工具导出入口 |
| tools/utils.ts | 工具共享工具函数 |
| tools/shared/ | 工具共享代码 |
| tools/testing/ | 工具测试基础设施 |

| 移到 old_code | 说明 |
|---------------|------|
| 其余约 33 个工具目录 | AgentTool, BashTool, FileEditTool, FileReadTool, GlobTool, GrepTool, REPLTool, WebSearchTool, LSPTool, MCPTool, NotebookEditTool, EnterPlanModeTool, ExitPlanModeTool, EnterWorktreeTool, ExitWorktreeTool, RemoteTriggerTool, SleepTool, SyntheticOutputTool, TaskCreateTool, TaskGetTool, TaskListTool, TaskOutputTool, TaskStopTool, TaskUpdateTool, TeamCreateTool, TeamDeleteTool, TodoWriteTool, ToolSearchTool, AskUserQuestionTool, BriefTool, ConfigTool, McpAuthTool, ListMcpResourcesTool, ReadMcpResourceTool, ScheduleCronTool, SendMessageTool, SkillTool, WebFetchTool, ExpandTool, FileWriteTool, GrepTool, KBSearchTool, WikiBrowseTool, PowerShellTool（保留 2 个辅助文件后移走主体） |

注意：PowerShellTool 需要特殊处理 — 只保留 destructiveCommandWarning.js 和 powershellSecurity.js 两个文件，其余内容移到 old_code。

---

## 三、保留不动的内容

### 顶层保留
| 文件/目录 | 说明 |
|-----------|------|
| CLAUDE.md, README.md | 开发原则和项目文档 |
| .env, .env.example | 环境配置 |
| .gitignore, .dockerignore | 版本控制 |
| package.json, package-lock.json | 依赖配置 |
| tsconfig.json | TypeScript 配置 |
| bun-loader.mjs | Bun 加载器 |
| start.py | 启动脚本 |
| start-with-proxy.sh | 代理启动 |
| embedding_server.py | 嵌入服务 |
| Dockerfile, Dockerfile.offline | Docker 构建 |
| docker-compose.yml, docker-compose.dev.yml | Docker 编排 |
| node_modules/ | 运行时依赖 |
| pip-wheels/ | Python 离线包 |
| uploads/ | 上传暂存 |
| data/ | 运行时数据（除 tmp/ 内容移走） |
| docs/ | 文档目录 |
| refcode/ | 参考代码（不动） |
| .superpowers/ | 插件数据 |
| .git/ | 版本控制 |

### DA 核心代码保留
| 目录 | 说明 |
|------|------|
| src/main.ts | 服务器入口 |
| src/core/ | 核心配置 |
| src/server/ | HTTP/WebSocket 服务 |
| src/store/ | PostgreSQL 存储 |
| src/wiki/ | Wiki 引擎 |
| src/models/ | LLM 提供商 |
| src/services/agent/ | Agent 系统（100% DA） |
| src/services/document-processors/ | 文档处理 |
| src/services/channels/ | 消息通道 |
| src/services/cron/ | 定时任务 |
| src/services/report/ | 报告生成 |
| src/services/ DA 独立文件 | embedding-reindex, event-bus, folder-migration, model-manager, paddleocr-vl-manager, processing-queue, display-resolver |
| src/bootstrap/ | DA 兼容层 |
| src/test-utils/ | DA 测试工具 |
| src/state/ | 应用状态 |
| src/coordinator/ | Agent 协调 |
| src/plugins/ | DA 插件系统 |
| src/skills/ | DA 技能系统 |

### 组件/服务保留
| 目录 | 说明 |
|------|------|
| frontend/ | 前端代码 |
| config/ | 配置文件 |
| plugins/ | 插件目录 |
| docling-service/ | Docling 解析服务 |
| whisper-service/ | Whisper ASR 服务 |
| whisper-models/ | Whisper 模型文件 |
| paddleocr-vl-service/ | PaddleOCR 视觉服务 |
| deploy/ | 部署脚本 |
| tests/ | 活跃测试 |
| scripts/ | 开发脚本 |

---

## 四、预计效果

### 移除文件统计
- src/ 下 CC 遗留代码：约 750+ 文件
- 顶层测试脚本：约 18 个文件
- 测试/基准数据：benchmarks/, cc_test/, test-reports/, test-results/, tmp/
- data/tmp/ 临时数据：约 40+ 个文件

### 编译效果
移除 CC 遗留代码后，`npx tsc --noEmit` 的编译错误将从当前的数百个（全部来自 CC 代码）减少到接近 0。

### 目录结构预期
清理后 src/ 下只保留：
```
src/
├── main.ts
├── bootstrap/
├── constants/ (1 file: querySource.ts)
├── core/
├── coordinator/
├── models/
├── plugins/
├── server/
├── services/
│   ├── agent/ (DA 核心，全部保留)
│   ├── channels/
│   ├── cron/
│   ├── document-processors/
│   ├── report/
│   └── *.ts (DA 独立服务文件)
├── skills/
├── state/
├── store/
├── test-utils/
├── tools/ (3 个 DA 工具 + PowerShell 辅助)
├── types/ (7 个 DA 类型文件)
├── utils/ (7 个 DA 使用的工具)
└── wiki/
```

---

## 五、执行顺序

1. 创建 old_code/ 目录结构
2. 移动顶层测试脚本和调试文件
3. 移动测试/基准数据目录
4. 移动 data/tmp/ 内容
5. 移动 src/ 下 CC 目录（按批次）
6. 处理 src/utils/（整体移走，复制 7 个回来）
7. 处理 src/types/（逐文件分离）
8. 处理 src/constants/（逐文件分离）
9. 处理 src/tools/（逐目录分离）
10. 处理 src/services/（逐目录分离）
11. 运行编译检查
12. 运行单元测试验证
