// =============================================================================
// DeepAnalyze - Search Test API Routes
// Compare different search methods (vector, BM25, grep) with RRF fusion.
// =============================================================================

import { Hono } from "hono";
import { getRepos } from "../../store/repos/index.js";
import { getEmbeddingManager } from "../../models/embedding.js";
import { DisplayResolver } from "../../services/display-resolver.js";

interface SearchTestRequest {
  query: string;
  kbIds: string[];
  docIds?: string[];
  methods: ("vector" | "bm25" | "grep")[];
  layer: "abstract" | "structure";
  topK: number;
}

export function createSearchTestRoutes(): Hono {
  const app = new Hono();

  // =====================================================================
  // POST /test - Execute search with multiple methods and fuse results
  // =====================================================================

  app.post("/test", async (c) => {
    const body = await c.req.json<SearchTestRequest>();
    const { query, kbIds, methods, layer, topK } = body;
    const repos = await getRepos();

    const results: Record<string, SearchResultItem[]> = {};

    // Execute each method independently
    if (methods.includes("vector")) {
      try {
        const embeddingManager = getEmbeddingManager();
        const queryVector = await embeddingManager.embed(query);
        const vectorResults = await repos.vectorSearch.searchByVector(queryVector as unknown as Float32Array, kbIds, {
          topK,
          pageTypes: [layer],
        });
        results.vector = vectorResults.map((r) => ({
          pageId: r.page_id,
          docId: r.doc_id ?? "",
          title: r.title,
          score: r.similarity,
          snippet: r.text_chunk?.slice(0, 200),
        }));
      } catch {
        results.vector = [];
      }
    }

    if (methods.includes("bm25")) {
      try {
        const ftsResults = await repos.ftsSearch.searchByText(query, kbIds, { topK });
        results.bm25 = ftsResults.map((r) => ({
          pageId: r.id,
          docId: r.doc_id ?? "",
          title: r.title,
          score: r.rank,
        }));
      } catch {
        results.bm25 = [];
      }
    }

    if (methods.includes("grep")) {
      // Grep search: return empty for now (needs file system access)
      results.grep = [];
    }

    // RRF fusion if multiple methods
    let fused: SearchResultItem[] | null = null;
    if (methods.length > 1) {
      fused = reciprocalRankFusion(results, topK);
    }

    // Inject display names
    const displayResolver = new DisplayResolver();
    const allDocIds = new Set<string>();
    Object.values(results).forEach((arr) =>
      arr.forEach((r) => { if (r.docId) allDocIds.add(r.docId); }),
    );
    const displayMap = await displayResolver.resolveBatch([...allDocIds]);

    const enrich = (r: SearchResultItem) => ({
      ...r,
      originalName: displayMap[r.docId]?.originalName ?? r.docId,
      kbName: displayMap[r.docId]?.kbName ?? "",
    });

    return c.json({
      results: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, v.map(enrich)]),
      ),
      fused: fused?.map(enrich) ?? null,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Types & Helpers
// ---------------------------------------------------------------------------

interface SearchResultItem {
  pageId: string;
  docId: string;
  title: string;
  score: number;
  snippet?: string;
  rrfScore?: number;
}

function reciprocalRankFusion(
  results: Record<string, SearchResultItem[]>,
  topK: number,
  k = 60,
): SearchResultItem[] {
  const scores = new Map<string, { item: SearchResultItem; score: number }>();

  for (const items of Object.values(results)) {
    items.forEach((item, rank) => {
      const key = item.pageId;
      const prev = scores.get(key);
      const rrfScore = 1 / (k + rank + 1);
      if (prev) {
        prev.score += rrfScore;
      } else {
        scores.set(key, { item, score: rrfScore });
      }
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ item, score }) => ({ ...item, rrfScore: score }));
}
