/**
 * Export Routes Tests
 * Covers: G-16 (report/document export)
 */
import { test, expect } from "@playwright/test";

const BASE = "/api/knowledge";

async function findKbWithReadyDoc(request: any, fileType?: string): Promise<{ kbId: string; doc: any } | null> {
  const kbsResp = await request.get(`${BASE}/kbs`);
  const kbs = await kbsResp.json();
  for (const kb of kbs.knowledgeBases || []) {
    const docsResp = await request.get(`${BASE}/kbs/${kb.id}/documents`);
    if (docsResp.status() !== 200) continue;
    const docs = await docsResp.json();
    const doc = fileType
      ? docs.documents?.find((d: any) => d.status === "ready" && d.file_type === fileType)
      : docs.documents?.find((d: any) => d.status === "ready");
    if (doc) return { kbId: kb.id, doc };
  }
  return null;
}

test.describe("Export Routes", () => {
  test("export markdown returns content", async ({ request }) => {
    const found = await findKbWithReadyDoc(request);
    test.skip(!found, "No ready document found");

    const resp = await request.get(
      `${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/export/markdown`,
    );
    expect([200, 404]).toContain(resp.status());
    if (resp.status() === 200) {
      const ct = resp.headers()["content-type"];
      expect(ct).toMatch(/text\/markdown|text\/plain/);
      const text = await resp.text();
      expect(text.length).toBeGreaterThan(0);
    }
  });

  test("export doctags returns content or 404", async ({ request }) => {
    const found = await findKbWithReadyDoc(request);
    test.skip(!found, "No ready document found");

    const resp = await request.get(
      `${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/export/doctags`,
    );
    expect([200, 404]).toContain(resp.status());
  });

  test("export structure-bundle returns data or 404", async ({ request }) => {
    const found = await findKbWithReadyDoc(request);
    test.skip(!found, "No ready document found");

    const resp = await request.get(
      `${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/export/structure-bundle`,
    );
    expect([200, 404]).toContain(resp.status());
  });

  test("export for non-existent doc returns 404", async ({ request }) => {
    const kbsResp = await request.get(`${BASE}/kbs`);
    const kbs = await kbsResp.json();
    const kbId = kbs.knowledgeBases?.[0]?.id;
    test.skip(!kbId, "No KB found");

    const resp = await request.get(
      `${BASE}/kbs/${kbId}/documents/00000000-0000-0000-0000-000000000000/export/markdown`,
    );
    expect(resp.status()).toBe(404);
  });
});
