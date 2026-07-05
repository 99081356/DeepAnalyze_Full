// =============================================================================
// DeepAnalyze - Knowledge Base API Routes
// Hono routes for knowledge base management, document upload, and processing.
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";
import { getPool } from "../../store/pg.js";
import type { WikiPage, WikiPageCreate } from "../../store/repos/index.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { stream } from "hono/streaming";
import { copyFileSync } from "node:fs";

/** Build a Content-Disposition header value that handles non-ASCII filenames (RFC 5987). */
function contentDispositionValue(disposition: string, fileName: string): string {
  if (/^[\x00-\x7F]*$/.test(fileName)) {
    return `${disposition}; filename="${fileName}"`;
  }
  const encoded = encodeURIComponent(fileName);
  const asciiFallback = fileName.replace(/[^\x00-\x7F]/g, "_");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
import { dirname, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { statSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";
import { getProcessingQueue } from "../../services/processing-queue.js";
import { errorMessage } from "../../utils/errors.ts";

// ---------------------------------------------------------------------------
// Helper: Detect file type from extension
// ---------------------------------------------------------------------------

function detectFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  // Return short extension names that match processor HANDLED_TYPES sets.
  // Processors (TextProcessor, ImageProcessor, etc.) match against short names
  // like "markdown", "pdf", "xlsx" — not MIME types like "text/markdown".
  const typeMap: Record<string, string> = {
    pdf: "pdf",
    docx: "docx",
    doc: "doc",
    xlsx: "xlsx",
    xls: "xls",
    xlsm: "xlsm",
    pptx: "pptx",
    ppt: "ppt",
    txt: "txt",
    md: "md",
    csv: "csv",
    json: "json",
    html: "html",
    htm: "htm",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    ini: "ini",
    // Legacy office formats — need LibreOffice conversion
    rtf: "rtf",
    odt: "odt",
    epub: "epub",
    png: "png",
    jpg: "jpg",
    jpeg: "jpeg",
    gif: "gif",
    bmp: "bmp",
    tiff: "tiff",
    tif: "tif",
    webp: "webp",
    svg: "svg",
    mp3: "mp3",
    wav: "wav",
    m4a: "m4a",
    flac: "flac",
    ogg: "ogg",
    aac: "aac",
    mp4: "mp4",
    avi: "avi",
    mov: "mov",
    mkv: "mkv",
    webm: "webm",
  };
  return typeMap[ext] ?? ext;
}

// ---------------------------------------------------------------------------
// Background helpers for post-processing
// ---------------------------------------------------------------------------

/**
 * Generate vector embeddings and FTS index for wiki pages of a document.
 * Embeds L0 (abstract) and L1 (overview) pages for semantic search.
 */
async function generateEmbeddingsAndIndex(kbId: string, docId: string): Promise<void> {
  try {
    const { ModelRouter } = await import("../../models/router.js");
    const { EmbeddingManager } = await import("../../models/embedding.js");
    const { Indexer } = await import("../../wiki/indexer.js");

    const modelRouter = new ModelRouter();
    await modelRouter.initialize();
    const embeddingManager = new EmbeddingManager(modelRouter);
    await embeddingManager.initialize();
    const indexer = new Indexer(embeddingManager);

    // Index L0 (abstract) and L1 (overview) pages
    const repos = await getRepos();
    for (const pageType of ["abstract", "overview"]) {
      const page = await repos.wikiPage.getByDocAndType(docId, pageType);
      if (!page) continue;

      const content = page.content;
      if (!content || content.trim().length === 0) continue;

      await indexer.indexPage(page, content);
    }
  } catch (err) {
    console.warn(
      `[Knowledge] Embedding generation failed for doc ${docId}:`,
      errorMessage(err),
    );
  }
}

/**
 * Extract entities from the overview page and create entity wiki pages
 * plus forward/backward links.
 */
async function extractEntitiesAndLinks(kbId: string, docId: string, filename: string): Promise<void> {
  // DISABLED: Entity extraction disabled per design decision
  return;
  // Code preserved below for potential future re-enablement
  try {
    const { ModelRouter } = await import("../../models/router.js");
    const { EntityExtractor } = await import("../../wiki/entity-extractor.js");

    const repos = await getRepos();

    // Read the overview content for entity extraction
    const overviewPage = await repos.wikiPage.getByDocAndType(docId, "overview");
    if (!overviewPage) return;

    const overviewContent = overviewPage.content;
    if (!overviewContent || overviewContent.trim().length < 50) return;

    // Extract entities using LLM
    const modelRouter = new ModelRouter();
    await modelRouter.initialize();
    const extractor = new EntityExtractor(modelRouter);
    const entities = await extractor.extract(overviewContent);

    if (entities.length === 0) return;

    // Create entity pages and links (limit to 20 entities per document)
    for (const entity of entities.slice(0, 20)) {
      const entityTitle = `${entity.type}: ${entity.name}`;
      const entityContent = `# ${entity.name}\n\nType: ${entity.type}\n\nMentions:\n${entity.mentions.map((m) => `- ${m}`).join("\n")}\n\nSource: ${filename}`;

      const wikiDir = join(DEEPANALYZE_CONFIG.dataDir, "wiki");
      const filePath = join(wikiDir, kbId, `${entityTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")}.md`);

      const entityPage = await repos.wikiPage.create({
        kb_id: kbId,
        doc_id: undefined,
        page_type: "entity",
        title: entityTitle,
        content: entityContent,
        file_path: filePath,
      });

      // Create forward link from overview to entity
      await repos.wikiLink.create(
        overviewPage.id,
        entityPage.id,
        "entity_ref",
        entity.name,
        entity.mentions[0] || "",
      );

      // Create backward link from entity to overview
      await repos.wikiLink.create(
        entityPage.id,
        overviewPage.id,
        "backward",
        entity.name,
        `Referenced in ${filename}`,
      );
    }

    console.log(`[Knowledge] Extracted ${entities.length} entities from ${filename}`);
  } catch (err) {
    console.warn(
      `[Knowledge] Entity extraction failed for doc ${docId}:`,
      errorMessage(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Exported document parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse a document file into plain text content.
 *
 * Routes through ProcessorFactory which picks the best processor for each
 * file type (native JS processors for Excel, docling for PDF/DOCX, etc.).
 * This function is shared between the route handler and the ProcessingQueue.
 */
export async function parseDocumentFile(filePath: string, fileType: string): Promise<string> {
  const { ProcessorFactory } = await import("../../services/document-processors/processor-factory.js");
  const factory = ProcessorFactory.getInstance();
  const parsed = await factory.parse(filePath, fileType);

  if (!parsed.success) {
    throw new Error(parsed.error ?? `Parse failed for ${filePath}`);
  }

  return parsed.text;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export const knowledgeRoutes = new Hono();

// =====================================================================
// GET / - Knowledge API root (API discoverability)
// =====================================================================

knowledgeRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    message: "Knowledge Base API",
    endpoints: [
      "GET    /kbs",
      "POST   /kbs",
      "GET    /kbs/:kbId",
      "PUT    /kbs/:kbId",
      "DELETE /kbs/:kbId",
      "GET    /kbs/:kbId/documents",
      "GET    /kbs/:kbId/entities",
      "GET    /kbs/:kbId/pages/:pageId?level=L1",
      "GET    /kbs/:kbId/pages/:pageId/preview?level=L1&q=keyword",
      "POST   /kbs/:kbId/upload",
      "GET    /kbs/:kbId/documents/:docId/status",
      "POST   /kbs/:kbId/process/:docId",
      "POST   /kbs/:kbId/process-all",
      "POST   /kbs/:kbId/trigger-processing",
      "GET    /:kbId/search?query=...",
      "GET    /:kbId/wiki/*",
      "POST   /:kbId/expand",
    ],
  });
});

// =====================================================================
// GET /kbs - List all knowledge bases
// =====================================================================

knowledgeRoutes.get("/kbs", async (c) => {
  const repos = await getRepos();
  const knowledgeBases = await repos.knowledgeBase.list();
  return c.json({ knowledgeBases });
});

// =====================================================================
// POST /kbs - Create a new knowledge base
// =====================================================================

knowledgeRoutes.post("/kbs", async (c) => {
  const body = await c.req.json<{
    name?: string;
    description?: string;
    visibility?: "private" | "team" | "public";
    ownerId?: string;
  }>();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const ownerId = body.ownerId ?? "default-user";
  const repos = await getRepos();
  const kb = await repos.knowledgeBase.create(
    body.name,
    ownerId,
    body.description,
    body.visibility,
  );

  // Create the data directories: {dataDir}/original/{kbId}/ and {dataDir}/wiki/{kbId}/
  const originalDir = join(DEEPANALYZE_CONFIG.dataDir, "original", kb.id);
  const wikiDir = join(DEEPANALYZE_CONFIG.dataDir, "wiki", kb.id);

  try {
    mkdirSync(originalDir, { recursive: true });
    mkdirSync(wikiDir, { recursive: true });
  } catch (err) {
    console.error(
      "[Knowledge] Failed to create directories for KB:",
      errorMessage(err),
    );
    // KB was created in DB but directories failed - still return the KB
  }

  return c.json(kb, 201);
});

// =====================================================================
// GET /kbs/:kbId - Get a single knowledge base
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId", async (c) => {
  const kbId = c.req.param("kbId");
  const repos = await getRepos();
  const kb = await repos.knowledgeBase.get(kbId);

  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  return c.json(kb);
});

// =====================================================================
// PUT /kbs/:kbId - Update a knowledge base
// =====================================================================

knowledgeRoutes.put("/kbs/:kbId", async (c) => {
  const kbId = c.req.param("kbId");
  const body = await c.req.json<{
    name?: string;
    description?: string;
    visibility?: "private" | "team" | "public";
  }>();

  const repos = await getRepos();
  const kb = await repos.knowledgeBase.update(kbId, body);

  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  return c.json(kb);
});

// =====================================================================
// DELETE /kbs/:kbId - Delete a knowledge base
// =====================================================================

knowledgeRoutes.delete("/kbs/:kbId", async (c) => {
  const kbId = c.req.param("kbId");
  const repos = await getRepos();
  const pool = await getPool();

  // 1. Clean up cron_jobs referencing this KB
  try {
    await pool.query(`DELETE FROM cron_jobs WHERE kb_id = $1`, [kbId]);
  } catch { /* best-effort */ }

  // 2. Clean up sessions.kb_scope referencing this KB
  try {
    const { rows } = await pool.query(
      `SELECT id, kb_scope FROM sessions WHERE kb_scope IS NOT NULL AND kb_scope != ''`
    );
    for (const session of rows) {
      if (session.kb_scope && session.kb_scope.includes(kbId)) {
        await pool.query(`UPDATE sessions SET kb_scope = NULL WHERE id = $1`, [session.id]);
      }
    }
  } catch { /* best-effort */ }

  // 3. Clean up search_cache entries referencing this KB
  try {
    await pool.query(`DELETE FROM search_cache WHERE kb_ids LIKE $1`, [`%${kbId}%`]);
  } catch { /* best-effort */ }

  // 4. Remove filesystem directories for this KB
  const dirsToClean = [
    join(DEEPANALYZE_CONFIG.dataDir, "original", kbId),
    join(DEEPANALYZE_CONFIG.dataDir, "wiki", kbId),
    join(DEEPANALYZE_CONFIG.dataDir, "generated", kbId),
  ];

  for (const dir of dirsToClean) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Directory may not exist, ignore
    }
  }

  // 5. DB deletion — CASCADE cleans: documents, wiki_pages, embeddings, anchors, wiki_links, document_tags
  const deleted = await repos.knowledgeBase.delete(kbId);

  if (!deleted) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  return c.json({ id: kbId, deleted: true });
});

// =====================================================================
// GET /kbs/:kbId/documents - List documents in a KB
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId/documents", async (c) => {
  const kbId = c.req.param("kbId");
  const repos = await getRepos();
  const kb = await repos.knowledgeBase.get(kbId);

  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  const documents = await repos.document.getByKbId(kbId);

  // Fetch L1 preview snippets for all documents in a single query
  const l1Previews = await repos.wikiPage.getL1Previews(kbId);

  // Attach l1Preview to each document
  const enriched = documents.map((doc) => ({
    ...doc,
    l1Preview: l1Previews[doc.id] ?? null,
  }));

  return c.json({ documents: enriched });
});

// =====================================================================
// GET /kbs/:kbId/entities - List all entities for a KB
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId/entities", async (c) => {
  const kbId = c.req.param("kbId");

  try {
    const repos = await getRepos();

    // Get all entity pages for this KB
    const entityPages = await repos.wikiPage.getByKbAndType(kbId, "entity");

    // For each entity, count mentions via wiki_links
    const entities = [];
    for (const page of entityPages) {
      const outgoing = await repos.wikiLink.getIncoming(page.id);
      const mentionCount = outgoing.filter((l) => l.linkType === "entity_ref").length;

      // Count distinct source docs
      const docIds = new Set<string>();
      for (const link of outgoing) {
        if (link.linkType === "entity_ref") {
          const sourcePage = await repos.wikiPage.getById(link.sourcePageId);
          if (sourcePage?.doc_id) docIds.add(sourcePage.doc_id);
        }
      }

      let entityType = "实体";
      if (page.metadata && typeof page.metadata === "object") {
        const meta = page.metadata as Record<string, unknown>;
        if (meta.type) entityType = meta.type as string;
      }

      // Strip type prefix from title (e.g. "Person: John Doe" -> "John Doe")
      const cleanName = page.title.includes(": ") ? page.title.split(": ").slice(1).join(": ") : page.title;

      entities.push({
        name: cleanName,
        type: entityType,
        mentions: mentionCount,
        docCount: docIds.size,
      });
    }

    // Sort by mention count descending
    entities.sort((a, b) => b.mentions - a.mentions);

    return c.json(entities);
  } catch (err) {
    return c.json({
      error: "Failed to fetch entities",
      detail: errorMessage(err),
    }, 500);
  }
});

// =====================================================================
// GET /kbs/:kbId/pages/:pageId - Get page with level parameter
// Returns page content and lists all available levels for the document.
// =====================================================================

const PAGE_TYPE_TO_LEVEL: Record<string, "L0" | "L1" | "L2"> = {
  abstract: "L0",
  overview: "L1",
  structure: "L1",
  structure_md: "L1",
  structure_dt: "L1",
  fulltext: "L2",
};

const LEVEL_TO_PAGE_TYPE: Record<string, string> = {
  L0: "abstract",
  L1: "overview",
  L2: "fulltext",
};

knowledgeRoutes.get("/kbs/:kbId/pages/:pageId", async (c) => {
  const kbId = c.req.param("kbId");
  const pageId = c.req.param("pageId");
  const levelParam = c.req.query("level"); // "L0", "L1", "L2"
  const pageTypeParam = c.req.query("pageType"); // "abstract", "overview", "fulltext"

  try {
    const repos = await getRepos();

    // Look up the original page
    const page = await repos.wikiPage.getById(pageId);
    if (!page || page.kb_id !== kbId) {
      return c.json({ error: "Page not found" }, 404);
    }

    // Determine which page type to return
    // If levelParam or pageTypeParam is given, try to find the sibling page at that level
    let targetPage = page;
    let requestedPageType = pageTypeParam ?? (levelParam ? LEVEL_TO_PAGE_TYPE[levelParam] : undefined);

    if (requestedPageType && requestedPageType !== page.page_type && page.doc_id) {
      let sibling = await repos.wikiPage.getByDocAndType(page.doc_id, requestedPageType);
      // For L1, fallback through all structure page types
      if (!sibling && requestedPageType === "overview" && page.doc_id) {
        for (const fallbackType of ["structure_md", "structure_dt", "structure"]) {
          sibling = await repos.wikiPage.getByDocAndType(page.doc_id, fallbackType);
          if (sibling) break;
        }
      }
      if (sibling) {
        targetPage = sibling;
      }
    }

    // Find all available levels for this document
    const availableLevels: Array<"L0" | "L1" | "L2"> = [];
    if (targetPage.doc_id) {
      const docPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "abstract");
      const overviewPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "overview");
      const fulltextPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "fulltext");
      const structurePages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "structure");
      const structureMdPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "structure_md");
      const structureDtPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "structure_dt");

      const pageTypes = new Set<string>();
      for (const p of [...docPages, ...overviewPages, ...fulltextPages, ...structurePages, ...structureMdPages, ...structureDtPages]) {
        pageTypes.add(p.page_type);
      }
      for (const pt of pageTypes) {
        const lvl = PAGE_TYPE_TO_LEVEL[pt];
        if (lvl) availableLevels.push(lvl);
      }
    } else {
      // Single page without document association - just report its own level
      const lvl = PAGE_TYPE_TO_LEVEL[targetPage.page_type];
      if (lvl) availableLevels.push(lvl);
    }

    return c.json({
      id: targetPage.id,
      kbId: targetPage.kb_id,
      docId: targetPage.doc_id,
      pageType: targetPage.page_type,
      level: PAGE_TYPE_TO_LEVEL[targetPage.page_type] ?? "L1",
      title: targetPage.title,
      content: targetPage.content,
      tokenCount: targetPage.token_count,
      availableLevels,
      createdAt: targetPage.created_at,
      updatedAt: targetPage.updated_at,
    });
  } catch (err) {
    return c.json({
      error: "Failed to get page",
      detail: errorMessage(err),
    }, 500);
  }
});

// =====================================================================
// GET /kbs/:kbId/pages/:pageId/preview - Preview snippet with highlights
// Returns a short snippet with keyword highlighting for hover preview.
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId/pages/:pageId/preview", async (c) => {
  const kbId = c.req.param("kbId");
  const pageId = c.req.param("pageId");
  const level = c.req.query("level") || "L1"; // "L0", "L1", "L2"
  const q = c.req.query("q") || ""; // query keywords (space-separated)
  const snippetLen = parseInt(c.req.query("snippetLen") || "300", 10);

  try {
    const repos = await getRepos();

    const page = await repos.wikiPage.getById(pageId);
    if (!page || page.kb_id !== kbId) {
      return c.json({ error: "Page not found" }, 404);
    }

    // If a specific level is requested, try to load that sibling page
    let targetPage = page;
    const requestedType = LEVEL_TO_PAGE_TYPE[level];
    if (requestedType && requestedType !== page.page_type && page.doc_id) {
      const sibling = await repos.wikiPage.getByDocAndType(page.doc_id, requestedType);
      if (sibling) targetPage = sibling;
    }

    const fullContent = targetPage.content;
    const keywords = q.split(/\s+/).map((w) => w.trim()).filter(Boolean);

    // Find the best snippet position based on keyword density
    let snippetStart = 0;
    if (keywords.length > 0 && fullContent.length > snippetLen) {
      let bestPos = 0;
      let bestScore = -1;

      // Slide a window of snippetLen over the content and score by keyword matches
      const step = Math.max(50, Math.floor(snippetLen / 4));
      for (let pos = 0; pos < fullContent.length - snippetLen; pos += step) {
        const window = fullContent.substring(pos, pos + snippetLen).toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          const idx = window.indexOf(kw.toLowerCase());
          if (idx >= 0) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          bestPos = pos;
        }
      }

      if (bestScore > 0) {
        snippetStart = bestPos;
      }
    }

    // Extract snippet
    let snippet: string;
    if (fullContent.length <= snippetLen) {
      snippet = fullContent;
    } else {
      const end = Math.min(fullContent.length, snippetStart + snippetLen);
      snippet = fullContent.substring(snippetStart, end);
      if (snippetStart > 0) snippet = "..." + snippet;
      if (end < fullContent.length) snippet = snippet + "...";
    }

    // Compute available levels
    const availableLevels: Array<"L0" | "L1" | "L2"> = [];

    if (targetPage.doc_id) {
      const docPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "abstract");
      const overviewPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "overview");
      const fulltextPages = await repos.wikiPage.getManyByDocAndType(targetPage.doc_id, "fulltext");

      const pageTypes = new Set<string>();
      for (const p of [...docPages, ...overviewPages, ...fulltextPages]) {
        pageTypes.add(p.page_type);
      }
      for (const pt of pageTypes) {
        const lvl = PAGE_TYPE_TO_LEVEL[pt];
        if (lvl) availableLevels.push(lvl);
      }
    } else {
      const lvl = PAGE_TYPE_TO_LEVEL[targetPage.page_type];
      if (lvl) availableLevels.push(lvl);
    }

    return c.json({
      title: targetPage.title,
      level: PAGE_TYPE_TO_LEVEL[targetPage.page_type] ?? level,
      tokenCount: targetPage.token_count,
      snippet,
      availableLevels,
    });
  } catch (err) {
    return c.json({
      error: "Failed to get preview",
      detail: errorMessage(err),
    }, 500);
  }
});

// =====================================================================
// POST /kbs/:kbId/upload - Upload a document to a KB
// =====================================================================

knowledgeRoutes.post("/kbs/:kbId/upload", async (c) => {
  const kbId = c.req.param("kbId");

  // Verify KB exists
  const repos = await getRepos();
  const kb = await repos.knowledgeBase.get(kbId);
  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  // Parse multipart form data
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  // Read the file into a buffer
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Normalize file path separators (Windows browsers may send backslashes).
  // file.name may contain relative paths from folder uploads, e.g.
  // "folder/subdir/file.pdf" or "folder\\subdir\\file.pdf".
  const safeFileName = file.name.replace(/\\/g, "/");

  // Save to a temp file so we can copy it to the data dir.
  // Use only the basename for the temp file to avoid issues with relative paths.
  const tempPath = join(
    tmpdir(),
    `deepanalyze-${randomUUID()}-${basename(safeFileName)}`,
  );

  try {
    writeFileSync(tempPath, buffer);

    // Create document record: copy file to original dir, compute hash, insert into DB
    const originalDir = join(DEEPANALYZE_CONFIG.dataDir, "original");
    const docId = randomUUID();

    // Split relative path into folder path and basename.
    // safeFileName may be "卷宗A/第一章/1.pdf" (folder upload) or "report.pdf" (single file).
    const lastSlash = safeFileName.lastIndexOf("/");
    const folderPath = lastSlash >= 0 ? safeFileName.substring(0, lastSlash) : "";
    let fileName = lastSlash >= 0 ? safeFileName.substring(lastSlash + 1) : safeFileName;

    // Copy source file to original/{kbId}/{folderPath}/{filename}
    // This preserves the original directory structure on disk.
    let destPath = join(originalDir, kbId, folderPath, fileName);

    // Security: prevent path traversal — the resolved destination must stay
    // within originalDir/{kbId}/. file.name is fully client-controlled and
    // may contain ".." segments that join() would collapse.
    const allowedBase = resolve(originalDir, kbId);
    const resolvedDest = resolve(destPath);
    if (!resolvedDest.startsWith(allowedBase + sep)) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    mkdirSync(dirname(destPath), { recursive: true });

    // Handle filename collision: append counter suffix if file already exists
    let collisionCounter = 1;
    while (existsSync(destPath)) {
      const ext = extname(fileName);
      const base = basename(fileName, ext);
      fileName = `${base}_${collisionCounter}${ext}`;
      destPath = join(originalDir, kbId, folderPath, fileName);
      collisionCounter++;
    }

    copyFileSync(tempPath, destPath);

    // Compute MD5 hash of the original file
    const fileBuffer = readFileSync(destPath);
    const fileHash = createHash("md5").update(fileBuffer).digest("hex");

    // Get file size
    const stat = statSync(destPath);
    const fileSize = stat.size;

    // Detect file type from extension
    const fileType = detectFileType(safeFileName);

    const doc = await repos.document.create({
      kb_id: kbId,
      filename: fileName,
      file_path: destPath,
      folder_path: folderPath,
      file_hash: fileHash,
      file_size: fileSize,
      file_type: fileType,
      status: "uploaded",
      metadata: {},
      processing_step: null,
      processing_progress: 0,
      processing_error: null,
    });

    // Auto-enqueue for processing (respects auto_process setting)
    const queue = getProcessingQueue();
    let autoProcess = true;
    try {
      const autoProcessVal = await repos.settings.get("auto_process");
      autoProcess = autoProcessVal !== "false";
    } catch {
      // Settings table may not exist yet — default to auto-process
    }

    if (autoProcess) {
      console.log(`[Knowledge] Auto-processing ${doc.filename} (${doc.id})`);
      queue.enqueue({
        kbId,
        docId: doc.id,
        filename: doc.filename,
        filePath: doc.file_path,
        fileType: doc.file_type,
      });
    }

    // Map to API response (camelCase)
    // Include both `id` and `documentId` for backward compatibility
    return c.json({
      id: doc.id,
      documentId: doc.id,
      docId: doc.id,
      kbId: doc.kb_id,
      filename: doc.filename,
      filePath: doc.file_path,
      folderPath: doc.folder_path,
      fileHash: doc.file_hash,
      fileSize: doc.file_size,
      fileType: doc.file_type,
      status: doc.status,
      createdAt: doc.created_at,
    }, 201);
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempPath);
    } catch {
      // Temp file cleanup is best-effort
    }
  }
});

// =====================================================================
// POST /kbs/:kbId/process/:docId - Process a single document
// =====================================================================

knowledgeRoutes.post("/kbs/:kbId/process/:docId", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");

  // Verify KB exists
  const repos = await getRepos();
  const kb = await repos.knowledgeBase.get(kbId);
  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  // Verify document exists and belongs to this KB
  const doc = await repos.document.getById(docId);
  if (!doc || doc.kb_id !== kbId) {
    return c.json({ error: "Document not found" }, 404);
  }

  const force = c.req.query("force") === "true";

  // Without force, reject documents that are already ready or actively processing
  if (!force && (doc.status === "ready" || ["parsing", "compiling", "indexing", "linking"].includes(doc.status))) {
    return c.json({
      documentId: docId,
      status: doc.status,
      message: doc.status === "ready"
        ? "Document is already processed"
        : `Document is currently ${doc.status}`,
    });
  }

  // Accept optional processor channel from request body or query
  let processor: string | undefined;
  try {
    const body = await c.req.json<{ processor?: string }>().catch(() => ({ processor: undefined as string | undefined }));
    processor = body.processor;
  } catch {
    // No body or invalid JSON
  }
  if (!processor) {
    processor = c.req.query("processor") ?? undefined;
  }

  // If force=true, cancel any active processing for this document first
  if (force) {
    const queue = getProcessingQueue();
    try {
      await queue.cancel(docId);
    } catch {
      // Job may not be active — that's fine
    }
  }

  // Enqueue for asynchronous processing
  const queue = getProcessingQueue();
  queue.enqueue({
    kbId,
    docId: doc.id,
    filename: doc.filename,
    filePath: doc.file_path,
    fileType: doc.file_type,
    processor,
    force,
  });

  return c.json({
    documentId: docId,
    status: "queued",
    message: "Document enqueued for processing",
  });
});

// =====================================================================
// POST /kbs/:kbId/documents/:docId/regenerate-abstract - Regenerate abstract for a single doc
// POST /kbs/:kbId/regenerate-abstracts - Batch regenerate abstracts for all docs in KB
// =====================================================================

knowledgeRoutes.post("/kbs/:kbId/documents/:docId/regenerate-abstract", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");
  const repos = await getRepos();

  const doc = await repos.document.getById(docId);
  if (!doc || doc.kb_id !== kbId) {
    return c.json({ error: "Document not found" }, 404);
  }

  try {
    const { ModelRouter } = await import("../../models/router.js");
    const { WikiCompiler } = await import("../../wiki/compiler.js");

    const router = new ModelRouter();
    await router.initialize();
    const dataDir = process.env.DATA_DIR || "data";
    const compiler = new WikiCompiler(router, dataDir);

    // Delete existing abstract page(s) for this document
    const existingAbstract = await repos.wikiPage.getByDocAndType(docId, "abstract");
    if (existingAbstract) {
      await repos.wikiPage.deleteById(existingAbstract.id);
    }

    // Regenerate abstract using the compiler
    const modality = (doc.metadata as Record<string, unknown>)?.modality as string | undefined;
    await compiler.compileAbstract(kbId, docId, modality ?? "document");

    return c.json({
      documentId: docId,
      status: "regenerated",
      message: "Abstract regenerated successfully",
    });
  } catch (err) {
    console.error(`[Knowledge] Failed to regenerate abstract for ${docId}:`, err);
    return c.json({
      error: "Failed to regenerate abstract",
      detail: errorMessage(err),
    }, 500);
  }
});

knowledgeRoutes.post("/kbs/:kbId/regenerate-abstracts", async (c) => {
  const kbId = c.req.param("kbId");
  const repos = await getRepos();

  const kb = await repos.knowledgeBase.get(kbId);
  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  try {
    const { ModelRouter } = await import("../../models/router.js");
    const { WikiCompiler } = await import("../../wiki/compiler.js");

    const router = new ModelRouter();
    await router.initialize();
    const dataDir = process.env.DATA_DIR || "data";
    const compiler = new WikiCompiler(router, dataDir);

    // Find all documents with empty or trivial abstracts
    const docs = await repos.document.getByKbId(kbId);
    const results: Array<{ docId: string; filename: string; status: string }> = [];

    for (const doc of docs) {
      if (doc.status !== "ready") {
        results.push({ docId: doc.id, filename: doc.filename, status: "skipped_not_ready" });
        continue;
      }

      const abstractPage = await repos.wikiPage.getByDocAndType(doc.id, "abstract");
      const content = abstractPage?.content ?? "";

      // Skip if abstract already has meaningful content (> 50 chars and not just heading)
      if (content.length > 50 && content !== "## 概述") {
        results.push({ docId: doc.id, filename: doc.filename, status: "skipped_has_content" });
        continue;
      }

      // Delete existing abstract and regenerate
      if (abstractPage) {
        await repos.wikiPage.deleteById(abstractPage.id);
      }

      try {
        const modality = (doc.metadata as Record<string, unknown>)?.modality as string | undefined;
        await compiler.compileAbstract(kbId, doc.id, modality ?? "document");
        results.push({ docId: doc.id, filename: doc.filename, status: "regenerated" });
      } catch (err) {
        results.push({
          docId: doc.id,
          filename: doc.filename,
          status: `failed: ${errorMessage(err)}`,
        });
      }
    }

    return c.json({
      kbId,
      total: docs.length,
      results,
    });
  } catch (err) {
    console.error(`[Knowledge] Batch regenerate abstracts failed for KB ${kbId}:`, err);
    return c.json({
      error: "Batch regeneration failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =====================================================================
// DELETE /kbs/:kbId/documents/:docId - Delete a document
// =====================================================================

knowledgeRoutes.delete("/kbs/:kbId/documents/:docId", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");
  const repos = await getRepos();
  const doc = await repos.document.getById(docId);
  if (!doc || doc.kb_id !== kbId) {
    return c.json({ error: "Document not found" }, 404);
  }

  // 1. Get all wiki pages for this document to clean up associated data
  const pages = await repos.wikiPage.getByKbAndType(kbId);
  const docPages = pages.filter(p => p.doc_id === docId);

  // 2. Delete embeddings, vectors, and FTS for each page
  for (const page of docPages) {
    try { await repos.embedding.deleteByPageId(page.id); } catch {}
    try { await repos.vectorSearch.deleteByPageId(page.id); } catch {}
    try { await repos.ftsSearch.deleteByPageId(page.id); } catch {}
  }

  // 3. Delete anchors
  try { await repos.anchor.deleteByDocId(docId); } catch {}

  // 4. Delete wiki pages
  try { await repos.wikiPage.deleteByDocId(docId); } catch {}

  // 5. Delete disk files (wiki data + original uploads)
  const { rm } = await import("node:fs/promises");
  const dataDir = process.env.DATA_DIR || "data";
  const wikiDocDir = join(dataDir, "wiki", kbId, "documents", docId);
  await rm(wikiDocDir, { recursive: true, force: true }).catch(() => {});

  // Delete original file at stored path (new structure or migrated)
  if (doc.file_path) {
    await rm(doc.file_path, { force: true }).catch(() => {});
    // Clean up empty parent directories up to the KB root
    const kbOriginalDir = resolve(dataDir, "original", kbId);
    let dir = resolve(dirname(doc.file_path));
    while (dir !== kbOriginalDir && dir.startsWith(kbOriginalDir)) {
      try {
        const entries = readdirSync(dir);
        if (entries.length === 0) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          dir = dirname(dir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
  // Also try to clean up legacy {docId} directory (pre-migration data)
  const legacyOriginalDir = join(dataDir, "original", kbId, docId);
  await rm(legacyOriginalDir, { recursive: true, force: true }).catch(() => {});

  // 6. Delete document record
  await repos.document.deleteById(docId);

  // 7. Update KB filesystem manifest
  try {
    const { updateManifest } = await import("../../wiki/manifest.js");
    await updateManifest(kbId);
  } catch { /* Non-critical: manifest will be stale until next update */ }

  return c.json({ id: docId, deleted: true });
});

// =====================================================================
// GET /knowledge/:kbId/documents/:docId/status - Document processing status
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId/documents/:docId/status", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");

  const repos = await getRepos();
  const doc = await repos.document.getById(docId);

  if (!doc || doc.kb_id !== kbId) {
    return c.json({ error: "Document not found" }, 404);
  }

  const stageMap: Record<string, { stage: string; progress: number }> = {
    uploaded:     { stage: "Queued",       progress: 5 },
    parsing:      { stage: "Parsing",      progress: 15 },
    compiling:    { stage: "Compiling",    progress: 35 },
    indexing:     { stage: "Indexing",     progress: 70 },
    quality_audit:{ stage: "Quality Audit",progress: 85 },
    linking:      { stage: "Linking",      progress: 90 },
    ready:        { stage: "Ready",        progress: 100 },
    error:        { stage: "Error",        progress: 0 },
  };

  const info = stageMap[doc.status] ?? { stage: doc.status, progress: 0 };

  return c.json({
    docId: doc.id,
    filename: doc.filename,
    stage: info.stage,
    progress: info.progress,
    status: doc.status,
  });
});

// =====================================================================
// POST /kbs/:kbId/process-all - Process all uploaded documents in a KB
// =====================================================================

knowledgeRoutes.post("/kbs/:kbId/process-all", async (c) => {
  const kbId = c.req.param("kbId");
  const force = c.req.query("force") === "true";

  // Verify KB exists
  const repos = await getRepos();
  const kb = await repos.knowledgeBase.get(kbId);
  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  const queue = getProcessingQueue();
  const documents = await repos.document.getByKbId(kbId);
  let enqueued = 0;

  for (const doc of documents) {
    if (force) {
      // Force mode: enqueue all documents regardless of status
      queue.enqueue({
        kbId,
        docId: doc.id,
        filename: doc.filename,
        filePath: doc.file_path,
        fileType: doc.file_type,
        force: true,
      });
      enqueued++;
    } else {
      // Normal mode: only enqueue documents in "uploaded" or "error" state
      if (doc.status !== "uploaded" && doc.status !== "error") {
        continue;
      }
      queue.enqueue({
        kbId,
        docId: doc.id,
        filename: doc.filename,
        filePath: doc.file_path,
        fileType: doc.file_type,
      });
      enqueued++;
    }
  }

  return c.json({ enqueued, force });
});

// =====================================================================
// POST /kbs/:kbId/trigger-processing - Enqueue all uploaded docs for processing
// =====================================================================

knowledgeRoutes.post("/kbs/:kbId/trigger-processing", async (c) => {
  const kbId = c.req.param("kbId");
  const repos = await getRepos();

  // Verify KB exists
  const kb = await repos.knowledgeBase.get(kbId);
  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  const queue = getProcessingQueue();

  const documents = await repos.document.getByKbId(kbId);
  const uploadedDocs = documents.filter((d) => d.status === "uploaded");

  let enqueued = 0;
  for (const doc of uploadedDocs) {
    queue.enqueue({
      kbId,
      docId: doc.id,
      filename: doc.filename,
      filePath: doc.file_path,
      fileType: doc.file_type,
    });
    enqueued++;
  }

  return c.json({ enqueued });
});

// =====================================================================
// GET /search - Cross-KB search (search across all knowledge bases)
// =====================================================================

knowledgeRoutes.get("/search", async (c) => {
  const query = decodeURIComponent(c.req.query("query") || c.req.query("q") || "");
  const topK = parseInt(c.req.query("topK") || "10", 10);
  const kbIdsParam = c.req.query("kbIds");
  const levelsParam = c.req.query("levels");
  const pageTypesParam = c.req.query("pageTypes");
  const modeParam = c.req.query("mode");

  if (!query.trim()) {
    return c.json({ error: "query parameter is required (use ?query=... or ?q=...)" }, 400);
  }

  try {
    const repos = await getRepos();

    // Resolve KB IDs: use provided list or fall back to all KBs
    let kbIds: string[];
    if (kbIdsParam) {
      kbIds = kbIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
      // Verify all specified KBs exist
      for (const kbId of kbIds) {
        const kb = await repos.knowledgeBase.get(kbId);
        if (!kb) {
          return c.json({ error: `Knowledge base not found: ${kbId}` }, 404);
        }
      }
    } else {
      const allKbs = await repos.knowledgeBase.list();
      kbIds = allKbs.map((kb) => kb.id);
    }

    if (kbIds.length === 0) {
      return c.json({ results: [], totalFound: 0, message: "No knowledge bases found" });
    }

    // Try to use the Retriever for proper vector + BM25 search
    try {
      const { getRetriever } = await import("../../services/agent/agent-system.js");
      const retriever = await getRetriever();

      if (levelsParam) {
        // Multi-level search with highlighting
        const requestedLevels = levelsParam.split(",").map((l) => l.trim());
        const result = await retriever.searchByLevels(query, kbIds, {
          topK,
          levels: requestedLevels,
          mode: modeParam as any,
        });

        const filtered: Record<string, unknown> = {};
        if (requestedLevels.includes("L0")) filtered.L0 = result.L0;
        if (requestedLevels.includes("L1")) filtered.L1 = result.L1;
        if (requestedLevels.includes("L2")) filtered.L2 = result.L2;

        return c.json({
          query,
          kbIds,
          results: filtered,
          totalFound:
            (requestedLevels.includes("L0") ? (result.L0?.length ?? 0) : 0) +
            (requestedLevels.includes("L1") ? (result.L1?.length ?? 0) : 0) +
            (requestedLevels.includes("L2") ? (result.L2?.length ?? 0) : 0),
        });
      }

      // Standard fusion search
      const pageTypes = pageTypesParam
        ? pageTypesParam.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

      const results = await retriever.search(query, {
        kbIds,
        topK,
        pageTypes,
      });

      return c.json({ results, totalFound: results.length, kbIds });
    } catch {
      // Retriever not initialized yet — fall back to simple LIKE search
      console.warn("[Knowledge] Retriever not available, falling back to simple search");
    }

    // Fallback: simple LIKE-based search across all specified KBs
    const allResults: Array<{
      kbId: string;
      docId: string;
      pageId: string;
      title: string;
      pageType: string;
      snippet: string;
      score: number;
    }> = [];

    const lowerQuery = query.toLowerCase();

    for (const kbId of kbIds) {
      const pages = await repos.wikiPage.getByKbAndType(kbId);
      for (const page of pages) {
        let score = 0;
        let snippet = "";

        if (page.title.toLowerCase().includes(lowerQuery)) {
          score = 0.8;
          snippet = page.title;
        }

        const content = page.content || "";
        const idx = content.toLowerCase().indexOf(lowerQuery);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(content.length, idx + query.length + 100);
          snippet = content.substring(start, end);
          if (start > 0) snippet = "..." + snippet;
          if (end < content.length) snippet = snippet + "...";
          score = Math.max(score, 0.5);
        }

        if (score > 0) {
          allResults.push({
            kbId,
            docId: page.doc_id || "",
            pageId: page.id,
            title: page.title,
            pageType: page.page_type,
            snippet,
            score,
          });
        }

        if (allResults.length >= topK * 3) break;
      }
      if (allResults.length >= topK * 3) break;
    }

    allResults.sort((a, b) => b.score - a.score);
    const slicedResults = allResults.slice(0, topK);

    // Inject kbName into results
    const involvedKbIds = [...new Set(slicedResults.map(r => r.kbId))];
    const kbNames = new Map<string, string>();
    if (involvedKbIds.length > 0) {
      for (const kbId of involvedKbIds) {
        try {
          const kb = await repos.knowledgeBase.get(kbId);
          kbNames.set(kbId, kb?.name ?? kbId);
        } catch {
          kbNames.set(kbId, kbId);
        }
      }
    }
    const results = slicedResults.map(r => ({ ...r, kbName: kbNames.get(r.kbId) ?? r.kbId }));

    return c.json({ results, totalFound: results.length, kbIds, fallback: true });
  } catch (err) {
    console.error("[Knowledge] Cross-KB search failed:", err);
    return c.json({
      error: "Search failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =====================================================================
// GET /:kbId/search - Search wiki pages in a knowledge base
// =====================================================================

knowledgeRoutes.get("/:kbId/search", async (c) => {
  const kbId = c.req.param("kbId");
  // Accept both "query" and "q" parameter names for flexibility
  const query = decodeURIComponent(c.req.query("query") || c.req.query("q") || "");
  const topK = parseInt(c.req.query("topK") || "10", 10);
  const docIdsParam = c.req.query("docIds");
  const levelsParam = c.req.query("levels"); // e.g. "L0,L1" or "L1"
  const modeParam = c.req.query("mode"); // "semantic" | "vector" | "keyword" | "hybrid"

  if (!query.trim()) {
    return c.json({ error: "query parameter is required (use ?query=... or ?q=...)" }, 400);
  }

  // Check embedding degradation status to include warning in response
  let searchWarning: string | null = null;
  try {
    const { getEmbeddingManager } = await import("../../models/embedding.js");
    const mgr = getEmbeddingManager();
    if (mgr.providerName === "hash-fallback") {
      searchWarning = "Embedding service unavailable — using keyword search only (no semantic matching). Configure an embedding provider for better results.";
    } else if (mgr.isDegraded) {
      // Configured provider temporarily failed → hash-fallback for the
      // cooldown. providerName is still the real provider, so the check
      // above misses it. Warn so the user knows results are degraded.
      searchWarning = `Embedding provider "${mgr.providerName}" temporarily unavailable — search degraded to keyword/hash matching until it recovers. Check the provider in Settings.`;
    }
  } catch { /* embedding not initialized */ }

  // Build docId filter set if provided
  const docIdFilter = docIdsParam
    ? new Set(docIdsParam.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  // Verify KB exists
  const repos = await getRepos();
  const kb = await repos.knowledgeBase.get(kbId);
  if (!kb) {
    return c.json({ error: "Knowledge base not found" }, 404);
  }

  // Resolve requested levels and corresponding page types for filtering
  const requestedLevels = levelsParam
    ? levelsParam.split(",").map((l) => l.trim()).filter((l) => ["L0", "L1", "L2"].includes(l))
    : ["L0", "L1", "L2"];

  try {
    // Primary path: use the Retriever for vector + BM25 fusion search
    try {
      const { getRetriever } = await import("../../services/agent/agent-system.js");
      const retriever = await getRetriever();

      // Use searchByLevels for proper multi-level search with filtering
      const levelResult = await retriever.searchByLevels(query, [kbId], {
        topK,
        levels: requestedLevels,
        mode: modeParam as any,
      });

      // Collect results from requested levels only, flatten with level annotation
      const results: Array<{
        docId: string;
        pageType: string;
        level: string;
        title: string;
        content: string;
        score: number;
        metadata: { pageId: string };
      }> = [];

      for (const level of requestedLevels) {
        const levelKey = level as "L0" | "L1" | "L2";
        const levelResults = levelResult[levelKey] ?? [];
        for (const r of levelResults) {
          results.push({
            docId: r.docId ?? "",
            pageType: (r as any).pageType ?? "",
            level,
            title: r.title,
            content: r.snippet ?? "",
            score: r.score,
            metadata: { pageId: r.pageId },
          });
        }
      }

      // Apply docId filter if provided
      const filteredResults = docIdFilter
        ? results.filter((r) => !r.docId || docIdFilter.has(r.docId))
        : results;

      return c.json({ results: filteredResults, totalFound: filteredResults.length, warning: searchWarning });
    } catch (retrieverErr) {
      // Retriever not initialized — fall back to FTS + LIKE search
      console.warn("[Knowledge] Retriever not available, falling back to DB search:", errorMessage(retrieverErr));
    }

    // Fallback: FTS + LIKE-based search with level filtering
    // Build the set of page types that correspond to requested levels
    const allowedPageTypes = new Set<string>();
    for (const level of requestedLevels) {
      if (level === "L0") allowedPageTypes.add("abstract");
      if (level === "L1") {
        allowedPageTypes.add("structure_md");
        allowedPageTypes.add("structure_dt");
        allowedPageTypes.add("overview");
        allowedPageTypes.add("structure");
      }
      if (level === "L2") allowedPageTypes.add("fulltext");
    }

    // Try FTS search first
    try {
      const ftsResults = await repos.ftsSearch.searchByText(query, [kbId], { topK });
      const results = ftsResults
        .filter((r) => allowedPageTypes.has(r.page_type))
        .map((r) => {
          const normalizedScore = Math.max(0, Math.min(1, 1 / (1 + Math.exp(-r.rank))));
          return {
            docId: r.doc_id ?? "",
            pageType: r.page_type,
            level: PAGE_TYPE_TO_LEVEL[r.page_type] ?? "L1",
            title: r.title,
            content: (r as any).content?.substring(0, 200) ?? "",
            score: normalizedScore,
            metadata: { pageId: r.id },
          };
        });

      // Apply docId filter if provided
      const filteredResults = docIdFilter
        ? results.filter((r) => !r.docId || docIdFilter.has(r.docId))
        : results;

      return c.json({ results: filteredResults, totalFound: filteredResults.length, warning: searchWarning });
    } catch {
      // FTS also failed, final fallback to LIKE
    }

    // Final fallback: LIKE-based search with level filtering
    const allPages = await repos.wikiPage.getByKbAndType(kbId);
    const lowerQuery = query.toLowerCase();
    const results: Array<{
      docId: string;
      pageType: string;
      level: string;
      title: string;
      content: string;
      score: number;
      metadata: { pageId: string };
    }> = [];

    for (const page of allPages) {
      // Filter by requested levels
      if (!allowedPageTypes.has(page.page_type)) continue;

      const title = page.title ?? "";
      const content = page.content ?? "";
      let score = 0;
      let snippet = "";

      if (title.toLowerCase().includes(lowerQuery)) {
        score = 0.8;
        snippet = title;
      } else if (content.toLowerCase().includes(lowerQuery)) {
        score = 0.5;
        const idx = content.toLowerCase().indexOf(lowerQuery);
        const start = Math.max(0, idx - 50);
        const end = Math.min(content.length, idx + query.length + 100);
        snippet = content.substring(start, end);
        if (start > 0) snippet = "..." + snippet;
        if (end < content.length) snippet = snippet + "...";
      }

      if (score > 0) {
        results.push({
          docId: page.doc_id ?? "",
          pageType: page.page_type,
          level: PAGE_TYPE_TO_LEVEL[page.page_type] ?? "L1",
          title,
          content: snippet,
          score,
          metadata: { pageId: page.id },
        });
      }

      if (results.length >= topK) break;
    }

    // Apply docId filter if provided
    const filteredResults = docIdFilter
      ? results.filter((r) => !r.docId || docIdFilter.has(r.docId))
      : results;

    return c.json({ results: filteredResults, totalFound: filteredResults.length, warning: searchWarning });
  } catch (err) {
    console.error("[Knowledge] Search failed:", err);
    return c.json({
      error: "Search failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =====================================================================
// GET /:kbId/wiki/* - Browse wiki pages
// =====================================================================

knowledgeRoutes.get("/:kbId/wiki/*", async (c) => {
  const kbId = c.req.param("kbId");
  // Extract the page path after /:kbId/wiki/
  const fullPath = c.req.path;
  const wikiPrefix = `/api/knowledge/${kbId}/wiki/`;
  const pagePath = fullPath.startsWith(wikiPrefix)
    ? fullPath.substring(wikiPrefix.length)
    : "";

  const repos = await getRepos();

  if (!pagePath) {
    // List all pages in the KB
    const pages = await repos.wikiPage.getByKbAndType(kbId);
    return c.json({ pages });
  }

  try {
    // Try to find page by ID first
    let page = await repos.wikiPage.getById(decodeURIComponent(pagePath));

    if (!page) {
      // Try to find by title containing the page path
      const decodedPath = decodeURIComponent(pagePath);
      const allPages = await repos.wikiPage.getByKbAndType(kbId);
      page = allPages.find((p) => p.title.includes(decodedPath));
    }

    if (!page) {
      return c.json({ error: "Page not found" }, 404);
    }

    const content = page.content;

    // Query links for this page
    let links: Array<{
      sourcePageId: string;
      targetPageId: string;
      linkType: string;
      entityName?: string;
    }> = [];
    try {
      const outgoing = await repos.wikiLink.getOutgoing(page.id);
      const incoming = await repos.wikiLink.getIncoming(page.id);
      links = [
        ...outgoing.map((l) => ({
          sourcePageId: l.sourcePageId,
          targetPageId: l.targetPageId,
          linkType: l.linkType,
          entityName: l.entityName || undefined,
        })),
        ...incoming.map((l) => ({
          sourcePageId: l.sourcePageId,
          targetPageId: l.targetPageId,
          linkType: l.linkType,
          entityName: l.entityName || undefined,
        })),
      ];
    } catch {
      // Linker may fail if wiki_links table doesn't exist yet
    }

    return c.json({
      id: page.id,
      kbId: page.kb_id,
      docId: page.doc_id,
      pageType: page.page_type,
      title: page.title,
      content,
      tokenCount: page.token_count,
      links,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
    });
  } catch (err) {
    return c.json({
      error: "Failed to browse wiki",
      detail: errorMessage(err),
    }, 500);
  }
});

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
    format?: string;
  }>();

  if (!body.docId && !body.pageId) {
    return c.json({ error: "docId or pageId is required" }, 400);
  }

  try {
    const { Expander } = await import("../../wiki/expander.js");
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
        body.format as "md" | "dt" | undefined,
      );
      return c.json({
        content: result.content,
        level: result.level,
        expandable: !!result.childPages && result.childPages.length > 0,
        pageId: result.pageId,
        source: result.source,
      });
    }

    if (body.pageId) {
      const result = await expander.expand(body.pageId);
      return c.json({
        content: result.content,
        level: result.level,
        expandable: !!result.childPages && result.childPages.length > 0,
        pageId: result.pageId,
        source: result.source,
      });
    }

    return c.json({ error: "Invalid parameters" }, 400);
  } catch (err) {
    const msg = errorMessage(err);
    // "No page found" and "Invalid target level" are data-not-found, not server errors
    if (msg.includes("No page found") || msg.includes("Invalid target level")) {
      return c.json({ error: msg }, 404);
    }
    return c.json({ error: "Expand failed", detail: msg }, 500);
  }
});

// =====================================================================
// GET /kbs/:kbId/documents/:docId/download - Download original file
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId/documents/:docId/download", async (c) => {
  const { kbId, docId } = c.req.param();

  const repos = await getRepos();
  const doc = await repos.document.getById(docId);
  if (!doc || doc.kb_id !== kbId) {
    return c.json({ error: "Document not found" }, 404);
  }

  let filePath = doc.file_path;
  // Fallback for pre-migration docs whose file_path may point to a moved location
  try {
    statSync(filePath);
  } catch {
    const dataDir = DEEPANALYZE_CONFIG.dataDir;
    if (doc.folder_path) {
      const newPath = join(dataDir, "original", kbId, doc.folder_path, doc.filename);
      try { statSync(newPath); filePath = newPath; } catch {}
    }
    if (!existsSync(filePath)) {
      const docDir = join(dataDir, "original", kbId, docId);
      try {
        const entries = readdirSync(docDir);
        const firstFile = entries.find((e) => !e.startsWith("."));
        if (firstFile) filePath = join(docDir, firstFile);
      } catch {}
    }
  }
  // Download name includes folder path for context
  const downloadName = doc.folder_path ? `${doc.folder_path}/${doc.filename}` : doc.filename;

  try {
    const buf = readFileSync(filePath);
    return c.body(buf, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDispositionValue("attachment", downloadName),
        "Content-Length": String(buf.length),
      },
    });
  } catch {
    return c.json({ error: "File not found on disk" }, 404);
  }
});

// =====================================================================
// GET /kbs/:kbId/documents/:docId/original - Serve original file with Range request support
// =====================================================================

// Serve original file with Range request support (for audio/video seeking)
knowledgeRoutes.get("/kbs/:kbId/documents/:docId/original", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");
  const repos = await getRepos();
  const doc = await repos.document.getById(docId);
  if (!doc || doc.kb_id !== kbId) {
    return c.json({ error: "Document not found" }, 404);
  }

  // Use doc.file_path (absolute path stored during upload) for reliability
  let filePath = doc.file_path;

  // Fallback: if file_path doesn't exist on disk, try legacy location
  // (pre-migration docs stored at original/{kbId}/{docId}/{filename})
  try {
    statSync(filePath);
  } catch {
    const dataDir = DEEPANALYZE_CONFIG.dataDir;
    // Try new structure: original/{kbId}/{folder_path}/{filename}
    if (doc.folder_path !== undefined && doc.folder_path !== "") {
      const newPath = join(dataDir, "original", kbId, doc.folder_path, doc.filename);
      try {
        statSync(newPath);
        filePath = newPath;
      } catch {
        // Not at new location either, try legacy
      }
    }
    // Try legacy structure: original/{kbId}/{docId}/{filename}
    const docDir = join(dataDir, "original", kbId, docId);
    try {
      const entries = readdirSync(docDir);
      const firstFile = entries.find((e) => !e.startsWith("."));
      if (firstFile) {
        filePath = join(docDir, firstFile);
      }
    } catch {
      // Directory doesn't exist either
    }
  }

  try {
    const stat = statSync(filePath);
    const ext = "." + (filePath.split(".").pop() || "").toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".mp4": "video/mp4", ".avi": "video/x-msvideo", ".mov": "video/quicktime",
      ".mkv": "video/x-matroska", ".webm": "video/webm", ".flv": "video/x-flv",
      ".wmv": "video/x-ms-wmv",
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
      ".aac": "audio/aac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
      ".wma": "audio/x-ms-wma",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";

    // Hono's stream() does not accept headers/status params — use new Response() instead
    const range = c.req.header("range");
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = parseInt(match[1]);
        const end = match[2] ? parseInt(match[2]) : stat.size - 1;
        const chunkSize = end - start + 1;
        const { createReadStream } = await import("node:fs");
        const nodeStream = createReadStream(filePath, { start, end });
        let closed = false;
        const readable = new ReadableStream({
          start(controller) {
            nodeStream.on("data", (chunk: Buffer) => {
              if (closed) return;
              try {
                controller.enqueue(new Uint8Array(chunk));
              } catch {
                // Controller already closed (client disconnected) — stop the stream
                closed = true;
                nodeStream.destroy();
              }
            });
            nodeStream.on("end", () => {
              if (!closed) {
                try { controller.close(); } catch { /* already closed */ }
              }
            });
            nodeStream.on("error", (err) => {
              if (!closed) {
                try { controller.error(err); } catch { /* already closed */ }
              }
            });
          },
          cancel() {
            closed = true;
            nodeStream.destroy();
          },
        });
        return new Response(readable, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(chunkSize),
            "Content-Type": contentType,
          },
        });
      }
    }

    // Full file response (no range) — use streaming to avoid loading large files into memory
    const { createReadStream: createReadStreamFull } = await import("node:fs");
    const fullStream = createReadStreamFull(filePath);
    let fullClosed = false;
    const fullReadable = new ReadableStream({
      start(controller) {
        fullStream.on("data", (chunk: Buffer) => {
          if (fullClosed) return;
          try {
            controller.enqueue(new Uint8Array(chunk));
          } catch {
            fullClosed = true;
            fullStream.destroy();
          }
        });
        fullStream.on("end", () => {
          if (!fullClosed) {
            try { controller.close(); } catch { /* already closed */ }
          }
        });
        fullStream.on("error", (err) => {
          if (!fullClosed) {
            try { controller.error(err); } catch { /* already closed */ }
          }
        });
      },
      cancel() {
        fullClosed = true;
        fullStream.destroy();
      },
    });
    return new Response(fullReadable, {
      status: 200,
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      },
    });
  } catch {
    return c.json({ error: "File not found on disk" }, 404);
  }
});

// =====================================================================
// GET /kbs/:kbId/documents/:docId/thumbnail - Serve image thumbnail
// =====================================================================

// Serve image thumbnail (falls back to original file if no thumbnail generated)
knowledgeRoutes.get("/kbs/:kbId/documents/:docId/thumbnail", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");

  const dataDir = DEEPANALYZE_CONFIG.dataDir;
  const thumbPath = join(dataDir, "wiki", kbId, "documents", docId, "thumb.webp");

  try {
    statSync(thumbPath);
    const thumbBuf = readFileSync(thumbPath);
    return c.body(thumbBuf, {
      headers: { "Content-Type": "image/webp" },
    });
  } catch {
    // No thumbnail — try serving the original file directly
    try {
      const repos = await getRepos();
      const doc = await repos.document.getById(docId);
      if (doc && doc.file_path) {
        const origBuf = readFileSync(doc.file_path);
        const ext = "." + (doc.file_path.split(".").pop() || "").toLowerCase();
        const mimeMap: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
          ".svg": "image/svg+xml",
        };
        const contentType = mimeMap[ext] || "application/octet-stream";
        return c.body(origBuf, {
          headers: { "Content-Type": contentType, "Content-Length": String(origBuf.length) },
        });
      }
    } catch {
      // Original file not found either
    }
    return c.json({ error: "Thumbnail not found" }, 404);
  }
});

// =====================================================================
// GET /kbs/:kbId/documents/:docId/frames/:index - Serve video frame thumbnail
// =====================================================================

// Serve video frame thumbnail
knowledgeRoutes.get("/kbs/:kbId/documents/:docId/frames/:index", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");
  const frameIndex = c.req.param("index");

  const dataDir = DEEPANALYZE_CONFIG.dataDir;
  const framePath = join(dataDir, "wiki", kbId, "documents", docId, "frames", `frame_${frameIndex}_thumb.jpg`);

  try {
    statSync(framePath);
    const frameBuf = readFileSync(framePath);
    return c.body(frameBuf, {
      headers: { "Content-Type": "image/jpeg" },
    });
  } catch {
    return c.json({ error: "Frame not found" }, 404);
  }
});

// =====================================================================
// GET /kbs/:kbId/documents/:docId/media-metadata - Media metadata for preview
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId/documents/:docId/media-metadata", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");
  const repos = await getRepos();

  const doc = await repos.document.getById(docId);
  if (!doc || doc.kb_id !== kbId) {
    return c.json({ error: "Document not found" }, 404);
  }

  // Determine file category
  const ext = doc.filename.split(".").pop()?.toLowerCase() ?? "";
  const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"]);
  const VIDEO_EXTS = new Set(["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv"]);
  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "svg"]);

  const result: Record<string, unknown> = { type: null };

  // Read raw JSON from disk (the canonical raw data source)
  const dataDir = DEEPANALYZE_CONFIG.dataDir;
  const rawJsonPath = join(dataDir, "wiki", kbId, "documents", docId, "raw", "docling.json");

  let rawData: Record<string, unknown> | null = null;
  try {
    const rawContent = readFileSync(rawJsonPath, "utf-8");
    rawData = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    // No raw JSON on disk — try reading from fulltext page
    try {
      const rawPage = await repos.wikiPage.getByDocAndType(docId, "fulltext");
      if (rawPage?.content) {
        rawData = JSON.parse(rawPage.content) as Record<string, unknown>;
      }
    } catch {
      // Not JSON either
    }
  }

  if (IMAGE_EXTS.has(ext)) {
    result.type = "image";
    if (rawData) {
      result.image = {
        width: rawData.width ?? rawData.imageWidth ?? 0,
        height: rawData.height ?? rawData.imageHeight ?? 0,
        description: rawData.description ?? rawData.vlmDescription ?? "",
        exif: rawData.exif ?? {},
      };
    } else {
      result.image = { width: 0, height: 0 };
    }
  } else if (AUDIO_EXTS.has(ext)) {
    result.type = "audio";
    if (rawData) {
      // rawData.speakers can be string[] or {id,label,totalDuration}[] depending on modality
      const rawSpeakers = rawData.speakers as Array<Record<string, unknown>> ?? [];
      const speakers = rawSpeakers.map((s) =>
        typeof s === "string" ? s : (s.label as string ?? s.id as string ?? String(s)),
      );
      const turns = (rawData.turns as Array<Record<string, unknown>>) ?? [];
      result.audio = {
        duration: rawData.duration ?? 0,
        speakers,
        turns: turns.map((t) => ({
          speaker: (t as Record<string, unknown>).speaker as string ?? "",
          text: (t as Record<string, unknown>).text as string ?? "",
          start: ((t as Record<string, unknown>).startTime ?? (t as Record<string, unknown>).start) as number | undefined,
          end: ((t as Record<string, unknown>).endTime ?? (t as Record<string, unknown>).end) as number | undefined,
        })),
      };
    } else {
      result.audio = { duration: 0, speakers: [], turns: [] };
    }
  } else if (VIDEO_EXTS.has(ext)) {
    result.type = "video";
    if (rawData) {
      const scenes = (rawData.scenes as Array<Record<string, unknown>>) ?? [];
      const transcript = rawData.transcript as Record<string, unknown> | undefined;
      // Handle both string[] and {id,label}[] speaker formats
      const rawSpeakers = (transcript?.speakers ?? rawData.speakers) as Array<Record<string, unknown>> ?? [];
      const speakers = rawSpeakers.map((s) =>
        typeof s === "string" ? s : (s.label as string ?? s.id as string ?? String(s)),
      );
      const turns = ((transcript?.turns ?? rawData.turns) as Array<Record<string, unknown>>) ?? [];

      // Count available frames
      const framesDir = join(dataDir, "wiki", kbId, "documents", docId, "frames");
      let frameCount = 0;
      try {
        const { readdirSync } = await import("node:fs");
        const entries = readdirSync(framesDir);
        frameCount = entries.filter((e) => e.includes("_thumb.jpg")).length;
      } catch { /* no frames */ }

      result.video = {
        duration: rawData.duration ?? 0,
        scenes: scenes.map((s) => ({
          start: (s as Record<string, unknown>).startTime ?? (s as Record<string, unknown>).start as number ?? 0,
          end: (s as Record<string, unknown>).endTime ?? (s as Record<string, unknown>).end as number ?? 0,
          description: (s as Record<string, unknown>).description as string | undefined,
        })),
        transcript: {
          speakers,
          turns: turns.map((t) => ({
            speaker: (t as Record<string, unknown>).speaker as string ?? "",
            text: (t as Record<string, unknown>).text as string ?? "",
            start: ((t as Record<string, unknown>).startTime ?? (t as Record<string, unknown>).start) as number | undefined,
            end: ((t as Record<string, unknown>).endTime ?? (t as Record<string, unknown>).end) as number | undefined,
          })),
        },
        frameCount,
      };
    } else {
      result.video = { duration: 0, scenes: [], transcript: { speakers: [], turns: [] }, frameCount: 0 };
    }
  }

  return c.json(result);
});

// =====================================================================
// GET /kbs/:kbId/documents/:docId/export/:format - Multi-format export
// format: "raw-json" | "doctags" | "markdown" | "structure-bundle"
// =====================================================================

knowledgeRoutes.get("/kbs/:kbId/documents/:docId/export/:format", async (c) => {
  const { kbId, docId, format } = c.req.param();

  try {
    const repos = await getRepos();

    switch (format) {
      case "raw-json": {
        const rawPath = join(DEEPANALYZE_CONFIG.dataDir, "wiki", kbId, "documents", docId, "raw", "docling.json");
        try {
          const content = readFileSync(rawPath, "utf-8");
          return new Response(content, {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": `attachment; filename="${docId}_raw.json"`,
            },
          });
        } catch {
          return c.json({ error: "Raw JSON not found" }, 404);
        }
      }

      case "doctags": {
        const pages = await repos.wikiPage.getManyByDocAndType(docId, "structure_dt");
        if (pages.length === 0) return c.json({ error: "No structure pages found" }, 404);
        const doctags = pages.map((p) => `# ${p.title}\n\n${p.content}`).join("\n\n---\n\n");
        return new Response(doctags, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${docId}_doctags.txt"`,
          },
        });
      }

      case "markdown": {
        const pages = await repos.wikiPage.getManyByDocAndType(docId, "structure_md");
        if (pages.length === 0) return c.json({ error: "No structure pages found" }, 404);
        const md = pages.map((p) => `## ${p.title}\n\n${p.content}`).join("\n\n");
        return new Response(md, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${docId}.md"`,
          },
        });
      }

      case "structure-bundle": {
        const pages = await repos.wikiPage.getManyByDocAndTypePrefix(docId, "structure");
        const anchors = await repos.anchor.getByDocId(docId);
        const manifest = JSON.stringify({
          docId,
          kbId,
          pages: pages.map((p) => ({
            id: p.id,
            title: p.title,
            pageType: p.page_type,
            metadata: p.metadata,
          })),
          anchors: anchors.map((a) => ({
            id: a.id,
            type: a.element_type,
            sectionTitle: a.section_title,
            pageNumber: a.page_number,
          })),
        }, null, 2);
        return new Response(manifest, {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${docId}_structure_manifest.json"`,
          },
        });
      }

      default:
        return c.json({ error: `Invalid format: ${format}. Use raw-json, doctags, markdown, or structure-bundle.` }, 400);
    }
  } catch (err) {
    return c.json({
      error: "Export failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =============================================================================
// POST /kbs/:kbId/reindex - Reindex all documents in a knowledge base
// Triggered when embedding model dimension changes to rebuild stale embeddings.
// =============================================================================

knowledgeRoutes.post("/kbs/:kbId/reindex", async (c) => {
  const kbId = c.req.param("kbId");

  try {
    const repos = await getRepos();
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    const docs = await repos.document.getByKbId(kbId);
    const queue = getProcessingQueue();
    let enqueued = 0;

    for (const doc of docs) {
      if (doc.status === "ready") {
        queue.enqueue({
          kbId,
          docId: doc.id,
          filename: doc.filename,
          filePath: doc.file_path,
          fileType: doc.file_type,
        });
        enqueued++;
      }
    }

    return c.json({
      message: `Reindex triggered for ${enqueued} documents in knowledge base ${kbId}`,
      enqueued,
      total: docs.length,
    });
  } catch (err) {
    return c.json({
      error: "Reindex failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =============================================================================
// POST /kbs/:kbId/rebuild-embeddings - Rebuild embeddings only (no recompilation)
// Use this when the embedding provider changes or embeddings are missing.
// =============================================================================

knowledgeRoutes.post("/kbs/:kbId/rebuild-embeddings", async (c) => {
  const kbId = c.req.param("kbId");

  try {
    const repos = await getRepos();
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    const { ModelRouter } = await import("../../models/router.js");
    const { EmbeddingManager } = await import("../../models/embedding.js");
    const { Indexer } = await import("../../wiki/indexer.js");

    const router = new ModelRouter();
    await router.initialize();
    const embeddingManager = new EmbeddingManager(router);
    await embeddingManager.initialize();
    const indexer = new Indexer(embeddingManager);

    // Re-index all pages in the KB (embeddings + FTS) without recompilation
    await indexer.indexKb(kbId);

    return c.json({
      kbId,
      status: "completed",
      provider: embeddingManager.providerName,
      dimension: embeddingManager.dimension,
      message: `Embeddings rebuilt using provider "${embeddingManager.providerName}" (${embeddingManager.dimension}d)`,
    });
  } catch (err) {
    console.error(`[Knowledge] Rebuild embeddings failed for KB ${kbId}:`, err);
    return c.json({
      error: "Rebuild embeddings failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =============================================================================
// GET /embedding-status - Check embedding system health
// =============================================================================

knowledgeRoutes.get("/embedding-status", async (c) => {
  try {
    const { getEmbeddingManager } = await import("../../models/embedding.js");
    const mgr = getEmbeddingManager();
    const staleCount = await mgr.getStaleCount();

    const isDegraded = mgr.providerName === "hash-fallback" || mgr.isDegraded;

    return c.json({
      provider: mgr.providerName,
      dimension: mgr.dimension,
      isDegraded,
      staleEmbeddings: staleCount,
      warning: isDegraded
        ? "Embedding service is using hash fallback. Semantic search is unavailable. Configure a real embedding provider in Settings."
        : staleCount > 0
          ? `${staleCount} stale embeddings detected. Use rebuild-embeddings to regenerate.`
          : null,
    });
  } catch {
    return c.json({
      provider: "uninitialized",
      dimension: 0,
      isDegraded: true,
      staleEmbeddings: 0,
      warning: "Embedding system not initialized.",
    });
  }
});

// =============================================================================
// POST /kbs/:kbId/documents/:docId/quality-audit - Manual quality audit trigger
// Query params: ?force=true&reExtract=true
// =============================================================================

knowledgeRoutes.post("/kbs/:kbId/documents/:docId/quality-audit", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");
  const force = c.req.query("force") === "true";
  const reExtract = c.req.query("reExtract") === "true";

  try {
    const repos = await getRepos();

    // Verify document exists and belongs to this KB
    const doc = await repos.document.getById(docId);
    if (!doc || doc.kb_id !== kbId) {
      return c.json({ error: "Document not found" }, 404);
    }

    const modality = (doc.metadata as Record<string, unknown>)?.modality as string | undefined;
    const fileType = doc.file_type;

    // Infer modality if not stored
    const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp", "svg"]);
    const AUDIO_TYPES = new Set(["mp3", "wav", "flac", "m4a", "aac", "ogg"]);
    const VIDEO_TYPES = new Set(["mp4", "avi", "mov", "mkv", "webm"]);
    const inferredModality = modality ?? (
      IMAGE_TYPES.has(fileType) ? "image"
      : AUDIO_TYPES.has(fileType) ? "audio"
      : VIDEO_TYPES.has(fileType) ? "video"
      : "document"
    );

    const { QualityAuditor } = await import("../../services/document-processors/quality-auditor.js");
    const auditor = new QualityAuditor();
    const result = await auditor.audit({
      kbId,
      docId,
      fileType,
      filePath: doc.file_path,
      modality: inferredModality,
      force,
      reExtract,
    });

    return c.json({
      docId,
      kbId,
      modality: inferredModality,
      ...result,
    });
  } catch (err) {
    return c.json({
      error: "Quality audit failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =============================================================================
// GET /kbs/:kbId/quality-report - Quality report for all documents in a KB
// =============================================================================

knowledgeRoutes.get("/kbs/:kbId/quality-report", async (c) => {
  const kbId = c.req.param("kbId");

  try {
    const repos = await getRepos();

    // Verify KB exists
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    const docs = await repos.document.getByKbId(kbId);

    const report = docs.map((doc) => {
      const metadata = doc.metadata as Record<string, unknown> | null;
      const audit = metadata?.qualityAudit as Record<string, unknown> | undefined;
      return {
        docId: doc.id,
        filename: doc.filename,
        fileType: doc.file_type,
        status: doc.status,
        modality: (metadata as Record<string, unknown>)?.modality as string | undefined,
        qualityAudit: audit ? {
          score: audit.score,
          issues: audit.issues,
          auditedAt: audit.auditedAt,
          reExtracted: audit.reExtracted,
          modelUsed: audit.modelUsed,
          failedPermanently: audit.failedPermanently,
        } : null,
      };
    });

    // Summary stats
    const audited = report.filter((r) => r.qualityAudit !== null);
    const lowQuality = audited.filter(
      (r) => (r.qualityAudit?.score as number ?? 100) < 50,
    );

    return c.json({
      kbId,
      totalDocuments: docs.length,
      auditedCount: audited.length,
      lowQualityCount: lowQuality.length,
      documents: report,
    });
  } catch (err) {
    return c.json({
      error: "Quality report failed",
      detail: errorMessage(err),
    }, 500);
  }
});

// =============================================================================
// POST /kbs/:kbId/preprocess - Run knowledge base deep preprocessing
// Triggers the "知识库预处理" built-in skill as a background agent task.
// This generates overview documents, restores fragmented tables, audits image
// quality, and detects handwritten annotations.
// =============================================================================

knowledgeRoutes.post("/kbs/:kbId/preprocess", async (c) => {
  const kbId = c.req.param("kbId");

  try {
    const repos = await getRepos();
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    // Check if preprocessing is already running for this KB
    // Use the orchestrator to check for active tasks in preprocessing sessions
    const preprocessSessions = (await repos.session.list()).filter(
      (s) => s.title === `[预处理] ${kb.name}`,
    );
    let preprocessingRunning = false;
    if (preprocessSessions.length > 0) {
      try {
        const { getOrchestrator } = await import("../../services/agent/agent-system.js");
        const orchestrator = await getOrchestrator();
        for (const ps of preprocessSessions) {
          const tasks = await orchestrator.listSessionTasks(ps.id);
          const hasRunning = tasks.some(
            (t) => t.status === "running" || t.status === "pending",
          );
          if (hasRunning) {
            preprocessingRunning = true;
            break;
          }
        }
      } catch {
        // If orchestrator isn't available, assume not running
      }
    }
    if (preprocessingRunning) {
      return c.json({ error: "该知识库已有预处理任务正在运行" }, 409);
    }

    // Create a temporary session for the preprocessing task
    const session = await repos.session.create(
      `[预处理] ${kb.name}`,
      { kbId },
    );

    // Get the preprocessing skill prompt and tools
    const { getKBPreprocessingPrompt } = await import(
      "../../services/agent/builtin-skills.js"
    );
    const systemPrompt = getKBPreprocessingPrompt();
    const toolsOverride = [
      "kb_search", "wiki_browse", "expand", "doc_grep",
      "read_file", "write_file", "glob", "grep",
      "bash", "run_sql", "workflow_run",
      "push_content",
      "agent_todo", "think", "finish",
    ];

    // Save a user message to the session
    await repos.message.create(
      session.id,
      "user",
      `[预处理] 请对知识库 ${kb.name} (${kbId}) 执行全量深度预处理。`,
    );

    // Run the agent in the background (non-blocking)
    const { getOrchestrator } = await import(
      "../../services/agent/agent-system.js"
    );
    const { agentAsyncContext } = await import(
      "../../services/agent/tool-registry.js"
    );
    const orchestrator = await getOrchestrator();

    // Create an isolated context for preprocessing via AsyncLocalStorage.
    // No save/restore needed — ALS automatically scopes the context to this async chain.
    const preprocessContext: Record<string, unknown> = {
      sessionId: session.id,
      parentMessages: [],
      isPreprocessingSession: true,
    };

    // Fire-and-forget: run in background inside ALS scope
    const runPromise = agentAsyncContext.run(preprocessContext, async () => {
      return await orchestrator.runSingle({
        input: `请对当前知识库执行全量深度预处理，生成全局概览文档、还原多页表格、校验图片VLM内容质量、检测手写批注。知识库名称: ${kb.name}`,
        agentType: "general",
        sessionId: session.id,
        systemPromptOverride: systemPrompt,
        toolsOverride,
        kbId,
        isSkillInvocation: true,
      });
    });

    // Don't await — let it run in background, but save the assistant message when done
    runPromise.then(async (result) => {
      try {
        await repos.message.create(
          session.id,
          "assistant",
          result.output || "(预处理完成)",
        );
        // Update last_preprocessed_at timestamp on the knowledge base
        await repos.knowledgeBase.update(kbId, { lastPreprocessedAt: new Date() });
        console.log(`[Preprocessing] Completed for KB ${kbId}, assistant message saved`);
      } catch (err) {
        console.error(`[Preprocessing] Failed to save assistant message:`, err);
      }
      // No context restore needed — ALS scope ends automatically
    }).catch((err) => {
      console.error(
        `[Preprocessing] Background task failed for KB ${kbId}:`,
        errorMessage(err),
      );
      // No context restore needed — ALS scope ends automatically
    });

    return c.json({
      message: `预处理已启动，知识库: ${kb.name}`,
      sessionId: session.id,
      kbId,
    });
  } catch (err) {
    return c.json({
      error: "启动预处理失败",
      detail: errorMessage(err),
    }, 500);
  }
});

// =============================================================================
// GET /kbs/:kbId/preprocess/status - Check preprocessing status
// =============================================================================

knowledgeRoutes.get("/kbs/:kbId/preprocess/status", async (c) => {
  const kbId = c.req.param("kbId");

  try {
    const repos = await getRepos();
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    const preprocessSessions = (await repos.session.list()).filter(
      (s) => s.title === `[预处理] ${kb.name}`,
    );

    let running = false;
    let sessionId: string | undefined;
    let startedAt: string | undefined;

    if (preprocessSessions.length > 0) {
      try {
        const { getOrchestrator } = await import("../../services/agent/agent-system.js");
        const orchestrator = await getOrchestrator();
        for (const ps of preprocessSessions) {
          const tasks = await orchestrator.listSessionTasks(ps.id);
          const activeTask = tasks.find(
            (t) => t.status === "running" || t.status === "pending",
          );
          if (activeTask) {
            running = true;
            sessionId = ps.id;
            startedAt = activeTask.createdAt || undefined;
            break;
          }
        }
      } catch {
        // Orchestrator not available — assume not running
      }
    }

    return c.json({
      running,
      sessionId,
      startedAt,
      lastPreprocessedAt: kb.lastPreprocessedAt || undefined,
    });
  } catch (err) {
    return c.json({
      error: "Failed to get preprocessing status",
      detail: errorMessage(err),
    }, 500);
  }
});

// =============================================================================
// POST /kbs/:kbId/preprocess/cancel - Cancel running preprocessing
// =============================================================================

knowledgeRoutes.post("/kbs/:kbId/preprocess/cancel", async (c) => {
  const kbId = c.req.param("kbId");

  try {
    const repos = await getRepos();
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    const preprocessSessions = (await repos.session.list()).filter(
      (s) => s.title === `[预处理] ${kb.name}`,
    );

    let cancelled = false;
    for (const ps of preprocessSessions) {
      try {
        const { getOrchestrator } = await import("../../services/agent/agent-system.js");
        const orchestrator = await getOrchestrator();
        const tasks = await orchestrator.listSessionTasks(ps.id);
        for (const task of tasks) {
          if (task.status === "running" || task.status === "pending") {
            orchestrator.cancel(task.id);
            cancelled = true;
          }
        }
      } catch {
        // Continue trying other sessions
      }
    }

    return c.json({
      cancelled,
      message: cancelled ? "预处理任务已取消" : "没有正在运行的预处理任务",
    });
  } catch (err) {
    return c.json({
      error: "取消预处理失败",
      detail: errorMessage(err),
    }, 500);
  }
});
