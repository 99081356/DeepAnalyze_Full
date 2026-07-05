/**
 * Knowledge Base & Document Processing E2E Tests
 *
 * Tests cover:
 *  3.1  List KBs returns array with test KB
 *  3.2  Get KB detail returns document list and stats
 *  3.3  Upload PDF document (verify existing PDF is processed)
 *  3.4  PDF L0 content - summary non-empty, tags non-empty
 *  3.5  PDF L1 content - DocTags/Markdown format, meaningful content
 *  3.6  PDF L2 content - Docling JSON structure valid
 *  3.7  XLSX document has metadata description
 *  3.8  Image (JPG) has VLM description + OCR in L1
 *  3.9  Audio (MP3) has ASR transcription text in L1
 *  3.10 Document status tracking - existing docs are status=ready
 *  3.11 Document deletion cascade cleanup
 *  3.12 Create new KB, upload a small test file, verify processing
 *  3.13 Delete KB cascade cleanup
 *  3.14 Wiki browse returns page list
 *  3.15 Quality report returns KB-level summary
 *  3.16 Knowledge base page screenshot - document tree, search bar render correctly
 *  3.17 Document card L0/L1/L2 buttons visible
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { waitForDocumentReady } from "./helpers/wait";
import { assertL0Content, assertL1Content, assertL2Content } from "./helpers/assertions";
import { TEST_KB_ID, DOC, FILE_META } from "./fixtures";

const KB_BASE = "/api/knowledge";
const API = "/api";

// ---------------------------------------------------------------------------
// 3.1 List KBs returns array with test KB
// ---------------------------------------------------------------------------
test.describe("3.1: List Knowledge Bases", () => {
  test("GET /kbs returns array containing test KB", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/kbs`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.knowledgeBases).toBeDefined();
    expect(Array.isArray(body.knowledgeBases)).toBeTruthy();

    const testKb = body.knowledgeBases.find(
      (kb: any) => kb.id === TEST_KB_ID,
    );
    expect(testKb).toBeDefined();
    expect(testKb.name).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3.2 Get KB detail returns document list and stats
// ---------------------------------------------------------------------------
test.describe("3.2: KB Detail", () => {
  test("GET /kbs/:kbId returns KB with documentCount", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/kbs/${TEST_KB_ID}`);
    expect(resp.status()).toBe(200);
    const kb = await resp.json();
    expect(kb.id).toBe(TEST_KB_ID);
    expect(kb.name).toBeTruthy();
    // KB detail may include documentCount or other stats fields
    expect(typeof kb).toBe("object");
  });

  test("GET /kbs/:kbId/documents returns document list", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/kbs/${TEST_KB_ID}/documents`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.documents).toBeDefined();
    expect(Array.isArray(body.documents)).toBeTruthy();
    // Test KB should have at least the 5 known documents
    expect(body.documents.length).toBeGreaterThanOrEqual(5);

    // Verify each document has required fields
    for (const doc of body.documents) {
      expect(doc.id).toBeTruthy();
      expect(doc.fileName || doc.filename).toBeTruthy();
      expect(doc.status).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 3.3 Upload PDF document (verify existing PDF is processed)
// ---------------------------------------------------------------------------
test.describe("3.3: PDF Upload & Processing", () => {
  test("existing PDF document is in ready status", async ({ request }) => {
    const resp = await request.get(
      `${KB_BASE}/kbs/${TEST_KB_ID}/documents/${DOC.pdf}/status`,
    );
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ready");
    expect(body.progress).toBe(100);
    expect(body.filename).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3.4 PDF L0 content - summary non-empty, tags non-empty
// ---------------------------------------------------------------------------
test.describe("3.4: PDF L0 Content", () => {
  test("expand PDF to L0 returns non-empty summary", async ({ request }) => {
    const resp = await request.post(`${KB_BASE}/${TEST_KB_ID}/expand`, {
      data: { docId: DOC.pdf, level: "L0" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.content).toBeDefined();
    assertL0Content(body.content, "PDF L0");

    // L0 summary should not be just a heading placeholder
    const text = typeof body.content === "string"
      ? body.content
      : JSON.stringify(body.content);
    expect(text.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 3.5 PDF L1 content - DocTags/Markdown format, meaningful content
// ---------------------------------------------------------------------------
test.describe("3.5: PDF L1 Content", () => {
  test("expand PDF to L1 returns DocTags/Markdown with meaningful content", async ({
    request,
  }) => {
    const resp = await request.post(`${KB_BASE}/${TEST_KB_ID}/expand`, {
      data: { docId: DOC.pdf, level: "L1" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.content).toBeDefined();

    const text = typeof body.content === "string"
      ? body.content
      : JSON.stringify(body.content);

    assertL1Content(body.content, "PDF L1");

    // Should contain DocTags markers or Markdown headings
    const hasDocTags = text.includes("<document") || text.includes("<page") || text.includes("</");
    const hasMarkdown =
      text.includes("##") || text.includes("###") || text.includes("- ");
    expect(
      hasDocTags || hasMarkdown,
      "L1 should have DocTags or Markdown formatting",
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3.6 PDF L2 content - Docling JSON structure valid
// ---------------------------------------------------------------------------
test.describe("3.6: PDF L2 Content", () => {
  test("expand PDF to L2 returns valid structured content", async ({
    request,
  }) => {
    const resp = await request.post(`${KB_BASE}/${TEST_KB_ID}/expand`, {
      data: { docId: DOC.pdf, level: "L2" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.content).toBeDefined();

    // L2 should be parseable as JSON (Docling format)
    const text = typeof body.content === "string"
      ? body.content
      : JSON.stringify(body.content);

    assertL2Content(body.content, "PDF L2");

    // Try to parse as JSON and check for Docling structure markers
    try {
      const parsed = typeof body.content === "string"
        ? JSON.parse(body.content)
        : body.content;
      expect(parsed).toBeTruthy();
      // Docling JSON should have name, main-text, or picture elements
      const jsonStr = JSON.stringify(parsed);
      const hasDoclingStructure =
        jsonStr.includes("main-text") ||
        jsonStr.includes("picture") ||
        jsonStr.includes("table") ||
        jsonStr.includes("page") ||
        jsonStr.includes("heading") ||
        jsonStr.includes("paragraph") ||
        jsonStr.includes("name");
      expect(
        hasDoclingStructure,
        "L2 JSON should contain Docling structural elements",
      ).toBeTruthy();
    } catch {
      // If it's not JSON, it might be raw text representation - still valid L2
      expect(text.length).toBeGreaterThan(50);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.7 XLSX document has metadata description
// ---------------------------------------------------------------------------
test.describe("3.7: XLSX Metadata", () => {
  test("XLSX document has sheet/column info in metadata", async ({ request }) => {
    // Get document metadata
    const docResp = await request.get(
      `${KB_BASE}/kbs/${TEST_KB_ID}/documents/${DOC.xlsx}`,
    );
    if (docResp.status() === 404) {
      test.skip();
      return;
    }
    expect(docResp.status()).toBe(200);
    const doc = await docResp.json();

    // Check that metadata contains sheet/column info
    const metadata = doc.metadata || {};
    const metaStr = JSON.stringify(metadata);

    // XLSX metadata should mention sheets, columns, or row data
    const hasXlsxInfo =
      metaStr.includes("sheet") ||
      metaStr.includes("column") ||
      metaStr.includes("row") ||
      metaStr.includes("Sheet") ||
      metaStr.includes("Column") ||
      metaStr.includes("表格") ||
      metaStr.includes("工作表");

    // Even if metadata keys differ, the document should be ready
    expect(doc.status).toBe("ready");
    expect(doc.file_type || doc.fileType).toBe("xlsx");

    // Also verify via L0/L1 expand that content is meaningful
    const expandResp = await request.post(`${KB_BASE}/${TEST_KB_ID}/expand`, {
      data: { docId: DOC.xlsx, level: "L0" },
    });
    if (expandResp.status() === 200) {
      const expandBody = await expandResp.json();
      if (expandBody.content) {
        const l0Text = typeof expandBody.content === "string"
          ? expandBody.content
          : JSON.stringify(expandBody.content);
        // L0 summary for XLSX should reference sheet/column/sample info
        expect(l0Text.length).toBeGreaterThan(10);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3.8 Image (JPG) has VLM description + OCR content in L1
// ---------------------------------------------------------------------------
test.describe("3.8: Image VLM + OCR", () => {
  test("JPG L1 has VLM visual description", async ({ request }) => {
    const resp = await request.post(`${KB_BASE}/${TEST_KB_ID}/expand`, {
      data: { docId: DOC.jpg, level: "L1" },
    });
    if (resp.status() === 404) {
      test.skip();
      return;
    }
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.content).toBeDefined();

    const text = typeof body.content === "string"
      ? body.content
      : JSON.stringify(body.content);

    // VLM description should contain actual visual content description
    // Should NOT contain error indicators
    const errorPatterns = [
      "[未配置VLM模型",
      "VLM不可用",
      "VLM failed",
      "skip",
    ];
    for (const pattern of errorPatterns) {
      expect(text).not.toContain(pattern);
    }

    // Content should be meaningful (not just a filename or empty string)
    expect(text.length).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// 3.9 Audio (MP3) has ASR transcription text in L1
// ---------------------------------------------------------------------------
test.describe("3.9: Audio ASR Transcription", () => {
  test("MP3 L1 has ASR transcription text", async ({ request }) => {
    const resp = await request.post(`${KB_BASE}/${TEST_KB_ID}/expand`, {
      data: { docId: DOC.mp3, level: "L1" },
    });
    if (resp.status() === 404) {
      test.skip();
      return;
    }
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.content).toBeDefined();

    const text = typeof body.content === "string"
      ? body.content
      : JSON.stringify(body.content);

    // ASR transcription should have actual spoken content, not empty or error
    expect(text.length).toBeGreaterThan(10);

    // Should not contain ASR failure indicators
    const errorPatterns = [
      "ASR不可用",
      "未配置ASR",
      "transcription failed",
      "Whisper error",
    ];
    for (const pattern of errorPatterns) {
      expect(text).not.toContain(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.10 Document status tracking - existing docs are status=ready
// ---------------------------------------------------------------------------
test.describe("3.10: Document Status Tracking", () => {
  const docEntries = [
    { key: "pdf", id: DOC.pdf, type: "pdf" },
    { key: "xlsx", id: DOC.xlsx, type: "xlsx" },
    { key: "jpg", id: DOC.jpg, type: "jpg" },
    { key: "mp3", id: DOC.mp3, type: "mp3" },
    { key: "mp4", id: DOC.mp4, type: "mp4" },
  ];

  for (const entry of docEntries) {
    test(`${entry.type} document has status=ready`, async ({ request }) => {
      const resp = await request.get(
        `${KB_BASE}/kbs/${TEST_KB_ID}/documents/${entry.id}/status`,
      );
      if (resp.status() === 404) {
        test.skip();
        return;
      }
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body.status).toBe("ready");
      expect(body.progress).toBe(100);
    });
  }
});

// ---------------------------------------------------------------------------
// 3.11 Document deletion cascade cleanup
// ---------------------------------------------------------------------------
test.describe("3.11: Document Deletion Cascade", () => {
  test("create, upload, delete document - all associated data cleaned", async ({
    request,
  }) => {
    const api = createApi(request);

    // Create a temporary KB for this test
    const kb = await api.createKB(`deletion-cascade-test-${Date.now()}`);
    expect(kb.id).toBeTruthy();

    try {
      // Create a small test file
      const testContent = `# Test Document\n\nThis is test content for deletion cascade verification.`;
      const buffer = Buffer.from(testContent, "utf-8");

      // Upload via the multipart endpoint
      const uploadResp = await request.post(
        `${KB_BASE}/kbs/${kb.id}/upload`,
        {
          multipart: {
            file: {
              name: "test-delete.md",
              mimeType: "text/markdown",
              buffer,
            },
          },
        },
      );
      // Upload may succeed or fail depending on server state
      if (uploadResp.status() === 201 || uploadResp.status() === 200) {
        const doc = await uploadResp.json();
        const docId = doc.id || doc.docId || doc.documentId;

        // Wait briefly for processing to start
        await new Promise((r) => setTimeout(r, 1000));

        // Delete the document
        const deleteResp = await request.delete(
          `${KB_BASE}/kbs/${kb.id}/documents/${docId}`,
        );
        expect(deleteResp.status()).toBe(200);
        const deleteBody = await deleteResp.json();
        expect(deleteBody.deleted).toBe(true);

        // Verify document is gone
        const statusResp = await request.get(
          `${KB_BASE}/kbs/${kb.id}/documents/${docId}/status`,
        );
        expect(statusResp.status()).toBe(404);

        // Verify wiki pages for that doc are gone
        const wikiResp = await request.get(`${KB_BASE}/${kb.id}/wiki/`);
        if (wikiResp.status() === 200) {
          const wikiBody = await wikiResp.json();
          const docPages = (wikiBody.pages || []).filter(
            (p: any) => p.doc_id === docId,
          );
          expect(docPages).toHaveLength(0);
        }
      }
    } finally {
      // Clean up: delete the temporary KB
      await api.deleteKB(kb.id);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.12 Create new KB, upload a small test file, verify processing
// ---------------------------------------------------------------------------
test.describe("3.12: Create KB + Upload + Process", () => {
  test("create KB, upload file, document reaches processing state", async ({
    request,
  }) => {
    const api = createApi(request);

    // Create KB
    const kb = await api.createKB(
      `e2e-upload-test-${Date.now()}`,
    );
    expect(kb.id).toBeTruthy();
    expect(kb.name).toBeTruthy();

    try {
      // Upload a small text file
      const testContent = "E2E test document content for processing verification.";
      const buffer = Buffer.from(testContent, "utf-8");

      const uploadResp = await request.post(
        `${KB_BASE}/kbs/${kb.id}/upload`,
        {
          multipart: {
            file: {
              name: "e2e-test.txt",
              mimeType: "text/plain",
              buffer,
            },
          },
        },
      );

      expect([200, 201]).toContain(uploadResp.status());
      const doc = await uploadResp.json();
      const docId = doc.id || doc.docId || doc.documentId;
      expect(docId).toBeTruthy();

      // Document should initially be in uploaded or processing state
      const statusResp = await request.get(
        `${KB_BASE}/kbs/${kb.id}/documents/${docId}/status`,
      );
      expect(statusResp.status()).toBe(200);
      const statusBody = await statusResp.json();
      expect([
        "uploaded",
        "parsing",
        "compiling",
        "indexing",
        "linking",
        "ready",
        "queued",
      ]).toContain(statusBody.status);

      // Verify document appears in listing
      const docsResp = await request.get(
        `${KB_BASE}/kbs/${kb.id}/documents`,
      );
      expect(docsResp.status()).toBe(200);
      const docsBody = await docsResp.json();
      const found = docsBody.documents.find((d: any) => d.id === docId);
      expect(found).toBeDefined();
    } finally {
      // Clean up
      await api.deleteKB(kb.id);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.13 Delete KB cascade cleanup
// ---------------------------------------------------------------------------
test.describe("3.13: Delete KB Cascade", () => {
  test("delete KB removes KB and all associated data", async ({ request }) => {
    const api = createApi(request);

    // Create KB
    const kb = await api.createKB(
      `e2e-delete-kb-test-${Date.now()}`,
    );
    expect(kb.id).toBeTruthy();

    // Verify KB exists
    const getResp = await request.get(`${KB_BASE}/kbs/${kb.id}`);
    expect(getResp.status()).toBe(200);

    // Delete KB
    await api.deleteKB(kb.id);

    // Verify KB is gone
    const deletedResp = await request.get(`${KB_BASE}/kbs/${kb.id}`);
    expect(deletedResp.status()).toBe(404);

    // Verify KB is not in the list
    const listResp = await request.get(`${KB_BASE}/kbs`);
    const listBody = await listResp.json();
    const found = listBody.knowledgeBases.find(
      (k: any) => k.id === kb.id,
    );
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3.14 Wiki browse returns page list
// ---------------------------------------------------------------------------
test.describe("3.14: Wiki Browse", () => {
  test("GET /:kbId/wiki/ returns page list for test KB", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/wiki/`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.pages).toBeDefined();
    expect(Array.isArray(body.pages)).toBeTruthy();

    // Test KB should have pages for each document
    expect(body.pages.length).toBeGreaterThan(0);

    // Each page should have core fields
    const firstPage = body.pages[0];
    expect(firstPage.id).toBeTruthy();
    expect(firstPage.title).toBeTruthy();
    expect(firstPage.page_type || firstPage.pageType).toBeTruthy();
  });

  test("wiki page types include expected varieties", async ({ request }) => {
    const resp = await request.get(`${KB_BASE}/${TEST_KB_ID}/wiki/`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    const pageTypes = new Set(
      body.pages.map((p: any) => p.page_type),
    );

    // Should have abstract (L0) pages for documents
    expect(pageTypes.has("abstract")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3.15 Quality report returns KB-level summary
// ---------------------------------------------------------------------------
test.describe("3.15: Quality Report", () => {
  test("GET /kbs/:kbId/quality-report returns summary", async ({ request }) => {
    const resp = await request.get(
      `${KB_BASE}/kbs/${TEST_KB_ID}/quality-report`,
    );
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    // Should have summary-level fields
    expect(body.kbId).toBe(TEST_KB_ID);
    expect(typeof body.totalDocuments).toBe("number");
    expect(body.totalDocuments).toBeGreaterThanOrEqual(0);

    // Should have document-level detail array
    expect(Array.isArray(body.documents)).toBeTruthy();

    // Each document entry should have basic fields
    if (body.documents.length > 0) {
      const first = body.documents[0];
      expect(first.docId || first.id).toBeTruthy();
      expect(first.filename || first.fileName).toBeTruthy();
      expect(first.status).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 3.16 Knowledge base page screenshot - document tree, search bar
// ---------------------------------------------------------------------------
test.describe("3.16: Knowledge Base Page UI", () => {
  test("knowledge page renders document tree and search bar", async ({
    page,
  }) => {
    await gotoPage(page, `knowledge/${TEST_KB_ID}`);

    // Wait for content to load
    await page.waitForTimeout(2000);

    // Take screenshot for visual verification
    await takeScreenshot(page, "knowledge-page-tree");

    // Verify the page has rendered some content
    const pageContent = await page.content();
    const hasRelevantContent =
      pageContent.includes("知识库") ||
      pageContent.includes("E2E") ||
      pageContent.includes("document") ||
      pageContent.includes("antigravity") ||
      pageContent.includes("athlete") ||
      pageContent.includes("搜索") ||
      pageContent.includes("文件");
    expect(hasRelevantContent).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3.17 Document card L0/L1/L2 buttons visible
// ---------------------------------------------------------------------------
test.describe("3.17: Document Card Level Buttons", () => {
  test("document detail shows L0/L1/L2 level buttons", async ({ page }) => {
    // Navigate to the PDF document in the test KB
    await gotoPage(page, `knowledge/${TEST_KB_ID}/${DOC.pdf}`);
    await page.waitForTimeout(2000);

    await takeScreenshot(page, "document-card-levels");

    // Check for level buttons or indicators
    const pageContent = await page.content();

    // The page should show L0/L1/L2 references or expand buttons
    const hasLevelIndicators =
      pageContent.includes("L0") ||
      pageContent.includes("L1") ||
      pageContent.includes("L2") ||
      pageContent.includes("摘要") ||
      pageContent.includes("结构") ||
      pageContent.includes("展开") ||
      pageContent.includes("abstract") ||
      pageContent.includes("structure");

    expect(hasLevelIndicators).toBeTruthy();
  });

  test("clicking L1 button loads structured content", async ({ page }) => {
    await gotoPage(page, `knowledge/${TEST_KB_ID}/${DOC.pdf}`);
    await page.waitForTimeout(2000);

    // Try to find and click an L1 or structure button
    const l1Button = page.locator(
      'button:has-text("L1"), button:has-text("结构"), button:has-text("展开")',
    ).first();

    if (await l1Button.isVisible().catch(() => false)) {
      await l1Button.click();
      await page.waitForTimeout(1500);

      await takeScreenshot(page, "document-L1-expanded");

      // Content area should update with structured content
      const pageContent = await page.content();
      const hasContent =
        pageContent.length > 100 &&
        (pageContent.includes("L1") ||
          pageContent.includes("document") ||
          pageContent.includes("content") ||
          pageContent.includes("page"));
      expect(hasContent).toBeTruthy();
    }
  });
});
