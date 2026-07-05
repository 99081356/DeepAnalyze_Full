# PG Migration - Phase 1: Infrastructure & Interfaces

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish all 17 repository interfaces and PG schema additions as the foundation for the full migration.

**Architecture:** Expand `repos/interfaces.ts` with all domain types and repo interfaces. Add PG migrations for missing tables (reports, agent_teams, embedding stale). Update the repo factory to be PG-only with a cached singleton.

**Tech Stack:** TypeScript, PostgreSQL, pgvector, zhparser, `pg` driver

---

### Task 1: Expand interfaces.ts with new domain types

**Files:**
- Modify: `src/store/repos/interfaces.ts`

- [ ] **Step 1: Add new domain types after existing types (after `FTSSearchResult` around line 120)**

Add these types to `interfaces.ts`:

```typescript
/** Session record. */
export interface Session {
  id: string;
  title: string | null;
  kbScope: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Chat message. */
export interface Message {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata: string | null;
  createdAt: string;
}

/** Knowledge base. */
export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

/** Wiki link between pages. */
export interface WikiLink {
  id: string;
  sourcePageId: string;
  targetPageId: string;
  linkType: string;
  entityName: string | null;
  context: string | null;
  createdAt: string;
}

/** Wiki page lightweight result for link queries. */
export interface WikiPageSummary {
  id: string;
  kbId: string;
  docId: string | null;
  pageType: string;
  title: string;
  filePath: string;
}

/** Settings key-value entry. */
export interface SettingEntry {
  key: string;
  value: string;
  updatedAt: string;
}

/** Report record. */
export interface Report {
  id: string;
  sessionId: string;
  messageId: string;
  title: string;
  cleanContent: string;
  rawContent: string;
  entities: string[];
  createdAt: string;
}

/** Report reference to a source. */
export interface ReportReference {
  id: number;
  reportId: string;
  refIndex: number;
  docId: string;
  pageId: string;
  title: string;
  level: 'L0' | 'L1' | 'L2';
  snippet: string;
  highlight: string;
}

/** Report with its references. */
export interface ReportWithReferences extends Report {
  references: ReportReference[];
}

/** Data to create a report. */
export interface CreateReportData {
  sessionId: string;
  messageId: string;
  title: string;
  cleanContent: string;
  rawContent: string;
  entities?: string[];
  references?: Omit<ReportReference, 'id' | 'reportId'>[];
}

/** Agent team mode. */
export type TeamMode = 'pipeline' | 'graph' | 'council' | 'parallel';

/** Agent team record. */
export interface AgentTeam {
  id: string;
  name: string;
  description: string;
  mode: TeamMode;
  isActive: boolean;
  crossReview: boolean;
  enableSkills: boolean;
  modelConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Agent team member. */
export interface AgentTeamMember {
  id: string;
  teamId: string;
  role: string;
  systemPrompt?: string;
  task: string;
  perspective?: string;
  dependsOn: string[];
  condition?: Record<string, unknown>;
  tools: string[];
  sortOrder: number;
}

/** Agent team with members. */
export interface AgentTeamWithMembers extends AgentTeam {
  members: AgentTeamMember[];
}

/** Data to create a team. */
export interface CreateTeamData {
  name: string;
  description: string;
  mode: TeamMode;
  isActive?: boolean;
  crossReview?: boolean;
  enableSkills?: boolean;
  modelConfig?: Record<string, unknown>;
  members: Omit<AgentTeamMember, 'id' | 'teamId'>[];
}

/** Data to update a team. */
export interface UpdateTeamData {
  name?: string;
  description?: string;
  mode?: TeamMode;
  isActive?: boolean;
  crossReview?: boolean;
  enableSkills?: boolean;
  modelConfig?: Record<string, unknown>;
  members?: Omit<AgentTeamMember, 'id' | 'teamId'>[];
}

/** Cron job record. */
export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  message: string;
  enabled: boolean;
  channel?: string;
  chatId?: string;
  deliverResponse?: boolean;
  lastRun?: string;
  nextRun?: string;
  lastStatus?: string;
  lastError?: string;
  runCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Data to create a cron job. */
export interface NewCronJob {
  name: string;
  schedule: string;
  message: string;
  enabled?: boolean;
  channel?: string;
  chatId?: string;
  deliverResponse?: boolean;
  nextRun?: string;
}

/** Plugin record. */
export interface Plugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  createdAt: string;
}

/** Data to upsert a plugin. */
export interface NewPlugin {
  id: string;
  name: string;
  version?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Skill record. */
export interface Skill {
  id: string;
  name: string;
  pluginId: string;
  description?: string;
  config: Record<string, unknown> | null;
  createdAt: string;
}

/** Data to create a skill. */
export interface NewSkill {
  id: string;
  name: string;
  pluginId: string;
  description?: string;
  config?: Record<string, unknown>;
}

/** Session memory record. */
export interface SessionMemory {
  id: string;
  sessionId: string;
  content: string;
  tokenCount: number;
  lastTokenPosition: number;
  createdAt: string;
  updatedAt: string;
}

/** Agent task record. */
export interface AgentTask {
  id: string;
  parentTaskId: string | null;
  sessionId: string | null;
  agentType: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Data to create an agent task. */
export interface NewAgentTask {
  parentTaskId?: string;
  sessionId?: string;
  agentType: string;
  input?: unknown;
}
```

- [ ] **Step 2: Add new repository interfaces (before `RepoSet` around line 220)**

```typescript
/** Session repository. */
export interface SessionRepo {
  create(title?: string, kbScope?: Record<string, unknown>): Promise<Session>;
  list(): Promise<Session[]>;
  get(id: string): Promise<Session | undefined>;
  delete(id: string): Promise<boolean>;
  updateTimestamp(id: string): Promise<void>;
}

/** Message repository. */
export interface MessageRepo {
  create(sessionId: string, role: string, content: string | null, metadata?: Record<string, unknown>): Promise<Message>;
  list(sessionId: string): Promise<Message[]>;
}

/** Knowledge base repository. */
export interface KnowledgeBaseRepo {
  create(name: string, ownerId: string, description?: string, visibility?: string): Promise<KnowledgeBase>;
  get(id: string): Promise<KnowledgeBase | undefined>;
  list(): Promise<KnowledgeBase[]>;
  update(id: string, fields: { name?: string; description?: string; visibility?: string }): Promise<KnowledgeBase | undefined>;
  delete(id: string): Promise<boolean>;
  getAnyId(): Promise<string | undefined>;
}

/** Wiki link repository. */
export interface WikiLinkRepo {
  create(sourcePageId: string, targetPageId: string, linkType: string, entityName?: string, context?: string): Promise<WikiLink>;
  getOutgoing(pageId: string): Promise<WikiLink[]>;
  getIncoming(pageId: string): Promise<WikiLink[]>;
  deleteByPageId(pageId: string): Promise<void>;
  findExisting(sourcePageId: string, targetPageId: string, linkType: string, entityName?: string): Promise<WikiLink | undefined>;
  findEntityLinksByKb(kbId: string): Promise<Array<{ sourcePageId: string; entityName: string }>>;
  findRelatedByEntity(kbId: string, entityName: string): Promise<WikiPageSummary[]>;
}

/** Settings repository. */
export interface SettingsRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  getProviderSettings(): Promise<any>;
  saveProviderSettings(settings: any): Promise<void>;
}

/** Report repository. */
export interface ReportRepo {
  create(data: CreateReportData): Promise<ReportWithReferences>;
  get(id: string): Promise<ReportWithReferences | undefined>;
  getByMessageId(messageId: string): Promise<ReportWithReferences | undefined>;
  list(limit?: number, offset?: number): Promise<Report[]>;
  listBySession(sessionId: string): Promise<Report[]>;
  delete(id: string): Promise<boolean>;
}

/** Agent team repository. */
export interface AgentTeamRepo {
  create(data: CreateTeamData): Promise<AgentTeamWithMembers>;
  get(id: string): Promise<AgentTeamWithMembers | undefined>;
  getByName(name: string): Promise<AgentTeamWithMembers | undefined>;
  list(): Promise<AgentTeam[]>;
  update(id: string, data: UpdateTeamData): Promise<AgentTeamWithMembers | undefined>;
  delete(id: string): Promise<boolean>;
}

/** Cron job repository. */
export interface CronJobRepo {
  create(job: NewCronJob): Promise<CronJob>;
  get(id: string): Promise<CronJob | undefined>;
  list(): Promise<CronJob[]>;
  update(id: string, fields: Partial<CronJob>): Promise<void>;
  delete(id: string): Promise<boolean>;
  getDueJobs(now: Date): Promise<CronJob[]>;
  markCompleted(id: string, nextRun: Date): Promise<void>;
  markFailed(id: string, error: string, nextRun: Date): Promise<void>;
}

/** Plugin repository. */
export interface PluginRepo {
  upsert(plugin: NewPlugin): Promise<void>;
  get(id: string): Promise<Plugin | undefined>;
  list(): Promise<Plugin[]>;
  updateEnabled(id: string, enabled: boolean): Promise<void>;
  updateConfig(id: string, config: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<boolean>;
}

/** Skill repository. */
export interface SkillRepo {
  create(skill: NewSkill): Promise<Skill>;
  get(id: string): Promise<Skill | undefined>;
  list(pluginId?: string): Promise<Skill[]>;
  delete(id: string): Promise<boolean>;
}

/** Session memory repository. */
export interface SessionMemoryRepo {
  load(sessionId: string): Promise<SessionMemory | undefined>;
  save(sessionId: string, content: string, tokenCount: number, lastTokenPosition: number): Promise<void>;
  listRecent(limit: number): Promise<Array<{ sessionId: string; content: string }>>;
}

/** Agent task repository. */
export interface AgentTaskRepo {
  create(data: NewAgentTask): Promise<AgentTask>;
  updateStatus(id: string, status: string, output?: unknown, error?: string): Promise<void>;
  get(id: string): Promise<AgentTask | undefined>;
  listBySession(sessionId: string): Promise<AgentTask[]>;
}
```

- [ ] **Step 3: Expand RepoSet to include all 17 repos**

Replace the existing `RepoSet` interface:

```typescript
export interface RepoSet {
  vectorSearch: VectorSearchRepo;
  ftsSearch: FTSSearchRepo;
  anchor: AnchorRepo;
  wikiPage: WikiPageRepo;
  document: DocumentRepo;
  embedding: EmbeddingRepo;
  session: SessionRepo;
  message: MessageRepo;
  knowledgeBase: KnowledgeBaseRepo;
  wikiLink: WikiLinkRepo;
  settings: SettingsRepo;
  report: ReportRepo;
  agentTeam: AgentTeamRepo;
  cronJob: CronJobRepo;
  plugin: PluginRepo;
  skill: SkillRepo;
  sessionMemory: SessionMemoryRepo;
  agentTask: AgentTaskRepo;
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit --pretty 2>&1 | head -30`

Expected: May have errors in other files (that's fine), but interfaces.ts itself should be clean.

- [ ] **Step 5: Commit**

```bash
git add src/store/repos/interfaces.ts
git commit -m "feat: expand repo interfaces with all 17 domain types and repository interfaces"
```

---

### Task 2: Expand existing repo interfaces with new methods

**Files:**
- Modify: `src/store/repos/interfaces.ts`

- [ ] **Step 1: Add new methods to WikiPageRepo interface**

Add to `WikiPageRepo`:

```typescript
  findByTitle(kbId: string, title: string, pageType: string): Promise<WikiPage | undefined>;
```

- [ ] **Step 2: Add new methods to EmbeddingRepo interface**

Add to `EmbeddingRepo`:

```typescript
  markAllStale(): Promise<void>;
  getStaleCount(): Promise<number>;
```

- [ ] **Step 3: Add new method to DocumentRepo interface**

Add to `DocumentRepo`:

```typescript
  updateStatusWithProcessing(id: string, status: string, step: string, progress: number, error?: string): Promise<void>;
```

- [ ] **Step 4: Commit**

```bash
git add src/store/repos/interfaces.ts
git commit -m "feat: expand WikiPageRepo, EmbeddingRepo, DocumentRepo interfaces"
```

---

### Task 3: Add PG migration 004 (reports and teams)

**Files:**
- Create: `src/store/pg-migrations/004_reports_and_teams.ts`

- [ ] **Step 1: Create migration file**

```typescript
import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 4,
  name: 'reports_and_teams',

  sql: `
-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  clean_content TEXT NOT NULL,
  raw_content   TEXT NOT NULL,
  entities      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_references (
  id         SERIAL PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  ref_index  INTEGER NOT NULL,
  doc_id     TEXT NOT NULL,
  page_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  level      TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2')),
  snippet    TEXT NOT NULL,
  highlight  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_session    ON reports(session_id);
CREATE INDEX IF NOT EXISTS idx_reports_message    ON reports(message_id);
CREATE INDEX IF NOT EXISTS idx_report_refs_report ON report_references(report_id);

-- Agent teams
CREATE TABLE IF NOT EXISTS agent_teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK(mode IN ('pipeline','graph','council','parallel')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  cross_review  BOOLEAN NOT NULL DEFAULT false,
  enable_skills BOOLEAN NOT NULL DEFAULT false,
  model_config  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_team_members (
  id               TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL REFERENCES agent_teams(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  system_prompt    TEXT,
  task             TEXT NOT NULL,
  perspective      TEXT,
  depends_on       JSONB DEFAULT '[]',
  condition_config JSONB,
  tools            JSONB NOT NULL DEFAULT '[]',
  sort_order       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_team_members_team ON agent_team_members(team_id);
`,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/store/pg-migrations/004_reports_and_teams.ts
git commit -m "feat: add PG migration 004 for reports and agent_teams tables"
```

---

### Task 4: Add PG migration 005 (embedding stale)

**Files:**
- Create: `src/store/pg-migrations/005_embedding_stale.ts`

- [ ] **Step 1: Create migration file**

```typescript
import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 5,
  name: 'embedding_stale',

  sql: `
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS stale BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_embeddings_stale ON embeddings(stale) WHERE stale = true;
`,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/store/pg-migrations/005_embedding_stale.ts
git commit -m "feat: add PG migration 005 for embedding stale column"
```

---

### Task 5: Update repo factory (PG-only, remove SQLite)

**Files:**
- Modify: `src/store/repos/index.ts`

- [ ] **Step 1: Rewrite index.ts to PG-only with singleton**

Replace entire file content:

```typescript
// =============================================================================
// DeepAnalyze - Repository Factory (PG-only)
// Creates and caches a singleton RepoSet backed by PostgreSQL.
// =============================================================================

import type { RepoSet } from './interfaces';
import { getPool } from '../pg';

// Import all PG repo implementations
import { PgVectorSearchRepo } from './vector-search';
import { PgFTSSearchRepo } from './fts-search';
import { PgAnchorRepo } from './anchor';
import { PgWikiPageRepo } from './wiki-page';
import { PgDocumentRepo } from './document';
import { PgEmbeddingRepo } from './embedding';
// New repos will be imported here as they are created:
// import { PgSessionRepo } from './session';
// ... etc.

let cachedRepos: RepoSet | null = null;

/**
 * Get the singleton RepoSet. Initializes PG pool and creates all repos on first call.
 * Thread-safe: concurrent callers will share the same promise.
 */
let initPromise: Promise<RepoSet> | null = null;

export async function getRepos(): Promise<RepoSet> {
  if (cachedRepos) return cachedRepos;
  if (!initPromise) {
    initPromise = (async () => {
      const pool = await getPool();
      cachedRepos = {
        vectorSearch: new PgVectorSearchRepo(pool),
        ftsSearch: new PgFTSSearchRepo(pool),
        anchor: new PgAnchorRepo(pool),
        wikiPage: new PgWikiPageRepo(pool),
        document: new PgDocumentRepo(pool),
        embedding: new PgEmbeddingRepo(pool),
        // New repos will be added here as they are implemented:
        // session: new PgSessionRepo(pool),
        // ... etc.
        // For now, these will throw "not implemented" to surface during development:
        session: null as any,
        message: null as any,
        knowledgeBase: null as any,
        wikiLink: null as any,
        settings: null as any,
        report: null as any,
        agentTeam: null as any,
        cronJob: null as any,
        plugin: null as any,
        skill: null as any,
        sessionMemory: null as any,
        agentTask: null as any,
      };
      return cachedRepos;
    })();
  }
  return initPromise;
}

/**
 * Backwards-compatible alias. Now always returns PG repos.
 */
export const createReposAsync = getRepos;

/**
 * Reset cached repos (for testing).
 */
export function resetRepos(): void {
  cachedRepos = null;
  initPromise = null;
}

export type {
  RepoSet,
  // Re-export all types from interfaces
  AnchorDef,
  WikiPage,
  WikiPageCreate,
  Document,
  EmbeddingRow,
  EmbeddingCreate,
  VectorSearchResult,
  FTSSearchResult,
  VectorSearchRepo,
  FTSSearchRepo,
  AnchorRepo,
  WikiPageRepo,
  DocumentRepo,
  EmbeddingRepo,
  SessionRepo,
  MessageRepo,
  KnowledgeBaseRepo,
  WikiLinkRepo,
  SettingsRepo,
  ReportRepo,
  AgentTeamRepo,
  CronJobRepo,
  PluginRepo,
  SkillRepo,
  SessionMemoryRepo,
  AgentTaskRepo,
  // Domain types
  Session,
  Message,
  KnowledgeBase,
  WikiLink,
  WikiPageSummary,
  SettingEntry,
  Report,
  ReportReference,
  ReportWithReferences,
  CreateReportData,
  AgentTeam,
  AgentTeamMember,
  AgentTeamWithMembers,
  CreateTeamData,
  UpdateTeamData,
  TeamMode,
  CronJob,
  NewCronJob,
  Plugin,
  NewPlugin,
  Skill,
  NewSkill,
  SessionMemory,
  AgentTask,
  NewAgentTask,
} from './interfaces';
```

- [ ] **Step 2: Delete sqlite-repos.ts**

Run: `rm src/store/repos/sqlite-repos.ts`

- [ ] **Step 3: Commit**

```bash
git add -A src/store/repos/
git commit -m "feat: convert repo factory to PG-only with singleton getRepos()"
```

---

### Task 6: Rewrite main.ts for PG-only startup

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Replace entire main.ts**

```typescript
// =============================================================================
// DeepAnalyze - Server Entry Point
// =============================================================================

import { createApp } from "./server/app.ts";
import {
  handleOpen,
  handleMessage,
  handleClose,
  type WsServerMessage,
} from "./server/ws.ts";

// ---------------------------------------------------------------------------
// PostgreSQL initialization
// ---------------------------------------------------------------------------
console.log("[PG] Initializing PostgreSQL...");

(async () => {
  try {
    const { getPool, migratePG } = await import("./store/pg.ts");
    const m001 = await import("./store/pg-migrations/001_init.ts");
    const m002 = await import("./store/pg-migrations/002_anchors_structure.ts");
    const m003 = await import("./store/pg-migrations/003_minimax_providers.ts");
    const m004 = await import("./store/pg-migrations/004_reports_and_teams.ts");
    const m005 = await import("./store/pg-migrations/005_embedding_stale.ts");
    await getPool();
    await migratePG([m001.migration, m002.migration, m003.migration, m004.migration, m005.migration]);
    console.log("[PG] PostgreSQL ready with pgvector + zhparser");
  } catch (err) {
    console.error(
      "[PG] Initialization failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
const app = createApp();

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const port = parseInt(process.env.PORT || "21000");

// Graceful shutdown handler
async function shutdown() {
  console.log("\n[Server] Shutting down...");
  try {
    const { closePool } = await import("./store/pg.ts");
    await closePool();
  } catch { /* PG not initialized */ }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Bun runtime (primary)
if (typeof Bun !== "undefined") {
  Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && server.upgrade(req)) {
        return;
      }
      return app.fetch(req, server);
    },
    websocket: {
      open(ws) { handleOpen(ws as unknown as WebSocket); },
      message(ws, message) { handleMessage(ws as unknown as WebSocket, message as string); },
      close(ws) { handleClose(ws as unknown as WebSocket); },
    },
    idleTimeout: 0,
  });
  console.log(`DeepAnalyze server running on http://localhost:${port}`);
  console.log("[WS] WebSocket endpoint available at ws://localhost:${port}/ws");
  console.log("[AgentSystem] Agent routes will initialize on first request to /api/agents/*");
} else {
  // Node.js runtime (fallback)
  import("@hono/node-server").then(({ serve }) => {
    const server = serve({ fetch: app.fetch, port });

    server.setTimeout(0);
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;

    let wssPromise: Promise<InstanceType<typeof import("ws").WebSocketServer>> | null = null;

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/ws") {
        if (!wssPromise) {
          wssPromise = import("ws").then(({ WebSocketServer }) => new WebSocketServer({ noServer: true }));
        }
        wssPromise.then((wss) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            handleOpen(ws);
            ws.on("message", (data) => { handleMessage(ws, data as Buffer); });
            ws.on("close", () => { handleClose(ws); });
          });
        }).catch((err) => {
          console.error("[WS] Failed to initialize WebSocketServer:", err);
          wssPromise = null;
          socket.destroy();
        });
      }
    });

    console.log(`DeepAnalyze server running on http://localhost:${port}`);
    console.log("[WS] WebSocket endpoint available at ws://localhost:${port}/ws");
    console.log("[AgentSystem] Agent routes will initialize on first request to /api/agents/*");
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main.ts
git commit -m "feat: rewrite main.ts for PG-only startup, remove SQLite initialization"
```

---

### Task 7: Update app.ts to remove SQLite migrations

**Files:**
- Modify: `src/server/app.ts`

- [ ] **Step 1: Remove SQLite imports and migration calls**

In `src/server/app.ts`:
- Remove line: `import { migrateReports } from "../store/reports.js";`
- Remove line: `import { migrateAgentTeams } from "../store/agent-teams.js";`
- Remove line: `import { DB } from "../store/database.js";`
- Remove lines 32-35: `migrateReports(DB.getInstance().raw);` and `migrateAgentTeams(DB.getInstance().raw);`

These are no longer needed because:
1. `reports` and `report_references` tables are now created by PG migration 004
2. `agent_teams` and `agent_team_members` tables are now created by PG migration 004
3. Migrations run in `main.ts` before `createApp()` is called

- [ ] **Step 2: Commit**

```bash
git add src/server/app.ts
git commit -m "feat: remove SQLite migration calls from app.ts"
```

---

## Phase 1 Summary

After completing Phase 1:
- All 17 repository interfaces are defined in `interfaces.ts`
- PG schema has all needed tables (migrations 001-005)
- Repo factory is PG-only with `getRepos()` singleton
- `main.ts` starts PG only, no SQLite
- `app.ts` no longer calls SQLite migrations

**Next:** Phase 2 implements the 11 new PG repo implementations and expands the 3 existing ones.
