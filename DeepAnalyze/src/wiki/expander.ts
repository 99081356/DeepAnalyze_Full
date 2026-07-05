// =============================================================================
// DeepAnalyze - Wiki Expander
// Layer-by-layer expand tool for drilling down from abstract to full content.
// Supports expanding from Abstract → Structure → Raw (DoclingDocument JSON).
// Uses PG Repository layer for all database operations.
// =============================================================================

import { getRepos } from "../store/repos/index.js";
import type { WikiPage } from "../types/index.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary of an anchor within a structure page. */
export interface AnchorSummary {
  id: string;
  type: string;
  lineStart: number | null;
  preview: string;
  sectionTitle?: string | null;
}

/** Result of expanding a page to a specific level. */
export interface ExpandResult {
  /** The page ID. */
  pageId: string;
  /** The document ID this page belongs to. */
  docId: string | null;
  /** The current expansion level. */
  level: "L0" | "L1" | "L2" | "raw";
  /** The content at this level. */
  content: string;
  /** Title of the page. */
  title: string;
  /** Child pages at the next level of detail. */
  childPages?: ExpandResult[];
  /** Estimated token count. */
  tokenCount: number;
  /** Content source for L2: "raw_json" (Docling output) or "fulltext" (fallback). */
  source?: "raw_json" | "fulltext";
  /** Anchor summaries for L1 content (only populated when level === "L1"). */
  anchors?: AnchorSummary[];
}

/** Result of expanding to the raw layer for a specific anchor. */
export interface RawExpandResult {
  /** The anchor ID. */
  anchorId: string;
  /** The document ID. */
  docId: string;
  /** The raw DoclingDocument JSON node at the anchor. */
  targetNode: unknown;
  /** Surrounding context nodes (siblings before and after). */
  context: { before: unknown[]; after: unknown[] };
  /** The full raw JSON (for deep inspection). */
  fullRaw: Record<string, unknown> | null;
  /** JSON Pointer path to the target node. */
  jsonPointer: string;
}

// ---------------------------------------------------------------------------
// Expander
// ---------------------------------------------------------------------------

export class Expander {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Batch-expand multiple documents to a target level in a single bulk DB query.
   * Uses getByKbAndType to fetch ALL pages of the target type for a KB at once,
   * then filters to the requested docIds.
   *
   * This replaces N × 4 individual queries with 2-4 total queries,
   * reducing DB load by ~50x for large batches.
   *
   * @param targetLevel - "L0" for abstracts (~125 tokens/doc), "L1" for structure (default)
   */
  async batchExpand(
    kbId: string,
    docIds?: string[],
    format: "md" | "dt" = "md",
    targetLevel: "L0" | "L1" = "L1",
  ): Promise<Array<{ docId: string; title: string; content: string; tokenCount: number }>> {
    const repos = await getRepos();
    const results = new Map<string, { docId: string; title: string; content: string; tokenCount: number }>();

    // Page types in priority order based on target level
    const pageTypes = targetLevel === "L0"
      ? ["abstract"]
      : format === "md"
        ? ["structure_md", "structure", "structure_dt", "overview"]
        : ["structure_dt", "structure", "structure_md", "overview"];

    // Track which docs still need resolution
    const remaining = new Set(docIds);

    for (const pageType of pageTypes) {
      if (remaining.size === 0) break;

      // Bulk fetch ALL pages of this type for the KB (1 query)
      const pages = await repos.wikiPage.getByKbAndType(kbId, pageType);

      for (const page of pages) {
        if (!page.doc_id || !page.content) continue;
        if (docIds && !remaining.has(page.doc_id)) continue;
        if (results.has(page.doc_id)) continue; // already have a better type

        results.set(page.doc_id, {
          docId: page.doc_id,
          title: page.title,
          content: page.content,
          tokenCount: page.token_count,
        });
        remaining.delete(page.doc_id);
      }
    }

    return Array.from(results.values());
  }

  /**
   * @deprecated Use batchExpand with targetLevel parameter instead.
   */
  async batchExpandToL1(
    kbId: string,
    docIds?: string[],
    format: "md" | "dt" = "md",
  ): Promise<Array<{ docId: string; title: string; content: string; tokenCount: number }>> {
    return this.batchExpand(kbId, docIds, format, "L1");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Expand from a page ID to get its content at the current level.
   * Also returns child pages that can be expanded further.
   */
  async expand(pageId: string): Promise<ExpandResult> {
    const repos = await getRepos();
    const pgPage = await repos.wikiPage.getById(pageId);
    if (!pgPage) {
      throw new Error(`Wiki page not found: ${pageId}`);
    }

    const content = pgPage.content || "";
    const level = this.pageTypeToLevel(pgPage.page_type);

    // Get child pages at the next level of detail
    let childPages: ExpandResult[] | undefined;

    if (pgPage.doc_id && level !== "raw") {
      const childLevel = this.nextLevel(level);
      if (childLevel) {
        let childPageType: string | null;
        if (childLevel === "L1") {
          childPageType = await this.resolveL1PageType(pgPage.doc_id);
        } else {
          childPageType = this.levelToPageType(childLevel);
        }
        if (childPageType) {
          const childPage = await repos.wikiPage.getByDocAndType(pgPage.doc_id, childPageType);
          if (childPage) {
            const childContent = childPage.content || "";
            childPages = [
              {
                pageId: childPage.id,
                docId: childPage.doc_id,
                level: childLevel,
                content: childContent,
                title: childPage.title,
                tokenCount: childPage.token_count,
              },
            ];
          }
        }
      }
    }

    return {
      pageId: pgPage.id,
      docId: pgPage.doc_id,
      level,
      content,
      title: pgPage.title,
      childPages,
      tokenCount: pgPage.token_count,
    };
  }

  /**
   * Expand to a specific level starting from a document.
   * Returns the content at the target level, with all intermediate levels
   * accessible as child pages.
   */
  async expandToLevel(
    docId: string,
    targetLevel: "L0" | "L1" | "L2",
    format?: "md" | "dt",
  ): Promise<ExpandResult> {
    const repos = await getRepos();

    // For L2: prefer raw Docling JSON over markdown fulltext
    if (targetLevel === "L2") {
      const rawResult = await this.expandRawJson(docId);
      if (rawResult) {
        return { ...rawResult, source: "raw_json" as const };
      }
      // Fall through to fulltext page if raw JSON not available
    }

    // Resolve page type with fallback for legacy "structure" pages at L1
    let targetPageType: string | null;
    if (targetLevel === "L1") {
      targetPageType = await this.resolveL1PageType(docId, format);
    } else {
      targetPageType = this.levelToPageType(targetLevel, format);
    }
    if (!targetPageType) {
      throw new Error(`Invalid target level: ${targetLevel}`);
    }

    const page = await repos.wikiPage.getByDocAndType(docId, targetPageType);
    if (!page) {
      throw new Error(
        `No page found for document ${docId} at level ${targetLevel}`,
      );
    }

    const content = page.content || "";

    // Build the tree of child pages at more detailed levels
    let childPages: ExpandResult[] | undefined;
    const childLevel = this.nextLevel(targetLevel);
    if (childLevel && page.doc_id) {
      let childPageType: string | null;
      if (childLevel === "L1") {
        childPageType = await this.resolveL1PageType(page.doc_id);
      } else {
        childPageType = this.levelToPageType(childLevel);
      }
      if (childPageType) {
        const childPage = await repos.wikiPage.getByDocAndType(page.doc_id, childPageType);
        if (childPage) {
          const childContent = childPage.content || "";
          childPages = [
            {
              pageId: childPage.id,
              docId: childPage.doc_id,
              level: childLevel,
              content: childContent,
              title: childPage.title,
              tokenCount: childPage.token_count,
            },
          ];
        }
      }
    }

    // Fetch anchor summaries for L1 pages
    let anchorSummaries: AnchorSummary[] | undefined;
    if (targetLevel === "L1" && page.doc_id) {
      try {
        const dbAnchors = await repos.anchor.getByDocId(page.doc_id);
        if (dbAnchors.length > 0) {
          anchorSummaries = dbAnchors.map((a) => ({
            id: a.id,
            type: a.element_type,
            lineStart: a.line_start ?? null,
            preview: (a.content_preview ?? "").slice(0, 80),
            sectionTitle: a.section_title ?? null,
          }));
        }
      } catch {
        // Non-critical: anchors are optional enrichment
      }
    }

    return {
      pageId: page.id,
      docId: page.doc_id,
      level: targetLevel,
      content,
      title: page.title,
      childPages,
      tokenCount: page.token_count,
      anchors: anchorSummaries,
      ...(targetLevel === "L2" ? { source: "fulltext" as const } : {}),
    };
  }

  /**
   * Expand a specific section within a page, identified by a heading.
   * Returns the content of the section (text between the heading and the
   * next heading of the same or higher level).
   */
  async expandSection(
    pageId: string,
    heading: string,
  ): Promise<ExpandResult | null> {
    const repos = await getRepos();
    const pgPage = await repos.wikiPage.getById(pageId);
    if (!pgPage) {
      throw new Error(`Wiki page not found: ${pageId}`);
    }

    const content = pgPage.content || "";
    const level = this.pageTypeToLevel(pgPage.page_type);

    // Find the section by heading (case-insensitive match)
    const lines = content.split("\n");
    const normalizedHeading = heading.toLowerCase().trim();

    let sectionStart = -1;
    let headingLevel = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^(#{1,6})\s+(.+)/);
      if (match) {
        const hLevel = match[1].length;
        const hText = match[2].toLowerCase().trim();

        if (hText.includes(normalizedHeading) || normalizedHeading.includes(hText)) {
          sectionStart = i;
          headingLevel = hLevel;
          break;
        }
      }
    }

    if (sectionStart === -1) {
      return null;
    }

    // Find the end of the section (next heading of same or higher level)
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^(#{1,6})\s+/);
      if (match && match[1].length <= headingLevel) {
        sectionEnd = i;
        break;
      }
    }

    const sectionContent = lines.slice(sectionStart, sectionEnd).join("\n");
    const tokenCount = Math.ceil(sectionContent.length / 4);

    return {
      pageId: pgPage.id,
      docId: pgPage.doc_id,
      level,
      content: sectionContent,
      title: `${pgPage.title} - ${lines[sectionStart].replace(/^#+\s*/, "")}`,
      tokenCount,
    };
  }

  /**
   * Expand with a token budget. Starts from the most compressed level (L0)
   * and progressively adds more detail until the budget is exhausted.
   * Returns the accumulated content across levels.
   */
  async expandWithBudget(
    docId: string,
    tokenBudget: number,
  ): Promise<ExpandResult> {
    const repos = await getRepos();
    const levels: Array<{ level: "L0" | "L1" | "L2"; pageType: string | null }> = [];

    // Resolve page types, with L1 fallback for legacy "structure" pages
    levels.push({ level: "L0", pageType: "abstract" });
    const l1Type = await this.resolveL1PageType(docId);
    levels.push({ level: "L1", pageType: l1Type });
    levels.push({ level: "L2", pageType: "fulltext" });

    let totalTokens = 0;
    let bestResult: ExpandResult | null = null;

    for (const { level, pageType } of levels) {
      if (!pageType) continue;

      const page = await repos.wikiPage.getByDocAndType(docId, pageType);
      if (!page) continue;

      const tokens = page.token_count;

      // Check if adding this level would exceed the budget
      if (totalTokens + tokens > tokenBudget) {
        // Budget is exhausted. If we have no result yet, include this
        // level anyway (better to return something than nothing).
        if (!bestResult) {
          const content = page.content || "";
          bestResult = {
            pageId: page.id,
            docId: page.doc_id,
            level,
            content,
            title: page.title,
            tokenCount: tokens,
          };
        }
        break;
      }

      const content = page.content || "";
      bestResult = {
        pageId: page.id,
        docId: page.doc_id,
        level,
        content,
        title: page.title,
        tokenCount: tokens,
      };
      totalTokens += tokens;
    }

    if (!bestResult) {
      throw new Error(
        `No wiki pages found for document ${docId}`,
      );
    }

    return bestResult;
  }

  // -----------------------------------------------------------------------
  // Raw layer access (anchor-based)
  // -----------------------------------------------------------------------

  /**
   * Expand to the Raw layer for a specific anchor element.
   *
   * Flow:
   *  1. Look up anchor by ID from AnchorRepo (PG)
   *  2. Read the raw DoclingDocument JSON from disk
   *  3. Use JSON Pointer to locate the target element
   *  4. Return the element with surrounding context
   */
  async expandToRaw(anchorId: string): Promise<RawExpandResult> {
    // Look up anchor via PG Repository
    const anchor = await this.getAnchorById(anchorId);
    if (!anchor) {
      throw new Error(`Anchor not found: ${anchorId}`);
    }

    const docId = anchor.doc_id;
    const jsonPointer = anchor.raw_json_path ?? `#/body/children/0`;

    // Load the raw DoclingDocument JSON
    const raw = this.loadRawJson(docId);
    if (!raw) {
      throw new Error(`Raw JSON not found for document ${docId}`);
    }

    // Resolve the JSON Pointer to get the target node
    const targetNode = this.resolveJsonPointer(raw, jsonPointer);
    if (targetNode === undefined) {
      throw new Error(`JSON Pointer ${jsonPointer} not found in raw JSON`);
    }

    // Get context (surrounding siblings)
    const children = (raw as Record<string, unknown>).body
      ? ((raw as Record<string, unknown>).body as Record<string, unknown>).children as unknown[]
      : [];
    const targetIndex = this.extractIndexFromPointer(jsonPointer);
    const contextBefore = children.slice(Math.max(0, targetIndex - 2), targetIndex);
    const contextAfter = children.slice(targetIndex + 1, targetIndex + 3);

    return {
      anchorId,
      docId,
      targetNode,
      context: { before: contextBefore, after: contextAfter },
      fullRaw: raw,
      jsonPointer,
    };
  }

  /**
   * Resolve a JSON Pointer (e.g., "#/body/children/3") to a value in a JSON object.
   */
  resolveJsonPointer(obj: Record<string, unknown>, pointer: string): unknown {
    // Strip leading "#/" or "/"
    let path = pointer;
    if (path.startsWith("#/")) {
      path = path.slice(2);
    } else if (path.startsWith("/")) {
      path = path.slice(1);
    }

    if (!path) return obj;

    const tokens = path.split("/");
    let current: unknown = obj;

    for (const token of tokens) {
      if (current === null || current === undefined) return undefined;

      if (Array.isArray(current)) {
        const index = parseInt(token, 10);
        if (isNaN(index)) return undefined;
        current = current[index];
      } else if (typeof current === "object") {
        current = (current as Record<string, unknown>)[token];
      } else {
        return undefined;
      }
    }

    return current;
  }

  // -----------------------------------------------------------------------
  // Private helpers (Raw layer)
  // -----------------------------------------------------------------------

  /**
   * Get an anchor by ID via PG Repository.
   */
  private async getAnchorById(
    anchorId: string,
  ): Promise<{ doc_id: string; raw_json_path?: string } | null> {
    try {
      const repos = await getRepos();
      const anchor = await repos.anchor.getById(anchorId);
      return anchor ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Load the raw DoclingDocument JSON from disk.
   */
  private loadRawJson(docId: string): Record<string, unknown> | null {
    // Try to find the wiki directory
    const wikiDir = join(this.dataDir, "wiki");

    try {
      // Try direct path construction: find the KB directory
      const kbDirs = readdirSync(wikiDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const kbDir of kbDirs) {
        const rawPath = join(wikiDir, kbDir, "documents", docId, "raw", "docling.json");
        try {
          const content = readFileSync(rawPath, "utf-8");
          return JSON.parse(content);
        } catch {
          continue;
        }
      }
    } catch {
      // Wiki directory not found
    }

    return null;
  }

  /**
   * Extract the array index from a JSON Pointer like "#/body/children/3".
   */
  private extractIndexFromPointer(pointer: string): number {
    const parts = pointer.split("/");
    const lastPart = parts[parts.length - 1];
    const index = parseInt(lastPart, 10);
    return isNaN(index) ? 0 : index;
  }

  // -----------------------------------------------------------------------
  // Private helpers (level mapping)
  // -----------------------------------------------------------------------

  /**
   * Map a page type to its expansion level.
   */
  private pageTypeToLevel(pageType: string): "L0" | "L1" | "L2" | "raw" {
    switch (pageType) {
      case "abstract":
        return "L0";
      case "overview":
      case "structure":
      case "structure_md":
      case "structure_dt":
        return "L1";
      case "fulltext":
        return "L2";
      case "entity":
      case "concept":
      case "report":
        return "raw";
      default:
        return "raw";
    }
  }

  /**
   * Map an expansion level back to a page type.
   */
  private levelToPageType(
    level: "L0" | "L1" | "L2" | "raw",
    format?: "md" | "dt",
  ): string | null {
    switch (level) {
      case "L0":
        return "abstract";
      case "L1":
        return format === "md" ? "structure_md" : "structure_dt";
      case "L2":
        return "fulltext";
      case "raw":
        return null;
      default:
        return null;
    }
  }

  /**
   * Get the page type for L1, with fallback to legacy "structure" format.
   * Returns the first matching page type that exists in the database.
   */
  private async resolveL1PageType(
    docId: string,
    format?: "md" | "dt",
  ): Promise<string | null> {
    const repos = await getRepos();
    const preferred = format === "md" ? "structure_md" : "structure_dt";
    const page = await repos.wikiPage.getByDocAndType(docId, preferred);
    if (page && page.content) return preferred;

    // Fallback: try the legacy "structure" type
    const legacy = await repos.wikiPage.getByDocAndType(docId, "structure");
    if (legacy && legacy.content) return "structure";

    // Fallback: try the other format
    const other = format === "md" ? "structure_dt" : "structure_md";
    const otherPage = await repos.wikiPage.getByDocAndType(docId, other);
    if (otherPage && otherPage.content) return other;

    // Final fallback: try "overview" type
    const overview = await repos.wikiPage.getByDocAndType(docId, "overview");
    if (overview && overview.content) return "overview";

    return null;
  }

  /**
   * Get the next more detailed level after the given level.
   */
  private nextLevel(
    level: "L0" | "L1" | "L2" | "raw",
  ): "L0" | "L1" | "L2" | "raw" | null {
    switch (level) {
      case "L0":
        return "L1";
      case "L1":
        return "L2";
      case "L2":
        return "raw";
      case "raw":
        return null;
      default:
        return null;
    }
  }

  /**
   * Try to expand the raw Docling JSON for a document's L2 layer.
   * Returns null if the raw JSON file doesn't exist on disk.
   */
  private async expandRawJson(docId: string): Promise<ExpandResult | null> {
    const repos = await getRepos();
    const doc = await repos.document.getById(docId);
    if (!doc) return null;

    // Try to find the KB that contains this document
    const kbId = doc.kb_id;
    const rawPath = join(this.dataDir, "wiki", kbId, "documents", docId, "raw", "docling.json");

    try {
      const rawContent = readFileSync(rawPath, "utf-8");
      // Validate it's JSON
      JSON.parse(rawContent);

      // Get the fulltext page for metadata (pageId, title)
      const fulltextPage = await repos.wikiPage.getByDocAndType(docId, "fulltext");

      return {
        pageId: fulltextPage?.id ?? `raw-${docId}`,
        docId,
        level: "L2",
        content: rawContent,
        title: fulltextPage?.title ?? `Raw JSON: ${doc.filename}`,
        tokenCount: Math.ceil(rawContent.length / 4),
      };
    } catch {
      return null;
    }
  }
}
