# DeepAnalyze 深度分析系统 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一套基于Claude Code harness的通用Agent驱动深度文档分析与报告生成平台

**Architecture:** 以Claude Code的TS/Bun Agent harness为核心引擎，改造其API接入层为多模型统一路由，去除CLI和权限审核机制替换为HTTP/WebSocket服务，新增Wiki知识引擎实现L0/L1/L2分层编译与融合检索，全新React前端提供图形化操作界面，Docling作为Python子进程提供文档解析能力。

**Tech Stack:** TypeScript/Bun (Agent引擎), React 19 + TypeScript + Tailwind CSS + Zustand (前端), SQLite + sqlite-vec + FTS5 (存储), Python/Docling (文档解析), ONNX Runtime/BGE-M3 (向量嵌入)

**Design Spec:** `docs/superpowers/specs/2026-04-08-deepanalyze-design.md`

---

## Phase 0: 项目骨架搭建

### Task 0.1: 初始化项目结构

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/main.ts`

- [ ] **Step 1: 初始化package.json**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
cat > package.json << 'PKGJSON'
{
  "name": "deepanalyze",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/main.ts",
    "build": "bun build src/main.ts --outdir dist --target bun",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "hono": "^4.7.0",
    "zod": "^3.24.0",
    "yaml": "^2.7.0",
    "ws": "^8.18.0",
    "pino": "^9.6.0",
    "onnxruntime-node": "^1.21.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/ws": "^8.5.0",
    "typescript": "^5.7.0",
    "@types/bun": "^1.2.0",
    "tailwindcss": "^4.1.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.5.0",
    "vite": "^6.3.0",
    "@vitejs/plugin-react": "^4.4.0"
  }
}
PKGJSON
```

- [ ] **Step 2: 创建tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "frontend"]
}
```

- [ ] **Step 3: 创建.gitignore**

```
node_modules/
dist/
data/
*.db
*.onnx
.cache/
.env
frontend/node_modules/
frontend/dist/
```

- [ ] **Step 4: 创建最小入口文件**

```typescript
// src/main.ts
import { serve } from "hono/node-serve";
import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

const port = parseInt(process.env.PORT || "21000");
console.log(`DeepAnalyze starting on port ${port}...`);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});
```

- [ ] **Step 5: 安装依赖并验证**

Run: `bun install`
Expected: 依赖安装成功

Run: `bun run src/main.ts &` 然后 `curl http://localhost:21000/api/health`
Expected: `{"status":"ok","version":"0.1.0"}`

- [ ] **Step 6: 初始化git并提交**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git init
git add package.json tsconfig.json .gitignore src/main.ts
git commit -m "feat: initialize project skeleton with minimal HTTP server"
```

---

### Task 0.2: SQLite存储层搭建

**Files:**
- Create: `src/store/database.ts`
- Create: `src/store/migrations/001_init.ts`
- Create: `src/types/index.ts`

- [ ] **Step 1: 定义核心类型**

```typescript
// src/types/index.ts
export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  visibility: "private" | "team" | "public";
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  kbId: string;
  filename: string;
  filePath: string;
  fileHash: string;
  fileSize: number | null;
  fileType: string | null;
  status: "uploaded" | "parsing" | "compiling" | "ready" | "error";
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface WikiPage {
  id: string;
  kbId: string;
  docId: string | null;
  pageType: "abstract" | "overview" | "fulltext" | "entity" | "concept" | "report";
  title: string;
  filePath: string;
  contentHash: string | null;
  tokenCount: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WikiLink {
  id: number;
  sourcePageId: string;
  targetPageId: string;
  linkType: "forward" | "backward" | "entity_ref" | "concept_ref";
  entityName: string | null;
  context: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  title: string | null;
  kbScope: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "user";
  createdAt: string;
}

export interface AgentTask {
  id: string;
  parentTaskId: string | null;
  sessionId: string | null;
  agentType: string;
  status: "pending" | "running" | "completed" | "failed";
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
```

- [ ] **Step 2: 创建数据库初始化与migration**

```typescript
// src/store/database.ts
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { runMigration001 } from "./migrations/001_init.js";

export class DB {
  private db: Database.Database;
  private static instance: DB | null = null;

  private constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  static getInstance(dbPath?: string): DB {
    if (!DB.instance) {
      const path = dbPath || join(process.cwd(), "data", "deepanalyze.db");
      DB.instance = new DB(path);
    }
    return DB.instance;
  }

  get raw(): Database.Database {
    return this.db;
  }

  migrate(): void {
    const TABLE = "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)";
    this.db.exec(TABLE);
    runMigration001(this.db);
  }

  close(): void {
    this.db.close();
  }
}
```

```typescript
// src/store/migrations/001_init.ts
import type Database from "better-sqlite3";

export function runMigration001(db: Database.Database): void {
  const applied = db.prepare("SELECT COUNT(*) as c FROM _migrations WHERE name = ?").get("001_init") as { c: number };
  if (applied.c > 0) return;

  db.exec(`
    CREATE TABLE knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      owner_id TEXT NOT NULL,
      visibility TEXT DEFAULT 'private',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL REFERENCES knowledge_bases(id),
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      file_size INTEGER,
      file_type TEXT,
      status TEXT DEFAULT 'uploaded',
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE wiki_pages (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL REFERENCES knowledge_bases(id),
      doc_id TEXT REFERENCES documents(id),
      page_type TEXT NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT,
      token_count INTEGER,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE wiki_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_page_id TEXT NOT NULL REFERENCES wiki_pages(id),
      target_page_id TEXT NOT NULL REFERENCES wiki_pages(id),
      link_type TEXT NOT NULL,
      entity_name TEXT,
      context TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id TEXT NOT NULL REFERENCES knowledge_bases(id),
      name TEXT NOT NULL,
      category TEXT,
      UNIQUE(kb_id, name)
    );

    CREATE TABLE document_tags (
      doc_id TEXT NOT NULL REFERENCES documents(id),
      tag_id INTEGER NOT NULL REFERENCES tags(id),
      PRIMARY KEY (doc_id, tag_id)
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      kb_scope TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agent_tasks (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT,
      session_id TEXT REFERENCES sessions(id),
      agent_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT,
      enabled INTEGER DEFAULT 1,
      config TEXT
    );

    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      plugin_id TEXT REFERENCES plugins(id),
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config TEXT
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
      page_id,
      kb_id,
      level,
      content,
      tokenize 'unicode61'
    );

    CREATE INDEX idx_documents_kb_id ON documents(kb_id);
    CREATE INDEX idx_documents_status ON documents(status);
    CREATE INDEX idx_wiki_pages_kb_id ON wiki_pages(kb_id);
    CREATE INDEX idx_wiki_pages_doc_id ON wiki_pages(doc_id);
    CREATE INDEX idx_wiki_pages_page_type ON wiki_pages(page_type);
    CREATE INDEX idx_wiki_links_source ON wiki_links(source_page_id);
    CREATE INDEX idx_wiki_links_target ON wiki_links(target_page_id);
    CREATE INDEX idx_messages_session_id ON messages(session_id);
    CREATE INDEX idx_agent_tasks_status ON agent_tasks(status);
    CREATE INDEX idx_agent_tasks_session_id ON agent_tasks(session_id);
  `);

  db.prepare("INSERT INTO _migrations (name) VALUES (?)").run("001_init");
}
```

- [ ] **Step 3: 更新main.ts集成数据库**

在 `src/main.ts` 中添加数据库初始化：

```typescript
// src/main.ts (追加在 serve 之前)
import { DB } from "./store/database.js";

const db = DB.getInstance();
db.migrate();
console.log("Database initialized.");

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});
```

- [ ] **Step 4: 验证**

Run: `bun run src/main.ts`
Expected: 控制台输出 "Database initialized." 和 "Server running at..."

Run: `curl http://localhost:21000/api/health`
Expected: `{"status":"ok","version":"0.1.0"}`

验证data目录下生成了 `deepanalyze.db` 文件。

- [ ] **Step 5: 提交**

```bash
git add src/store/ src/types/
git commit -m "feat: add SQLite storage layer with initial migration"
```

---

### Task 0.3: React前端骨架搭建

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/tailwind.config.ts`

- [ ] **Step 1: 创建前端项目**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
mkdir -p frontend/src
```

```json
// frontend/package.json
{
  "name": "deepanalyze-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.5.0",
    "zustand": "^5.0.0",
    "socket.io-client": "^4.10.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.4.0",
    "typescript": "^5.7.0",
    "vite": "^6.3.0",
    "tailwindcss": "^4.1.0",
    "@tailwindcss/vite": "^4.1.0"
  }
}
```

```json
// frontend/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

```typescript
// frontend/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      "/api": "http://localhost:21000",
      "/ws": { target: "ws://localhost:21000", ws: true },
    },
  },
});
```

```html
<!-- frontend/index.html -->
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DeepAnalyze - 深度分析系统</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```typescript
// frontend/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

```css
/* frontend/src/index.css */
@import "tailwindcss";
```

```typescript
// frontend/src/App.tsx
export function App() {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-900">DeepAnalyze</h1>
        <p className="mt-2 text-gray-500">深度分析系统</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 安装前端依赖**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze/frontend
bun install
```

- [ ] **Step 3: 验证前端启动**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && bun run dev`
Expected: Vite dev server running at http://localhost:3000，页面显示 "DeepAnalyze 深度分析系统"

- [ ] **Step 4: 提交**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add frontend/
git commit -m "feat: scaffold React frontend with Vite and Tailwind"
```

---

### Task 0.4: 从Claude Code复制核心Harness文件

**Files:**
- Copy from: `refcode/claude-code/src/` 下的核心文件

这是关键步骤。需要从Claude Code代码库中复制Agent harness的核心文件到新项目中。

- [ ] **Step 1: 创建目标目录结构**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
mkdir -p src/core src/tools src/services/compact src/services/tools \
  src/services/SessionMemory src/services/autoDream \
  src/services/AgentSummary src/models src/utils \
  src/server/routes src/wiki src/store/migrations \
  src/subprocess src/plugins src/skills
```

- [ ] **Step 2: 复制核心Harness文件**

从Claude Code复制以下文件（需要逐一适配import路径）：

```
# 核心循环
cp refcode/claude-code/src/query.ts -> src/core/query.ts
cp refcode/claude-code/src/Tool.ts -> src/core/Tool.ts
cp refcode/claude-code/src/types/ -> src/core/types/ (消息类型等)

# 工具系统
cp refcode/claude-code/src/tools/ -> src/tools/ (全部工具目录)
cp refcode/claude-code/src/tools.ts -> src/tools/index.ts (工具注册)
cp refcode/claude-code/src/services/tools/ -> src/services/tools/ (工具编排)

# 上下文管理
cp refcode/claude-code/src/services/compact/ -> src/services/compact/
cp refcode/claude-code/src/services/SessionMemory/ -> src/services/SessionMemory/
cp refcode/claude-code/src/services/autoDream/ -> src/services/autoDream/
cp refcode/claude-code/src/services/AgentSummary/ -> src/services/AgentSummary/

# 并行调度
cp refcode/claude-code/src/utils/swarm/ -> src/utils/swarm/

# 工具函数
cp refcode/claude-code/src/utils/ -> src/utils/ (按需选取)

# 状态管理
cp refcode/claude-code/src/state/ -> src/state/
```

**注意**：此步骤需要手动或脚本批量复制，然后逐文件修复import路径。由于Claude Code使用 `.js` 后缀的ES模块导入，且路径结构不同，需要：
1. 批量复制文件
2. 全局替换import路径前缀（从原始路径到新路径）
3. 解决缺失的依赖

- [ ] **Step 3: 创建适配层桥接缺失模块**

对于Claude Code中引用但新项目不需要的模块（CLI、Bridge、Ink等），创建stub或adapter：

```typescript
// src/core/stubs.ts - 为不需要的模块提供stub
export const cli = { isEnabled: () => false };
export const bridge = { isConnected: () => false };
export const ink = { render: () => {} };
```

- [ ] **Step 4: 编译验证**

Run: `bun run typecheck`
Expected: 编译通过（可能需要多轮修复import和类型错误）

- [ ] **Step 5: 提交**

```bash
git add src/
git commit -m "feat: copy and adapt Claude Code harness core files"
```

---

## Phase 1: 最小Agent对话

### Task 1.1: 多模型统一接入层

**Files:**
- Create: `src/models/provider.ts`
- Create: `src/models/openai-compatible.ts`
- Create: `src/models/router.ts`
- Create: `config/default.yaml`

- [ ] **Step 1: 定义统一模型Provider接口**

```typescript
// src/models/provider.ts
import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  stream?: boolean;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string;
}

export interface StreamChunk {
  type: "text" | "tool_call" | "tool_call_delta" | "done" | "error";
  content?: string;
  toolCall?: Partial<ToolCall>;
  finishReason?: string;
}

export interface ModelProvider {
  name: string;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk>;
  estimateTokens(text: string): number;
}

export const ModelConfigSchema = z.object({
  models: z.record(z.object({
    provider: z.string(),
    endpoint: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    modelPath: z.string().optional(),
    maxTokens: z.number().optional(),
    supportsToolUse: z.boolean().optional().default(true),
    dimension: z.number().optional(),
  })),
  defaults: z.object({
    main: z.string(),
    summarizer: z.string().optional(),
    embedding: z.string().optional(),
    vlm: z.string().optional(),
  }),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
```

- [ ] **Step 2: 实现OpenAI兼容适配器**

```typescript
// src/models/openai-compatible.ts
import type { ModelProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk, ToolCall } from "./provider.js";

export class OpenAICompatibleProvider implements ModelProvider {
  name: string;
  private endpoint: string;
  private apiKey: string;
  private modelName: string;
  private maxTokens: number;

  constructor(opts: { name: string; endpoint: string; apiKey?: string; model: string; maxTokens?: number }) {
    this.name = opts.name;
    this.endpoint = opts.endpoint.replace(/\/$/, "");
    this.apiKey = opts.apiKey || "unused";
    this.modelName = opts.model;
    this.maxTokens = opts.maxTokens || 8192;
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const body = this.buildRequestBody(messages, options);
    const resp = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!resp.ok) throw new Error(`Model API error: ${resp.status} ${await resp.text()}`);
    const data = await resp.json() as any;
    return this.parseResponse(data);
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const body = { ...this.buildRequestBody(messages, options), stream: true };
    const resp = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!resp.ok) throw new Error(`Model API error: ${resp.status}`);

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") { yield { type: "done" }; return; }
        try {
          const parsed = JSON.parse(data);
          yield* this.parseStreamChunk(parsed);
        } catch { /* skip malformed chunks */ }
      }
    }
  }

  estimateTokens(text: string): number {
    // CJK-aware estimation (参考lossless-claw)
    let tokens = 0;
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code >= 0x4e00 && code <= 0x9fff) tokens += 1.5;      // CJK
      else if (code >= 0x1f600 && code <= 0x1f64f) tokens += 2; // Emoji
      else tokens += 0.25;                                        // ASCII
    }
    return Math.ceil(tokens);
  }

  private buildRequestBody(messages: ChatMessage[], options: ChatOptions) {
    const formatted = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    }));
    return {
      model: options.model || this.modelName,
      messages: formatted,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature,
      ...(options.tools?.length ? { tools: options.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
    };
  }

  private parseResponse(data: any): ChatResponse {
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || "",
      toolCalls: choice?.message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : undefined,
      finishReason: choice?.finish_reason,
    };
  }

  private *parseStreamChunk(data: any): Generator<StreamChunk> {
    const delta = data.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) yield { type: "text", content: delta.content };
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        yield { type: "tool_call_delta", toolCall: { id: tc.id, function: { name: tc.function?.name, arguments: tc.function?.arguments } } };
      }
    }
    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason) yield { type: "done", finishReason };
  }
}
```

- [ ] **Step 3: 实现模型路由器**

```typescript
// src/models/router.ts
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk, ModelConfig } from "./provider.js";
import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

export class ModelRouter {
  private providers: Map<string, ModelProvider> = new Map();
  private defaults: { main: string; summarizer?: string; embedding?: string; vlm?: string };
  private config: ModelConfig | null = null;

  async initialize(configPath?: string): Promise<void> {
    const path = configPath || join(process.cwd(), "config", "model-config.yaml");
    if (!existsSync(path)) {
      console.warn(`Model config not found at ${path}, using defaults`);
      this.defaults = { main: "default" };
      return;
    }
    const raw = readFileSync(path, "utf-8");
    this.config = parseYaml(raw) as ModelConfig;
    this.defaults = this.config.defaults;
    for (const [key, cfg] of Object.entries(this.config.models)) {
      if (cfg.provider === "openai-compatible" || cfg.provider === "anthropic") {
        const provider = new OpenAICompatibleProvider({
          name: key,
          endpoint: cfg.endpoint || "http://localhost:11434/v1",
          apiKey: cfg.apiKey,
          model: cfg.model || key,
          maxTokens: cfg.maxTokens,
        });
        this.providers.set(key, provider);
      }
      // local-onnx 等其他provider类型后续扩展
    }
  }

  getProvider(name?: string): ModelProvider {
    const key = name || this.defaults.main;
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Model provider not found: ${key}`);
    return provider;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    return this.getProvider(options?.model).chat(messages, { ...options, model: undefined });
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    yield* this.getProvider(options?.model).chatStream(messages, { ...options, model: undefined });
  }

  estimateTokens(text: string): number {
    const provider = this.providers.get(this.defaults.main);
    return provider ? provider.estimateTokens(text) : Math.ceil(text.length * 0.5);
  }

  getDefaultModel(role: "main" | "summarizer" | "embedding" | "vlm"): string {
    return this.defaults[role] || this.defaults.main;
  }
}
```

- [ ] **Step 4: 创建默认配置文件模板**

```yaml
# config/model-config.yaml
models:
  main:
    provider: openai-compatible
    endpoint: http://localhost:11434/v1
    model: deepseek-r1
    maxTokens: 128000
    supportsToolUse: true

defaults:
  main: main
```

- [ ] **Step 5: 提交**

```bash
git add src/models/ config/
git commit -m "feat: add multi-model router with OpenAI-compatible provider"
```

---

### Task 1.2: HTTP/WebSocket服务层

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/routes/chat.ts`
- Create: `src/server/routes/sessions.ts`
- Create: `src/server/websocket.ts`
- Create: `src/store/sessions.ts`
- Create: `src/store/messages.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 实现会话和消息存储**

```typescript
// src/store/sessions.ts
import { DB } from "./database.js";
import type { Session } from "../types/index.js";
import { randomUUID } from "crypto";

export function createSession(title?: string, kbScope?: Record<string, unknown>): Session {
  const db = DB.getInstance().raw;
  const session: Session = {
    id: randomUUID(),
    title: title || null,
    kbScope: kbScope || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO sessions (id, title, kb_scope) VALUES (?, ?, ?)")
    .run(session.id, session.title, session.kbScope ? JSON.stringify(session.kbScope) : null);
  return session;
}

export function listSessions(): Session[] {
  const db = DB.getInstance().raw;
  return db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as Session[];
}

export function getSession(id: string): Session | undefined {
  const db = DB.getInstance().raw;
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined;
}
```

```typescript
// src/store/messages.ts
import { DB } from "./database.js";
import type { Message } from "../types/index.js";
import { randomUUID } from "crypto";

export function createMessage(sessionId: string, role: Message["role"], content: string | null, metadata?: Record<string, unknown>): Message {
  const db = DB.getInstance().raw;
  const msg: Message = {
    id: randomUUID(),
    sessionId,
    role,
    content,
    metadata: metadata || null,
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO messages (id, session_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)")
    .run(msg.id, sessionId, role, content, metadata ? JSON.stringify(metadata) : null);
  db.prepare("UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sessionId);
  return msg;
}

export function getMessages(sessionId: string): Message[] {
  const db = DB.getInstance().raw;
  return db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as Message[];
}
```

- [ ] **Step 2: 实现HTTP路由**

```typescript
// src/server/routes/sessions.ts
import { Hono } from "hono";
import { createSession, listSessions, getSession } from "../../store/sessions.js";
import { getMessages } from "../../store/messages.js";

export const sessionRoutes = new Hono();

sessionRoutes.get("/", (c) => c.json(listSessions()));

sessionRoutes.post("/", async (c) => {
  const body = await c.req.json<{ title?: string; kbScope?: Record<string, unknown> }>();
  return c.json(createSession(body.title, body.kbScope));
});

sessionRoutes.get("/:id", (c) => {
  const session = getSession(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

sessionRoutes.get("/:id/messages", (c) => {
  return c.json(getMessages(c.req.param("id")));
});
```

```typescript
// src/server/routes/chat.ts
import { Hono } from "hono";
import { createMessage } from "../../store/messages.js";

export const chatRoutes = new Hono();

chatRoutes.post("/send", async (c) => {
  const { sessionId, content } = await c.req.json<{ sessionId: string; content: string }>();
  const userMsg = createMessage(sessionId, "user", content);
  return c.json({ messageId: userMsg.id, status: "received" });
});
```

- [ ] **Step 3: 组装HTTP应用**

```typescript
// src/server/app.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { sessionRoutes } from "./routes/sessions.js";
import { chatRoutes } from "./routes/chat.js";

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", cors());

  // API路由
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/chat", chatRoutes);
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // 静态文件(前端构建产物)
  app.use("/*", serveStatic({ root: "./frontend/dist" }));

  return app;
}
```

- [ ] **Step 4: 更新main.ts**

```typescript
// src/main.ts
import { DB } from "./store/database.js";
import { createApp } from "./server/app.js";
import { ModelRouter } from "./models/router.js";

const db = DB.getInstance();
db.migrate();
console.log("Database initialized.");

const modelRouter = new ModelRouter();
await modelRouter.initialize();
console.log("Model router initialized.");

const app = createApp();

const port = parseInt(process.env.PORT || "21000");
console.log(`DeepAnalyze starting on port ${port}...`);
Bun.serve({
  fetch: app.fetch,
  port,
  websocket: { open: () => {}, message: () => {}, close: () => {} },
});

console.log(`Server running at http://localhost:${port}`);
```

- [ ] **Step 5: 验证**

Run: `bun run src/main.ts`
Run: `curl -X POST http://localhost:21000/api/sessions -H 'Content-Type: application/json' -d '{"title":"test"}'`
Expected: 返回新session对象

Run: `curl http://localhost:21000/api/sessions`
Expected: 返回session列表

- [ ] **Step 6: 提交**

```bash
git add src/server/ src/store/sessions.ts src/store/messages.ts src/main.ts
git commit -m "feat: add HTTP server with session and chat routes"
```

---

### Task 1.3: 前端聊天界面

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/websocket.ts`
- Create: `frontend/src/store/chat.ts`
- Create: `frontend/src/components/Sidebar.tsx`
- Create: `frontend/src/components/ChatWindow.tsx`
- Create: `frontend/src/components/MessageList.tsx`
- Create: `frontend/src/components/MessageInput.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: 实现API客户端**

```typescript
// frontend/src/api/client.ts
const BASE_URL = import.meta.env.PROD ? "" : "http://localhost:21000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export interface SessionInfo {
  id: string;
  title: string | null;
  createdAt: string;
}

export const api = {
  listSessions: () => request<SessionInfo[]>("/api/sessions"),
  createSession: (title?: string) => request<SessionInfo>("/api/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  getSession: (id: string) => request<SessionInfo>(`/api/sessions/${id}`),
  sendMessage: (sessionId: string, content: string) => request<{ messageId: string }>("/api/chat/send", { method: "POST", body: JSON.stringify({ sessionId, content }) }),
  getMessages: (sessionId: string) => request<any[]>(`/api/sessions/${sessionId}/messages`),
};
```

- [ ] **Step 2: 实现Zustand chat store**

```typescript
// frontend/src/store/chat.ts
import { create } from "zustand";
import { api, type SessionInfo } from "../api/client";

interface ChatState {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  messages: Array<{ id: string; role: string; content: string }>;
  isLoading: boolean;
  streamingContent: string;

  loadSessions: () => Promise<void>;
  createSession: (title?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  setStreamingContent: (content: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  isLoading: false,
  streamingContent: "",

  loadSessions: async () => {
    const sessions = await api.listSessions();
    set({ sessions });
  },

  createSession: async (title) => {
    const session = await api.createSession(title);
    set((s) => ({ sessions: [session, ...s.sessions], currentSessionId: session.id, messages: [] }));
  },

  selectSession: async (id) => {
    set({ currentSessionId: id, isLoading: true });
    const messages = await api.getMessages(id);
    set({ messages, isLoading: false });
  },

  sendMessage: async (content) => {
    const { currentSessionId } = get();
    if (!currentSessionId) return;
    set((s) => ({ messages: [...s.messages, { id: Date.now().toString(), role: "user", content }], streamingContent: "" }));
    await api.sendMessage(currentSessionId, content);
    // 后续通过WebSocket接收流式回复
  },

  setStreamingContent: (content) => set({ streamingContent: content }),
}));
```

- [ ] **Step 3: 实现聊天UI组件**

实现Sidebar、ChatWindow、MessageList、MessageInput组件。Sidebar显示会话列表和新建按钮。ChatWindow显示消息列表和输入框。MessageList渲染用户消息和Agent回复。MessageInput提供输入框和发送按钮。具体实现参考AIE前端的专业设计风格，使用Tailwind CSS构建。

- [ ] **Step 4: 更新App.tsx整合路由**

```typescript
// frontend/src/App.tsx
import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatWindow } from "./components/ChatWindow";
import { useChatStore } from "./store/chat";

export function App() {
  const loadSessions = useChatStore((s) => s.loadSessions);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  return (
    <div className="h-screen flex bg-gray-50">
      <Sidebar />
      <ChatWindow />
    </div>
  );
}
```

- [ ] **Step 5: 验证前端与后端联调**

启动后端和前端，创建新会话，发送消息，确认消息被保存到数据库。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/
git commit -m "feat: add chat UI with session management"
```

---

## Phase 2: 工具系统就绪

### Task 2.1: 权限系统改造（自动批准）

**Files:**
- Modify: `src/core/permissions.ts` (或从Claude Code复制的权限文件)

- [ ] **Step 1: 实现自动批准的CanUseToolFn**

在Claude Code的权限系统中，`CanUseToolFn` 是核心入口。需要将其替换为始终返回 `allow` 的函数：

```typescript
// 修改权限检查函数为始终允许
export const autoApproveAll: CanUseToolFn = async (tool, input, context, assistantMessage, toolUseID) => {
  // 记录审计日志
  auditLog("tool_approved", { tool: tool.name, input });
  return { behavior: "allow", updatedInput: input, decisionReason: { type: "mode", mode: "bypassPermissions" } };
};
```

同时在 `query()` 调用时传入此函数替代原始的 `hasPermissionsToUseTool`。

- [ ] **Step 2: 验证工具调用不再需要确认**

- [ ] **Step 3: 提交**

```bash
git commit -m "feat: bypass permission system with auto-approve and audit logging"
```

---

### Task 2.2: Docling Python子进程服务

**Files:**
- Create: `docling-service/main.py`
- Create: `docling-service/requirements.txt`
- Create: `docling-service/parser.py`
- Create: `src/subprocess/manager.ts`
- Create: `src/subprocess/docling-client.ts`
- Create: `src/tools/DoclingParseTool/index.ts`

- [ ] **Step 1: 创建Docling Python服务**

```python
# docling-service/main.py
import sys
import json
import asyncio
from parser import parse_document

async def handle_request(line: str):
    req = json.loads(line)
    try:
        result = await parse_document(req["file_path"], req.get("options", {}))
        print(json.dumps({"id": req.get("id"), "status": "ok", "data": result}), flush=True)
    except Exception as e:
        print(json.dumps({"id": req.get("id"), "status": "error", "error": str(e)}), flush=True)

async def main():
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break
        line = line.decode().strip()
        if line:
            await handle_request(line)

if __name__ == "__main__":
    asyncio.run(main())
```

```python
# docling-service/parser.py
import json

async def parse_document(file_path: str, options: dict) -> dict:
    from docling.document_converter import DocumentConverter
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import PdfFormatOption

    converter = DocumentConverter()
    result = converter.convert(file_path)

    markdown_content = result.document.export_to_markdown()

    tables = []
    for table in result.document.tables:
        tables.append({
            "data": table.export_to_dataframe().to_csv(),
            "page": getattr(table.prov, "page_no", None) if table.prov else None,
        })

    images = []
    for pic in result.document.pictures:
        images.append({
            "caption": pic.caption_text(result.document) if pic.captions else None,
            "page": getattr(pic.prov, "page_no", None) if pic.prov else None,
        })

    metadata = {
        "page_count": len(result.pages) if hasattr(result, "pages") else None,
        "format": str(result.input.format) if hasattr(result, "input") else None,
    }

    return {
        "content": markdown_content,
        "tables": tables,
        "images": images,
        "metadata": metadata,
    }
```

```txt
# docling-service/requirements.txt
docling>=2.15.0
```

- [ ] **Step 2: 实现子进程管理器**

```typescript
// src/subprocess/manager.ts
import { spawn, type Subprocess } from "bun";

export class SubprocessManager {
  private processes: Map<string, Subprocess> = new Map();
  private listeners: Map<string, Map<string, (data: any) => void>> = new Map();

  async start(name: string, command: string[], cwd?: string): Promise<void> {
    const proc = spawn({
      cmd: command,
      cwd: cwd || process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.processes.set(name, proc);
    this.listeners.set(name, new Map());

    // 读stdout行
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    (async () => {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const id = data.id;
            const cbs = this.listeners.get(name);
            if (cbs?.has(id)) {
              cbs.get(id)!(data);
              cbs.delete(id);
            }
          } catch { /* skip */ }
        }
      }
    })();
  }

  async send(name: string, data: any): Promise<any> {
    const proc = this.processes.get(name);
    if (!proc) throw new Error(`Subprocess ${name} not started`);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error("Timeout")); this.listeners.get(name)?.delete(id); }, 120_000);
      this.listeners.get(name)!.set(id, (data) => { clearTimeout(timeout); resolve(data); });
      proc.stdin.write(JSON.stringify({ ...data, id }) + "\n");
    });
  }

  async stop(name: string): Promise<void> {
    const proc = this.processes.get(name);
    if (proc) {
      proc.kill();
      this.processes.delete(name);
      this.listeners.delete(name);
    }
  }

  async stopAll(): Promise<void> {
    for (const name of this.processes.keys()) {
      await this.stop(name);
    }
  }
}
```

- [ ] **Step 3: 实现Docling客户端**

```typescript
// src/subprocess/docling-client.ts
import { SubprocessManager } from "./manager.js";

const DOCLING_PROCESS_NAME = "docling";

export async function startDocling(baseDir: string): Promise<SubprocessManager> {
  const mgr = new SubprocessManager();
  await mgr.start(DOCLING_PROCESS_NAME, ["python", "main.py"], `${baseDir}/docling-service`);
  return mgr;
}

export async function parseWithDocling(mgr: SubprocessManager, filePath: string, options?: { ocr?: boolean; vlm?: boolean }): Promise<{
  content: string;
  tables: Array<{ data: string; page: number | null }>;
  images: Array<{ caption: string | null; page: number | null }>;
  metadata: Record<string, unknown>;
}> {
  const result = await mgr.send(DOCLING_PROCESS_NAME, { file_path: filePath, options: options || {} });
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}
```

- [ ] **Step 4: 实现DoclingParseTool**

```typescript
// src/tools/DoclingParseTool/index.ts
// 实现Claude Code的Tool接口，调用docling-client
// inputSchema: { filePath: string, options?: object }
// call: 调用parseWithDocling，返回解析结果
```

- [ ] **Step 5: 更新main.ts启动Docling子进程**

在main.ts中添加Docling子进程的启动和关闭管理。

- [ ] **Step 6: 验证**

上传PDF文件，调用docling_parse工具，确认返回解析后的Markdown内容。

- [ ] **Step 7: 提交**

```bash
git add docling-service/ src/subprocess/ src/tools/DoclingParseTool/
git commit -m "feat: add Docling subprocess for document parsing"
```

---

## Phase 3: Wiki知识引擎核心

### Task 3.1: Wiki编译器

**Files:**
- Create: `src/wiki/compiler.ts`
- Create: `src/wiki/page-manager.ts`
- Create: `src/wiki/entity-extractor.ts`
- Create: `src/store/wiki-pages.ts`
- Create: `src/store/documents.ts`
- Create: `src/store/migrations/002_wiki.sql`

- [ ] **Step 1: 扩展数据库migration添加向量表**

```typescript
// src/store/migrations/002_wiki_vec.ts
// 添加 sqlite-vec 向量表（如果sqlite-vec可用）
// 添加 wiki_pages, wiki_links 等索引优化
```

- [ ] **Step 2: 实现Wiki页面管理器**

```typescript
// src/wiki/page-manager.ts
// Wiki页面的CRUD操作
// createPage, updatePage, getPage, deletePage
// 文件系统层面的 .md 文件读写
```

- [ ] **Step 3: 实现L0/L1/L2分层编译器**

```typescript
// src/wiki/compiler.ts
import { ModelRouter } from "../models/router.js";

export class WikiCompiler {
  private router: ModelRouter;

  constructor(router: ModelRouter) {
    this.router = router;
  }

  // 编译L2: 保存Docling解析的原始Markdown
  async compileL2(kbId: string, docId: string, parsedContent: string, metadata: Record<string, unknown>): Promise<void> {
    // 保存parsed.md到wiki/{kbId}/documents/{docId}/parsed.md
    // 写入wiki_pages表 (pageType: 'fulltext')
  }

  // 编译L1: 读取L2全文，让Agent生成概览
  async compileL1(kbId: string, docId: string): Promise<void> {
    // 读取L2全文
    // 调用summarizer模型生成概览(~2000 tokens)
    // 提取结构导航、实体列表
    // 保存.overview.md
    // 写入wiki_pages表 (pageType: 'overview')
  }

  // 编译L0: 读取L1概览，压缩为一句话摘要
  async compileL0(kbId: string, docId: string): Promise<void> {
    // 读取L1概览
    // 调用summarizer模型压缩为~100 tokens
    // 保存.abstract.md
    // 写入wiki_pages表 (pageType: 'abstract')
  }

  // 完整编译流程
  async compile(kbId: string, docId: string, parsedContent: string, metadata: Record<string, unknown>): Promise<void> {
    await this.compileL2(kbId, docId, parsedContent, metadata);
    await this.compileL1(kbId, docId);
    await this.compileL0(kbId, docId);
  }
}
```

- [ ] **Step 4: 实现实体提取器**

```typescript
// src/wiki/entity-extractor.ts
// 使用Agent(而非NER模型)从L1概览中提取实体
// 实体类型: 人物、机构、地点、时间、金额等
// 返回实体列表，供linker构建链接
```

- [ ] **Step 5: 验证**

上传一份测试文档，触发编译流程，确认L0/L1/L2三层文件生成。

- [ ] **Step 6: 提交**

```bash
git commit -m "feat: add Wiki compiler with L0/L1/L2 layer generation"
```

---

### Task 3.2: 向量索引与检索引擎

**Files:**
- Create: `src/models/embedding.ts`
- Create: `src/wiki/indexer.ts`
- Create: `src/wiki/retriever.ts`
- Create: `src/wiki/linker.ts`
- Create: `src/wiki/expander.ts`
- Create: `src/tools/KBSearchTool/index.ts`
- Create: `src/tools/WikiBrowseTool/index.ts`
- Create: `src/tools/ExpandTool/index.ts`

- [ ] **Step 1: 实现嵌入模型管理**

```typescript
// src/models/embedding.ts
// 使用ONNX Runtime加载BGE-M3
// 生成向量嵌入
// 也可配置为调用外部API
```

- [ ] **Step 2: 实现向量+全文索引管理**

```typescript
// src/wiki/indexer.ts
// 将L0/L1的嵌入写入sqlite-vec
// 将L2全文写入FTS5
// 更新时先删旧索引再写新索引
```

- [ ] **Step 3: 实现正反向链接管理**

```typescript
// src/wiki/linker.ts
// 从实体提取结果构建正反向链接
// 写入wiki_links表
// 更新L1概览中的链接信息
```

- [ ] **Step 4: 实现融合检索引擎**

```typescript
// src/wiki/retriever.ts
export class Retriever {
  // 三路检索
  async vectorSearch(query: string, kbIds: string[], topK: number): Promise<SearchResult[]> { ... }
  async bm25Search(query: string, kbIds: string[], topK: number): Promise<SearchResult[]> { ... }
  async linkedSearch(startDocId: string, depth: number): Promise<SearchResult[]> { ... }

  // RRF融合排序
  rrfMerge(results: SearchResult[][], k?: number): SearchResult[] { ... }

  // 统一检索入口
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const [vec, bm25, linked] = await Promise.all([
      this.vectorSearch(query, options.kbIds, options.topK),
      this.bm25Search(query, options.kbIds, options.topK),
      options.linkedFrom ? this.linkedSearch(options.linkedFrom, 1) : Promise.resolve([]),
    ]);
    return this.rrfMerge([vec, bm25, linked]);
  }
}
```

- [ ] **Step 5: 实现expand工具**

```typescript
// src/wiki/expander.ts
// 从L0 -> L1 -> L2 -> raw 逐层展开
// 支持定位到特定章节和位置
// 支持token预算控制
```

- [ ] **Step 6: 实现KBSearchTool、WikiBrowseTool、ExpandTool**

按Tool接口定义包装检索、浏览、展开能力为Agent可调用的工具。

- [ ] **Step 7: 端到端验证**

上传5份测试文档 -> 编译 -> kb_search检索 -> expand展开 -> 看到链接

- [ ] **Step 8: 提交**

```bash
git commit -m "feat: add Wiki retrieval engine with vector+BM25+linked fusion search"
```

---

## Phase 4-7 概要

Phase 3完成后，系统已具备核心Agent对话+知识检索能力。后续Phase按以下任务推进：

### Phase 4: 父子Agent与多轮检索
- 确保AgentTool在新项目中正常工作
- 新增ExploreAgent、CompileAgent、VerifyAgent到builtInAgents.ts
- 适配Coordinator/Swarm并行调度到知识检索场景
- 前端子任务进度面板
- 上下文压缩验证

### Phase 5: 报告与分析能力
- 实现report_generate、timeline_build、graph_build工具
- 知识复利回写（分析结果自动生成Wiki页面）
- 前端报告页面、时间线可视化(D3/Recharts)、关系图谱(力导向图)
- 溯源链接跳转

### Phase 6: Plugin/Skill系统
- Plugin加载器(YAML解析、Agent定义注入、Prompt增强)
- Skill加载器(YAML解析、工具注册)
- judicial-evidence示例插件
- xlsx-analyzer示例Skill
- 前端插件和Skill管理页面
- 知识库浏览前端页面

### Phase 7: 打磨与生产化
- VLM集成(图片分析+OCR)
- CJK Token估算修正
- 审计日志完善
- 用户认证(基础版)
- 子进程崩溃自动重启
- 前端UI打磨(参考AIE风格)
- 性能优化(批量编译、检索缓存)
- 部署打包(单目录打包)
