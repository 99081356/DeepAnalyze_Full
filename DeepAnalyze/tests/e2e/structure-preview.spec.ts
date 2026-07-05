/**
 * Structure Preview + Structure Map + Layer Previews
 * Covers: C-09 (Structure layer), C-38 (L1 preview), C-21 (anchor access)
 *
 * Tests auto-discover available KBs for resilience.
 */
import { test, expect } from "@playwright/test";

const PREVIEW = "/api/preview";
const BASE = "/api/knowledge";

async function findKbWithReadyDoc(request: any, fileTypes?: string[]): Promise<{ kbId: string; docId: string } | null> {
  const kbsResp = await request.get(`${BASE}/kbs`);
  const kbs = await kbsResp.json();
  for (const kb of kbs.knowledgeBases || []) {
    const docsResp = await request.get(`${BASE}/kbs/${kb.id}/documents`);
    if (docsResp.status() !== 200) continue;
    const docs = await docsResp.json();
    if (fileTypes) {
      // Only match specified file types
      for (const ft of fileTypes) {
        const doc = docs.documents?.find((d: any) => d.status === "ready" && d.file_type === ft);
        if (doc) return { kbId: kb.id, docId: doc.id };
      }
    } else {
      // No filter — return any ready doc
      const doc = docs.documents?.find((d: any) => d.status === "ready");
      if (doc) return { kbId: kb.id, docId: doc.id };
    }
  }
  return null;
}

test.describe("Structure Preview", () => {
  test("structure preview returns non-empty chunks for ready documents", async ({ request }) => {
    // Prefer document types that are likely to have structure pages
    const found = await findKbWithReadyDoc(request, ["pdf", "docx"]);
    test.skip(!found, "No KB with ready PDF/DOCX documents found");

    const resp = await request.get(
      `${PREVIEW}/kbs/${found.kbId}/documents/${found.docId}/preview/structure`,
    );
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.chunks).toBeDefined();
    expect(Array.isArray(body.chunks)).toBeTruthy();
    expect(body.chunks.length).toBeGreaterThan(0);

    const chunk = body.chunks[0];
    expect(chunk.id).toBeDefined();
    expect(chunk.title).toBeDefined();
  });

  test("structure chunk detail accessible via chunkId", async ({ request }) => {
    const found = await findKbWithReadyDoc(request, ["pdf", "docx", "txt", "md"]);
    test.skip(!found, "No KB with ready documents found");

    const listResp = await request.get(
      `${PREVIEW}/kbs/${found.kbId}/documents/${found.docId}/preview/structure`,
    );
    const list = await listResp.json();
    test.skip(!list.chunks?.length, "No structure chunks found");
    const chunkId = list.chunks[0].id;

    const detailResp = await request.get(
      `${PREVIEW}/kbs/${found.kbId}/documents/${found.docId}/preview/structure?chunkId=${chunkId}`,
    );
    expect(detailResp.status()).toBe(200);
    const detail = await detailResp.json();
    expect(detail.chunk).toBeDefined();
    expect(detail.chunk.id).toBe(chunkId);
  });
});

test.describe("Structure Map", () => {
  test("structure map returns data for ready documents", async ({ request }) => {
    const found = await findKbWithReadyDoc(request, ["pdf", "docx", "txt", "md"]);
    test.skip(!found, "No KB with ready documents found");

    const resp = await request.get(
      `${PREVIEW}/kbs/${found.kbId}/documents/${found.docId}/structure-map`,
    );
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.structureMap).toBeDefined();
    expect(Array.isArray(body.structureMap)).toBeTruthy();
    expect(body.structureMap.length).toBeGreaterThan(0);

    const entry = body.structureMap[0];
    expect(entry.id).toBeDefined();
    expect(entry.title).toBeDefined();
  });
});

test.describe("Layer Previews", () => {
  test("abstract preview returns content", async ({ request }) => {
    const found = await findKbWithReadyDoc(request);
    test.skip(!found, "No KB with ready documents found");

    const resp = await request.get(
      `${PREVIEW}/kbs/${found.kbId}/documents/${found.docId}/preview/abstract`,
    );
    expect(resp.status()).toBe(200);
  });

  test("raw preview returns data or graceful 404", async ({ request }) => {
    const found = await findKbWithReadyDoc(request);
    test.skip(!found, "No KB with ready documents found");

    const resp = await request.get(
      `${PREVIEW}/kbs/${found.kbId}/documents/${found.docId}/preview/raw`,
    );
    expect([200, 404]).toContain(resp.status());
  });
});

test.describe("Anchor Detail", () => {
  test("non-existent anchor returns 404", async ({ request }) => {
    const resp = await request.get(`${PREVIEW}/anchors/00000000-0000-0000-0000-000000000000`);
    expect(resp.status()).toBe(404);
  });
});
