// =============================================================================
// DeepAnalyze - Report, Timeline, and Graph API Routes
// =============================================================================
// Hono routes for report management, timeline extraction, knowledge graph
// visualization, and pushed content grouping. Uses PG repos for all data
// access and direct SQL for complex queries.
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";
import { DisplayResolver } from "../../services/display-resolver.js";
import { getPool } from "../../store/pg.js";

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create report API routes.
 *
 * Routes (CRUD via report store):
 *   GET    /reports                    - List all reports (paginated)
 *   GET    /reports/:id               - Get single report with references
 *   DELETE /reports/:id               - Delete a report
 *   GET    /reports/:id/export        - Export report as Markdown
 *   GET    /sessions/:sessionId/reports - List reports by session
 *
 * Routes (legacy wiki-based):
 *   GET  /reports/kb/:kbId            - List all reports for a knowledge base
 *   GET  /report/:reportId            - Get full report content (wiki page)
 *   GET  /pushed-by-kb                - Get pushed content grouped by knowledge base
 *   GET  /timeline/:kbId              - Get timeline data for a knowledge base
 *   GET  /graph/:kbId                 - Get graph data for a knowledge base
 */
export function createReportRoutes(): Hono {
  const router = new Hono();

  // =====================================================================
  // GET / - Report API root (API discoverability)
  // =====================================================================

  router.get("/", (c) => {
    return c.json({
      status: "ok",
      message: "Reports API",
      endpoints: [
        "GET    /reports",
        "GET    /reports/:id",
        "DELETE /reports/:id",
        "GET    /reports/:id/export",
        "GET    /sessions/:sessionId/reports",
        "GET    /reports/kb/:kbId",
        "GET    /report/:reportId",
        "GET    /pushed-by-kb",
        "GET    /timeline/:kbId",
        "GET    /graph/:kbId",
      ],
    });
  });

  // =====================================================================
  // GET /reports - List all reports (paginated)
  // =====================================================================

  router.get("/reports", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const repos = await getRepos();
    const pages = await repos.wikiPage.getAllByType("report", limit, offset);

    const reports = pages.map((page) => ({
      id: page.id,
      kbId: page.kb_id,
      title: page.title,
      tokenCount: page.token_count,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
    }));

    return c.json({
      reports,
      pagination: {
        limit,
        offset,
        count: reports.length,
      },
    });
  });

  // =====================================================================
  // GET /reports/:id - Get single report with references
  // =====================================================================
  // NOTE: This route must come after any static /reports/* paths (like
  // /reports/kb/:kbId below) to avoid the :id parameter matching "kb".

  router.get("/reports/kb/:kbId", async (c) => {
    const kbId = c.req.param("kbId");
    const sessionId = c.req.query("sessionId");
    const repos = await getRepos();

    // Verify the knowledge base exists
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    const pages = sessionId
      ? await repos.wikiPage.getByKbTypeAndSession(kbId, "report", sessionId)
      : await repos.wikiPage.getByKbAndType(kbId, "report");

    const reports = pages.map((page) => ({
      id: page.id,
      title: page.title,
      tokenCount: page.token_count,
      sessionId: page.session_id ?? null,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
    }));

    return c.json({ kbId, reports, sessionId: sessionId || null });
  });

  router.get("/reports/:id", async (c) => {
    const id = c.req.param("id");

    const repos = await getRepos();
    const page = await repos.wikiPage.getById(id);
    if (!page || page.page_type !== "report") {
      return c.json({ error: "Report not found" }, 404);
    }

    return c.json({
      id: page.id,
      kbId: page.kb_id,
      title: page.title,
      content: page.content,
      tokenCount: page.token_count,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
    });
  });

  // =====================================================================
  // DELETE /reports/:id - Delete a report
  // =====================================================================

  router.delete("/reports/:id", async (c) => {
    const id = c.req.param("id");

    const repos = await getRepos();
    const page = await repos.wikiPage.getById(id);
    if (!page || page.page_type !== "report") {
      return c.json({ error: "Report not found" }, 404);
    }

    await repos.wikiPage.deleteById(id);
    return c.json({ success: true, id });
  });

  // =====================================================================
  // GET /reports/:id/export - Export report as Markdown
  // =====================================================================

  router.get("/reports/:id/export", async (c) => {
    const id = c.req.param("id");

    const repos = await getRepos();
    const page = await repos.wikiPage.getById(id);
    if (!page || page.page_type !== "report") {
      return c.json({ error: "Report not found" }, 404);
    }

    // Build a Markdown document from the wiki page content
    let md = `# ${page.title}\n\n`;
    md += page.content;
    md += "\n";

    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="report-${id}.md"`,
    );
    return c.body(md);
  });

  // =====================================================================
  // GET /sessions/:sessionId/reports - List reports by session
  // =====================================================================

  router.get("/sessions/:sessionId/reports", async (c) => {
    const sessionId = c.req.param("sessionId");

    const repos = await getRepos();
    // Find report IDs from message metadata in this session
    const messages = await repos.message.list(sessionId);
    const reportIds: string[] = [];
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.metadata) {
        try {
          const meta = typeof msg.metadata === "string" ? JSON.parse(msg.metadata) : msg.metadata;
          if (meta?.reportId) reportIds.push(meta.reportId);
        } catch { /* ignore parse errors */ }
      }
    }

    const reports = [];
    for (const reportId of reportIds) {
      const page = await repos.wikiPage.getById(reportId);
      if (page && page.page_type === "report") {
        reports.push({
          id: page.id,
          kbId: page.kb_id,
          title: page.title,
          tokenCount: page.token_count,
          createdAt: page.created_at,
          updatedAt: page.updated_at,
        });
      }
    }

    return c.json({
      sessionId,
      reports,
      totalCount: reports.length,
    });
  });

  // (Moved to /reports/kb/:kbId above to avoid route conflicts with /reports/:id)

  // =====================================================================
  // GET /report/:reportId - Get full report content
  // =====================================================================

  router.get("/report/:reportId", async (c) => {
    const reportId = c.req.param("reportId");

    const repos = await getRepos();
    const page = await repos.wikiPage.getById(reportId);
    if (!page) {
      return c.json({ error: "Report not found" }, 404);
    }

    if (page.page_type !== "report") {
      return c.json({ error: "Page is not a report" }, 400);
    }

    return c.json({
      id: page.id,
      kbId: page.kb_id,
      title: page.title,
      content: page.content,
      tokenCount: page.token_count,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
    });
  });

  // =====================================================================
  // GET /pushed-by-kb - Get pushed content grouped by knowledge base
  // =====================================================================

  router.get("/pushed-by-kb", async (c) => {
    const filterKbId = c.req.query("kbId");
    const pool = await getPool();

    // Query all assistant messages with pushedContents in their metadata
    const { rows } = await pool.query(
      `SELECT s.id as session_id, s.title as session_title, s.kb_scope,
              m.id as message_id, m.metadata->'pushedContents' as pushed_contents,
              m.created_at
       FROM sessions s
       JOIN messages m ON m.session_id = s.id
       WHERE m.metadata ? 'pushedContents'
         AND m.role = 'assistant'
         AND jsonb_array_length(m.metadata->'pushedContents') > 0
       ORDER BY m.created_at DESC`,
    );

    // Collect all unique kbIds for name lookup
    const kbNameMap = new Map<string, string>();
    const allKbIds = new Set<string>();

    // First pass: extract kbIds from kb_scope of each session
    for (const row of rows) {
      const kbScope = row.kb_scope;
      if (kbScope) {
        try {
          const scope = typeof kbScope === "string" ? JSON.parse(kbScope) : kbScope;
          // New format: { "knowledgeBases": [{ "kbId": "..." }] }
          if (scope?.knowledgeBases && Array.isArray(scope.knowledgeBases)) {
            for (const kb of scope.knowledgeBases) {
              if (kb.kbId) allKbIds.add(kb.kbId);
            }
          }
          // Legacy format: { "kbIds": ["..."] }
          if (scope?.kbIds && Array.isArray(scope.kbIds)) {
            for (const kbId of scope.kbIds) {
              allKbIds.add(kbId);
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // If filtering by kbId, only look up that one
    if (filterKbId) {
      allKbIds.clear();
      allKbIds.add(filterKbId);
    }

    // Look up KB names
    if (allKbIds.size > 0) {
      const repos = await getRepos();
      for (const kbId of allKbIds) {
        try {
          const kb = await repos.knowledgeBase.get(kbId);
          kbNameMap.set(kbId, kb?.name ?? kbId);
        } catch {
          kbNameMap.set(kbId, kbId);
        }
      }
    }

    // Build grouped results
    const groupMap = new Map<string, {
      kbId: string;
      kbName: string;
      items: Array<{
        sessionId: string;
        sessionTitle: string;
        messageId: string;
        pushedContent: { type: string; title: string; dataLength?: number; format?: string; timestamp?: string };
        createdAt: string;
      }>;
    }>();

    // Helper to get or create a group
    function getGroup(kbId: string, kbName: string) {
      if (!groupMap.has(kbId)) {
        groupMap.set(kbId, { kbId, kbName, items: [] });
      }
      return groupMap.get(kbId)!;
    }

    // Process each row
    for (const row of rows) {
      const sessionId = row.session_id;
      const sessionTitle = row.session_title || "无标题";
      const messageId = row.message_id;
      const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);

      // Parse pushed contents
      let pushedContents: any[] = [];
      try {
        pushedContents = typeof row.pushed_contents === "string"
          ? JSON.parse(row.pushed_contents)
          : Array.isArray(row.pushed_contents) ? row.pushed_contents : [];
      } catch { continue; }

      // Extract kbIds from session's kb_scope
      const sessionKbIds: string[] = [];
      const kbScope = row.kb_scope;
      if (kbScope) {
        try {
          const scope = typeof kbScope === "string" ? JSON.parse(kbScope) : kbScope;
          if (scope?.knowledgeBases && Array.isArray(scope.knowledgeBases)) {
            for (const kb of scope.knowledgeBases) {
              if (kb.kbId) sessionKbIds.push(kb.kbId);
            }
          }
          if (scope?.kbIds && Array.isArray(scope.kbIds)) {
            for (const kbId of scope.kbIds) {
              sessionKbIds.push(kbId);
            }
          }
        } catch { /* ignore */ }
      }

      for (const pc of pushedContents) {
        const item = {
          sessionId,
          sessionTitle,
          messageId,
          pushedContent: {
            type: pc.type || "unknown",
            title: pc.title || "无标题",
            dataLength: typeof pc.data === "string" ? pc.data.length : undefined,
            format: pc.format,
            timestamp: pc.timestamp,
          },
          createdAt,
        };

        if (sessionKbIds.length > 0) {
          // Add item under each associated KB
          for (const kbId of sessionKbIds) {
            // If filtering, skip non-matching KBs
            if (filterKbId && kbId !== filterKbId) continue;
            const group = getGroup(kbId, kbNameMap.get(kbId) ?? kbId);
            group.items.push(item);
          }
        } else {
          // No KB associated - put in "未关联知识库" group
          if (!filterKbId) {
            const group = getGroup("__none__", "未关联知识库");
            group.items.push(item);
          }
        }
      }
    }

    // Sort groups: matching kbId first (if filtering), then alphabetically
    const groups = Array.from(groupMap.values());

    return c.json({ groups });
  });

  // =====================================================================
  // GET /timeline/:kbId - Get timeline data for a knowledge base
  // =====================================================================

  router.get("/timeline/:kbId", async (c) => {
    const kbId = c.req.param("kbId");
    const query = c.req.query("query") || "";
    const maxEvents = parseInt(c.req.query("maxEvents") || "50", 10);

    const repos = await getRepos();

    // Verify the knowledge base exists
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    // Get pages to extract dates from.
    // If a query is provided, do a simple search on titles and content.
    // Otherwise, use all pages in the KB.
    const pages = await repos.wikiPage.getByKbAndType(kbId);

    // Filter pages by query if provided
    const targetPages = query
      ? pages.filter((page) => {
          const titleMatch = page.title.toLowerCase().includes(query.toLowerCase());
          if (titleMatch) return true;
          return page.content.toLowerCase().includes(query.toLowerCase());
        })
      : pages;

    // Extract date-referenced events from page content
    const events: TimelineEventResponse[] = [];

    for (const page of targetPages) {
      const content = page.content;
      if (!content) continue;

      const rawEvents = extractDateEvents(content, page.id, page.title);

      for (const raw of rawEvents) {
        events.push({
          date: raw.date,
          title: generateEventTitle(raw.description),
          description: raw.description,
          sourcePageId: raw.sourcePageId,
          sourceTitle: raw.sourceTitle,
        });

        if (events.length >= maxEvents) break;
      }

      if (events.length >= maxEvents) break;
    }

    // Sort chronologically by date string
    events.sort((a, b) => a.date.localeCompare(b.date));

    return c.json({
      kbId,
      events,
      totalCount: events.length,
    });
  });

  // =====================================================================
  // GET /graph/:kbId - Get graph data for a knowledge base
  // =====================================================================

  router.get("/graph/:kbId", async (c) => {
    const kbId = c.req.param("kbId");
    const query = c.req.query("query") || "";
    const maxNodes = parseInt(c.req.query("maxNodes") || "100", 10);

    const repos = await getRepos();

    // Verify the knowledge base exists
    const kb = await repos.knowledgeBase.get(kbId);
    if (!kb) {
      return c.json({ error: "Knowledge base not found" }, 404);
    }

    const nodeMap = new Map<string, GraphNodeResponse>();
    const edgeList: GraphEdgeResponse[] = [];
    const edgeSet = new Set<string>();

    // Helper to add a node
    function addNode(page: { id: string; title: string; page_type: string; kb_id: string }): void {
      if (!nodeMap.has(page.id)) {
        nodeMap.set(page.id, {
          id: page.id,
          label: page.title,
          type: mapPageTypeToNodeType(page.page_type),
          group: page.kb_id,
        });
      }
    }

    // Helper to add a deduplicated edge
    function addEdge(source: string, target: string, linkType: string, label?: string): void {
      const key = `${source}->${target}->${linkType}`;
      if (!edgeSet.has(key) && source !== target) {
        edgeSet.add(key);
        edgeList.push({
          source,
          target,
          label: label || linkType,
          type: linkType,
        });
      }
    }

    // Get pages for the KB
    let pages = await repos.wikiPage.getByKbAndType(kbId);

    // Filter by query if provided
    if (query) {
      const q = query.toLowerCase();
      pages = pages.filter((page) => {
        if (page.title.toLowerCase().includes(q)) return true;
        return page.content.toLowerCase().includes(q);
      });
    }

    // Add all matching pages as nodes
    for (const page of pages) {
      addNode(page);
      if (nodeMap.size >= maxNodes) break;
    }

    // Query wiki_links for edges
    const pageIds = Array.from(nodeMap.keys());
    if (pageIds.length > 0) {
      // Outgoing links from our pages
      for (const pageId of pageIds) {
        const outgoing = await repos.wikiLink.getOutgoing(pageId);
        for (const link of outgoing) {
          const targetPage = await repos.wikiPage.getById(link.targetPageId);
          if (!targetPage) continue;

          addNode(targetPage);
          addEdge(
            link.sourcePageId,
            link.targetPageId,
            link.linkType,
            link.entityName || undefined,
          );

          if (nodeMap.size >= maxNodes) break;
        }
        if (nodeMap.size >= maxNodes) break;
      }

      // Incoming links to our pages
      for (const pageId of pageIds) {
        const incoming = await repos.wikiLink.getIncoming(pageId);
        for (const link of incoming) {
          const sourcePage = await repos.wikiPage.getById(link.sourcePageId);
          if (!sourcePage) continue;

          addNode(sourcePage);
          addEdge(
            link.sourcePageId,
            link.targetPageId,
            link.linkType,
            link.entityName || undefined,
          );

          if (nodeMap.size >= maxNodes) break;
        }
        if (nodeMap.size >= maxNodes) break;
      }
    }

    const nodes = Array.from(nodeMap.values());

    // Filter edges to only include those between nodes that are in our set
    const validEdges = edgeList.filter(
      (e) => nodeMap.has(e.source) && nodeMap.has(e.target),
    );

    return c.json({
      kbId,
      nodes,
      edges: validEdges,
      stats: {
        nodeCount: nodes.length,
        edgeCount: validEdges.length,
      },
    });
  });

  // =====================================================================
  // GET /reports/:id/sources - Get source documents and anchors for a report
  // =====================================================================

  router.get("/reports/:id/sources", async (c) => {
    const id = c.req.param("id");

    const repos = await getRepos();
    const page = await repos.wikiPage.getById(id);
    if (!page || page.page_type !== "report") {
      return c.json({ error: "Report not found" }, 404);
    }

    // Extract anchor IDs from report content
    const anchorIds = extractAnchorIds(page.content);

    if (anchorIds.length === 0) {
      // No anchors found in wiki-based report
      return c.json({ sources: [] });
    }

    // Query anchor details
    const anchors = [];
    for (const anchorId of anchorIds) {
      const anchor = await repos.anchor.getById(anchorId);
      if (anchor) anchors.push(anchor);
    }

    // Group by document
    const byDoc = new Map<string, typeof anchors>();
    for (const a of anchors) {
      const list = byDoc.get(a.doc_id) || [];
      list.push(a);
      byDoc.set(a.doc_id, list);
    }

    // Display names
    const displayResolver = new DisplayResolver();
    const displayMap = await displayResolver.resolveBatch([...byDoc.keys()]);

    const sources = [...byDoc.entries()].map(([docId, docAnchors]) => ({
      docId,
      originalName: displayMap[docId]?.originalName ?? docId,
      kbName: displayMap[docId]?.kbName ?? "",
      fileType: displayMap[docId]?.fileType ?? "",
      anchors: docAnchors.map((a) => ({
        id: a.id,
        type: a.element_type,
        sectionTitle: a.section_title,
        pageNumber: a.page_number,
        preview: a.content_preview,
      })),
    }));

    return c.json({ sources });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface TimelineEventResponse {
  date: string;
  title: string;
  description: string;
  sourcePageId: string;
  sourceTitle: string;
}

interface GraphNodeResponse {
  id: string;
  label: string;
  type: string;
  group?: string;
}

interface GraphEdgeResponse {
  source: string;
  target: string;
  label?: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Date extraction helpers (mirrors TimelineTool logic)
// ---------------------------------------------------------------------------

/**
 * ISO date: 2024-01-15 or 2024/01/15
 */
const ISO_DATE_RE = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g;

/**
 * Chinese dates: 2024年1月15日 or 2024年1月 or 2024年
 */
const CHINESE_FULL_DATE_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日/g;
const CHINESE_MONTH_DATE_RE = /(\d{4})年(\d{1,2})月(?!\d)/g;

/**
 * English date month name lookup
 */
const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const ENGLISH_DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
const ENGLISH_DATE_ALT_RE = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})\b/gi;

interface RawDateEvent {
  date: string;
  description: string;
  sourcePageId: string;
  sourceTitle: string;
}

/**
 * Normalize a year, month, day to an ISO date string.
 */
function normalizeDate(year: number, month?: number, day?: number): string {
  if (day && month) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (month) {
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  return `${year}`;
}

/**
 * Validate that a year is reasonable (between 1000 and 2100).
 */
function isValidYear(year: number): boolean {
  return year >= 1000 && year <= 2100;
}

/**
 * Validate that a month is between 1 and 12.
 */
function isValidMonth(month: number): boolean {
  return month >= 1 && month <= 12;
}

/**
 * Validate that a day is between 1 and 31.
 */
function isValidDay(day: number): boolean {
  return day >= 1 && day <= 31;
}

/**
 * Extract a sentence or paragraph around a position in text.
 */
function extractContext(text: string, matchEnd: number, maxLen: number = 200): string {
  let start = matchEnd;
  for (let i = matchEnd - 1; i >= Math.max(0, matchEnd - maxLen); i--) {
    const ch = text[i];
    if (ch === "." || ch === "\n" || ch === "!" || ch === "?") {
      start = i + 1;
      break;
    }
    if (i === Math.max(0, matchEnd - maxLen)) {
      start = i;
    }
  }

  let end = matchEnd;
  for (let i = matchEnd; i < Math.min(text.length, matchEnd + maxLen); i++) {
    const ch = text[i];
    if (ch === "." || ch === "\n" || ch === "!" || ch === "?") {
      end = i;
      break;
    }
    if (i === Math.min(text.length, matchEnd + maxLen) - 1) {
      end = i + 1;
    }
  }

  let context = text.substring(start, end).trim();
  if (context.length > maxLen) {
    context = context.substring(0, maxLen) + "...";
  }
  return context;
}

/**
 * Extract date-referenced events from text content.
 */
function extractDateEvents(
  text: string,
  sourcePageId: string,
  sourceTitle: string,
): RawDateEvent[] {
  const events: RawDateEvent[] = [];
  const seenDates = new Set<string>();

  let match: RegExpExecArray | null;

  // ISO dates: 2024-01-15
  ISO_DATE_RE.lastIndex = 0;
  while ((match = ISO_DATE_RE.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (isValidYear(year) && isValidMonth(month) && isValidDay(day)) {
      const date = normalizeDate(year, month, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // Chinese full dates: 2024年1月15日
  CHINESE_FULL_DATE_RE.lastIndex = 0;
  while ((match = CHINESE_FULL_DATE_RE.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (isValidYear(year) && isValidMonth(month) && isValidDay(day)) {
      const date = normalizeDate(year, month, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // Chinese month dates: 2024年1月
  CHINESE_MONTH_DATE_RE.lastIndex = 0;
  while ((match = CHINESE_MONTH_DATE_RE.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    if (isValidYear(year) && isValidMonth(month)) {
      const date = normalizeDate(year, month);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // English dates: Month Day, Year
  ENGLISH_DATE_RE.lastIndex = 0;
  while ((match = ENGLISH_DATE_RE.exec(text)) !== null) {
    const monthNum = MONTH_NAMES[match[1].toLowerCase()];
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    if (monthNum && isValidYear(year) && isValidDay(day)) {
      const date = normalizeDate(year, monthNum, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  // English dates alt: Day Month Year
  ENGLISH_DATE_ALT_RE.lastIndex = 0;
  while ((match = ENGLISH_DATE_ALT_RE.exec(text)) !== null) {
    const day = parseInt(match[1], 10);
    const monthNum = MONTH_NAMES[match[2].toLowerCase()];
    const year = parseInt(match[3], 10);
    if (monthNum && isValidYear(year) && isValidDay(day)) {
      const date = normalizeDate(year, monthNum, day);
      if (!seenDates.has(date + ":" + match.index)) {
        seenDates.add(date + ":" + match.index);
        events.push({
          date,
          description: extractContext(text, match.index + match[0].length),
          sourcePageId,
          sourceTitle,
        });
      }
    }
  }

  return events;
}

/**
 * Generate a short title from an event description.
 */
function generateEventTitle(description: string): string {
  const sentenceEnd = description.search(/[.!?]/);
  if (sentenceEnd !== -1 && sentenceEnd < 100) {
    return description.substring(0, sentenceEnd).trim();
  }
  if (description.length > 80) {
    return description.substring(0, 80).trim() + "...";
  }
  return description.trim();
}

/**
 * Map a wiki page type to a node type for visualization.
 */
function mapPageTypeToNodeType(pageType: string): string {
  switch (pageType) {
    case "abstract":
    case "overview":
    case "fulltext":
      return "document";
    case "entity":
      return "entity";
    case "concept":
      return "concept";
    case "report":
      return "report";
    default:
      return "document";
  }
}

/**
 * Extract anchor IDs from report content.
 * Matches patterns like (#anchor:docId:paragraph:5) or [来源: ...](#anchor:xxx)
 */
function extractAnchorIds(content: string): string[] {
  const ids: string[] = [];
  // Match anchor IDs in markdown links: ](#anchor:ID)
  const anchorLinkRe = /\(#anchor:([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = anchorLinkRe.exec(content)) !== null) {
    ids.push(match[1]);
  }

  // Also match 锚点: ID pattern from compound content
  const anchorRefRe = /锚点:\s*([a-zA-Z0-9_:.-]+)/g;
  while ((match = anchorRefRe.exec(content)) !== null) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }

  return ids;
}
