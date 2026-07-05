// =============================================================================
// DeepAnalyze - Fusion Retrieval Engine
// Combines vector similarity search, BM25 full-text search, and link traversal
// using Reciprocal Rank Fusion (RRF) for unified result ranking.
// Uses PG Repository layer exclusively for all database operations.
// =============================================================================

import { getRepos } from "../store/repos/index.js";
import type { WikiPage } from "../types/index.js";
import type { EmbeddingManager } from "../models/embedding.js";
import type { Indexer } from "./indexer.js";
import type { Linker } from "./linker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single search result from any retrieval method. */
export interface SearchResult {
  pageId: string;
  kbId: string;
  docId: string | null;
  pageType: string;
  title: string;
  score: number;
  /** Relevant text excerpt. */
  snippet: string;
  /** Which retrieval method produced this result. */
  source: "vector" | "bm25" | "linked" | "fusion";
  /** Best-matching anchor ID for the snippet (for evidence links). */
  anchorId?: string;
}

/** A search result with hierarchical level annotation. */
export interface LeveledSearchResult {
  pageId: string;
  title: string;
  snippet: string;
  highlights: Array<{ text: string; position: number }>;
  level: "L0" | "L1" | "L2";
  score: number;
  kbId: string;
  docId?: string;
  /** Best-matching anchor ID for the snippet (for evidence links). */
  anchorId?: string;
}

/** An entity discovered in the knowledge base. */
export interface EntitySearchResult {
  name: string;
  type: string;
  count: number;
  relatedPages: string[];
}

/** Search mode controls which search strategies are used. */
export type SearchMode = "semantic" | "vector" | "keyword" | "hybrid";

/** Options for configuring a search query. */
export interface SearchOptions {
  /** Knowledge base IDs to search within. */
  kbIds: string[];
  /** Maximum number of results to return (default 10). */
  topK?: number;
  /** Page ID to start link traversal from (adds linked results). */
  linkedFrom?: string;
  /** Filter results to specific page types. */
  pageTypes?: string[];
  /** Minimum score threshold (0-1 scale). */
  minScore?: number;
  /**
   * Search mode:
   * - "semantic" or "vector" — vector embedding search only (best for meaning-based queries)
   * - "keyword" — BM25 full-text search only (best for exact term matching)
   * - "hybrid" — both vector + BM25 with RRF fusion (default, best overall)
   */
  mode?: SearchMode;
}

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

export class Retriever {
  private indexer: Indexer;
  private linker: Linker;
  private embeddingManager: EmbeddingManager;

  constructor(
    indexer: Indexer,
    linker: Linker,
    embeddingManager: EmbeddingManager,
  ) {
    this.indexer = indexer;
    this.linker = linker;
    this.embeddingManager = embeddingManager;
  }

  // -----------------------------------------------------------------------
  // Vector similarity search (PG pgvector)
  // -----------------------------------------------------------------------

  /**
   * Search using vector embedding similarity via PG pgvector HNSW index.
   * Replaces the brute-force JS cosine similarity computation.
   */
  async vectorSearch(
    query: string,
    kbIds: string[],
    topK: number,
  ): Promise<SearchResult[]> {
    if (kbIds.length === 0) return [];

    try {
      const repos = await getRepos();

      const queryResult = await this.embeddingManager.embed(query);
      const results = await repos.vectorSearch.searchByVector(
        queryResult.embedding,
        kbIds,
        {
          topK,
          modelName: this.embeddingManager.providerName,
        },
      );

      return results.map((r) => ({
        pageId: r.page_id,
        kbId: r.kb_id,
        docId: r.doc_id,
        pageType: r.page_type,
        title: r.title,
        score: r.similarity,
        snippet: this.extractSnippet(r.text_chunk ?? "", query),
        source: "vector" as const,
      }));
    } catch (err) {
      console.warn(
        `[Retriever] PG vector search failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // BM25 full-text search (PG zhparser/GIN)
  // -----------------------------------------------------------------------

  /**
   * Search using BM25 ranking via PG full-text search with zhparser.
   * Falls back to LIKE-based matching when FTS is unavailable.
   */
  async bm25Search(
    query: string,
    kbIds: string[],
    topK: number,
  ): Promise<SearchResult[]> {
    if (kbIds.length === 0) return [];

    try {
      const results = await this.pgFtsSearch(query, kbIds, topK);
      if (results.length === 0) {
        // FTS returned no matches — zhparser may not be configured for Chinese,
        // or the query terms didn't tokenize. Fall back to LIKE-based search.
        return this.likeSearch(query, kbIds, topK);
      }
      return results;
    } catch {
      // PG FTS may fail. Fall back to LIKE-based search.
      return this.likeSearch(query, kbIds, topK);
    }
  }

  /**
   * PG FTS-based search using zhparser and GIN index.
   */
  private async pgFtsSearch(
    query: string,
    kbIds: string[],
    topK: number,
  ): Promise<SearchResult[]> {
    const repos = await getRepos();

    const results = await repos.ftsSearch.searchByText(query, kbIds, { topK });

    return results.map((r) => {
      // Normalize PG ts_rank score to 0-1 range
      const normalizedScore = Math.max(0, Math.min(1, 1 / (1 + Math.exp(-r.rank))));

      return {
        pageId: r.id,
        kbId: r.kb_id,
        docId: r.doc_id,
        pageType: r.page_type,
        title: r.title,
        score: normalizedScore,
        snippet: "",
        source: "bm25" as const,
      };
    });
  }

  /**
   * LIKE-based fallback when FTS is unavailable.
   * Uses repos.wikiPage.getByKbAndType() with in-memory filtering.
   */
  private async likeSearch(
    query: string,
    kbIds: string[],
    topK: number,
  ): Promise<SearchResult[]> {
    const repos = await getRepos();
    const likePattern = `%${query}%`;
    const lowerQuery = query.toLowerCase();

    const matchedPages: Array<{
      page: { id: string; kb_id: string; doc_id: string | null; page_type: string; title: string; content: string };
      score: number;
      snippet: string;
    }> = [];

    for (const kbId of kbIds) {
      const pages = await repos.wikiPage.getByKbAndType(kbId);

      for (const page of pages) {
        // Check title match
        if (page.title.toLowerCase().includes(lowerQuery)) {
          matchedPages.push({
            page,
            score: 0.8,
            snippet: page.title.substring(0, 200),
          });
          continue;
        }

        // Check content match
        const content = page.content || "";
        if (content.toLowerCase().includes(lowerQuery)) {
          matchedPages.push({
            page,
            score: 0.5,
            snippet: this.extractSnippet(content, query),
          });
        }
      }
    }

    // Sort by score and take topK
    matchedPages.sort((a, b) => b.score - a.score);
    const topResults = matchedPages.slice(0, topK);

    return topResults.map((m) => ({
      pageId: m.page.id,
      kbId: m.page.kb_id,
      docId: m.page.doc_id,
      pageType: m.page.page_type,
      title: m.page.title,
      score: m.score,
      snippet: m.snippet,
      source: "bm25" as const,
    }));
  }

  // -----------------------------------------------------------------------
  // Link-based traversal search
  // -----------------------------------------------------------------------

  /**
   * Search by traversing links from a starting page.
   * Returns pages reachable within the given depth, scored by distance.
   */
  async linkedSearch(
    startPageId: string,
    depth: number = 2,
  ): Promise<SearchResult[]> {
    const linkedPages = await this.linker.getLinkedPages(startPageId, depth);

    return linkedPages.map((lp) => {
      // Score decreases with distance (1/distance)
      const score = 1 / lp.distance;

      return {
        pageId: lp.page.id,
        kbId: lp.page.kbId,
        docId: lp.page.docId,
        pageType: lp.page.pageType,
        title: lp.page.title,
        score,
        snippet: "",
        source: "linked" as const,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Reciprocal Rank Fusion (RRF)
  // -----------------------------------------------------------------------

  /**
   * Merge multiple result sets using Reciprocal Rank Fusion.
   *
   * RRF score for a document = sum over all result sets of:
   *   1 / (k + rank_in_set)
   *
   * @param resultSets - Array of ranked result arrays
   * @param k - RRF constant (default 60)
   */
  rrfMerge(resultSets: SearchResult[][], k: number = 60): SearchResult[] {
    // Map pageId -> accumulated RRF score and best metadata
    const pageScores = new Map<
      string,
      {
        score: number;
        result: SearchResult;
      }
    >();

    for (const results of resultSets) {
      for (let rank = 0; rank < results.length; rank++) {
        const result = results[rank];
        const rrfContribution = 1 / (k + rank + 1);

        const existing = pageScores.get(result.pageId);
        if (existing) {
          existing.score += rrfContribution;
          // Keep the better snippet
          if (result.snippet.length > existing.result.snippet.length) {
            existing.result = {
              ...existing.result,
              snippet: result.snippet,
            };
          }
        } else {
          pageScores.set(result.pageId, {
            score: rrfContribution,
            result: { ...result },
          });
        }
      }
    }

    // Convert to array, set fusion source and score, sort
    const merged = Array.from(pageScores.entries()).map(
      ([_pageId, { score, result }]) => ({
        ...result,
        score,
        source: "fusion" as const,
      }),
    );

    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

  // -----------------------------------------------------------------------
  // Unified search entry point
  // -----------------------------------------------------------------------

  /**
   * Main search method combining all retrieval strategies.
   *
   * 1. Runs vector similarity search (PG pgvector)
   * 2. Runs BM25 full-text search (PG zhparser)
   * 3. Optionally runs link traversal from a starting page
   * 4. Merges all results using RRF
   * 5. Applies filters and returns top results
   *
   * Default pageTypes is now ["structure"] for the three-layer architecture.
   */
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const {
      kbIds,
      topK = 10,
      linkedFrom,
      pageTypes,
      minScore,
      mode = "hybrid",
    } = options;

    // Run search strategies based on mode
    const searchPromises: Promise<SearchResult[]>[] = [];

    if (mode === "semantic" || mode === "vector") {
      searchPromises.push(this.vectorSearch(query, kbIds, topK));
    } else if (mode === "keyword") {
      searchPromises.push(this.bm25Search(query, kbIds, topK));
    } else {
      // hybrid (default) — run both
      searchPromises.push(this.vectorSearch(query, kbIds, topK));
      searchPromises.push(this.bm25Search(query, kbIds, topK));
    }

    if (linkedFrom) {
      searchPromises.push(this.linkedSearch(linkedFrom, 2));
    }

    const settled = await Promise.allSettled(searchPromises);

    const resultSets: SearchResult[][] = [];

    for (const result of settled) {
      if (result.status === "fulfilled" && result.value.length > 0) {
        resultSets.push(result.value);
      } else if (result.status === "rejected") {
        console.warn(
          `[Retriever] Search strategy failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }

    // If only one result set, return it directly (no need for RRF)
    let finalResults: SearchResult[];
    if (resultSets.length === 0) {
      finalResults = [];
    } else if (resultSets.length === 1) {
      finalResults = resultSets[0];
    } else {
      // Merge with RRF
      finalResults = this.rrfMerge(resultSets);
    }

    // Apply page type filter
    if (pageTypes && pageTypes.length > 0) {
      finalResults = finalResults.filter((r) =>
        pageTypes.includes(r.pageType),
      );
    }

    // Apply minimum score filter
    if (minScore !== undefined) {
      finalResults = finalResults.filter((r) => r.score >= minScore);
    }

    // Limit to topK
    const topResults = finalResults.slice(0, topK);

    // Enrich results with best-matching anchorId for evidence links
    await this.enrichWithAnchorIds(topResults);

    return topResults;
  }

  /**
   * For each search result, find the best-matching anchor based on snippet text.
   * Anchors are linked to wiki pages via structure_page_id.
   */
  private async enrichWithAnchorIds(results: SearchResult[]): Promise<void> {
    if (results.length === 0) return;

    const repos = await getRepos();

    // Group by pageId for batch lookup
    const pageIds = [...new Set(results.map((r) => r.pageId))];
    const anchorMap = new Map<string, Array<{ id: string; content_preview?: string }>>();

    for (const pageId of pageIds) {
      try {
        const anchors = await repos.anchor.getByStructurePageId(pageId);
        anchorMap.set(pageId, anchors.map((a) => ({ id: a.id, content_preview: a.content_preview })));
      } catch {
        // No anchors for this page
      }
    }

    for (const result of results) {
      const anchors = anchorMap.get(result.pageId);
      if (!anchors || anchors.length === 0) continue;

      if (result.snippet && anchors.length > 1) {
        // Find the anchor whose content_preview best matches the snippet
        let bestAnchor = anchors[0];
        let bestScore = 0;
        const snippetLower = result.snippet.toLowerCase();

        for (const anchor of anchors) {
          if (!anchor.content_preview) continue;
          const previewLower = anchor.content_preview.toLowerCase();
          // Check overlap: how many words from snippet appear in preview
          const previewWords = previewLower.split(/\s+/);
          const matchCount = previewWords.filter((w) => w.length > 1 && snippetLower.includes(w)).length;
          if (matchCount > bestScore) {
            bestScore = matchCount;
            bestAnchor = anchor;
          }
        }
        result.anchorId = bestAnchor.id;
      } else {
        result.anchorId = anchors[0].id;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Extract a short snippet from text around the query match.
   */
  private extractSnippet(text: string, query: string, maxLen: number = 500): string {
    if (!text) return "";
    if (!query) return text.substring(0, maxLen);

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery.split(/\s+/)[0] ?? lowerQuery);

    if (idx === -1) {
      return text.substring(0, maxLen);
    }

    // Extract context around the match (wider window for better context)
    const start = Math.max(0, idx - 100);
    const end = Math.min(text.length, idx + query.length + 300);
    let snippet = text.substring(start, end);

    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";

    return snippet;
  }

  // -----------------------------------------------------------------------
  // Multi-level search (L0 / L1 / L2)
  // -----------------------------------------------------------------------

  /**
   * Search by hierarchical levels:
   *  - L0 = abstract (quick summary)
   *  - L1 = overview (structured summary)
   *  - L2 = fulltext (full content)
   *
   * All three levels are searched in parallel. Results include keyword
   * highlights and are grouped by level.
   *
   * @param query   - The search query string
   * @param kbIds   - The knowledge base IDs to search across
   * @param options - Optional overrides for topK per level and entity search toggle
   */
  async searchByLevels(
    query: string,
    kbIds: string[],
    options?: {
      topK?: number;
      includeEntities?: boolean;
      docId?: string;
      levels?: string[];
      mode?: SearchMode;
    },
  ): Promise<{
    L0: LeveledSearchResult[];
    L1: LeveledSearchResult[];
    L2: LeveledSearchResult[];
    entities: EntitySearchResult[];
  }> {
    const { topK = 10, includeEntities = false, docId, levels, mode } = options ?? {};

    const keywords = query.split(/\s+/).filter((w) => w.length > 0);

    // Mapping from level to page_type values in the DB
    const levelMap: Record<string, string[]> = {
      L0: ["abstract"],
      L1: ["structure_md", "structure_dt", "overview", "structure"],
      L2: ["fulltext"],
    };

    const requestedLevels = levels ?? ["L0", "L1", "L2"];

    // Only search requested levels
    const searchL0 = requestedLevels.includes("L0");
    const searchL1 = requestedLevels.includes("L1");
    const searchL2 = requestedLevels.includes("L2");

    const [l0Results, l1Results, l2Results, entityResults] = await Promise.all([
      searchL0 ? this.searchLevel(query, kbIds, levelMap.L0, "L0", keywords, topK, docId, mode) : Promise.resolve([]),
      searchL1 ? this.searchLevel(query, kbIds, levelMap.L1, "L1", keywords, topK, docId, mode) : Promise.resolve([]),
      searchL2 ? this.searchLevel(query, kbIds, levelMap.L2, "L2", keywords, topK, docId, mode) : Promise.resolve([]),
      includeEntities ? this.searchEntities(query, kbIds, topK) : Promise.resolve([]),
    ]);

    return {
      L0: l0Results,
      L1: l1Results,
      L2: l2Results,
      entities: entityResults,
    };
  }

  /**
   * Search a single level (set of page types) within a KB.
   */
  private async searchLevel(
    query: string,
    kbIds: string[],
    pageTypes: string[],
    level: "L0" | "L1" | "L2",
    keywords: string[],
    topK: number,
    docId?: string,
    mode?: SearchMode,
  ): Promise<LeveledSearchResult[]> {
    // Delegate to the unified search and filter by page type
    const opts: SearchOptions = {
      kbIds,
      topK,
      pageTypes,
      mode,
    };

    const raw = await this.search(query, opts);

    // Optionally filter by docId
    const filtered = docId
      ? raw.filter((r) => r.docId === docId || !r.docId)
      : raw;

    return filtered.map((r) => {
      const highlightedSnippet = this.highlightKeywords(r.snippet, keywords);
      const highlights = this.extractHighlights(r.snippet, keywords);

      return {
        pageId: r.pageId,
        title: r.title,
        snippet: highlightedSnippet,
        highlights,
        level,
        score: r.score,
        anchorId: r.anchorId,
        kbId: r.kbId,
        docId: r.docId ?? undefined,
      };
    });
  }

  /**
   * Search entities matching the query within a KB.
   */
  private async searchEntities(
    query: string,
    kbIds: string[],
    topK: number,
  ): Promise<EntitySearchResult[]> {
    const repos = await getRepos();
    const lowerQuery = query.toLowerCase();

    try {
      const results: EntitySearchResult[] = [];

      for (const kbId of kbIds) {
        const entityPages = await repos.wikiPage.getByKbAndType(kbId, "entity");
        const matchingEntities = entityPages.filter(p =>
          p.title.toLowerCase().includes(lowerQuery)
        ).slice(0, topK);

        for (const page of matchingEntities) {
          // Get incoming entity_ref links to count mentions
          const incomingLinks = await repos.wikiLink.getIncoming(page.id);
          const entityRefLinks = incomingLinks.filter(l => l.linkType === "entity_ref");

          // Extract entity type from title (format: "Type: Name")
          const parts = page.title.split(": ");
          const type = parts.length > 1 ? parts[0] : "entity";
          const name = parts.length > 1 ? parts.slice(1).join(": ") : page.title;

          results.push({
            name,
            type,
            count: entityRefLinks.length,
            relatedPages: entityRefLinks.map(l => l.sourcePageId).slice(0, 10),
          });
        }
      }

      // Sort by mention count descending
      results.sort((a, b) => b.count - a.count);
      return results;
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Keyword highlight helpers
  // -----------------------------------------------------------------------

  /**
   * Wrap occurrences of keywords in the text with `<mark>` tags.
   */
  highlightKeywords(text: string, keywords: string[]): string {
    if (!text || keywords.length === 0) return text;

    let result = text;
    for (const kw of keywords) {
      // Case-insensitive replacement preserving original casing
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(${escaped})`, "gi");
      result = result.replace(regex, "<mark>$1</mark>");
    }
    return result;
  }

  /**
   * Extract highlight positions for each keyword occurrence in the text.
   */
  extractHighlights(
    text: string,
    keywords: string[],
  ): Array<{ text: string; position: number }> {
    if (!text || keywords.length === 0) return [];

    const highlights: Array<{ text: string; position: number }> = [];

    for (const kw of keywords) {
      const lowerText = text.toLowerCase();
      const lowerKw = kw.toLowerCase();
      let pos = lowerText.indexOf(lowerKw);
      while (pos !== -1) {
        highlights.push({
          text: text.substring(pos, pos + kw.length),
          position: pos,
        });
        pos = lowerText.indexOf(lowerKw, pos + 1);
      }
    }

    // Sort by position
    highlights.sort((a, b) => a.position - b.position);
    return highlights;
  }

  // -----------------------------------------------------------------------
  // Two-stage strategy search: Abstract → Structure
  // -----------------------------------------------------------------------

  /**
   * Two-stage search strategy:
   *  Stage 1: Search Abstract pages to identify relevant documents
   *  Stage 2: Search Structure pages within those documents for precise results
   *
   * This provides better relevance by first narrowing to relevant documents,
   * then finding the most specific section matches.
   */
  async searchByStrategy(
    query: string,
    kbIds: string[],
    options?: {
      topK?: number;
      strategy?: "abstract_then_structure" | "structure_only" | "all_layers";
    },
  ): Promise<SearchResult[]> {
    const { topK = 10, strategy = "abstract_then_structure" } = options ?? {};

    if (strategy === "structure_only") {
      return this.search(query, { kbIds, topK, pageTypes: ["structure"] });
    }

    if (strategy === "all_layers") {
      return this.search(query, { kbIds, topK, pageTypes: ["abstract", "structure", "fulltext"] });
    }

    // Two-stage: Abstract → Structure
    // Stage 1: Find relevant documents via abstract pages
    const abstractResults = await this.search(query, {
      kbIds,
      topK: Math.min(topK, 5),
      pageTypes: ["abstract"],
    });

    if (abstractResults.length === 0) {
      // Fallback: search structure directly
      return this.search(query, { kbIds, topK, pageTypes: ["structure"] });
    }

    // Extract relevant docIds from abstract results
    const relevantDocIds = new Set(
      abstractResults
        .filter((r) => r.docId)
        .map((r) => r.docId!),
    );

    // Stage 2: Search structure pages within relevant documents
    const structureResults = await this.search(query, {
      kbIds,
      topK,
      pageTypes: ["structure"],
    });

    // Prioritize results from relevant documents
    const prioritized = [
      ...structureResults.filter((r) => r.docId && relevantDocIds.has(r.docId)),
      ...structureResults.filter((r) => !r.docId || !relevantDocIds.has(r.docId)),
    ];

    return prioritized.slice(0, topK);
  }
}
