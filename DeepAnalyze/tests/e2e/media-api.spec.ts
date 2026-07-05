/**
 * Media Content-Type + Range Request + Download + Thumbnail
 * Covers: BUG-1 (Content-Type), C-17 (media preview), C-39 (media player)
 */
import { test, expect } from "@playwright/test";

const BASE = "/api/knowledge";

interface DocInfo { kbId: string; doc: any }

async function findDoc(request: any, ...fileTypes: string[]): Promise<DocInfo | null> {
  const kbsResp = await request.get(`${BASE}/kbs`);
  const kbs = await kbsResp.json();
  for (const kb of kbs.knowledgeBases || []) {
    const docsResp = await request.get(`${BASE}/kbs/${kb.id}/documents`);
    if (docsResp.status() !== 200) continue;
    const docs = await docsResp.json();
    for (const ft of fileTypes) {
      const doc = docs.documents?.find((d: any) => d.status === "ready" && d.file_type === ft);
      if (doc) return { kbId: kb.id, doc };
    }
  }
  return null;
}

const MEDIA_EXPECT: Record<string, RegExp> = {
  jpg: /^image\/jpeg/,
  jpeg: /^image\/jpeg/,
  png: /^image\/png/,
  mp3: /^audio\/mpeg/,
  wav: /^audio\/wav/,
  mp4: /^video\/mp4/,
};

test.describe("BUG-1: Media Content-Type", () => {
  test("image has correct Content-Type", async ({ request }) => {
    const found = await findDoc(request, "jpg", "jpeg", "png");
    test.skip(!found, "No ready image document found");

    const resp = await request.get(`${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/original`);
    expect(resp.status()).toBe(200);
    const ct = resp.headers()["content-type"];
    expect(ct).toMatch(/^image\//);
    expect(resp.headers()["accept-ranges"]).toBe("bytes");
  });

  test("audio has correct Content-Type", async ({ request }) => {
    const found = await findDoc(request, "mp3", "wav", "flac");
    test.skip(!found, "No ready audio document found");

    const resp = await request.get(`${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/original`);
    expect(resp.status()).toBe(200);
    const ct = resp.headers()["content-type"];
    expect(ct).toMatch(/^audio\//);
  });

  test("video has correct Content-Type", async ({ request }) => {
    const found = await findDoc(request, "mp4");
    test.skip(!found, "No ready video document found");

    const resp = await request.get(`${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/original`);
    expect(resp.status()).toBe(200);
    const ct = resp.headers()["content-type"];
    expect(ct).toMatch(/^video\//);
  });
});

test.describe("Range Request Support", () => {
  test("partial content returns 206", async ({ request }) => {
    const found = await findDoc(request, "mp4", "mp3", "jpg");
    test.skip(!found, "No ready media document found");

    const resp = await request.get(`${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/original`, {
      headers: { Range: "bytes=0-1023" },
    });
    expect(resp.status()).toBe(206);
    expect(resp.headers()["content-range"]).toMatch(/^bytes 0-1023\/\d+$/);
    expect(resp.headers()["content-length"]).toBe("1024");
  });
});

test.describe("Download Route", () => {
  test("download returns attachment", async ({ request }) => {
    const found = await findDoc(request, "pdf", "mp3", "jpg");
    test.skip(!found, "No ready document found");

    const resp = await request.get(`${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/download`);
    expect(resp.status()).toBe(200);
    expect(resp.headers()["content-disposition"]).toContain("attachment");
  });

  test("download non-existent doc returns 404", async ({ request }) => {
    const found = await findDoc(request, "pdf");
    test.skip(!found, "No ready document found");

    const resp = await request.get(
      `${BASE}/kbs/${found.kbId}/documents/00000000-0000-0000-0000-000000000000/download`,
    );
    expect(resp.status()).toBe(404);
  });
});

test.describe("Thumbnail Route", () => {
  test("image thumbnail returns image data", async ({ request }) => {
    const found = await findDoc(request, "jpg", "jpeg", "png");
    test.skip(!found, "No ready image document found");

    const resp = await request.get(`${BASE}/kbs/${found.kbId}/documents/${found.doc.id}/thumbnail`);
    expect(resp.status()).toBe(200);
    expect(resp.headers()["content-type"]).toMatch(/^image\//);
  });
});
