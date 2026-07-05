# 第 8 册：部署、路线图与范围外事项

> **文档日期**: 2026-04-20
> **来源**: 综合 04-08 初始路线图、04-15 实施阶段、04-18 子项目依赖关系

---

## 1. 部署方案

### 1.1 本地开发部署

```bash
# 安装依赖
npm install
cd frontend && npm install && cd ..

# 构建前端
cd frontend && npx vite build && cd ..

# 配置环境
cp .env.example .env
# 编辑 .env 设置 PG_HOST, API keys 等

# 启动（Python 启动器，自动管理 Docling 子进程）
python start.py start

# 或直接启动
npx tsx src/main.ts
```

默认端口：`http://localhost:21000`

### 1.2 Docker 部署

```yaml
# docker-compose.yml
services:
  deepanalyze:
    build: .
    ports:
      - "21000:21000"
    environment:
      - PG_HOST=postgres
      - DATA_DIR=/data
    volumes:
      - ./data:/data
    depends_on:
      - postgres

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: deepanalyze
      POSTGRES_USER: deepanalyze
      POSTGRES_PASSWORD: ${PG_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data

  docling:
    build: ./docling-service
    # Docling Python 服务

volumes:
  pgdata:
```

### 1.3 数据目录结构

```
data/                           ← 可配置，支持外部存储
├── raw/                        ← Raw 层文件
├── wiki/                       ← Structure + Abstract 层文件
├── original/                   ← 用户上传的原始文件
├── models/                     ← 本地模型文件
│   └── docling/                ← Docling 模型
└── embeddings/                 ← 本地嵌入缓存（可选）
```

---

## 2. 实施路线图

### 2.1 总体依赖关系 (04-18 提出)

```
子项目 1: Provider 重构与模型配置对齐
    ↓
子项目 2: 文档处理流水线修复与多媒体完善
    ↓
子项目 3: 知识库 UI 统一重写（含多媒体预览播放）
    ↓
子项目 4: Agent 体系优化
    ↓
子项目 5: 系统健壮性与自动降级
```

每个子项目独立完成 spec → plan → 实施 → 验证，子项目间通过接口隔离。

### 2.2 PG 迁移路线 (04-17 提出)

```
Phase 1: 基础设施
  - 扩展 interfaces.ts（17 个接口 + 领域类型）
  - 添加 PG migration 004, 005
  - 更新 factory（PG-only，移除 SQLite 切换）
  - 重写 main.ts 为 PG-only 启动
  - 添加 getRepos() 单例

Phase 2: 核心 Repos
  - SettingsRepo, KnowledgeBaseRepo, SessionRepo, MessageRepo

Phase 3: 文档与 Wiki 核心
  - DocumentRepo, WikiPageRepo, WikiLinkRepo

Phase 4: 领域服务
  - EmbeddingRepo, CronJobRepo, PluginRepo, SkillRepo, SessionMemoryRepo, AgentTaskRepo

Phase 5: 复合服务
  - ReportRepo, AgentTeamRepo
  - Retriever 移除 SQLite 代码
  - Indexer 移除 SQLite 代码

Phase 6: 清理
  - 删除所有 SQLite 文件
  - 移除 better-sqlite3 依赖
  - 更新测试
```

### 2.3 原始阶段路线图 (04-08 提出，部分已完成)

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 0 | Agent Harness 保留与验证 | 已完成 |
| Phase 1 | 基础 Wiki 引擎（L0/L1/L2 编译） | 已完成（后重构为 Raw/Structure/Abstract） |
| Phase 2 | 多模态文档处理 | 部分完成（正在进行多媒体增强） |
| Phase 3 | 前端完整实现 | 部分完成（正在进行 UI 重写） |
| Phase 4 | 高级功能（Teams/Reports/Plugins） | 部分完成 |
| Phase 5 | 性能优化与测试 | 未开始 |

---

## 3. 不在当前范围内的事项

| 项目 | 说明 | 备注 |
|------|------|------|
| **知识图谱与关系抽取** | 保留现有代码和入口，暂不启用 | 04-15 决定冻结 |
| **3D 生成能力** | 保留增强模型配置入口，暂不实现 | 04-18 保留 |
| **用户认证系统** | `users` 表已存在但无实际使用 | 后续按需实现 |
| **全文搜索缓存** | `search_cache` 表已存在但无实现 | 后续按需 |
| **消息分页加载** | 大对话场景下再优化 | 后续 |
| **移动端响应式** | 完整移动适配 | 后续 |
| **多语言 i18n** | 国际化框架 | 后续 |
| **插件市场** | 在线插件安装/管理 | 后续 |

---

## 4. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Provider 配置变更导致现有功能不可用 | 高 | 保留 YAML fallback，配置错误时自动回退 |
| PG 迁移过程中数据丢失 | 高 | 保留 migrate-sqlite-to-pg.ts 脚本，渐进迁移 |
| 发言人分离依赖额外服务/API | 中 | 三级降级：API → 静默检测 → 单一说话者 |
| 视频理解模型不支持直接视频输入 | 中 | 降级到帧采样+逐帧VLM |
| 视频音频轨提取依赖 ffmpeg | 中 | ffmpeg 不可用时跳过音频转写 |
| 知识库 UI 重写影响现有工作流 | 中 | 新旧组件共存过渡期 |
| 嵌入模型切换触发全量重索引 | 中 | 后台异步执行，不阻塞 UI，可取消 |
| Docling 模型下载耗时/网络依赖 | 低 | 预下载到 data/models/，支持离线使用 |
| web_search API 依赖外部服务 | 低 | 降级为"搜索不可用"提示 |

---

## 5. 后续演进方向

| 方向 | 优先级 | 说明 |
|------|--------|------|
| 用户认证与权限 | 高 | 启用 users 表，登录、角色、知识库权限 |
| 知识图谱启用 | 中 | 设计实体关系抽取场景，启用 graph 功能 |
| 性能优化 | 中 | 消息分页、搜索缓存、文档列表分页 |
| 移动端适配 | 中 | 完整响应式布局 |
| 多语言 i18n | 低 | 国际化框架 |
| 插件市场 | 低 | 在线插件和 Skill 的安装/管理 |
| 实时协作 ASR | 低 | 流式音频转写，边录边转 |
| 多租户 | 低 | 基于 OpenViking 参考的多租户隔离 |

---

## 6. API 端点汇总

### 6.1 核心 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/health` | GET | 健康检查 |
| `GET /api/sessions` | GET | 会话列表 |
| `POST /api/sessions` | POST | 创建会话 |
| `DELETE /api/sessions/:id` | DELETE | 删除会话 |
| `POST /api/chat/send` | POST | 发送聊天消息 |
| `POST /api/agents/run-stream` | POST | Agent 流式运行（SSE） |

### 6.2 知识库 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/knowledge/kbs` | GET | 知识库列表 |
| `POST /api/knowledge/kbs` | POST | 创建知识库 |
| `POST /api/knowledge/kbs/:id/upload` | POST | 上传文档 |
| `GET /api/knowledge/kbs/:kbId/documents/:docId/original` | GET | 获取原文件（支持 Range） |
| `GET /api/knowledge/kbs/:kbId/documents/:docId/thumbnail` | GET | 获取缩略图 |
| `GET /api/knowledge/kbs/:kbId/documents/:docId/frames/:index` | GET | 获取视频帧 |
| `POST /api/knowledge/kbs/:kbId/reindex-embeddings` | POST | 重新生成嵌入 |
| `GET /api/knowledge/:id/wiki/:path` | GET | 浏览 Wiki 内容 |

### 6.3 报告 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `POST /api/reports/generate` | POST | 生成报告 |
| `GET /api/reports` | GET | 报告列表 |

### 6.4 设置 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/settings/providers` | GET | 获取 Provider 配置 |
| `PUT /api/settings/providers` | PUT | 更新 Provider 配置 |
| `GET /api/settings/docling-config` | GET | 获取 Docling 配置 |
| `PUT /api/settings/docling-config` | PUT | 更新 Docling 配置 |
| `GET /api/settings/docling-models` | GET | 扫描可用模型 |

### 6.5 插件 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/plugins/plugins` | GET | 插件列表 |
| `GET /api/plugins/skills` | GET | 技能列表 |

### 6.6 Agent Teams API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/agent-teams` | GET | 团队列表 |
| `POST /api/agent-teams` | POST | 创建团队 |
| `PUT /api/agent-teams/:id` | PUT | 更新团队 |
| `DELETE /api/agent-teams/:id` | DELETE | 删除团队 |
| `POST /api/agent-teams/:id/execute` | POST | 执行团队工作流 |

---

## 7. 项目代码结构（目标状态）

```
DeepAnalyze/
├── src/
│   ├── main.ts                          # 服务器入口
│   ├── server/
│   │   ├── app.ts                       # Hono 应用配置
│   │   └── routes/
│   │       ├── agents.ts                # Agent 执行 + SSE
│   │       ├── agent-teams.ts           # Agent Teams CRUD
│   │       ├── chat.ts                  # 聊天消息
│   │       ├── knowledge.ts             # 知识库 + 文档管理
│   │       ├── reports.ts               # 报告生成
│   │       ├── sessions.ts              # 会话 CRUD
│   │       ├── settings.ts              # Provider 配置
│   │       └── plugins.ts               # 插件管理
│   ├── models/
│   │   ├── provider-registry.ts         # 22 Provider 元数据
│   │   ├── provider.ts                  # 核心接口 + Schema
│   │   ├── openai-compatible.ts         # OpenAI 兼容客户端
│   │   ├── router.ts                    # 模型路由 + 熔断
│   │   ├── capability-dispatcher.ts     # 增强模型调度
│   │   └── embedding.ts                 # 嵌入模型管理
│   ├── services/
│   │   ├── agent/
│   │   │   ├── agent-runner.ts          # TAOR 循环
│   │   │   ├── agent-system.ts          # Agent 编排
│   │   │   ├── orchestrator.ts          # 多 Agent 协调
│   │   │   ├── workflow-engine.ts       # 4 种调度模式
│   │   │   ├── tool-setup.ts            # 工具注册
│   │   │   ├── compaction.ts            # 上下文压缩
│   │   │   ├── session-memory.ts        # 会话记忆
│   │   │   ├── context-manager.ts       # 上下文窗口管理
│   │   │   ├── micro-compact.ts         # 增量压缩
│   │   │   └── auto-dream.ts            # 后台处理
│   │   ├── document-processors/
│   │   │   ├── processor-factory.ts     # MIME 类型路由
│   │   │   ├── docling-processor.ts     # 文档处理
│   │   │   ├── image-processor.ts       # 图片处理
│   │   │   ├── audio-processor.ts       # 音频处理
│   │   │   ├── video-processor.ts       # 视频处理
│   │   │   └── modality-types.ts        # 数据类型定义
│   │   ├── processing-queue.ts          # 并发处理队列
│   │   └── cron/service.ts              # 定时任务调度
│   ├── wiki/
│   │   ├── compiler.ts                  # Raw→Structure→Abstract 编译
│   │   ├── expander.ts                  # 按需 Raw 层访问
│   │   ├── retriever.ts                 # 融合检索
│   │   ├── indexer.ts                   # 嵌入索引管理
│   │   ├── linker.ts                    # 交叉引用（已冻结）
│   │   └── modality-compilers/          # 多模态编译器
│   ├── store/
│   │   ├── pg.ts                        # PG 连接池 + 迁移框架
│   │   ├── pg-migrations/               # PG schema 迁移
│   │   └── repos/
│   │       ├── interfaces.ts            # 17 个 Repository 接口
│   │       ├── index.ts                 # getRepos() 工厂
│   │       └── *.ts                     # 各接口 PG 实现
│   └── utils/
│       ├── hooks/                       # React hooks
│       └── session*.ts                  # 会话工具函数
├── frontend/
│   ├── src/
│   │   ├── App.tsx                      # 根组件
│   │   ├── api/client.ts               # API 客户端
│   │   ├── components/
│   │   │   ├── chat/                    # 聊天界面
│   │   │   ├── knowledge/              # 知识库统一页面
│   │   │   │   ├── KnowledgePanel.tsx   # 主面板（无 Tab）
│   │   │   │   ├── DocumentCard.tsx     # 统一文档卡片
│   │   │   │   ├── ImagePreview.tsx     # 图片预览
│   │   │   │   ├── AudioPlayer.tsx      # 音频播放器
│   │   │   │   ├── VideoPlayer.tsx      # 视频播放器
│   │   │   │   └── KnowledgeSearchBar.tsx # 统一搜索栏
│   │   │   ├── reports/                 # 报告面板
│   │   │   ├── settings/               # 设置面板（多 Tab）
│   │   │   │   ├── SettingsPanel.tsx
│   │   │   │   ├── MainModelConfig.tsx
│   │   │   │   ├── SubModelConfig.tsx
│   │   │   │   ├── DoclingConfig.tsx    # 文档处理配置
│   │   │   │   └── ModelsPanel.tsx
│   │   │   ├── teams/                  # Teams 管理
│   │   │   ├── tasks/                  # 任务监控
│   │   │   ├── plugins/               # 插件浏览
│   │   │   └── layout/                # Header, Sidebar, AppShell
│   │   ├── store/                      # Zustand 状态
│   │   ├── hooks/                      # React hooks
│   │   ├── types/                      # TypeScript 类型
│   │   └── styles/                     # 设计 Token
│   └── package.json
├── docling-service/                    # Docling Python 子进程
│   ├── main.py
│   └── parser.py
├── config/
│   ├── default.yaml                    # YAML fallback 配置
│   └── SYSTEM.md                       # 系统 Prompt
├── scripts/
│   ├── dev.sh / dev.bat                # 开发启动脚本
│   ├── migrate-sqlite-to-pg.ts         # 数据迁移脚本
│   └── configure-minimax.ts            # MiniMax 配置脚本
├── start.py                            # Python 启动器
├── Dockerfile
├── docker-compose.yml
└── tsconfig.json
```

---

## 8. 文档版本记录

| 版本 | 日期 | 变更摘要 |
|------|------|---------|
| V1.0 | 2026-04-08 | 初始设计文档（L0/L1/L2, SQLite, Claude Code harness） |
| V1.1 | 2026-04-10 | 前端重构设计（6页面18组件双主题） |
| V1.2 | 2026-04-12 | AIE 功能迁移（模型角色、渠道、定时任务） |
| V1.3 | 2026-04-13 | Phase A/B/C 三阶段修复 |
| V2.0 | 2026-04-14 | 系统重设计（三层系统 + 多Agent并行） |
| V3.0 | 2026-04-15 | **重大架构变更** — Raw/Structure/Abstract + 锚点 + PG |
| V3.1 | 2026-04-17 | Docling 模型可插拔 + PG 迁移完整方案 |
| V4.0 | 2026-04-18 | **最新系统重构** — 5 个子项目（Provider/管线/UI/Agent/健壮性） |
| 综合 | 2026-04-20 | **本文档** — 综合 11 份设计文档的最新状态 |
