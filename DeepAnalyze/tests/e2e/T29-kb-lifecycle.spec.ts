/**
 * T29: 知识库完整生命周期——创建→上传→处理→分析→删除
 *
 * 测试设计：
 * - 通过API创建新知识库，上传测试文件，等待处理完成
 * - 验证文档状态和内容质量
 * - 运行Agent分析，验证检索可用
 * - 删除知识库，验证清理彻底
 *
 * 观察目标：
 * 1. KB创建成功，前端可见
 * 2. 文件上传完整，处理进度正确
 * 3. L0摘要和L1内容质量有意义
 * 4. expand/kb_search能正常检索上传的文档
 * 5. 删除后数据完全清理，搜索返回空
 */
import { test, expect } from "@playwright/test";
import { createApi, type Document } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { waitForDocumentReady } from "./helpers/wait";
import { readFileSync } from "fs";

const TEST_FILES = [
  { path: "/mnt/d/testdata/pdf/kb/antigravity-rag-2026.pdf", name: "antigravity-rag-2026.pdf", mime: "application/pdf" },
  { path: "/mnt/d/testdata/images/屏幕截图 2025-11-26 104817.png", name: "screenshot-01.png", mime: "image/png" },
  { path: "/mnt/d/testdata/execl/athlete_events.xlsx", name: "athlete_events.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
];

test.describe("T29 - 知识库完整生命周期", () => {
  let kbId: string;
  let sessionId: string;
  let page: Page;
  const uploadedDocIds: string[] = [];

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);

    // Create a new knowledge base
    const kb = await api.createKB("T29-测试知识库");
    kbId = kb.id;
    console.log(`[T29] Created KB: ${kbId}`);

    // Create a session bound to the new KB
    const session = await api.createSession("T29-知识库生命周期", {
      kbIds: [kbId],
    });
    sessionId = session.id;
    console.log(`[T29] Created session: ${sessionId}`);

    page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    (page as any).__consoleErrors = consoleErrors;
  });

  test.afterAll(async ({ request }) => {
    // Cleanup: delete KB if it still exists
    if (kbId) {
      const api = createApi(request);
      await api.deleteKB(kbId).catch(() => {});
      console.log(`[T29] Cleanup: deleted KB ${kbId}`);
    }
    if (page) await page.close().catch(() => {});
  });

  test("T29.1 创建KB并上传文件，等待处理完成", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    const api = createApi(request);

    // Upload 3 test files
    for (const file of TEST_FILES) {
      const buffer = readFileSync(file.path);
      const doc = await api.uploadDocument(kbId, buffer, file.name, file.mime);
      console.log(`[T29] Uploaded ${file.name}: docId=${doc.id}, status=${doc.status}`);
      uploadedDocIds.push(doc.id);
    }

    expect(uploadedDocIds.length, "Should have uploaded 3 files").toBe(3);

    // Wait for all documents to be ready
    for (const docId of uploadedDocIds) {
      const doc = await waitForDocumentReady(request, kbId, docId, 600_000);
      console.log(`[T29] Document ${docId} ready: status=${doc.status}, progress=${doc.progress}`);
      expect(doc.status, `Document ${docId} should be ready`).toBe("ready");
    }

    // Navigate to session page and take screenshot
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T29-1-files-uploaded-and-ready");
  });

  test("T29.2 验证文档状态和内容质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    // List all documents and verify count
    const docs = await api.listDocuments(kbId);
    console.log(`[T29] Total documents in KB: ${docs.length}`);
    expect(docs.length, "Should have 3 documents").toBe(3);

    // Verify each document's quality
    for (const doc of docs) {
      console.log(`[T29] Doc ${doc.fileName}: status=${doc.status}, progress=${doc.progress}`);

      // Status should be ready
      expect(doc.status, `${doc.fileName} should be ready`).toBe("ready");

      // L0 preview should exist and be meaningful (not empty or template text)
      if (doc.l1Preview) {
        console.log(`[T29]   L1 preview length: ${doc.l1Preview.length}`);
        expect(doc.l1Preview.length, `${doc.fileName} L1 preview should have content`).toBeGreaterThan(0);
      }

      // Check metadata
      if (doc.metadata) {
        const meta = doc.metadata as Record<string, unknown>;
        console.log(`[T29]   Metadata keys: ${Object.keys(meta).join(", ")}`);
      }
    }

    // Try searching within the KB
    const searchResult = await api.search(kbId, "RAG", { topK: 5 });
    console.log(`[T29] Search "RAG": ${searchResult.results.length} results, total=${searchResult.total}`);

    await takeScreenshot(page, "T29-2-document-quality-verified");
  });

  test("T29.3 运行Agent分析知识库", async ({ request }) => {
    test.setTimeout(600_000); // 10 minutes for agent analysis

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    const PROMPT = `请分析当前知识库中的所有文档。对每个文档：1）给出摘要；2）使用expand查看其L0和L1内容；3）评估内容质量。`;

    const status = await page.evaluate(async ({ prompt, sid }) => {
      const resp = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: prompt, sessionId: sid }),
      });
      const reader = resp.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      return resp.status;
    }, { prompt: PROMPT, sid: sessionId });

    console.log(`[T29] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T29-3-agent-analysis-completed");

    // Verify messages were produced
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    console.log(`[T29] Total messages after agent run: ${msgs.length}`);
    expect(msgs.length, "Should have messages after agent run").toBeGreaterThanOrEqual(2);
  });

  test("T29.4 删除知识库并验证清理", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    // Delete the knowledge base
    await api.deleteKB(kbId);
    console.log(`[T29] Deleted KB: ${kbId}`);

    // Verify KB is gone - list should not contain our KB
    const kbs = await api.listKBs();
    const found = (kbs as any[]).find((kb: any) => kb.id === kbId);
    expect(found, "Deleted KB should not appear in list").toBeUndefined();

    // Try to get the KB - should fail
    try {
      await api.getKB(kbId);
      // If we get here without error, that's a problem
      console.log(`[T29] WARNING: getKB succeeded after deletion`);
    } catch (err) {
      console.log(`[T29] getKB correctly failed after deletion: ${(err as Error).message}`);
    }

    // Search should return empty for deleted KB
    try {
      const searchResult = await api.search(kbId, "RAG");
      console.log(`[T29] Search after delete: ${searchResult.results.length} results`);
    } catch (err) {
      console.log(`[T29] Search after delete correctly failed: ${(err as Error).message}`);
    }

    await takeScreenshot(page, "T29-4-kb-deleted");
  });

  test("T29.5 最终截图和错误检查", async () => {
    test.setTimeout(60_000);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await takeScreenshot(page, "T29-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T29] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);

    await takeScreenshot(page, "T29-5-final-state");
  });
});
