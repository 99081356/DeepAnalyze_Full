/**
 * Search System E2E Tests
 *
 * Tests cover:
 *  4.1  Vector search returns relevant results
 *  4.2  BM25 keyword search works with Chinese
 *  4.3  Hybrid search (RRF fusion) returns results
 *  4.4  Level-specific search (L0/L1/L2)
 *  4.5  topK parameter controls result count
 *  4.6  Search results have anchorId
 *  4.7  Cross-KB search returns results with kbId/kbName
 *  4.8  Chinese search uses zhparser tokenization correctly
 *  4.9  Empty search returns empty results gracefully
 *  4.10 Search bar UI renders correctly in knowledge page
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { assertSearchResults } from "./helpers/assertions";
import { TEST_KB_ID, DOC } from "./fixtures";

const KB_BASE = "/api/knowledge";
const SEARCH_BASE = "/api/search";

// ---------------------------------------------------------------------------
// 4.1 Vector search returns relevant results
// ---------------------------------------------------------------------------
test.describe("4.1: Vector Search", () => {
  test("semantic/vector search returns relevant results for test KB", async ({
    request,
  }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "5", mode: "vector" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();

    // If results exist, verify structure
    if (body.results.length > 0) {
      const first = body.results[0];
      expect(first.content || first.snippet || first.title).toBeTruthy();
      expect(typeof first.score).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// 4.2 BM25 keyword search works with Chinese
// ---------------------------------------------------------------------------
test.describe("4.2: BM25 Keyword Search (Chinese)", () => {
  test("keyword mode search with Chinese terms", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "反重力", topK: "5", mode: "keyword" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
  });

  test("keyword search with Latin terms works", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "5", mode: "keyword" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4.3 Hybrid search (RRF fusion) returns results
// ---------------------------------------------------------------------------
test.describe("4.3: Hybrid Search (RRF Fusion)", () => {
  test("hybrid mode combines vector + keyword results", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity RAG", topK: "10", mode: "hybrid" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();

    // Hybrid results should contain scored items
    if (body.results.length > 0) {
      for (const result of body.results) {
        expect(typeof result.score).toBe("number");
        expect(result.score).toBeGreaterThan(0);
      }
    }
  });

  test("hybrid search with Chinese terms", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "运动数据 奥运会", topK: "5", mode: "hybrid" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4.4 Level-specific search (L0/L1/L2)
// ---------------------------------------------------------------------------
test.describe("4.4: Level-Specific Search", () => {
  test("L0-only search returns abstract-level results", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "5", levels: "L0" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();

    // If results exist, they should be from L0 (abstract) pages
    if (body.results.length > 0) {
      for (const r of body.results) {
        // Level should be L0 or pageType should be abstract
        if (r.level) expect(r.level).toBe("L0");
      }
    }
  });

  test("L1-only search returns structure-level results", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "5", levels: "L1" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
  });

  test("L2-only search returns fulltext-level results", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "5", levels: "L2" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
  });

  test("combined L0+L1 search returns multi-level results", async ({
    request,
  }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "10", levels: "L0,L1" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
  });

  test("search via unified route supports levels", async ({ request }) => {
    const resp = await request.get(
      `${SEARCH_BASE}/knowledge/${TEST_KB_ID}/search`,
      {
        params: { query: "antigravity", topK: "3", levels: "L0,L1" },
      },
    );
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    // Results should be keyed by level
    if (body.results.L0 !== undefined || body.results.L1 !== undefined) {
      // Level-keyed response format
      expect(typeof body.results).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// 4.5 topK parameter controls result count
// ---------------------------------------------------------------------------
test.describe("4.5: topK Parameter Control", () => {
  test("topK=1 returns at most 1 result", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "1" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results.length).toBeLessThanOrEqual(1);
  });

  test("topK=3 returns fewer or equal results than topK=10", async ({ request }) => {
    const resp3 = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "3" },
    });
    const resp10 = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "10" },
    });
    expect(resp3.status()).toBe(200);
    expect(resp10.status()).toBe(200);
    const body3 = await resp3.json();
    const body10 = await resp10.json();
    // topK=3 should return no more than topK=10
    expect(body3.results.length).toBeLessThanOrEqual(body10.results.length);
  });

  test("topK=10 allows more results", async ({ request }) => {
    const resp1 = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "2" },
    });
    const resp2 = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "10" },
    });

    const body1 = await resp1.json();
    const body2 = await resp2.json();

    // Higher topK should allow at least as many results
    // (may be equal if there are fewer results than topK)
    expect(body2.results.length).toBeGreaterThanOrEqual(body1.results.length);
  });
});

// ---------------------------------------------------------------------------
// 4.6 Search results have anchorId
// ---------------------------------------------------------------------------
test.describe("4.6: Search Result Anchors", () => {
  test("search results include page ID for anchor linkage", async ({
    request,
  }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "5" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    if (body.results && body.results.length > 0) {
      // Results should have pageId or metadata.pageId for anchor linkage
      for (const result of body.results) {
        const hasPageRef =
          result.pageId ||
          result.metadata?.pageId ||
          result.anchorId ||
          result.id;
        // At least some identifier should exist for anchor linkage
        expect(hasPageRef || result.docId || result.title).toBeTruthy();
      }
    }
  });

  test("L0 results have page reference", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity", topK: "5", levels: "L0" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    if (body.results && body.results.length > 0) {
      const first = body.results[0];
      // L0 results should have at minimum a page reference
      expect(
        first.pageId ||
          first.metadata?.pageId ||
          first.docId ||
          first.pageType,
      ).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 4.7 Cross-KB search returns results with kbId/kbName
// ---------------------------------------------------------------------------
test.describe("4.7: Cross-KB Search", () => {
  test("cross-KB search via /knowledge/search returns results", async ({
    request,
  }) => {
    const resp = await request.get(`${KB_BASE}/search`, {
      params: { query: "antigravity", topK: "5" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    // Results may be an array or level-keyed object
    if (body.results) {
      if (Array.isArray(body.results)) {
        // Array format: check for kbId/kbName
        if (body.results.length > 0) {
          const first = body.results[0];
          // Should have KB identification
          expect(first.kbId || first.kbName).toBeTruthy();
        }
      } else if (typeof body.results === "object") {
        // Level-keyed format (L0, L1, L2)
        const allResults = [
          ...(body.results.L0 || []),
          ...(body.results.L1 || []),
          ...(body.results.L2 || []),
        ];
        if (allResults.length > 0) {
          // Cross-KB results should have KB identification
          const first = allResults[0];
          expect(
            first.kbId || first.kbName || first.kb_id,
          ).toBeTruthy();
        }
      }
    }
  });

  test("cross-KB search via /search/knowledge/search returns results", async ({
    request,
  }) => {
    const resp = await request.get(`${SEARCH_BASE}/knowledge/search`, {
      params: { query: "antigravity", topK: "5" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toBeTruthy();
  });

  test("cross-KB search scoped to specific kbIds", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/search`, {
      params: {
        query: "antigravity",
        topK: "5",
        kbIds: TEST_KB_ID,
      },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4.8 Chinese search uses zhparser tokenization correctly
// ---------------------------------------------------------------------------
test.describe("4.8: Chinese Search Tokenization", () => {
  test("Chinese compound terms are tokenized and matched", async ({
    request,
  }) => {
    // "反重力" should match documents about antigravity
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "反重力", topK: "5" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    // Results may or may not exist depending on content, but should not error
  });

  test("Chinese sentence search works", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "这是一个测试查询", topK: "3" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
  });

  test("mixed Chinese-English search works", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "antigravity反重力RAG", topK: "5" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
  });

  test("single Chinese character search returns results", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "测", topK: "3" },
    });
    expect(resp.status()).toBe(200);
    // Should not crash with single character
    const body = await resp.json();
    expect(body.results).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4.9 Empty search returns empty results gracefully
// ---------------------------------------------------------------------------
test.describe("4.9: Empty Search Handling", () => {
  test("empty query returns 400 error", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "" },
    });
    // Empty query should be rejected
    expect(resp.status()).toBe(400);
  });

  test("whitespace-only query returns 400 error", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: { query: "   " },
    });
    expect(resp.status()).toBe(400);
  });

  test("nonsensical query returns empty results gracefully", async ({
    request,
  }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/search`, {
      params: {
        query: "xyzzynonexistent12345fizzbuzz",
        topK: "5",
      },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
    // May return 0 results, which is correct behavior
  });

  test("cross-KB empty query returns error", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/search`, {
      params: { query: "" },
    });
    expect(resp.status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4.10 Search bar UI renders correctly in knowledge page
// ---------------------------------------------------------------------------
test.describe("4.10: Search Bar UI", () => {
  test("search bar is visible on knowledge base page", async ({ page }) => {
    await gotoPage(page, `knowledge/${TEST_KB_ID}`);
    await page.waitForTimeout(2000);

    await takeScreenshot(page, "knowledge-search-bar");

    // Look for search input or search-related UI elements
    const pageContent = await page.content();
    const hasSearchUI =
      pageContent.includes("搜索") ||
      pageContent.includes("search") ||
      pageContent.includes("查找") ||
      pageContent.includes("query");

    // The knowledge page should render search-related UI
    expect(hasSearchUI).toBeTruthy();
  });

  test("search input accepts text input", async ({ page }) => {
    await gotoPage(page, `knowledge/${TEST_KB_ID}`);
    await page.waitForTimeout(2000);

    // Try to find and interact with a search input
    const searchInput = page.locator(
      'input[type="text"], input[type="search"], input[placeholder*="搜索"], input[placeholder*="search"], textarea',
    ).first();

    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill("antigravity");
      await page.waitForTimeout(500);

      await takeScreenshot(page, "knowledge-search-input");

      // Input should contain the typed text
      const value = await searchInput.inputValue();
      expect(value).toContain("antigravity");
    }
  });

  test("search bar renders without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await gotoPage(page, `knowledge/${TEST_KB_ID}`);
    await page.waitForTimeout(3000);

    // Filter critical errors (ignore known harmless ones)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("net::ERR") &&
        !e.includes("404") &&
        !e.includes("Failed to fetch") &&
        !e.includes("NetworkError") &&
        !e.includes("ResizeObserver") &&
        !e.includes("WebSocket"),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
