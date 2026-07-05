// =============================================================================
// DeepAnalyze - Search Result Index
// =============================================================================
// Lightweight index of search results that persists across compaction.
// Provides a summary of what has been searched and found, so the model
// doesn't re-search the same queries after context compression.
// =============================================================================

const INDEXED_TOOLS = new Set([
  "kb_search", "web_search", "doc_grep", "wiki_browse", "expand",
]);

interface SearchResultEntry {
  query: string;
  toolName: string;
  resultCount: number;
  docTitles: string[];
  snippets: string[];
  timestamp: number;
}

export class SearchResultIndex {
  private entries: SearchResultEntry[] = [];
  private readonly maxEntries = 100;

  /**
   * Record a search result in the index.
   */
  addEntry(query: string, toolName: string, result: unknown): boolean {
    if (!INDEXED_TOOLS.has(toolName)) return false;
    if (!query || query.trim().length === 0) return false;

    const isDuplicate = this.hasSearched(query);

    // Extract result count and document titles from the result
    let resultCount = 0;
    const docTitles: string[] = [];
    const snippets: string[] = [];

    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      // Extract count
      if (typeof r.total === "number") resultCount = r.total;
      else if (Array.isArray(r.results)) resultCount = r.results.length;
      else if (Array.isArray(r.matches)) resultCount = r.matches.length;
      else if (Array.isArray(r.pages)) resultCount = r.pages.length;

      // Extract document titles (up to 5)
      const items = (r.results as Array<Record<string, unknown>> | undefined) ??
                    (r.pages as Array<Record<string, unknown>> | undefined) ??
                    (r.matches as Array<Record<string, unknown>> | undefined) ?? [];
      for (const item of items.slice(0, 5)) {
        const title = (item.title as string) ?? (item.name as string) ?? (item.pageId as string);
        if (title) docTitles.push(title);
      }

      // Extract snippets (up to 5, each truncated to 100 characters)
      for (const item of items.slice(0, 5)) {
        const text = (item.snippet as string) ?? (item.content as string) ?? (item.text as string) ?? (item.summary as string);
        if (text) snippets.push(text.slice(0, 100));
      }
    }

    this.entries.push({
      query: query.trim(),
      toolName,
      resultCount,
      docTitles,
      snippets,
      timestamp: Date.now(),
    });

    // Evict oldest if over limit
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return isDuplicate;
  }

  /**
   * Check if a query has already been searched (exact match).
   */
  hasSearched(query: string): boolean {
    const q = query.trim().toLowerCase();
    return this.entries.some(e => e.query.toLowerCase() === q);
  }

  /**
   * Get all indexed entries.
   */
  getEntries(): ReadonlyArray<SearchResultEntry> {
    return this.entries;
  }

  /**
   * Generate a summary string for injection into session memory.
   */
  getSummary(): string {
    if (this.entries.length === 0) return "";
    const lines = this.entries.map(e => {
      const titles = e.docTitles.length > 0
        ? ": " + e.docTitles.slice(0, 3).join(", ")
        : "";
      return `- ${e.toolName}("${e.query}") → ${e.resultCount} results${titles}`;
    });
    return "## Search History\n" + lines.join("\n");
  }

  /**
   * Generate a richer summary including snippets for injection into session memory.
   */
  getDetailedSummary(): string {
    if (this.entries.length === 0) return "";
    const lines = this.entries.map(e => {
      const titles = e.docTitles.length > 0
        ? ": " + e.docTitles.slice(0, 3).join(", ")
        : "";
      const snippetStr = e.snippets.length > 0
        ? "\n  摘要: " + e.snippets[0]!
        : "";
      return `- ${e.toolName}("${e.query}") → ${e.resultCount} results${titles}${snippetStr}`;
    });
    return "## Search History (Detailed)\n" + lines.join("\n");
  }

  /**
   * Get all unique query keywords as a newline-separated list.
   */
  getKeywordList(): string {
    const keywords = [...new Set(this.entries.map(e => e.query.toLowerCase()))];
    if (keywords.length === 0) return "";
    return "## 已搜索关键词\n" + keywords.map(k => `- ${k}`).join("\n");
  }

  /**
   * Total number of indexed entries.
   */
  get count(): number {
    return this.entries.length;
  }

  /**
   * Restore entries from a previously serialized JSON string.
   * Used to reconstruct the index from persisted session memory.
   */
  restoreEntries(json: string): void {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (entry && typeof entry.query === "string" && typeof entry.toolName === "string") {
          this.entries.push({
            query: entry.query,
            toolName: entry.toolName,
            resultCount: typeof entry.resultCount === "number" ? entry.resultCount : 0,
            docTitles: Array.isArray(entry.docTitles) ? entry.docTitles : [],
            snippets: Array.isArray(entry.snippets) ? entry.snippets : [],
            timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
          });
        }
      }
      // Trim to maxEntries
      while (this.entries.length > this.maxEntries) {
        this.entries.shift();
      }
    } catch {
      // Invalid JSON — start with empty index
    }
  }
}
