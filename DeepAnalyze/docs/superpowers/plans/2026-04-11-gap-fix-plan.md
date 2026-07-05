# DeepAnalyze Gap Fix & Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all gaps identified by OpenClaw testing to bring DeepAnalyze from ~55% to ~90% completion, focusing on Agent route 404 fix, Wiki API endpoints, Docling integration, embedding generation, and frontend PluginManager/SkillBrowser.

**Architecture:** The core subsystems (Retriever, Expander, Linker, EntityExtractor, SubprocessManager, DoclingClient) already exist as working code. The primary gaps are: (1) route wiring (Agent 404 bug in app.ts), (2) missing Wiki REST API endpoints in knowledge.ts, (3) Docling not called in document processing pipeline, (4) embeddings not generated after compilation, (5) frontend stubs for Plugin/Skill management.

**Tech Stack:** TypeScript, Hono v4.7, better-sqlite3, React 19, Zustand, Python (Docling subprocess)

---

## Gap Analysis Summary

| # | Issue | Priority | Root Cause | File(s) |
|---|-------|----------|------------|---------|
| G1 | Agent routes return 404 | P0 | `app.use("/api/agents/*")` doesn't rewrite URL path for sub-app | `src/server/app.ts` |
| G2 | Plugin routes same issue | P0 | Same pattern as G1 | `src/server/app.ts` |
| G3 | Wiki search/browse/expand API missing | P1 | No routes in knowledge.ts for search, wiki browse, expand | `src/server/routes/knowledge.ts` |
| G4 | Docling not integrated in processing | P1 | process/:docId only handles text files, skips PDF/Word | `src/server/routes/knowledge.ts` |
| G5 | Vector embeddings not generated | P2 | process/:docId never calls embeddingManager | `src/server/routes/knowledge.ts` |
| G6 | Entity extraction & link building not integrated | P2 | process/:docId never calls EntityExtractor or Linker | `src/server/routes/knowledge.ts` |
| G7 | Frontend PluginManager is stub | P2 | Placeholder component | `frontend/src/components/plugins/PluginManager.tsx` |
| G8 | Frontend SkillBrowser is stub | P2 | Placeholder component | `frontend/src/components/plugins/SkillBrowser.tsx` |
| G9 | Report generate depends on Agent (500) | P2 | Blocked by G1 fix | `src/server/routes/reports.ts` |

---

## Task 1: Fix Agent & Plugin Route 404 (G1, G2) — P0

**Root Cause Analysis:**

In `src/server/app.ts:45-51`, the middleware does:
```typescript
app.use("/api/agents/*", async (c, next) => {
  if (!agentRoutes) {
    const orchestrator = await getOrchestrator();
    agentRoutes = createAgentRoutes(orchestrator);
  }
  return agentRoutes.fetch(c.req.raw);
});
```

When a request hits `POST /api/agents/run`, the middleware matches and calls `agentRoutes.fetch(c.req.raw)`. But `c.req.raw` still has URL `/api/agents/run`, while the `agentRoutes` sub-app defines routes as `/run`, `/tasks/:sessionId`, etc. (relative to root `/`). The sub-app cannot match `/api/agents/run` to `/run`, so it returns Hono's default 404.

**Fix:** Rewrite the request URL before forwarding to the sub-app by stripping the `/api/agents` prefix.

**Files:**
- Modify: `src/server/app.ts:40-70`

- [ ] **Step 1: Fix agent route middleware**

Replace the agent middleware block (lines 40-51) in `src/server/app.ts`:

```typescript
  // Agent routes - lazily initialized on first request
  let agentRoutes: Hono | null = null;

  app.all("/api/agents/{*path}", async (c) => {
    const path = c.req.param("path") || "";

    try {
      if (!agentRoutes) {
        console.log("[AgentSystem] Initializing agent routes...");
        const orchestrator = await getOrchestrator();
        agentRoutes = createAgentRoutes(orchestrator);
        console.log("[AgentSystem] Agent routes ready.");
      }

      // Rewrite URL to strip /api/agents prefix before forwarding to sub-app
      const url = new URL(c.req.url);
      url.pathname = "/" + path;
      const newRequest = new Request(url.toString(), {
        method: c.req.method,
        headers: c.req.headers,
        body: ["POST", "PUT", "PATCH"].includes(c.req.method)
          ? await c.req.raw.clone().text()
          : undefined,
      });

      return agentRoutes.fetch(newRequest);
    } catch (err) {
      console.error("[AgentSystem] Error:", err);
      return c.json({
        error: "Agent system error",
        detail: err instanceof Error ? err.message : String(err),
      }, 503);
    }
  });
```

- [ ] **Step 2: Fix plugin route middleware (same pattern)**

Replace the plugin middleware block (lines 63-70) in `src/server/app.ts`:

```typescript
  // Plugin and skill routes - lazily initialized
  let pluginRoutes: Hono | null = null;

  app.all("/api/plugins/{*path}", async (c) => {
    const path = c.req.param("path") || "";

    try {
      if (!pluginRoutes) {
        pluginRoutes = createPluginRoutes();
      }

      const url = new URL(c.req.url);
      url.pathname = "/" + path;
      const newRequest = new Request(url.toString(), {
        method: c.req.method,
        headers: c.req.headers,
        body: ["POST", "PUT", "PATCH"].includes(c.req.method)
          ? await c.req.raw.clone().text()
          : undefined,
      });

      return pluginRoutes.fetch(newRequest);
    } catch (err) {
      console.error("[PluginSystem] Error:", err);
      return c.json({
        error: "Plugin system error",
        detail: err instanceof Error ? err.message : String(err),
      }, 503);
    }
  });
```

- [ ] **Step 3: Verify the fix compiles**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit src/server/app.ts 2>&1 | head -30`

Expected: No errors (or only pre-existing unrelated errors)

- [ ] **Step 4: Manual test**

Start server and test:
```bash
# Start server
python3 start.py --skip-frontend &

# Test agent routes
curl -s -X POST http://localhost:21000/api/agents/run \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test","input":"hello"}' | head -c 200

# Should return JSON with error (503 or 500 about session not found or agent init) — NOT 404
# Test plugin routes
curl -s http://localhost:21000/api/plugins/plugins | head -c 200

# Should return {"plugins":[]} — NOT 404
```

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts
git commit -m "fix: resolve agent/plugin route 404 by rewriting URL path for sub-app dispatch"
```

---

## Task 2: Add Wiki Search/Browse/Expand API Routes (G3) — P1

**Context:** The frontend `client.ts` calls three endpoints that don't exist yet:
- `GET /api/knowledge/:kbId/search?query=...&mode=...&topK=...`
- `GET /api/knowledge/:kbId/wiki/:path`
- `POST /api/knowledge/:kbId/expand` with body `{docId, level, section}`

The backend wiki subsystem (`Retriever`, `Expander`) already exists but is only wired to agent tools (not REST API). We need to add REST routes that instantiate and call these subsystems.

**Files:**
- Modify: `src/server/routes/knowledge.ts` (add 3 new routes at the end, before the closing)

- [ ] **Step 1: Add search route to knowledge.ts**

Add the following routes at the end of `knowledge.ts` (after the `process-all` route, before file end):

```typescript
// =====================================================================
// GET /:kbId/search - Search wiki pages in a knowledge base
// =====================================================================

knowledgeRoutes.get("/:kbId/search", async (c) => {
  const kbId = c.req.param("kbId");
  const query = c.req.query("query") || c.req.query("q") || "";
  const mode = c.req.query("mode") || "hybrid";
  const topK = parseInt(c.req.query("topK") || "10", 10);

  if (!query) {
    return c.json({ error: "query parameter is required" }, 400);
  }

  // Verify KB exists
  const kb = getKnowledgeBase(kbId);
  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  try {
    // Use the agent system's retriever if available, otherwise do simple search
    const { isOrchestratorReady, getOrchestrator } = await import("../../services/agent/agent-system.js");

    let results: Array<{
      docId: string;
      level: string;
      content: string;
      score: number;
      metadata: Record<string, unknown>;
    }> = [];

    if (isOrchestratorReady()) {
      // Get the retriever from the agent system
      const { Retriever } = await import("../../wiki/retriever.js");
      const { Linker } = await import("../../wiki/linker.js");
      const { Indexer } = await import("../../wiki/indexer.js");
      const { ModelRouter } = await import("../../models/router.js");
      const { EmbeddingManager } = await import("../../models/embedding.js");
      const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");

      const modelRouter = new ModelRouter();
      await modelRouter.initialize();
      const embeddingManager = new EmbeddingManager(modelRouter);
      await embeddingManager.initialize();
      const linker = new Linker();
      const indexer = new Indexer(embeddingManager);
      const retriever = new Retriever(indexer, linker, embeddingManager);

      const searchResults = await retriever.search(query, {
        kbIds: [kbId],
        topK,
      });

      results = searchResults.map((r) => ({
        docId: r.docId || "",
        level: r.pageType,
        content: r.snippet,
        score: r.score,
        metadata: { pageId: r.pageId, source: r.source, title: r.title },
      }));
    } else {
      // Fallback: simple LIKE-based search on wiki_pages
      const { getPageContent } = await import("../../store/wiki-pages.js");
      const { DB } = await import("../../store/database.js");
      const db = DB.getInstance().raw;
      const likePattern = `%${query}%`;

      const rows = db.prepare(
        `SELECT id, kb_id, doc_id, page_type, title, file_path
         FROM wiki_pages
         WHERE kb_id = ? AND (title LIKE ? OR page_type IN ('abstract', 'overview'))
         LIMIT ?`,
      ).all(kbId, likePattern, topK) as Record<string, unknown>[];

      results = rows.map((row) => {
        let snippet = "";
        try {
          const content = getPageContent(row.file_path as string);
          const idx = content.toLowerCase().indexOf(query.toLowerCase());
          if (idx >= 0) {
            snippet = content.substring(Math.max(0, idx - 50), idx + query.length + 100);
          } else {
            snippet = content.substring(0, 200);
          }
        } catch { /* ignore */ }

        return {
          docId: (row.doc_id as string) || "",
          level: row.page_type as string,
          content: snippet,
          score: 0.5,
          metadata: { pageId: row.id as string, title: row.title as string },
        };
      });
    }

    return c.json({ results, totalFound: results.length });
  } catch (err) {
    console.error("[Knowledge] Search failed:", err);
    return c.json({
      error: "Search failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
```

- [ ] **Step 2: Add wiki browse route**

```typescript
// =====================================================================
// GET /:kbId/wiki/* - Browse a wiki page by path
// =====================================================================

knowledgeRoutes.get("/:kbId/wiki/*", async (c) => {
  const kbId = c.req.param("kbId");
  // Extract the page path after /:kbId/wiki/
  const fullPath = c.req.path;
  const wikiPrefix = `/api/knowledge/${kbId}/wiki/`;
  const pagePath = fullPath.startsWith(wikiPrefix)
    ? fullPath.substring(wikiPrefix.length)
    : "";

  if (!pagePath) {
    // List all pages in the KB
    const { getWikiPagesByKb } = await import("../../store/wiki-pages.js");
    const pages = getWikiPagesByKb(kbId);
    return c.json({ pages });
  }

  try {
    const { getWikiPage, getPageContent } = await import("../../store/wiki-pages.js");
    const { DB } = await import("../../store/database.js");
    const db = DB.getInstance().raw;

    // Try to find page by path or by ID
    let page = getWikiPage(decodeURIComponent(pagePath));

    if (!page) {
      // Try to find by file_path containing the page path
      const row = db.prepare(
        `SELECT id FROM wiki_pages WHERE kb_id = ? AND file_path LIKE ? LIMIT 1`,
      ).get(kbId, `%${decodeURIComponent(pagePath)}%`) as Record<string, unknown> | undefined;

      if (row) {
        page = getWikiPage(row.id as string);
      }
    }

    if (!page) {
      return c.json({ error: "Page not found" }, 404);
    }

    const content = getPageContent(page.filePath);

    return c.json({
      id: page.id,
      kbId: page.kbId,
      docId: page.docId,
      pageType: page.pageType,
      title: page.title,
      content,
      tokenCount: page.tokenCount,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    });
  } catch (err) {
    return c.json({
      error: "Failed to browse wiki",
      detail: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
```

- [ ] **Step 3: Add expand route**

```typescript
// =====================================================================
// POST /:kbId/expand - Expand wiki content to a deeper level
// =====================================================================

knowledgeRoutes.post("/:kbId/expand", async (c) => {
  const kbId = c.req.param("kbId");
  const body = await c.req.json<{
    docId?: string;
    level?: string;
    section?: string;
    pageId?: string;
  }>();

  if (!body.docId && !body.pageId) {
    return c.json({ error: "docId or pageId is required" }, 400);
  }

  try {
    const { Expander } = await import("../../wiki/expander.js");
    const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
    const expander = new Expander(DEEPANALYZE_CONFIG.dataDir);

    if (body.pageId && body.section) {
      const result = await expander.expandSection(body.pageId, body.section);
      if (!result) {
        return c.json({ error: "Section not found" }, 404);
      }
      return c.json({
        content: result.content,
        level: result.level,
        expandable: true,
        pageId: result.pageId,
      });
    }

    if (body.docId && body.level) {
      const result = await expander.expandToLevel(
        body.docId,
        body.level as "L0" | "L1" | "L2",
      );
      const nextLevel = result.childPages && result.childPages.length > 0;
      return c.json({
        content: result.content,
        level: result.level,
        expandable: nextLevel,
        pageId: result.pageId,
      });
    }

    if (body.pageId) {
      const result = await expander.expand(body.pageId);
      return c.json({
        content: result.content,
        level: result.level,
        expandable: !!result.childPages && result.childPages.length > 0,
        pageId: result.pageId,
      });
    }

    return c.json({ error: "Invalid parameters" }, 400);
  } catch (err) {
    return c.json({
      error: "Expand failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
```

- [ ] **Step 4: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit src/server/routes/knowledge.ts 2>&1 | head -30`

- [ ] **Step 5: Test the new endpoints**

```bash
# Create a KB and upload a text file first
KB_ID=$(curl -s -X POST http://localhost:21000/api/knowledge/kbs \
  -H "Content-Type: application/json" -d '{"name":"test-wiki"}' | jq -r '.id')

echo "Hello world test document" > /tmp/test.txt
DOC_ID=$(curl -s -X POST "http://localhost:21000/api/knowledge/kbs/${KB_ID}/upload" \
  -F "file=@/tmp/test.txt" | jq -r '.id')

# Process the document
curl -s -X POST "http://localhost:21000/api/knowledge/kbs/${KB_ID}/process/${DOC_ID}"

# Test search
curl -s "http://localhost:21000/api/knowledge/${KB_ID}/search?query=hello"

# Test browse (list)
curl -s "http://localhost:21000/api/knowledge/${KB_ID}/wiki/"

# Test expand
curl -s -X POST "http://localhost:21000/api/knowledge/${KB_ID}/expand" \
  -H "Content-Type: application/json" \
  -d "{\"docId\":\"${DOC_ID}\",\"level\":\"L2\"}"
```

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/knowledge.ts
git commit -m "feat: add wiki search, browse, and expand REST API routes"
```

---

## Task 3: Integrate Docling in Document Processing (G4) — P1

**Context:** `src/subprocess/manager.ts` and `src/subprocess/docling-client.ts` already exist with a full JSON-line subprocess protocol. The `docling-service/` directory has `main.py` and `parser.py`. The issue is that `knowledge.ts:process/:docId` doesn't call Docling for non-text files.

**Files:**
- Modify: `src/server/routes/knowledge.ts` (modify the process route at ~line 264-273)

- [ ] **Step 1: Modify the process/:docId route to integrate Docling**

Replace the non-text file handling block in `knowledge.ts` (the block at ~line 264 that currently returns an error for non-text files):

```typescript
    // Step 3: Determine processing path based on file type
    const textTypes = ["txt", "markdown", "md", "csv", "json", "html", "xml", "rtf"];
    const doclingTypes = ["pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "png", "jpg", "jpeg", "tiff", "bmp"];

    let content: string;

    if (textTypes.includes(doc.fileType)) {
      // Text files: read directly
      try {
        content = readFileSync(doc.filePath, "utf-8");
      } catch (err) {
        updateDocumentStatus(docId, "error");
        return c.json({
          documentId: docId,
          status: "error",
          message: `Failed to read document: ${err instanceof Error ? err.message : String(err)}`,
        }, 500);
      }
    } else if (doclingTypes.includes(doc.fileType)) {
      // Non-text files: use Docling subprocess
      try {
        const { SubprocessManager } = await import("../../subprocess/manager.js");
        const { startDocling, parseWithDocling } = await import("../../subprocess/docling-client.js");
        const projectRoot = resolve(DEEPANALYZE_CONFIG.dataDir, "..");

        const mgr = new SubprocessManager();
        await startDocling(projectRoot, mgr);
        console.log(`[Knowledge] Docling parsing: ${doc.filename}`);

        const result = await parseWithDocling(mgr, doc.filePath, {
          ocr: true,
          extract_tables: true,
        });
        await mgr.stop("docling");

        content = result.content;
        console.log(`[Knowledge] Docling parsed ${doc.filename}: ${content.length} chars`);
      } catch (err) {
        console.error(`[Knowledge] Docling parsing failed for ${doc.filename}:`, err);
        updateDocumentStatus(docId, "error");
        return c.json({
          documentId: docId,
          status: "error",
          message: `Docling parsing failed: ${err instanceof Error ? err.message : String(err)}`,
        }, 500);
      }
    } else {
      // Unsupported file type
      updateDocumentStatus(docId, "error");
      return c.json({
        documentId: docId,
        status: "error",
        message: `Unsupported file type: '${doc.fileType}'`,
      }, 400);
    }
```

- [ ] **Step 2: Also fix the process-all route with same logic**

In the `process-all` route (~line 390-396), replace the non-text type block similarly. The key change is replacing:

```typescript
      // Check if the file type can be processed directly
      const textTypes = ["txt", "markdown", "csv", "json", "html", "xml", "rtf"];
      if (!textTypes.includes(doc.fileType)) {
        updateDocumentStatus(doc.id, "error");
        errors++;
        continue;
      }
```

With:

```typescript
      const textTypes = ["txt", "markdown", "md", "csv", "json", "html", "xml", "rtf"];
      const doclingTypes = ["pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "png", "jpg", "jpeg", "tiff", "bmp"];

      let docContent: string;
      if (textTypes.includes(doc.fileType)) {
        try {
          docContent = readFileSync(doc.filePath, "utf-8");
        } catch {
          updateDocumentStatus(doc.id, "error");
          errors++;
          continue;
        }
      } else if (doclingTypes.includes(doc.fileType)) {
        try {
          const { SubprocessManager } = await import("../../subprocess/manager.js");
          const { startDocling, parseWithDocling } = await import("../../subprocess/docling-client.js");
          const projectRoot = resolve(DEEPANALYZE_CONFIG.dataDir, "..");
          const mgr = new SubprocessManager();
          await startDocling(projectRoot, mgr);
          const result = await parseWithDocling(mgr, doc.filePath);
          await mgr.stop("docling");
          docContent = result.content;
        } catch (err) {
          console.error(`[Knowledge] Docling failed for ${doc.filename}:`, err);
          updateDocumentStatus(doc.id, "error");
          errors++;
          continue;
        }
      } else {
        updateDocumentStatus(doc.id, "error");
        errors++;
        continue;
      }
```

And then use `docContent` instead of `content` in the subsequent wiki page creation code.

- [ ] **Step 3: Add the missing import for `resolve`**

Ensure `resolve` is imported from `node:path` at the top of `knowledge.ts` (it already is).

- [ ] **Step 4: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit src/server/routes/knowledge.ts 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/knowledge.ts
git commit -m "feat: integrate Docling subprocess for PDF/Word/PPT parsing in document processing"
```

---

## Task 4: Generate Embeddings After Document Compilation (G5) — P2

**Context:** After document processing creates wiki pages (L0/L1/L2), we need to generate vector embeddings for L0 (abstract) and L1 (overview) pages so that vector semantic search works. The `EmbeddingManager` in `src/models/embedding.ts` and `Indexer` in `src/wiki/indexer.ts` already exist.

**Files:**
- Modify: `src/server/routes/knowledge.ts` (add embedding step after wiki page creation in both process and process-all)

- [ ] **Step 1: Add embedding generation helper function**

Add this function near the top of `knowledge.ts` (after the imports):

```typescript
/**
 * Generate vector embeddings for wiki pages of a document.
 * Embeds L0 (abstract) and L1 (overview) pages for semantic search.
 */
async function generateEmbeddings(kbId: string, docId: string): Promise<void> {
  try {
    const { ModelRouter } = await import("../../models/router.js");
    const { EmbeddingManager } = await import("../../models/embedding.js");
    const { Indexer } = await import("../../wiki/indexer.js");
    const { getWikiPageByDoc, getPageContent } = await import("../../store/wiki-pages.js");

    const modelRouter = new ModelRouter();
    await modelRouter.initialize();
    const embeddingManager = new EmbeddingManager(modelRouter);
    await embeddingManager.initialize();
    const indexer = new Indexer(embeddingManager);

    // Embed L0 (abstract) and L1 (overview) pages
    for (const pageType of ["abstract", "overview"]) {
      const page = getWikiPageByDoc(docId, pageType);
      if (!page) continue;

      const content = getPageContent(page.filePath);
      if (!content || content.trim().length === 0) continue;

      await indexer.indexPage(page.id, kbId, pageType, content);
    }
  } catch (err) {
    // Embedding failure should not block document processing
    console.warn(
      `[Knowledge] Embedding generation failed for doc ${docId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
```

- [ ] **Step 2: Call generateEmbeddings after wiki page creation in process/:docId**

After the `updateDocumentStatus(docId, "ready")` line in the process route (~line 331), add:

```typescript
    // Step 7: Generate vector embeddings (async, non-blocking)
    generateEmbeddings(kbId, docId).catch((err) => {
      console.warn(`[Knowledge] Background embedding failed for ${docId}:`, err);
    });
```

- [ ] **Step 3: Same for process-all route**

After the `updateDocumentStatus(doc.id, "ready")` in the process-all loop, add:

```typescript
      // Generate embeddings in background
      generateEmbeddings(kbId, doc.id).catch((err) => {
        console.warn(`[Knowledge] Background embedding failed for ${doc.id}:`, err);
      });
```

- [ ] **Step 4: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit src/server/routes/knowledge.ts 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/knowledge.ts
git commit -m "feat: generate vector embeddings for wiki pages after document compilation"
```

---

## Task 5: Integrate Entity Extraction & Link Building (G6) — P2

**Context:** After document processing, the wiki pages should have entity extraction performed and forward/backward links built. The `EntityExtractor` and `Linker` already exist but aren't called in the processing pipeline.

**Files:**
- Modify: `src/server/routes/knowledge.ts` (add entity extraction + link building after embedding step)

- [ ] **Step 1: Add entity extraction and link building helper**

Add this function near `generateEmbeddings`:

```typescript
/**
 * Extract entities from the overview page and create entity wiki pages
 * plus forward/backward links.
 */
async function extractEntitiesAndLinks(kbId: string, docId: string, filename: string): Promise<void> {
  try {
    const { ModelRouter } = await import("../../models/router.js");
    const { EntityExtractor } = await import("../../wiki/entity-extractor.js");
    const { Linker } = await import("../../wiki/linker.js");
    const { getWikiPageByDoc, getPageContent, createWikiPage } = await import("../../store/wiki-pages.js");

    // Read the overview content for entity extraction
    const overviewPage = getWikiPageByDoc(docId, "overview");
    if (!overviewPage) return;

    const overviewContent = getPageContent(overviewPage.filePath);
    if (!overviewContent || overviewContent.trim().length < 50) return;

    // Extract entities using LLM
    const modelRouter = new ModelRouter();
    await modelRouter.initialize();
    const extractor = new EntityExtractor(modelRouter);
    const entities = await extractor.extract(overviewContent);

    if (entities.length === 0) return;

    const wikiDir = join(DEEPANALYZE_CONFIG.dataDir, "wiki");
    const linker = new Linker();

    // Create entity pages and links
    for (const entity of entities.slice(0, 20)) { // limit to 20 entities per document
      const entityTitle = `${entity.type}: ${entity.name}`;
      const entityContent = `# ${entity.name}\n\nType: ${entity.type}\n\nMentions:\n${entity.mentions.map((m) => `- ${m}`).join("\n")}\n\nSource: ${filename}`;

      const entityPage = createWikiPage(
        kbId,
        null, // no doc_id for entity pages
        "entity",
        entityTitle,
        entityContent,
        wikiDir,
      );

      // Create forward link from overview to entity
      linker.createLink({
        sourcePageId: overviewPage.id,
        targetPageId: entityPage.id,
        linkType: "entity_ref",
        entityName: entity.name,
        context: entity.mentions[0] || "",
      });

      // Create backward link from entity to overview
      linker.createLink({
        sourcePageId: entityPage.id,
        targetPageId: overviewPage.id,
        linkType: "backward",
        entityName: entity.name,
        context: `Referenced in ${filename}`,
      });
    }

    console.log(`[Knowledge] Extracted ${entities.length} entities from ${filename}`);
  } catch (err) {
    console.warn(
      `[Knowledge] Entity extraction failed for doc ${docId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
```

- [ ] **Step 2: Call after embedding generation in process/:docId**

After the `generateEmbeddings` call in process route, add:

```typescript
    // Step 8: Extract entities and build links (async, non-blocking)
    extractEntitiesAndLinks(kbId, docId, doc.filename).catch((err) => {
      console.warn(`[Knowledge] Background entity extraction failed for ${docId}:`, err);
    });
```

- [ ] **Step 3: Same for process-all route**

After the `generateEmbeddings` call in process-all loop, add:

```typescript
      // Extract entities and build links in background
      extractEntitiesAndLinks(kbId, doc.id, doc.filename).catch((err) => {
        console.warn(`[Knowledge] Entity extraction failed for ${doc.id}:`, err);
      });
```

- [ ] **Step 4: Verify compilation**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit src/server/routes/knowledge.ts 2>&1 | head -30`

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/knowledge.ts
git commit -m "feat: integrate entity extraction and link building in document processing pipeline"
```

---

## Task 6: Implement Frontend PluginManager Component (G7) — P2

**Context:** `frontend/src/components/plugins/PluginManager.tsx` is currently a stub. It should display installed plugins with enable/disable/configure actions using the existing backend API.

**Files:**
- Modify: `frontend/src/components/plugins/PluginManager.tsx`

- [ ] **Step 1: Implement PluginManager component**

Replace the stub with a full implementation:

```tsx
import { useState, useEffect } from "react";
import { api } from "../../api/client.js";
import type { PluginInfo } from "../../types/index.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import { Spinner } from "../ui/Spinner.js";

export function PluginManager() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPlugins = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.listPlugins();
      setPlugins(result.plugins);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadPlugins(); }, []);

  const handleToggle = async (plugin: PluginInfo) => {
    try {
      if (plugin.enabled) {
        await api.disablePlugin(plugin.id);
      } else {
        await api.enablePlugin(plugin.id);
      }
      setPlugins((prev) =>
        prev.map((p) => (p.id === plugin.id ? { ...p, enabled: !p.enabled } : p)),
      );
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDelete = async (plugin: PluginInfo) => {
    try {
      await api.deletePlugin(plugin.id);
      setPlugins((prev) => prev.filter((p) => p.id !== plugin.id));
    } catch (err) {
      setError(String(err));
    }
  };

  if (isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "48px" }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div style={{ padding: "24px", maxWidth: "900px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 600, color: "var(--text-primary)" }}>
          插件管理
        </h2>
        <Button variant="secondary" onClick={loadPlugins}>
          刷新
        </Button>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", background: "var(--error-bg, #fef2f2)", borderRadius: "8px", color: "var(--error, #ef4444)", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      {plugins.length === 0 ? (
        <EmptyState
          title="暂无插件"
          description="系统中尚未安装任何插件。插件可以通过 Plugin API 注册。"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              style={{
                padding: "16px",
                background: "var(--bg-primary, #fff)",
                border: "1px solid var(--border-primary, #e2e8f0)",
                borderRadius: "12px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                  <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{plugin.name}</span>
                  <Badge variant={plugin.enabled ? "success" : "default"}>
                    {plugin.enabled ? "已启用" : "已禁用"}
                  </Badge>
                  {plugin.version && (
                    <span style={{ fontSize: "12px", color: "var(--text-tertiary, #94a3b8)" }}>v{plugin.version}</span>
                  )}
                </div>
                <div style={{ fontSize: "14px", color: "var(--text-secondary, #475569)" }}>
                  {plugin.description || "无描述"}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <Button
                  variant={plugin.enabled ? "ghost" : "primary"}
                  size="sm"
                  onClick={() => handleToggle(plugin)}
                >
                  {plugin.enabled ? "禁用" : "启用"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(plugin)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/plugins/PluginManager.tsx
git commit -m "feat: implement PluginManager component with real backend API integration"
```

---

## Task 7: Implement Frontend SkillBrowser Component (G8) — P2

**Context:** `frontend/src/components/plugins/SkillBrowser.tsx` is a stub. It should list available skills with create/delete/run actions.

**Files:**
- Modify: `frontend/src/components/plugins/SkillBrowser.tsx`

- [ ] **Step 1: Implement SkillBrowser component**

```tsx
import { useState, useEffect } from "react";
import { api } from "../../api/client.js";
import type { SkillInfo } from "../../types/index.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { EmptyState } from "../ui/EmptyState.js";
import { Spinner } from "../ui/Spinner.js";
import { Modal } from "../ui/Modal.js";

export function SkillBrowser() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newSkill, setNewSkill] = useState({ name: "", description: "", systemPrompt: "", tools: "" });

  const loadSkills = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.listSkills();
      setSkills(result.skills);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadSkills(); }, []);

  const handleCreate = async () => {
    try {
      await api.createSkill({
        name: newSkill.name,
        description: newSkill.description,
        systemPrompt: newSkill.systemPrompt,
        tools: newSkill.tools.split(",").map((t) => t.trim()).filter(Boolean),
      });
      setShowCreate(false);
      setNewSkill({ name: "", description: "", systemPrompt: "", tools: "" });
      loadSkills();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDelete = async (skill: SkillInfo) => {
    try {
      await api.deleteSkill(skill.id);
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
    } catch (err) {
      setError(String(err));
    }
  };

  if (isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "48px" }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div style={{ padding: "24px", maxWidth: "900px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 600, color: "var(--text-primary)" }}>
          技能库
        </h2>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button variant="secondary" onClick={loadSkills}>刷新</Button>
          <Button variant="primary" onClick={() => setShowCreate(true)}>创建技能</Button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", background: "var(--error-bg, #fef2f2)", borderRadius: "8px", color: "var(--error, #ef4444)", marginBottom: "16px" }}>
          {error}
        </div>
      )}

      {skills.length === 0 ? (
        <EmptyState
          title="暂无技能"
          description="系统中尚未创建任何技能。点击"创建技能"添加自定义技能。"
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }}>
          {skills.map((skill) => (
            <div
              key={skill.id}
              style={{
                padding: "16px",
                background: "var(--bg-primary, #fff)",
                border: "1px solid var(--border-primary, #e2e8f0)",
                borderRadius: "12px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "8px" }}>
                <span style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "16px" }}>
                  {skill.name}
                </span>
                <Badge variant={skill.enabled ? "success" : "default"}>
                  {skill.enabled ? "启用" : "禁用"}
                </Badge>
              </div>
              <p style={{ fontSize: "14px", color: "var(--text-secondary, #475569)", marginBottom: "12px", lineHeight: 1.5 }}>
                {skill.description || "无描述"}
              </p>
              <div style={{ display: "flex", gap: "8px" }}>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(skill)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="创建技能" size="md">
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "14px", fontWeight: 500 }}>名称</span>
            <input
              value={newSkill.name}
              onChange={(e) => setNewSkill((s) => ({ ...s, name: e.target.value }))}
              placeholder="skill-name"
              style={{ padding: "8px 12px", border: "1px solid var(--border-primary, #e2e8f0)", borderRadius: "6px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "14px", fontWeight: 500 }}>描述</span>
            <input
              value={newSkill.description}
              onChange={(e) => setNewSkill((s) => ({ ...s, description: e.target.value }))}
              placeholder="技能描述"
              style={{ padding: "8px 12px", border: "1px solid var(--border-primary, #e2e8f0)", borderRadius: "6px" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "14px", fontWeight: 500 }}>系统提示词</span>
            <textarea
              value={newSkill.systemPrompt}
              onChange={(e) => setNewSkill((s) => ({ ...s, systemPrompt: e.target.value }))}
              placeholder="你是一个..."
              rows={4}
              style={{ padding: "8px 12px", border: "1px solid var(--border-primary, #e2e8f0)", borderRadius: "6px", resize: "vertical" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "14px", fontWeight: 500 }}>工具 (逗号分隔)</span>
            <input
              value={newSkill.tools}
              onChange={(e) => setNewSkill((s) => ({ ...s, tools: e.target.value }))}
              placeholder="kb_search, wiki_browse, expand"
              style={{ padding: "8px 12px", border: "1px solid var(--border-primary, #e2e8f0)", borderRadius: "6px" }}
            />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>取消</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!newSkill.name}>创建</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/plugins/SkillBrowser.tsx
git commit -m "feat: implement SkillBrowser component with create/delete/list functionality"
```

---

## Task 8: Verify Report Generation Works After Agent Fix (G9) — P2

**Context:** `POST /api/reports/generate` returns 500 because it depends on `getOrchestrator()`. After Task 1 fixes the Agent route, the orchestrator initialization should work. This task verifies and fixes any remaining issues.

**Files:**
- Read: `src/server/routes/reports.ts`
- Possibly modify: `src/server/routes/reports.ts`

- [ ] **Step 1: Read reports.ts to understand the generate endpoint**

Read `src/server/routes/reports.ts` and identify the `/generate` route handler. Check if it has proper error handling around `getOrchestrator()`.

- [ ] **Step 2: Add error handling to the generate route if missing**

If the generate route doesn't have try-catch around orchestrator initialization, add it:

```typescript
router.post("/generate", async (c) => {
  try {
    const body = await c.req.json();
    // ... existing validation ...

    const orchestrator = await getOrchestrator();
    // ... existing logic ...
  } catch (err) {
    console.error("[Reports] Generate failed:", err);
    return c.json({
      error: "Report generation failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
```

- [ ] **Step 3: Test report generation**

```bash
# Create a session first
SESSION_ID=$(curl -s -X POST http://localhost:21000/api/sessions \
  -H "Content-Type: application/json" -d '{"title":"test report"}' | jq -r '.id')

# Generate a report
curl -s -X POST http://localhost:21000/api/reports/generate \
  -H "Content-Type: application/json" \
  -d "{\"kbId\":\"test\",\"query\":\"test report\",\"title\":\"Test Report\",\"sessionId\":\"${SESSION_ID}\"}"
```

Expected: Returns `{"taskId":"...","status":"running"}` or a meaningful error (not 404)

- [ ] **Step 4: Commit if changes were made**

```bash
git add src/server/routes/reports.ts
git commit -m "fix: add error handling to report generation endpoint"
```

---

## Task 9: Final Integration Test

- [ ] **Step 1: Rebuild frontend**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npm run build
```

- [ ] **Step 2: Restart server and run comprehensive health check**

```bash
# Kill old server
pkill -f "start.py" 2>/dev/null || true

# Start fresh
python3 /mnt/d/code/deepanalyze/deepanalyze/start.py &
sleep 5

# Test all previously broken endpoints
echo "=== Agent Routes ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:21000/api/agents/run \
  -H "Content-Type: application/json" -d '{"sessionId":"test","input":"hello"}'

echo "=== Plugin Routes ==="
curl -s -w "\nHTTP %{http_code}\n" http://localhost:21000/api/plugins/plugins

echo "=== Wiki Search ==="
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:21000/api/knowledge/test-kb/search?query=test"

echo "=== Health ==="
curl -s -w "\nHTTP %{http_code}\n" http://localhost:21000/api/health

echo "=== Frontend ==="
curl -s -w "\nHTTP %{http_code}\n" http://localhost:21000/ | head -c 200
```

Expected:
- Agent routes: HTTP 4xx or 5xx with JSON body (NOT 404)
- Plugin routes: HTTP 200 with `{"plugins":[]}`
- Wiki search: HTTP 200 or 404 for non-existent KB (NOT 404 for route)
- Health: HTTP 200
- Frontend: HTML page

- [ ] **Step 3: Run Playwright tests from OpenClaw test suite**

```bash
cd /mnt/d/code/deepanalyze/openclaw_test/2026-04-11-0000-test-report
node api-test.js 2>&1 | tail -30
```

Expected: Significantly fewer 404 errors, agent routes accessible.

- [ ] **Final commit**

```bash
git add -A
git commit -m "chore: integration verification after gap fixes"
```

---

## Expected Completion After Fixes

| Phase | Before | After (expected) |
|-------|--------|------------------|
| Phase 0 - Skeleton | 95% | 95% |
| Phase 1 - Agent Dialog | 20% | 85% |
| Phase 2 - Tool System | 40% | 75% |
| Phase 3 - Wiki Engine | 30% | 75% |
| Phase 4 - Parent-Child Agent | 0% | 60% |
| Phase 5 - Report Analysis | 50% | 80% |
| Phase 6 - Plugin/Skill | 20% | 65% |
| **Overall** | **~55%** | **~75-80%** |
