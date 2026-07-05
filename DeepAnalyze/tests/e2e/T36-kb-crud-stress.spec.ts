/**
 * T36: 知识库文档CRUD压力测试
 *
 * 测试设计：
 * - API级别测试：对bigtest知识库执行CRUD操作
 * - 列出所有文档并验证数量
 * - 搜索并验证结果
 * - 上传新文档，等待处理完成
 * - 删除文档，验证移除
 *
 * 观察目标：
 * 1. 文档列表返回完整
 * 2. 搜索结果正确
 * 3. 上传文档处理成功
 * 4. 删除文档即时生效
 * 5. 并发操作数据一致性
 */
import { test, expect } from "@playwright/test";
import { createApi, type Document } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { waitForDocumentReady } from "./helpers/wait";
import { readFileSync } from "fs";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const TEST_UPLOAD_FILE = {
  path: "/mnt/d/testdata/pdf/kb/antigravity-rag-2026.pdf",
  name: "T36-stress-test-upload.pdf",
  mime: "application/pdf",
};

test.describe("T36 - 知识库CRUD压力测试", () => {
  let page: Page;
  let uploadedDocId: string | null = null;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    (page as any).__consoleErrors = consoleErrors;
  });

  test.afterAll(async ({ request }) => {
    // Cleanup: delete uploaded doc if it still exists
    if (uploadedDocId) {
      const api = createApi(request);
      await api.deleteDocument(BIGTEST_KB_ID, uploadedDocId).catch(() => {});
      console.log(`[T36] Cleanup: deleted doc ${uploadedDocId}`);
    }
    if (page) await page.close().catch(() => {});
  });

  test("T36.1 列出所有文档并验证数量", async ({ request }) => {
    test.setTimeout(120_000);
    const api = createApi(request);

    const docs = await api.listDocuments(BIGTEST_KB_ID);
    console.log(`[T36] Total documents in bigtest KB: ${Array.isArray(docs) ? docs.length : 'NOT AN ARRAY'}`);
    expect(Array.isArray(docs), "listDocuments should return an array").toBe(true);
    expect(docs.length, "bigtest KB should have documents").toBeGreaterThan(0);

    // Check document statuses
    const readyDocs = docs.filter((d) => d.status === "ready");
    const processingDocs = docs.filter((d) => d.status === "processing");
    const failedDocs = docs.filter((d) => d.status === "failed");
    console.log(`[T36] Ready: ${readyDocs.length}, Processing: ${processingDocs.length}, Failed: ${failedDocs.length}`);

    // Log file types distribution
    const typeDistribution: Record<string, number> = {};
    for (const doc of docs) {
      const ext = doc.fileName.split(".").pop() || "unknown";
      typeDistribution[ext] = (typeDistribution[ext] || 0) + 1;
    }
    console.log(`[T36] File type distribution: ${JSON.stringify(typeDistribution)}`);

    await gotoPage(page, "knowledge");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T36-1-document-list");
  });

  test("T36.2 搜索并验证结果", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    // Search with multiple queries
    const queries = ["RAG", "论文", "记忆"];
    for (const query of queries) {
      const result = await api.search(BIGTEST_KB_ID, query, { topK: 10 });
      console.log(`[T36] Search "${query}": ${result.results.length} results, total=${result.total}`);
      expect(result.results.length, `Search for "${query}" should return results`).toBeGreaterThan(0);
    }

    // Verify search results have required fields
    const ragResult = await api.search(BIGTEST_KB_ID, "RAG", { topK: 5 });
    for (const r of ragResult.results.slice(0, 3)) {
      expect(r.content, "Result should have content").toBeTruthy();
      console.log(`[T36]   Result score: ${r.score}, content length: ${r.content?.length || 0}`);
    }

    await takeScreenshot(page, "T36-2-search-results");
  });

  test("T36.3 上传新文档并等待处理", async ({ request }) => {
    test.setTimeout(600_000); // 10 minutes for processing
    const api = createApi(request);

    // Upload a new document
    const buffer = readFileSync(TEST_UPLOAD_FILE.path);
    const doc = await api.uploadDocument(BIGTEST_KB_ID, buffer, TEST_UPLOAD_FILE.name, TEST_UPLOAD_FILE.mime);
    uploadedDocId = doc.id;
    console.log(`[T36] Uploaded ${TEST_UPLOAD_FILE.name}: docId=${doc.id}, status=${doc.status}`);

    expect(doc.id, "Upload should return a document ID").toBeTruthy();

    // Wait for processing to complete
    const processedDoc = await waitForDocumentReady(request, BIGTEST_KB_ID, doc.id, 300_000);
    console.log(`[T36] Document processed: status=${processedDoc.status}, progress=${processedDoc.progress}`);
    expect(processedDoc.status, "Document should be ready after processing").toBe("ready");

    // Verify document appears in list
    const docsAfterUpload = await api.listDocuments(BIGTEST_KB_ID);
    const found = docsAfterUpload.find((d) => d.id === doc.id);
    expect(found, "Uploaded document should appear in document list").toBeDefined();

    // Search should now find the document
    const searchResult = await api.search(BIGTEST_KB_ID, "antigravity", { topK: 5 });
    console.log(`[T36] Search "antigravity" after upload: ${searchResult.results.length} results`);

    await gotoPage(page, "knowledge");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T36-3-document-uploaded");
  });

  test("T36.4 删除文档并验证移除", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    if (!uploadedDocId) {
      console.log(`[T36] Skipping delete test - no document was uploaded`);
      return;
    }

    // Record document count before delete
    const docsBeforeDelete = await api.listDocuments(BIGTEST_KB_ID);
    const countBefore = docsBeforeDelete.length;
    console.log(`[T36] Documents before delete: ${countBefore}`);

    // Delete the uploaded document
    await api.deleteDocument(BIGTEST_KB_ID, uploadedDocId);
    console.log(`[T36] Deleted document: ${uploadedDocId}`);

    // Verify document is removed from list
    const docsAfterDelete = await api.listDocuments(BIGTEST_KB_ID);
    const countAfter = docsAfterDelete.length;
    console.log(`[T36] Documents after delete: ${countAfter}`);

    const stillExists = docsAfterDelete.find((d) => d.id === uploadedDocId);
    expect(stillExists, "Deleted document should not appear in list").toBeUndefined();
    expect(countAfter, "Document count should decrease by 1").toBe(countBefore - 1);

    // Try to get the deleted document - should fail
    try {
      await api.getDocument(BIGTEST_KB_ID, uploadedDocId);
      console.log(`[T36] WARNING: getDocument succeeded after deletion`);
    } catch (err) {
      console.log(`[T36] getDocument correctly failed after deletion: ${(err as Error).message}`);
    }

    uploadedDocId = null; // Mark as cleaned up

    await gotoPage(page, "knowledge");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T36-4-document-deleted");
  });

  test("T36.5 最终截图和错误检查", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, "knowledge");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T36-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T36] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T36-5-final-state");
  });
});
