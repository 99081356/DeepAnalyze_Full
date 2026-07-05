// =============================================================================
// DeepAnalyze - Unified Search API Routes
// Multi-level (L0/L1/L2) search with keyword highlighting and entity discovery.
// =============================================================================

import { Hono } from "hono";
import type { Retriever, SearchMode } from "../../wiki/retriever.js";

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createSearchRoutes(
  getRetriever: () => Promise<Retriever>,
): Hono {
  const app = new Hono();

  // =====================================================================
  // GET / - Search API root (API discoverability)
  // =====================================================================

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      message: "Unified Search API",
      endpoints: [
        "GET /knowledge/:kbId/search?query=...&topK=...&levels=L0,L1,L2&includeEntities=true&docId=...&mode=hybrid",
        "GET /knowledge/search?query=...&kbIds=...&topK=...&levels=L0,L1,L2&mode=hybrid",
      ],
    });
  });

  // =====================================================================
  // GET /knowledge/search - Cross-KB search
  // =====================================================================

  app.get("/knowledge/search", async (c) => {
    const query = decodeURIComponent(
      c.req.query("query") || c.req.query("q") || "",
    );
    const topK = parseInt(c.req.query("topK") || "10", 10);
    const kbIdsParam = c.req.query("kbIds");
    const levelsParam = c.req.query("levels");
    const modeParam = c.req.query("mode");

    if (!query.trim()) {
      return c.json(
        { error: "query parameter is required (use ?query=... or ?q=...)" },
        400,
      );
    }

    // Resolve KB IDs
    let kbIds: string[];
    if (kbIdsParam) {
      kbIds = kbIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      // Default to all knowledge bases
      try {
        const { getRepos } = await import("../../store/repos/index.js");
        const repos = await getRepos();
        const allKbs = await repos.knowledgeBase.list();
        kbIds = allKbs.map((kb) => kb.id);
      } catch {
        return c.json({ error: "Failed to list knowledge bases" }, 500);
      }
    }

    if (kbIds.length === 0) {
      return c.json({ results: {}, totalFound: 0 });
    }

    try {
      const retriever = await getRetriever();
      const requestedLevels = levelsParam
        ? levelsParam.split(",").map((l) => l.trim())
        : ["L0", "L1", "L2"];

      const result = await retriever.searchByLevels(query, kbIds, {
        topK,
        levels: requestedLevels,
        mode: modeParam as SearchMode | undefined,
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
    } catch (err) {
      console.error("[Search] Cross-KB search failed:", err);
      return c.json(
        {
          error: "Search failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  // =====================================================================
  // GET /knowledge/:kbId/search - Multi-level search with highlighting
  // =====================================================================

  app.get("/knowledge/:kbId/search", async (c) => {
    const kbId = c.req.param("kbId");
    const query = decodeURIComponent(
      c.req.query("query") || c.req.query("q") || "",
    );
    const topK = parseInt(c.req.query("topK") || "10", 10);
    const levelsParam = c.req.query("levels"); // e.g. "L0,L1" or "L0"
    const includeEntities = c.req.query("includeEntities") === "true";
    const docId = c.req.query("docId") || undefined;
    const modeParam = c.req.query("mode");

    if (!query.trim()) {
      return c.json(
        { error: "query parameter is required (use ?query=... or ?q=...)" },
        400,
      );
    }

    try {
      const retriever = await getRetriever();

      const requestedLevels = levelsParam
        ? levelsParam.split(",").map((l) => l.trim())
        : ["L0", "L1", "L2"];

      const result = await retriever.searchByLevels(query, [kbId], {
        topK,
        includeEntities,
        docId,
        levels: requestedLevels,
        mode: modeParam as SearchMode | undefined,
      });

      // Filter by requested levels if specified

      const filtered: Record<string, unknown> = {};
      if (requestedLevels.includes("L0")) filtered.L0 = result.L0;
      if (requestedLevels.includes("L1")) filtered.L1 = result.L1;
      if (requestedLevels.includes("L2")) filtered.L2 = result.L2;

      // Only include entities if requested
      if (includeEntities) {
        filtered.entities = result.entities;
      }

      return c.json({
        query,
        kbId,
        results: filtered,
        totalFound:
          (requestedLevels.includes("L0") ? (result.L0?.length ?? 0) : 0) +
          (requestedLevels.includes("L1") ? (result.L1?.length ?? 0) : 0) +
          (requestedLevels.includes("L2") ? (result.L2?.length ?? 0) : 0),
      });
    } catch (err) {
      console.error("[Search] Multi-level search failed:", err);
      return c.json(
        {
          error: "Search failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  return app;
}
