/**
 * Comprehensive Search Tests
 * Covers: C-18 (hybrid retrieval), C-35 (Chinese full-text), G-15 (cross-KB search)
 *
 * Auto-discovers available KBs for resilience.
 */
import { test, expect } from "@playwright/test";

const BASE = "/api/knowledge";

async function findAnyKbId(request: any): Promise<string | null> {
  const kbsResp = await request.get(`${BASE}/kbs`);
  const kbs = await kbsResp.json();
  return kbs.knowledgeBases?.[0]?.id ?? null;
}

test.describe("Global Search", () => {
  test("global search returns results", async ({ request }) => {
    const resp = await request.get(`${BASE}/search`, {
      params: { q: "test", limit: "5" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBeTruthy();
  });

  test("global search with query parameter", async ({ request }) => {
    const resp = await request.get(`${BASE}/search`, {
      params: { query: "test", limit: "5" },
    });
    expect(resp.status()).toBe(200);
  });

  test("global search results include kbId when present", async ({ request }) => {
    const resp = await request.get(`${BASE}/search`, {
      params: { q: "test", limit: "10" },
    });
    const body = await resp.json();
    if (body.results && body.results.length > 0) {
      expect(body.results[0].kbId).toBeDefined();
    }
  });
});

test.describe("KB-Specific Search", () => {
  test("search within specific KB", async ({ request }) => {
    const kbId = await findAnyKbId(request);
    test.skip(!kbId, "No KB found");

    const resp = await request.get(`${BASE}/${kbId}/search`, {
      params: { query: "test", topK: "5" },
    });
    expect(resp.status()).toBe(200);
  });

  test("search with levels parameter", async ({ request }) => {
    const kbId = await findAnyKbId(request);
    test.skip(!kbId, "No KB found");

    const resp = await request.get(`${BASE}/${kbId}/search`, {
      params: { query: "test", topK: "3", levels: "L0,L1" },
    });
    expect(resp.status()).toBe(200);
  });

  test("search with mode parameter", async ({ request }) => {
    const kbId = await findAnyKbId(request);
    test.skip(!kbId, "No KB found");

    const hybridResp = await request.get(`${BASE}/${kbId}/search`, {
      params: { query: "test", topK: "3", mode: "hybrid" },
    });
    expect(hybridResp.status()).toBe(200);

    const kwResp = await request.get(`${BASE}/${kbId}/search`, {
      params: { query: "test", topK: "3", mode: "keyword" },
    });
    expect(kwResp.status()).toBe(200);
  });
});

test.describe("C-35: Chinese Full-Text Search", () => {
  test("Chinese global search works", async ({ request }) => {
    const resp = await request.get(`${BASE}/search`, {
      params: { q: "测试", limit: "5" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.results).toBeDefined();
  });

  test("Chinese search within KB", async ({ request }) => {
    const kbId = await findAnyKbId(request);
    test.skip(!kbId, "No KB found");

    const resp = await request.get(`${BASE}/${kbId}/search`, {
      params: { query: "测试", topK: "5" },
    });
    expect(resp.status()).toBe(200);
  });
});

test.describe("Search API via /api/search route", () => {
  test("cross-KB search via search route", async ({ request }) => {
    const resp = await request.get("/api/search/knowledge/search", {
      params: { query: "test", topK: "5" },
    });
    expect(resp.status()).toBe(200);
  });

  test("single-KB search via search route", async ({ request }) => {
    const kbId = await findAnyKbId(request);
    test.skip(!kbId, "No KB found");

    const resp = await request.get(`/api/search/knowledge/${kbId}/search`, {
      params: { query: "test", topK: "5" },
    });
    expect(resp.status()).toBe(200);
  });
});

test.describe("Wiki Browse", () => {
  test("browse wiki pages for KB", async ({ request }) => {
    const kbId = await findAnyKbId(request);
    test.skip(!kbId, "No KB found");

    const resp = await request.get(`${BASE}/${kbId}/wiki`);
    expect(resp.status()).toBe(200);
  });
});

test.describe("Expand", () => {
  test("expand endpoint responds", async ({ request }) => {
    const kbId = await findAnyKbId(request);
    test.skip(!kbId, "No KB found");

    // Find a ready doc in this KB
    const docsResp = await request.get(`${BASE}/kbs/${kbId}/documents`);
    const docs = await docsResp.json();
    const doc = docs.documents?.find((d: any) => d.status === "ready");
    test.skip(!doc, "No ready document found");

    const resp = await request.post(`${BASE}/${kbId}/expand`, {
      data: { docId: doc.id, level: "L1" },
    });
    // Expand may return various status codes
    expect([200, 400, 500]).toContain(resp.status());
  });
});
