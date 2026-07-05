# PG Migration - Phase 3: Migrate Consumer Files

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all direct SQLite access and old store module imports with the new PG repository layer across all 37 consumer files.

**Architecture:** Each consumer file is updated to import `getRepos()` from `repos/index.ts` and call async repo methods instead of sync SQLite calls. Old store module imports are removed.

---

## Migration Pattern

Every file follows the same pattern:

**Before:**
```typescript
import { DB } from "../store/database.js";
const db = DB.getInstance().raw;
const rows = db.prepare("SELECT * FROM sessions").all();
```

**After:**
```typescript
import { getRepos } from "../store/repos/index.js";
const repos = await getRepos();
const sessions = await repos.session.list();
```

For route handlers in Hono, the handler must become `async` and `await` the repo calls.

---

### Task 16: Migrate route files (sessions, chat, knowledge)

**Files:**
- Modify: `src/server/routes/sessions.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/routes/knowledge.ts`

- [ ] **Step 1: Migrate sessions.ts**

In `src/server/routes/sessions.ts`:
- Replace `import * as sessionStore from "../../store/sessions.js"` with `import { getRepos } from "../../store/repos/index.js"`
- Replace `import * as messageStore from "../../store/messages.js"` with nothing (messages are in repos too)
- In each route handler:
  - `sessionStore.createSession(...)` → `(await getRepos()).session.create(...)`
  - `sessionStore.listSessions()` → `(await getRepos()).session.list()`
  - `sessionStore.getSession(id)` → `(await getRepos()).session.get(id)`
  - `sessionStore.deleteSession(id)` → `(await getRepos()).session.delete(id)`
  - `messageStore.getMessages(sessionId)` → `(await getRepos()).message.list(sessionId)`
- Note: Session objects now use camelCase from repos, not the old camelCase mapping. Verify field names match what the API returns.

- [ ] **Step 2: Migrate chat.ts**

In `src/server/routes/chat.ts`:
- Replace session/message store imports with `getRepos`
- `sessionStore.createSession(...)` → `(await getRepos()).session.create(...)`
- `messageStore.createMessage(...)` → `(await getRepos()).message.create(...)`
- `messageStore.getMessages(...)` → `(await getRepos()).message.list(...)`
- `sessionStore.getSession(...)` → `(await getRepos()).session.get(...)`

- [ ] **Step 3: Migrate knowledge.ts**

In `src/server/routes/knowledge.ts`:
- Replace `import { createKnowledgeBase, getKnowledgeBase, ... } from "../../store/knowledge-bases.js"` with `import { getRepos } from "../../store/repos/index.js"`
- Replace `import { createDocument, listDocuments, ... } from "../../store/documents.js"` with nothing (docs use repos)
- Replace `import { createWikiPage, getWikiPage, ... } from "../../store/wiki-pages.js"` with nothing (wiki uses repos)
- Knowledge base ops: use `repos.knowledgeBase.create/get/list/update/delete`
- Document ops: use `repos.document.create/getByKbId/updateStatus/updateStatusWithProcessing/deleteById`
  - Note: `createDocument` in old `documents.ts` handles file copying and hashing. This logic must move into the route handler or a helper, with only the DB record creation going through `repos.document.create()`.
- Wiki page ops: use `repos.wikiPage.create/getById/getByDocAndType/getByKbAndType`
  - Note: `createWikiPage` in old `wiki-pages.ts` handles filesystem ops. This logic stays in the route handler or helper.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/sessions.ts src/server/routes/chat.ts src/server/routes/knowledge.ts
git commit -m "feat: migrate sessions, chat, knowledge routes to PG repos"
```

---

### Task 17: Migrate settings and agents routes

**Files:**
- Modify: `src/server/routes/settings.ts`
- Modify: `src/server/routes/agents.ts`

- [ ] **Step 1: Migrate settings.ts**

In `src/server/routes/settings.ts`:
- Replace `import { SettingsStore, ... } from "../../store/settings.js"` with `import { getRepos } from "../../store/repos/index.js"`
- The `SettingsStore` class methods now become direct repo calls:
  - `new SettingsStore()` → `const repos = await getRepos(); const settings = repos.settings;`
  - `store.getProviderSettings()` → `settings.getProviderSettings()`
  - `store.saveProviderSettings(s)` → `settings.saveProviderSettings(s)`
  - `store.get(key)` → `settings.get(key)`
  - `store.set(key, value)` → `settings.set(key, value)`
  - `store.getAgentSettings()` → parse from `settings.get("agent_settings")`
  - `store.saveAgentSettings(s)` → `settings.set("agent_settings", JSON.stringify(s))`
  - `store.getDoclingConfig()` → parse from `settings.get("docling_config")`
  - `store.saveDoclingConfig(c)` → `settings.set("docling_config", JSON.stringify(c))`
  - `store.getEnhancedModels()` → parse from `settings.get("enhanced_models")`
  - `store.saveEnhancedModels(m)` → `settings.set("enhanced_models", JSON.stringify(m))`
- Keep the type imports for `ProviderConfig`, `ProviderDefaults`, `DoclingConfig` — move them inline or to a shared types file if needed. Actually, these types are only used in settings.ts route and a few other places. Import them from the store types or define locally.

- [ ] **Step 2: Migrate agents.ts**

In `src/server/routes/agents.ts`:
- Replace session/message store imports with `getRepos`
- Same pattern as sessions/chat routes

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/settings.ts src/server/routes/agents.ts
git commit -m "feat: migrate settings and agents routes to PG repos"
```

---

### Task 18: Migrate reports and agent-teams routes

**Files:**
- Modify: `src/server/routes/reports.ts`
- Modify: `src/server/routes/agent-teams.ts`

- [ ] **Step 1: Migrate reports.ts**

In `src/server/routes/reports.ts`:
- Remove `import { DB } from "../../store/database.js"`
- Remove `import { listReports, getReport, ... } from "../../store/reports.js"`
- Remove `import { getWikiPage, getWikiPagesByKb, getPageContent } from "../../store/wiki-pages.js"`
- Remove `import { createReposAsync } from "../../store/repos/index.js"` (use `getRepos` instead)
- Replace all direct `DB.getInstance().raw` queries with repo calls:
  - KB existence check: `repos.knowledgeBase.get(id)`
  - Wiki page queries: `repos.wikiPage.getByKbAndType(kbId, pageType)`
  - Wiki link graph queries: `repos.wikiLink.getOutgoing/getIncoming`
  - Report CRUD: `repos.report.list/get/listBySession/delete`
- For graph endpoint: use `repos.wikiLink.getOutgoing` + `repos.wikiLink.getIncoming` instead of direct SQL JOINs

- [ ] **Step 2: Migrate agent-teams.ts**

In `src/server/routes/agent-teams.ts`:
- Remove old store imports
- Replace with `getRepos()` calls:
  - `createTeam(data)` → `repos.agentTeam.create(data)`
  - `getTeam(id)` → `repos.agentTeam.get(id)`
  - `listTeams()` → `repos.agentTeam.list()`
  - `updateTeam(id, data)` → `repos.agentTeam.update(id, data)`
  - `deleteTeam(id)` → `repos.agentTeam.delete(id)`

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/reports.ts src/server/routes/agent-teams.ts
git commit -m "feat: migrate reports and agent-teams routes to PG repos"
```

---

### Task 19: Migrate search-test, preview routes

**Files:**
- Modify: `src/server/routes/search-test.ts`
- Modify: `src/server/routes/preview.ts`

- [ ] **Step 1: Migrate search-test.ts**

- Replace `import { createReposAsync }` with `import { getRepos }`
- Replace `await createReposAsync()` with `await getRepos()`

- [ ] **Step 2: Migrate preview.ts**

- Same pattern: replace `createReposAsync` with `getRepos`

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/search-test.ts src/server/routes/preview.ts
git commit -m "feat: migrate search-test and preview routes to getRepos()"
```

---

### Task 20: Migrate wiki subsystem files

**Files:**
- Modify: `src/wiki/retriever.ts`
- Modify: `src/wiki/linker.ts`
- Modify: `src/wiki/indexer.ts`
- Modify: `src/wiki/expander.ts`
- Modify: `src/wiki/compiler.ts`
- Modify: `src/wiki/knowledge-compound.ts`
- Modify: `src/wiki/page-manager.ts`
- Modify: `src/wiki/l0-linker.ts`

This is the largest migration batch. The wiki files heavily use direct SQLite access.

**Key pattern change**: Wiki classes currently import `DB` directly. They should instead receive `RepoSet` via constructor injection or access `getRepos()`.

- [ ] **Step 1: Migrate linker.ts**

The Linker class has the most direct SQL. Key changes:
- Remove `import { DB } from "../store/database.js"`
- Add `import { getRepos } from "../store/repos/index.js"`
- Remove `import { getWikiPage, getPageContent, updateWikiPage } from "../store/wiki-pages.js"`
- Replace all direct SQL:
  - `SELECT id FROM wiki_links WHERE ...` → `repos.wikiLink.findExisting(...)`
  - `INSERT INTO wiki_links ...` → `repos.wikiLink.create(...)`
  - `SELECT * FROM wiki_links WHERE source_page_id=?` → `repos.wikiLink.getOutgoing(...)`
  - `SELECT * FROM wiki_links WHERE target_page_id=?` → `repos.wikiLink.getIncoming(...)`
  - `DELETE FROM wiki_links WHERE ...` → `repos.wikiLink.deleteByPageId(...)`
  - Wiki page queries → `repos.wikiPage.getById(...)`
  - `updateWikiPage(...)` → `repos.wikiPage.updateContent(...)`
  - Entity link queries → `repos.wikiLink.findEntityLinksByKb(...)` and `repos.wikiLink.findRelatedByEntity(...)`
- All methods that were sync become async

- [ ] **Step 2: Migrate retriever.ts**

- Remove `import { DB } from "../store/database.js"`
- Remove `import { getWikiPage, getPageContent } from "../store/wiki-pages.js"`
- Add `import { getRepos } from "../store/repos/index.js"`
- Remove SQLite-specific code paths:
  - `vectorSearch()` (brute-force SQLite) → use `repos.vectorSearch.searchByVector()` always
  - `fts5Search()` (SQLite FTS5) → use `repos.ftsSearch.searchByText()` always
  - `likeSearch()` → keep as fallback but use `repos.wikiPage.getByKbAndType()`
  - `searchEntities()` → use `repos.wikiPage` + `repos.wikiLink`
- The `pgVectorSearch()` and `pgFtsSearch()` methods become the primary paths (no branching)

- [ ] **Step 3: Migrate indexer.ts**

- Remove `import { DB } from "../store/database.js"`
- Add `import { getRepos } from "../store/repos/index.js"`
- Remove SQLite FTS5 operations (`DELETE FROM fts_content`, `INSERT INTO fts_content`) — replaced by `repos.ftsSearch.upsertFTSEntry()` and `repos.ftsSearch.deleteByPageId()`
- Remove `DELETE FROM embeddings WHERE page_id=?` → `repos.vectorSearch.deleteByPageId()` or `repos.embedding.deleteByPageId()`
- Embedding read/write → `repos.embedding.getOrNone()` and `repos.embedding.upsert()`
- Wiki page queries → `repos.wikiPage.getByDocAndType()` etc.

- [ ] **Step 4: Migrate compiler.ts**

- Remove `import { DB } from "../store/database.js"`
- Remove `import { updateDocumentStatus } from "../store/documents.js"`
- Remove `import { getWikiPage, getWikiPageByDoc, getPageContent } from "../store/wiki-pages.js"`
- Add `import { getRepos } from "../store/repos/index.js"`
- Direct SQL for wiki_pages/wiki_links → use repos
  - `SELECT id FROM wiki_pages WHERE kb_id=? AND title=? AND page_type='entity'` → `repos.wikiPage.findByTitle(...)`
  - `SELECT id FROM wiki_links WHERE source_page_id=? AND target_page_id=? AND entity_name=?` → `repos.wikiLink.findExisting(...)`
  - `INSERT INTO wiki_links ...` → `repos.wikiLink.create(...)`
- `updateDocumentStatus(...)` → `repos.document.updateStatus(...)`
- `createWikiPage(...)` → filesystem handling stays + `repos.wikiPage.create(...)`
- Anchor operations already use repos, keep as-is

- [ ] **Step 5: Migrate remaining wiki files**

- `knowledge-compound.ts`: Remove `import { DB }`, remove `import { createWikiPage }`. Use `repos.wikiPage.create()` + `repos.wikiPage.findByTitle()` for entity lookups + `repos.wikiLink` for links.
- `expander.ts`: Remove wiki-pages imports. Use `repos.wikiPage.getById()`, `repos.wikiPage.getByDocAndType()`.
- `page-manager.ts`: Same pattern.
- `l0-linker.ts`: Remove DB import. Use `repos.wikiPage.getByKbAndType()`, `repos.wikiLink`.

- [ ] **Step 6: Commit**

```bash
git add src/wiki/
git commit -m "feat: migrate wiki subsystem to PG repos"
```

---

### Task 21: Migrate service files

**Files:**
- Modify: `src/services/cron/service.ts`
- Modify: `src/services/processing-queue.ts`
- Modify: `src/services/plugins/plugin-manager.ts`
- Modify: `src/services/agent/session-memory.ts`
- Modify: `src/services/agent/orchestrator.ts`
- Modify: `src/services/agent/auto-dream.ts`
- Modify: `src/services/agent/agent-runner.ts`
- Modify: `src/services/agent/tool-setup.ts`
- Modify: `src/services/channels/channel-manager.ts`
- Modify: `src/services/document-processors/docling-processor.ts`
- Modify: `src/models/embedding.ts`
- Modify: `src/services/display-resolver.ts`

- [ ] **Step 1: Migrate cron/service.ts**

- Remove `import { DB } from "../../store/database.js"`
- Add `import { getRepos } from "../../store/repos/index.js"`
- Replace all direct SQL on `cron_jobs` table with `repos.cronJob` methods:
  - `INSERT INTO cron_jobs` → `repos.cronJob.create(...)`
  - `SELECT * FROM cron_jobs WHERE id=?` → `repos.cronJob.get(id)`
  - `SELECT * FROM cron_jobs ORDER BY` → `repos.cronJob.list()`
  - Dynamic UPDATE → `repos.cronJob.update(id, fields)`
  - `DELETE FROM cron_jobs WHERE id=?` → `repos.cronJob.delete(id)`
  - `SELECT * FROM cron_jobs WHERE enabled=1 AND next_run<=?` → `repos.cronJob.getDueJobs(now)`
  - Mark completed/failed → `repos.cronJob.markCompleted/markFailed`

- [ ] **Step 2: Migrate processing-queue.ts**

- Remove `import { DB } from "../store/database.js"`
- Add `import { getRepos } from "../store/repos/index.js"`
- `updateDbStatus()` → `repos.document.updateStatusWithProcessing(id, status, step, progress, error)`

- [ ] **Step 3: Migrate plugins/plugin-manager.ts**

- Remove `import { DB } from "../../store/database.js"`
- Add `import { getRepos } from "../../store/repos/index.js"`
- All `plugins` table ops → `repos.plugin.upsert/get/list/updateEnabled/updateConfig/delete`
- All `skills` table ops → `repos.skill.create/get/list/delete`

- [ ] **Step 4: Migrate agent/session-memory.ts**

- Remove `import { DB } from "../../store/database.js"`
- Add `import { getRepos } from "../../store/repos/index.js"`
- `SELECT * FROM session_memory WHERE session_id=?` → `repos.sessionMemory.load(sessionId)`
- `INSERT OR REPLACE INTO session_memory` → `repos.sessionMemory.save(...)`

- [ ] **Step 5: Migrate agent/orchestrator.ts**

- Remove `import { DB } from "../../store/database.js"`
- Add `import { getRepos } from "../../store/repos/index.js"`
- All `agent_tasks` ops → `repos.agentTask.create/updateStatus/get/listBySession`

- [ ] **Step 6: Migrate agent/auto-dream.ts**

- Remove `import { DB } from "../../store/database.js"`
- Add `import { getRepos } from "../../store/repos/index.js"`
- Settings read/write → `repos.settings.get/set`
- `SELECT session_id, content FROM session_memory` → `repos.sessionMemory.listRecent(limit)`
- `SELECT id FROM knowledge_bases LIMIT 1` → `repos.knowledgeBase.getAnyId()`
- JSON manipulation (`json_set`) → read-modify-write via `repos.settings.get/set`

- [ ] **Step 7: Migrate remaining service files**

- `agent-runner.ts`: Remove `import { SettingsStore }`, use `repos.settings` for settings access
- `tool-setup.ts`: Remove wiki-pages imports, use `repos.wikiPage`
- `channel-manager.ts`: Remove `import { SettingsStore }`, use `repos.settings`
- `docling-processor.ts`: Same pattern
- `models/embedding.ts`: Remove `import { DB }`, use `repos.embedding.markAllStale()` and `repos.embedding.getStaleCount()`, use `repos.settings` for dimension tracking
- `display-resolver.ts`: Remove `import { getPool }`, use `repos.document.getById()` + `repos.knowledgeBase.get()` to resolve display info

- [ ] **Step 8: Commit**

```bash
git add src/services/ src/models/
git commit -m "feat: migrate all service files to PG repos"
```

---

### Task 22: Migrate tool files

**Files:**
- Modify: `src/tools/WikiBrowseTool/index.ts`
- Modify: `src/tools/TimelineTool/index.ts`
- Modify: `src/tools/GraphTool/index.ts`
- Modify: `src/tools/ReportTool/index.ts`

- [ ] **Step 1: Replace wiki-pages imports with repos**

For each tool file:
- Remove `import { getWikiPage, getWikiPagesByKb, getPageContent } from "../../store/wiki-pages.js"`
- Add `import { getRepos } from "../../store/repos/index.js"`
- Replace calls:
  - `getWikiPage(id)` → `repos.wikiPage.getById(id)`
  - `getWikiPagesByKb(kbId, type)` → `repos.wikiPage.getByKbAndType(kbId, type)`
  - `getPageContent(filePath)` → This reads from filesystem. Keep the filesystem read or use `repos.wikiPage.getById()` which returns content from DB (PG stores content in the `content` column).

- [ ] **Step 2: Commit**

```bash
git add src/tools/
git commit -m "feat: migrate tool files to PG repos"
```

---

## Phase 3 Summary

After Phase 3:
- All 37 consumer files use `getRepos()` instead of direct SQLite
- No file imports `store/database.ts` or old store modules
- All data access is async through repository interfaces

**Next:** Phase 4 removes all SQLite code and cleans up.
