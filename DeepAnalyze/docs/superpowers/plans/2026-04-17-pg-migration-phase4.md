# PG Migration - Phase 4: Cleanup & Finalization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all SQLite code, clean up dependencies, update tests, verify the system works with PG only.

---

### Task 23: Delete all SQLite files

**Files to delete:**
- `src/store/database.ts`
- `src/store/migrations/001_init.ts`
- `src/store/migrations/002_wiki_indexes.ts`
- `src/store/migrations/003_vector_tables.ts`
- `src/store/migrations/004_settings.ts`
- `src/store/migrations/005_session_memory.ts`
- `src/store/migrations/006_cron_jobs.ts`
- `src/store/migrations/007_processing_steps.ts`
- `src/store/migrations/008_embedding_stale.ts`
- `src/store/migrations/009_anchors.ts`
- `src/store/migrations/010_wiki_structure_page_type.ts`
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
- `src/store/migrations/` (entire directory)

- [ ] **Step 1: Delete files**

```bash
rm src/store/database.ts
rm -rf src/store/migrations/
rm src/store/sessions.ts
rm src/store/messages.ts
rm src/store/knowledge-bases.ts
rm src/store/wiki-pages.ts
rm src/store/documents.ts
rm src/store/settings.ts
rm src/store/settings-reader.ts
rm src/store/reports.ts
rm src/store/agent-teams.ts
rm src/store/repos/sqlite-repos.ts
```

- [ ] **Step 2: Verify no remaining SQLite imports**

```bash
grep -r "from.*store/database" src/ --include="*.ts" || echo "OK: no SQLite imports"
grep -r "from.*store/sessions" src/ --include="*.ts" || echo "OK: no sessions imports"
grep -r "from.*store/messages" src/ --include="*.ts" || echo "OK: no messages imports"
grep -r "from.*store/knowledge-bases" src/ --include="*.ts" || echo "OK: no kb imports"
grep -r "from.*store/wiki-pages" src/ --include="*.ts" || echo "OK: no wiki-pages imports"
grep -r "from.*store/documents" src/ --include="*.ts" || echo "OK: no documents imports"
grep -r "from.*store/settings\"" src/ --include="*.ts" || echo "OK: no settings imports"
grep -r "from.*store/settings-reader" src/ --include="*.ts" || echo "OK: no settings-reader imports"
grep -r "from.*store/reports\"" src/ --include="*.ts" || echo "OK: no reports imports"
grep -r "from.*store/agent-teams" src/ --include="*.ts" || echo "OK: no agent-teams imports"
grep -r "sqlite-repos" src/ --include="*.ts" || echo "OK: no sqlite-repos imports"
grep -r "better-sqlite3" src/ --include="*.ts" || echo "OK: no better-sqlite3 refs"
```

Expected: All output "OK: no ... imports"

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove all SQLite code and old store modules"
```

---

### Task 24: Remove better-sqlite3 dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove from package.json**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npm uninstall better-sqlite3 @types/better-sqlite3
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove better-sqlite3 dependency"
```

---

### Task 25: Remove PG_HOST toggle logic

**Files:**
- Modify: `src/store/repos/index.ts` (if any PG_HOST checks remain)
- Modify: Any file still checking `process.env.PG_HOST`

- [ ] **Step 1: Search for remaining PG_HOST checks**

```bash
grep -rn "PG_HOST" src/ --include="*.ts"
```

Expected: No results (or only in comments). If any remain in logic code, remove the conditional and keep only the PG path.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: remove PG_HOST toggle, PG is now the only backend"
```

---

### Task 26: Update .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Update .env.example**

- Remove any mention of SQLite being the default
- PG connection vars should be marked as required (not optional)
- Add a note that PostgreSQL is required

Example:
```
# PostgreSQL (required)
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=deepanalyze
PG_USER=deepanalyze
PG_PASSWORD=deepanalyze_dev
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: update .env.example to reflect PG-only configuration"
```

---

### Task 27: Update tests

**Files:**
- Modify: `tests/pg-infrastructure.test.ts`
- Modify: `tests/repos/*.test.ts`
- Modify: `tests/compiler-e2e.test.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Update pg-infrastructure.test.ts**

- Remove any SQLite references
- Remove `PG_HOST` skip conditions (PG is always available now)
- Ensure tests verify the full RepoSet with all 17 repos

- [ ] **Step 2: Update repo tests**

- Each `tests/repos/*.test.ts` should use `getRepos()` directly
- Remove any SQLite-specific test fixtures
- Ensure all repo methods are tested

- [ ] **Step 3: Update integration tests**

- `compiler-e2e.test.ts`: Remove SQLite setup, use PG repos
- `orchestrator.test.ts`: Remove DB singleton setup, use repos

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: update all tests for PG-only database"
```

---

### Task 28: Verify compilation and basic smoke test

- [ ] **Step 1: Run TypeScript compilation**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx tsc --noEmit --pretty
```

Expected: No errors

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: Tests pass (may need PG running)

- [ ] **Step 3: Smoke test server startup**

```bash
PG_HOST=localhost npm run dev &
sleep 5
curl http://localhost:21000/api/health
kill %1
```

Expected: `{"status":"ok","version":"0.1.0"}`

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: finalize PG migration, verify compilation and tests"
```

---

## Phase 4 Summary

After Phase 4:
- Zero SQLite code remains in the codebase
- `better-sqlite3` removed from dependencies
- PG is the only database backend
- All tests use PG repos
- System compiles and starts correctly

## Plan Files

| File | Phase | Content |
|------|-------|---------|
| `2026-04-17-pg-migration-phase1.md` | Infrastructure | Interfaces, PG migrations, factory, main.ts |
| `2026-04-17-pg-migration-phase2.md` | Repo Implementation | All 17 PG repo classes |
| `2026-04-17-pg-migration-phase3.md` | Consumer Migration | All 37 consumer files |
| `2026-04-17-pg-migration-phase4.md` | Cleanup | Delete SQLite, remove deps, update tests |
