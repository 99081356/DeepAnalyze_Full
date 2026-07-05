// =============================================================================
// DeepAnalyze - Preview & Anchor API Routes
// Layer preview (raw/structure/abstract), anchor details, and structure map.
// =============================================================================

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRepos } from "../../store/repos/index.js";
import { getPool } from "../../store/pg.js";
import { DisplayResolver } from "../../services/display-resolver.js";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";

export function createPreviewRoutes(): Hono {
  const app = new Hono();

  // =====================================================================
  // GET /kbs/:kbId/documents/:docId/preview/:layer
  // Layer preview: raw / structure / abstract
  // =====================================================================

  app.get("/kbs/:kbId/documents/:docId/preview/:layer", async (c) => {
    const { kbId, docId, layer } = c.req.param();
    const repos = await getRepos();

    switch (layer) {
      case "raw": {
        try {
          const rawPath = join(DEEPANALYZE_CONFIG.dataDir, kbId, "documents", docId, "raw", "docling.json");
          const rawJson = await readFile(rawPath, "utf-8");
          const parsed = JSON.parse(rawJson);
          const elementCount = countElements(parsed);
          return c.json({ content: parsed, summary: { elementCount } });
        } catch {
          return c.json({ error: "Raw data not found" }, 404);
        }
      }

      case "structure": {
        const chunkId = c.req.query("chunkId");
        if (chunkId) {
          const page = await repos.wikiPage.getById(chunkId);
          if (!page) return c.json({ error: "Chunk not found" }, 404);
          const anchors = await repos.anchor.getByStructurePageId(chunkId);
          return c.json({ chunk: page, anchors });
        }

        // List all structure pages for this document (matches structure_md and structure_dt)
        const pages = await repos.wikiPage.getManyByDocAndTypePrefix(docId, "structure");
        const summaries = pages.map((p) => ({
          id: p.id,
          title: p.title,
          sectionPath: p.metadata?.sectionPath,
          anchorIds: p.metadata?.anchorIds,
          pageRange: p.metadata?.pageRange ?? p.metadata?.timeRange,
          hasTable: Array.isArray(p.metadata?.elementTypes) && (p.metadata?.elementTypes as string[]).includes("table"),
          hasImage: Array.isArray(p.metadata?.elementTypes) && (p.metadata?.elementTypes as string[]).includes("image"),
          modality: p.metadata?.modality,
        }));
        return c.json({ chunks: summaries });
      }

      case "abstract": {
        const page = await repos.wikiPage.getByDocAndType(docId, "abstract");
        if (!page) return c.json({ error: "Abstract not found" }, 404);
        return c.json({
          content: page.content,
          metadata: {
            documentType: page.metadata?.documentType,
            tags: page.metadata?.tags,
            keyDates: page.metadata?.keyDates,
            toc: page.metadata?.toc,
          },
        });
      }

      default:
        return c.json({ error: `Invalid layer: ${layer}` }, 400);
    }
  });

  // =====================================================================
  // GET /anchors/:anchorId
  // Anchor detail: definition + structure snippet + raw context
  // =====================================================================

  app.get("/anchors/:anchorId", async (c) => {
    const { anchorId } = c.req.param();
    const repos = await getRepos();

    const anchor = await repos.anchor.getById(anchorId);
    if (!anchor) return c.json({ error: "Anchor not found" }, 404);

    // Structure layer snippet
    let structureSnippet: string | null = null;
    if (anchor.structure_page_id) {
      const page = await repos.wikiPage.getById(anchor.structure_page_id);
      if (page) {
        structureSnippet = extractSnippet(page.content, anchor.content_preview ?? "");
      }
    }

    // Raw layer context
    let rawContext: unknown = null;
    if (anchor.raw_json_path) {
      try {
        const rawPath = join(DEEPANALYZE_CONFIG.dataDir, anchor.kb_id, "documents", anchor.doc_id, "raw", "docling.json");
        const rawJson = JSON.parse(await readFile(rawPath, "utf-8"));
        rawContext = resolveJsonPointer(rawJson, anchor.raw_json_path);
      } catch {
        // Raw file not found or path invalid
      }
    }

    // Display names
    const displayResolver = new DisplayResolver();
    const displayInfo = await displayResolver.resolve(anchor.doc_id);

    return c.json({
      anchor,
      structureSnippet,
      rawContext,
      display: displayInfo,
    });
  });

  // =====================================================================
  // GET /kbs/:kbId/documents/:docId/structure-map
  // Flat list of all structure chunks with anchors (for navigation sidebar)
  // =====================================================================

  app.get("/kbs/:kbId/documents/:docId/structure-map", async (c) => {
    const { docId } = c.req.param();
    const repos = await getRepos();

    const pages = await repos.wikiPage.getManyByDocAndTypePrefix(docId, "structure");
    const anchors = await repos.anchor.getByDocId(docId);

    const map = pages.map((page) => ({
      id: page.id,
      title: page.title,
      sectionPath: page.metadata?.sectionPath,
      pageRange: page.metadata?.pageRange ?? page.metadata?.timeRange,
      modality: page.metadata?.modality,
      anchors: anchors
        .filter((a) => a.structure_page_id === page.id)
        .map((a) => ({
          id: a.id,
          type: a.element_type,
          preview: a.content_preview,
          lineStart: a.line_start,
          sectionTitle: a.section_title,
        })),
    }));

    return c.json({ structureMap: map });
  });

  // =====================================================================
  // GET /evidence/:anchorId
  // Evidence preview: returns preview data for an evidence anchor
  // =====================================================================

  app.get("/evidence/:anchorId", async (c) => {
    const { anchorId } = c.req.param();
    const repos = await getRepos();

    let anchor = await repos.anchor.getById(anchorId);

    // Fallback: fuzzy match (short UUID prefix + tolerant element_type)
    if (!anchor) {
      anchor = await repos.anchor.getByFuzzyId(anchorId);
    }

    if (!anchor) {
      // Extract docId from anchorId for client-side fallback navigation
      const fallbackDocId = await resolveDocIdPrefix(repos, anchorId);
      if (fallbackDocId) {
        return c.json({ error: "Anchor not found", fallbackDocId, anchorId }, 404);
      }
      return c.json({ error: "Anchor not found", anchorId }, 404);
    }

    const displayResolver = new DisplayResolver();
    const displayInfo = await displayResolver.resolve(anchor.doc_id);

    const baseResult: Record<string, unknown> = {
      anchor,
      kbId: anchor.kb_id,
      docId: anchor.doc_id,
      display: { originalName: displayInfo.originalName, kbName: displayInfo.kbName },
    };

    switch (anchor.element_type) {
      case "image": {
        baseResult.previewType = "image";
        baseResult.imageUrl = `/api/files/${anchor.kb_id}/documents/${anchor.doc_id}/original`;
        baseResult.imageCaption = anchor.content_preview || anchor.section_title || "";
        return c.json(baseResult);
      }

      case "table": {
        baseResult.previewType = "table";
        if (anchor.structure_page_id) {
          const page = await repos.wikiPage.getById(anchor.structure_page_id);
          if (page) {
            const tableData = parseTableFromContent(page.content, anchor.element_index);
            baseResult.tableData = tableData;
          }
        }
        if (!baseResult.tableData) {
          baseResult.tableData = { headers: [], rows: [], highlightRowIndex: anchor.element_index, caption: anchor.section_title };
        }
        return c.json(baseResult);
      }

      case "audio":
      case "video": {
        baseResult.previewType = anchor.element_type;
        baseResult.mediaUrl = `/api/files/${anchor.kb_id}/documents/${anchor.doc_id}/original`;
        return c.json(baseResult);
      }

      default: {
        // text, paragraph, heading, etc.
        baseResult.previewType = "document";
        if (anchor.structure_page_id) {
          const page = await repos.wikiPage.getById(anchor.structure_page_id);
          if (page) {
            baseResult.sectionContent = page.content;
            baseResult.sectionTitle = anchor.section_title || page.title || "";
          }
        }
        // Fallback: load L1 content by docId when anchor has no structure_page_id
        // or when the structure page was not found
        if (!baseResult.sectionContent && anchor.doc_id) {
          for (const pt of ["structure_md", "structure_dt", "structure", "overview"]) {
            const page = await repos.wikiPage.getByDocAndType(anchor.doc_id, pt);
            if (page?.content) {
              baseResult.sectionContent = page.content;
              baseResult.sectionTitle = (baseResult.sectionTitle as string) || page.title || "";
              break;
            }
          }
        }
        baseResult.highlightText = anchor.content_preview || "";
        baseResult.lineStart = anchor.line_start ?? null;
        return c.json(baseResult);
      }
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a table from markdown content at the given table index.
 * Returns headers, rows, and highlightRowIndex.
 */
function parseTableFromContent(content: string, tableIndex: number): {
  headers: string[];
  rows: string[][];
  highlightRowIndex?: number;
  caption?: string;
} {
  const lines = content.split("\n");
  const tables: { headers: string[]; rows: string[][]; startLine: number }[] = [];

  let i = 0;
  while (i < lines.length) {
    // Look for a separator line (|---|---| pattern) which marks a table
    if (/^\|?\s*[-:]+[-|\s:]*$/.test(lines[i].trim())) {
      // The line above should be the header
      if (i > 0 && lines[i - 1].includes("|")) {
        const headerLine = lines[i - 1];
        const headers = headerLine.split("|").map((c) => c.trim()).filter(Boolean);
        const rows: string[][] = [];
        let j = i + 1;
        while (j < lines.length && lines[j].includes("|")) {
          const rowCells = lines[j].split("|").map((c) => c.trim()).filter(Boolean);
          // Only add if it's not a separator line
          if (!/^\|?\s*[-:]+[-|\s:]*$/.test(lines[j].trim())) {
            rows.push(rowCells);
          }
          j++;
        }
        tables.push({ headers, rows, startLine: i - 1 });
        i = j;
        continue;
      }
    }
    i++;
  }

  if (tables.length === 0) {
    return { headers: [], rows: [], highlightRowIndex: tableIndex };
  }

  const targetTable = tables[Math.min(tableIndex, tables.length - 1)];
  return {
    headers: targetTable.headers,
    rows: targetTable.rows,
    highlightRowIndex: tableIndex >= targetTable.rows.length ? undefined : tableIndex,
  };
}

function countElements(obj: unknown): number {
  if (!obj || typeof obj !== "object") return 0;
  const o = obj as Record<string, unknown>;
  if (Array.isArray(o["main-text"])) return (o["main-text"] as unknown[]).length;
  if (Array.isArray(o["body"])) return (o["body"] as unknown[]).length;
  return Object.keys(o).length;
}

function extractSnippet(content: string, preview: string): string {
  if (!preview) return content.slice(0, 200);
  const idx = content.indexOf(preview);
  if (idx === -1) return content.slice(0, 200);
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + preview.length + 50);
  return content.slice(start, end);
}

function resolveJsonPointer(obj: unknown, pointer: string): unknown {
  if (!pointer || pointer === "#") return obj;
  const path = pointer.startsWith("#/") ? pointer.slice(2).split("/") : pointer.split("/");
  let current: unknown = obj;
  for (const key of path) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return current;
}

/**
 * Extract docId from anchorId and try to resolve short UUID prefix to full UUID.
 * AnchorId format: "{docId}:{elementType}:{index}".
 * Returns the full docId if found, or the raw prefix if not.
 */
async function resolveDocIdPrefix(
  _repos: Awaited<ReturnType<typeof getRepos>>,
  anchorId: string,
): Promise<string | null> {
  const colonIdx = anchorId.indexOf(':');
  const rawPrefix = colonIdx > 0 ? anchorId.slice(0, colonIdx) : anchorId;
  if (!rawPrefix) return null;

  // Always verify the document actually exists before returning a fallback
  try {
    const pool = await getPool();

    // If it's a full UUID (36 chars), do exact match
    if (rawPrefix.length === 36) {
      const { rows } = await pool.query(
        'SELECT id FROM documents WHERE id = $1 LIMIT 1',
        [rawPrefix],
      );
      if (rows.length > 0) return rows[0].id;
      return null; // Full UUID but no matching document — hallucinated
    }

    // Short UUID prefix: LIKE match
    const { rows } = await pool.query(
      'SELECT id FROM documents WHERE id::text LIKE $1 LIMIT 1',
      [`${rawPrefix}%`],
    );
    if (rows.length > 0) return rows[0].id;
  } catch {
    // DB lookup failed
  }

  // No matching document found — do not return a fake fallback
  return null;
}
