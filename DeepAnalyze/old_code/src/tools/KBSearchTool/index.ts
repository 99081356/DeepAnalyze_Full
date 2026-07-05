// =============================================================================
// DeepAnalyze - Knowledge Base Search Tool
// Provides semantic and keyword search across the knowledge base wiki pages.
// Wraps the Retriever's fusion search functionality.
// =============================================================================

import type { Retriever, SearchResult, SearchOptions } from "../../wiki/retriever.js";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface KBSearchInput {
  /** The search query text. */
  query: string;
  /** Knowledge base IDs to search within. If empty, searches all KBs. */
  kbIds?: string[];
  /** Maximum number of results to return (default 10). */
  topK?: number;
  /** Filter results to specific page types (e.g. ["abstract", "overview"]). */
  pageTypes?: string[];
  /** Page ID to start link traversal from (adds linked results). */
  linkedFrom?: string;
  /** Minimum score threshold (0-1). */
  minScore?: number;
}

export interface KBSearchOutput {
  /** The search results. */
  results: SearchResult[];
  /** Total number of results before topK truncation. */
  totalMatches: number;
  /** The search query used. */
  query: string;
}

// ---------------------------------------------------------------------------
// KBSearchTool
// ---------------------------------------------------------------------------

export class KBSearchTool {
  readonly name = "kb_search";
  readonly description =
    "使用语义向量搜索、关键词匹配（BM25）和链接遍历的组合来搜索知识库。" +
    "结果通过倒数排名融合（Reciprocal Rank Fusion）合并，实现最优相关性排序。";

  private retriever: Retriever;

  constructor(retriever: Retriever) {
    this.retriever = retriever;
  }

  /**
   * Execute a knowledge base search.
   */
  async execute(input: KBSearchInput): Promise<KBSearchOutput> {
    const options: SearchOptions = {
      kbIds: input.kbIds ?? [],
      topK: input.topK ?? 10,
      linkedFrom: input.linkedFrom,
      pageTypes: input.pageTypes,
      minScore: input.minScore,
    };

    // If no kbIds specified, get all knowledge base IDs from the DB
    if (options.kbIds.length === 0) {
      options.kbIds = await this.getAllKbIds();
    }

    const results = await this.retriever.search(input.query, options);

    return {
      results,
      totalMatches: results.length,
      query: input.query,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Get all knowledge base IDs from the database.
   */
  private async getAllKbIds(): Promise<string[]> {
    const { getRepos } = await import("../../store/repos/index.js");
    const repos = await getRepos();
    const kbs = await repos.knowledgeBase.list();
    return kbs.map((kb) => kb.id);
  }
}
