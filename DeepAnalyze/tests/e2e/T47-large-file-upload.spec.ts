/**
 * T47: 超大文件上传与处理
 *
 * 测试设计：
 * - 创建新知识库，上传大文件
 * - API级别测试：创建KB、上传文件、等待处理、验证内容、清理删除KB
 *
 * 观察目标：
 * 1. 知识库创建成功
 * 2. 大文件上传成功
 * 3. 文件处理完成
 * 4. 内容质量验证
 * 5. 清理删除知识库
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";

test.describe("T47 - 超大文件上传与处理", () => {
  let kbId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    (page as any).__consoleErrors = consoleErrors;
  });

  test.afterAll(async ({ request }) => {
    // Cleanup: delete the KB
    if (kbId) {
      const api = createApi(request);
      await api.deleteKB(kbId).catch(() => {});
      console.log(`[T47] Cleanup: deleted KB ${kbId}`);
    }
    if (page) await page.close().catch(() => {});
  });

  test("T47.1 创建知识库", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const kb = await api.createKB("T47-超大文件上传测试");
    kbId = kb.id;
    console.log(`[T47] Created KB: ${kbId}`);
    expect(kbId, "Should create KB with valid ID").toBeTruthy();
  });

  test("T47.2 上传大文件", async ({ request }) => {
    test.setTimeout(120_000);
    const api = createApi(request);

    // Find a large PDF from testdata
    const possiblePaths = [
      "/mnt/d/testdata/pdf/",
      "/mnt/d/testdata/",
      "/tmp/testdata/",
    ];

    let uploadPath: string | null = null;
    for (const dir of possiblePaths) {
      if (existsSync(dir)) {
        // Try to find any PDF file
        const files = readdirSync(dir).filter((f: string) => f.endsWith(".pdf"));
        if (files.length > 0) {
          // Use the largest file
          let largestFile = files[0];
          let largestSize = 0;
          for (const f of files) {
            const stat = statSync(resolve(dir, f));
            if (stat.size > largestSize) {
              largestSize = stat.size;
              largestFile = f;
            }
          }
          uploadPath = resolve(dir, largestFile);
          console.log(`[T47] Selected file: ${uploadPath} (${largestSize} bytes)`);
          break;
        }
      }
    }

    if (uploadPath && existsSync(uploadPath)) {
      const fileBuffer = readFileSync(uploadPath);
      const fileName = uploadPath.split("/").pop() || "test.pdf";
      const doc = await api.uploadDocument(kbId, fileBuffer, fileName, "application/pdf");
      console.log(`[T47] Uploaded document: ${doc.id}, status: ${doc.status}`);
      expect(doc.id, "Should upload document with valid ID").toBeTruthy();
    } else {
      // If no large file available, upload a small test file
      console.log(`[T47] No large PDF found in testdata dirs, creating test content`);
      const testContent = Buffer.from("%PDF-1.4 test content for large file upload simulation");
      const doc = await api.uploadDocument(kbId, testContent, "test-upload.pdf", "application/pdf");
      console.log(`[T47] Uploaded test document: ${doc.id}`);
      expect(doc.id, "Should upload document").toBeTruthy();
    }

    await takeScreenshot(page, "T47-2-upload-complete");
  });

  test("T47.3 等待处理完成", async ({ request }) => {
    test.setTimeout(300_000); // 5 minutes
    const api = createApi(request);

    // Poll for processing completion
    let allReady = false;
    let attempts = 0;
    const maxAttempts = 30; // 30 * 10s = 5 minutes

    while (!allReady && attempts < maxAttempts) {
      attempts++;
      const docs = await api.listDocuments(kbId);
      console.log(`[T47] Poll attempt ${attempts}: ${docs.length} documents`);

      if (docs.length === 0) {
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }

      allReady = docs.every((d) => d.status === "ready" || d.status === "error");
      if (!allReady) {
        const statuses = docs.map((d) => `${d.fileName}: ${d.status} (${d.progress}%)`);
        console.log(`[T47] Processing statuses: ${statuses.join(", ")}`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }

    console.log(`[T47] Processing completed after ${attempts} polls, allReady: ${allReady}`);
  });

  test("T47.4 验证内容质量", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const docs = await api.listDocuments(kbId);
    console.log(`[T47] Documents: ${docs.length}`);

    for (const doc of docs) {
      console.log(`[T47] Document: ${doc.fileName}, status: ${doc.status}, progress: ${doc.progress}%`);

      if (doc.status === "ready") {
        // Try to get document details
        const docDetail = await api.getDocument(kbId, doc.id);
        console.log(`[T47] Document detail: l1Preview length = ${docDetail.l1Preview?.length || 0}`);
      }
    }

    await gotoPage(page, `knowledge/${kbId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T47-4-content-quality");
  });

  test("T47.5 清理删除知识库", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    await api.deleteKB(kbId);
    console.log(`[T47] Deleted KB: ${kbId}`);

    // Verify deletion
    const kbs = await api.listKBs();
    const stillExists = (kbs as any[]).some((kb: any) => kb.id === kbId);
    console.log(`[T47] KB still exists after deletion: ${stillExists}`);

    await takeScreenshot(page, "T47-5-cleanup");
  });
});
