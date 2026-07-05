# DeepAnalyze: Complete SQLite-to-PostgreSQL Migration Design

**Date**: 2026-04-17
**Status**: Approved
**Goal**: Migrate all database operations from SQLite to PostgreSQL+pgvector, establish a complete Repository abstraction layer, and remove SQLite entirely from the runtime path.

---

## 1. Problem Statement

The project currently has a dual-database architecture:

- **SQLite** (default, always initialized): 16 files use `DB.getInstance().raw` directly; 7 store modules (`sessions.ts`, `messages.ts`, `knowledge-bases.ts`, `wiki-pages.ts`, `documents.ts`, `settings.ts`, `reports.ts`, `agent-teams.ts`) are SQLite-only.
- **PostgreSQL** (optional, gated by `PG_HOST`): Repository pattern exists for 6 entities only (vector search, FTS search, anchor, wiki page, document, embedding).

This causes inconsistent behavior, data splitting between backends, and maintenance burden. The goal is to make PostgreSQL the sole database and abstract all access through repository interfaces.

---

## 2. Architecture

### 2.1 Target Architecture

```
Consumer Files (37 files)
    │
    ▼
Repository Interfaces (repos/interfaces.ts)
    │
    ▼
PG Implementations (repos/*.ts)
    │
    ▼
PostgreSQL + pgvector + zhparser
```

- Business code imports from `repos/interfaces.ts` (types) and `repos/index.ts` (factory).
- No file outside `repos/` should import `pg.ts` directly.
- All repository methods are `async`.
- A singleton `getRepos()` function provides the cached `RepoSet`.

### 2.2 Files Removed

After migration, these files are deleted:
- `src/store/database.ts` (SQLite singleton)
- `src/store/migrations/001_init.ts` through `010_*.ts` (SQLite migrations)
- `src/store/sessions.ts`
- `src/store/messages.ts`
- `src/store/knowledge-bases.ts`
- `src/store/wiki-pages.ts`
- `src/store/documents.ts`
- `src/store/settings.ts`
- `src/store/settings-reader.ts`
- `src/store/reports.ts`
- `src/store/agent-teams.ts`
- `src/store/repos/sqlite-repos.ts`
- `data/deepanalyze.db` (SQLite database file)

### 2.3 Files Kept

- `src/store/pg.ts` (connection pool + migration framework)
- `src/store/pg-migrations/001_init.ts` through `003_*.ts` (existing PG schema)
- `src/store/repos/vector-search.ts`, `fts-search.ts`, `anchor.ts` (existing PG repos)
- `scripts/migrate-sqlite-to-pg.ts` (kept for historical data import)

---

## 3. Repository Interfaces

### 3.1 Existing Interfaces (kept, minor expansions)

#### VectorSearchRepo (no changes)
- `upsertEmbedding(row)`, `searchByVector(query, kbIds, options)`, `deleteByPageId(pageId)`, `deleteByDocId(docId)`

#### FTSSearchRepo (no changes)
- `upsertFTSEntry(pageId, title, content)`, `searchByText(query, kbIds, options)`, `deleteByPageId(pageId)`

#### AnchorRepo (no changes)
- `batchInsert(anchors)`, `getByDocId(docId)`, `getById(id)`, `getByStructurePageId(pageId)`, `updateStructurePageId(ids, pageId)`, `deleteByDocId(docId)`

#### WikiPageRepo (expand)
Existing methods kept. Additional methods to cover `store/wiki-pages.ts` operations:
- `create(data: WikiPageCreate)` - already exists
- `getById(id)` - already exists
- `getByDocAndType(docId, pageType)` - already exists
- `getManyByDocAndType(docId, pageType)` - already exists
- `getByKbAndType(kbId, pageType?)` - already exists
- `updateMetadata(id, metadata)` - already exists
- `updateContent(id, content, contentHash, tokenCount)` - already exists
- `deleteById(id)` - already exists
- `deleteByDocId(docId)` - already exists
- **NEW**: `findByTitle(kbId, title, pageType)` - for entity/concept lookup by title
- **NEW**: `getContent(id)` - read file_path + content from DB

Note: `wiki-pages.ts` manages filesystem (writing markdown files) alongside DB operations. The repo handles DB only; filesystem management stays in the wiki subsystem.

#### DocumentRepo (expand)
Existing methods kept. Additional methods:
- **NEW**: `updateProcessing(id, step, progress, error?)` - already exists in interface but `SqliteDocumentRepo` was a no-op. PG implementation must work correctly.
- **NEW**: `updateStatusWithProcessing(id, status, step, progress, error?)` - for processing-queue combined update

#### EmbeddingRepo (expand)
- `getOrNone(pageId, modelName, chunkIndex)` - already exists
- `upsert(row)` - already exists
- `deleteByPageId(pageId)` - already exists
- **NEW**: `markAllStale()` - `UPDATE embeddings SET stale = true`
- **NEW**: `getStaleCount()` - `SELECT COUNT(*) FROM embeddings WHERE stale = true`

### 3.2 New Interfaces

#### SessionRepo
```typescript
interface SessionRepo {
  create(title?: string, kbScope?: Record<string, unknown>): Promise<Session>;
  list(): Promise<Session[]>;
  get(id: string): Promise<Session | undefined>;
  delete(id: string): Promise<boolean>;
  updateTimestamp(id: string): Promise<void>;
}
```

#### MessageRepo
```typescript
interface MessageRepo {
  create(sessionId: string, role: MessageRole, content: string | null, metadata?: Record<string, unknown>): Promise<Message>;
  list(sessionId: string): Promise<Message[]>;
}
```

#### KnowledgeBaseRepo
```typescript
interface KnowledgeBaseRepo {
  create(name: string, ownerId: string, description?: string, visibility?: string): Promise<KnowledgeBase>;
  get(id: string): Promise<KnowledgeBase | undefined>;
  list(): Promise<KnowledgeBase[]>;
  update(id: string, fields: Partial<{name: string; description: string; visibility: string}>): Promise<KnowledgeBase | undefined>;
  delete(id: string): Promise<boolean>;
  getAnyId(): Promise<string | undefined>;
}
```

#### WikiLinkRepo
```typescript
interface WikiLinkRepo {
  create(sourcePageId: string, targetPageId: string, linkType: string, entityName?: string, context?: string): Promise<WikiLink>;
  getOutgoing(pageId: string): Promise<WikiLink[]>;
  getIncoming(pageId: string): Promise<WikiLink[]>;
  deleteByPageId(pageId: string): Promise<void>;
  findExisting(sourcePageId: string, targetPageId: string, linkType: string): Promise<WikiLink | undefined>;
  findEntityLinksByKb(kbId: string): Promise<Array<{sourcePageId: string; entityName: string}>>;
  findRelatedByEntity(kbId: string, entityName: string): Promise<WikiPageResult[]>;
}
```

#### SettingsRepo
```typescript
interface SettingsRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  getProviderSettings(): Promise<ProviderSettings>;
  saveProviderSettings(settings: ProviderSettings): Promise<void>;
}
```

#### ReportRepo
```typescript
interface ReportRepo {
  create(data: CreateReportData): Promise<ReportWithReferences>;
  get(id: string): Promise<ReportWithReferences | undefined>;
  getByMessageId(messageId: string): Promise<ReportWithReferences | undefined>;
  list(limit?: number, offset?: number): Promise<Report[]>;
  listBySession(sessionId: string): Promise<Report[]>;
  delete(id: string): Promise<boolean>;
}
```

#### AgentTeamRepo
```typescript
interface AgentTeamRepo {
  create(data: CreateTeamData): Promise<AgentTeamWithMembers>;
  get(id: string): Promise<AgentTeamWithMembers | undefined>;
  getByName(name: string): Promise<AgentTeamWithMembers | undefined>;
  list(): Promise<AgentTeam[]>;
  update(id: string, data: UpdateTeamData): Promise<AgentTeamWithMembers | undefined>;
  delete(id: string): Promise<boolean>;
}
```

#### CronJobRepo
```typescript
interface CronJobRepo {
  create(job: NewCronJob): Promise<CronJob>;
  get(id: string): Promise<CronJob | undefined>;
  list(): Promise<CronJob[]>;
  update(id: string, fields: Partial<CronJob>): Promise<void>;
  delete(id: string): Promise<boolean>;
  getDueJobs(now: Date): Promise<CronJob[]>;
  markCompleted(id: string, nextRun: Date): Promise<void>;
  markFailed(id: string, error: string, nextRun: Date): Promise<void>;
}
```

#### PluginRepo
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

#### SkillRepo
```typescript
interface SkillRepo {
  create(skill: NewSkill): Promise<Skill>;
  get(id: string): Promise<Skill | undefined>;
  list(pluginId?: string): Promise<Skill[]>;
  delete(id: string): Promise<boolean>;
}
```

#### SessionMemoryRepo
```typescript
interface SessionMemoryRepo {
  load(sessionId: string): Promise<SessionMemory | undefined>;
  save(sessionId: string, content: string, tokenCount: number, lastTokenPosition: number): Promise<void>;
  listRecent(limit: number): Promise<Array<{sessionId: string; content: string}>>;
}
```

#### AgentTaskRepo
```typescript
interface AgentTaskRepo {
  create(data: NewAgentTask): Promise<AgentTask>;
  updateStatus(id: string, status: string, output?: unknown, error?: string): Promise<void>;
  get(id: string): Promise<AgentTask | undefined>;
  listBySession(sessionId: string): Promise<AgentTask[]>;
}
```

### 3.3 RepoSet

```typescript
interface RepoSet {
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

---

## 4. PG Schema Additions

### Migration 004: `004_reports_and_teams.ts`

Creates `reports`, `report_references`, `agent_teams`, and `agent_team_members` tables with PG-native types (TIMESTAMPTZ, JSONB, BOOLEAN, SERIAL for report_references).

### Migration 005: `005_embedding_stale.ts`

Adds `stale BOOLEAN DEFAULT false` column to `embeddings` table and a partial index for stale lookups.

---

## 5. Migration Order

### Phase 1: Infrastructure
1. Expand `repos/interfaces.ts` with all 17 interfaces + domain types
2. Add PG migration 004 and 005
3. Update `repos/index.ts` factory (PG-only, remove SQLite toggle)
4. Rewrite `main.ts` to PG-only startup (remove SQLite init)
5. Add `getRepos()` singleton helper

### Phase 2: Core Repos (low dependency count)
6. `SettingsRepo` PG implementation → update 7 consumers
7. `KnowledgeBaseRepo` PG implementation → update 1 consumer + auto-dream
8. `SessionRepo` + `MessageRepo` PG implementations → update 3 consumers

### Phase 3: Document & Wiki Core
9. Expand `DocumentRepo` PG implementation → update 2 consumers + processing-queue
10. Expand `WikiPageRepo` PG implementation (cover wiki-pages.ts) → update 15 consumers
11. `WikiLinkRepo` PG implementation → update linker, compiler, retriever, reports route

### Phase 4: Domain Services
12. Expand `EmbeddingRepo` PG implementation (stale management) → update indexer, embedding
13. `CronJobRepo` PG implementation → update cron/service.ts
14. `PluginRepo` + `SkillRepo` PG implementations → update plugin-manager.ts
15. `SessionMemoryRepo` PG implementation → update session-memory.ts + auto-dream
16. `AgentTaskRepo` PG implementation → update orchestrator.ts

### Phase 5: Composite Services
17. `ReportRepo` PG implementation → update reports store + route + app.ts migration removal
18. `AgentTeamRepo` PG implementation → update agent-teams store + route + manager + app.ts migration removal
19. Refactor `Retriever` → remove SQLite FTS5/brute-force code paths
20. Refactor `Indexer` → remove SQLite FTS5 operations

### Phase 6: Cleanup
21. Delete all SQLite files listed in Section 2.2
22. Remove `better-sqlite3` and `@types/better-sqlite3` from `package.json`
23. Remove `DB` import from `main.ts`
24. Update tests to use PG repos only
25. Update `migrate-sqlite-to-pg.ts` script (keep functional but mark as legacy)
26. Remove `PG_HOST` toggle logic — PG is always used

---

## 6. File Organization After Migration

```
src/store/
├── pg.ts                          # Connection pool + migration framework
├── pg-migrations/
│   ├── 001_init.ts                # Existing: consolidated schema
│   ├── 002_anchors_structure.ts   # Existing: anchor indexes
│   ├── 003_minimax_providers.ts   # Existing: seed data
│   ├── 004_reports_and_teams.ts   # NEW
│   └── 005_embedding_stale.ts     # NEW
├── repos/
│   ├── interfaces.ts              # All 17 interfaces + domain types
│   ├── index.ts                   # getRepos() factory
│   ├── vector-search.ts           # Existing
│   ├── fts-search.ts              # Existing
│   ├── anchor.ts                  # Existing
│   ├── wiki-page.ts               # Expanded
│   ├── document.ts                # Expanded
│   ├── embedding.ts               # Expanded
│   ├── session.ts                 # NEW
│   ├── message.ts                 # NEW
│   ├── knowledge-base.ts          # NEW
│   ├── wiki-link.ts               # NEW
│   ├── settings.ts                # NEW
│   ├── report.ts                  # NEW
│   ├── agent-team.ts              # NEW
│   ├── cron-job.ts                # NEW
│   ├── plugin.ts                  # NEW
│   ├── skill.ts                   # NEW
│   ├── session-memory.ts          # NEW
│   └── agent-task.ts              # NEW
```

---

## 7. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| All repos async | PG driver is naturally async; unified async interface is consistent |
| RepoSet singleton via `getRepos()` | Avoids passing repos through every function; cached after first init |
| Filesystem ops outside repos | Wiki page file management (read/write markdown) stays in wiki subsystem; repos handle DB only |
| Remove `PG_HOST` toggle | PG is the only backend; no runtime backend selection |
| Keep `migrate-sqlite-to-pg.ts` | Useful for importing historical data from SQLite |
| Wiki subsystem gets `RepoSet` injection | Linker, Indexer, Compiler receive repos as constructor params for clean testing |
| `display-resolver.ts` moves to repos | Currently uses `pg.ts` directly; will use `DocumentRepo` + `KnowledgeBaseRepo` |

---

## 8. Testing Strategy

- Existing `tests/repos/*.test.ts` files are updated to test new repo implementations
- Each new repo gets its own test file in `tests/repos/`
- `tests/pg-infrastructure.test.ts` updated to remove SQLite references
- Integration tests verify the full pipeline works with PG only
