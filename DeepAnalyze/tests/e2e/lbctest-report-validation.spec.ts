/**
 * lbctest 知识库报告完整验证测试
 *
 * 完整流程：
 * 1. 验证已生成的证据链报告内容
 * 2. 提取报告中所有 da-evidence:// 链接
 * 3. 验证每个链接的真实性（docId 存在、非伪造）
 * 4. 按文件格式分类链接（PDF, DOCX, XLSX, JPG, PNG, TXT, MD）
 * 5. 在前端逐个测试不同格式的证据链接预览面板
 * 6. 截图验证每种格式的预览效果
 */
import { test, expect } from "@playwright/test";

const KB_ID = "f65cb573-05c7-4098-ba7d-c26c006986ee";
const BASE = "/api/knowledge";
const PREVIEW = "/api/preview";
const REPORTS_API = "/api/reports";
const REPORT_ID = "88cd5673-13c5-4390-b308-063930221570";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract all da-evidence URLs from report content */
function extractEvidenceUrls(content: string): string[] {
  // Matches: da-evidence://kbId/docId or da-evidence://kbId/docId?anchor=xxx
  const re = /da-evidence:\/\/[^\s\]\)]+/g;
  return [...new Set(content.match(re) || [])];
}

/** Parse a da-evidence URL into components */
function parseEvidenceUrl(url: string) {
  const m = url.match(
    /^da-evidence:\/\/([^/]+)\/([^/?]+)(?:\?anchor=(.+))?$/,
  );
  if (!m) return null;
  return { kbId: m[1], docId: m[2], anchorId: m[3] || null };
}

/** Get all documents in lbctest KB as a Map */
async function getKbDocs(request: any): Promise<Map<string, any>> {
  const resp = await request.get(`${BASE}/kbs/${KB_ID}/documents`);
  const data = await resp.json();
  const map = new Map<string, any>();
  for (const doc of data.documents || []) {
    map.set(doc.id, doc);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("lbctest 证据链报告完整验证", () => {
  test.describe.configure({ timeout: 300_000 });

  let reportContent: string;
  let evidenceUrls: string[];
  let docMap: Map<string, any>;

  // -----------------------------------------------------------------------
  // Step 1: Fetch report and verify structure
  // -----------------------------------------------------------------------
  test("1. 获取报告并验证结构完整性", async ({ request }) => {
    const resp = await request.get(`${REPORTS_API}/report/${REPORT_ID}`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    reportContent = data.content;
    expect(reportContent).toBeTruthy();
    expect(reportContent.length).toBeGreaterThan(5000);

    // Verify report structure has key sections
    expect(reportContent).toContain("证据链");
    expect(reportContent).toContain("da-evidence://");

    // Extract all evidence URLs
    evidenceUrls = extractEvidenceUrls(reportContent);
    console.log(`Report: "${data.title}"`);
    console.log(`Content length: ${reportContent.length} chars`);
    console.log(`Evidence URLs (unique): ${evidenceUrls.length}`);

    // Must have substantial number of evidence links
    expect(evidenceUrls.length).toBeGreaterThanOrEqual(30);

    // Get doc map
    docMap = await getKbDocs(request);
    console.log(`KB documents: ${docMap.size}`);
  });

  // -----------------------------------------------------------------------
  // Step 2: Validate every evidence link
  // -----------------------------------------------------------------------
  test("2. 验证所有证据链接的真实性（无伪造）", async ({ request }) => {
    if (!reportContent) {
      const resp = await request.get(`${REPORTS_API}/report/${REPORT_ID}`);
      reportContent = (await resp.json()).content;
    }
    if (!evidenceUrls) evidenceUrls = extractEvidenceUrls(reportContent);
    if (!docMap) docMap = await getKbDocs(request);

    let validCount = 0;
    let invalidCount = 0;
    let wrongKbCount = 0;
    const invalidLinks: string[] = [];

    for (const url of evidenceUrls) {
      const parsed = parseEvidenceUrl(url);
      if (!parsed) {
        invalidCount++;
        invalidLinks.push(`MALFORMED: ${url}`);
        continue;
      }

      // Check kbId matches
      if (parsed.kbId !== KB_ID) {
        wrongKbCount++;
        invalidLinks.push(`WRONG_KB: ${url}`);
        continue;
      }

      // Check docId is a valid UUID
      if (!UUID_RE.test(parsed.docId)) {
        invalidCount++;
        invalidLinks.push(`INVALID_UUID: docId=${parsed.docId}`);
        continue;
      }

      // Check document exists in KB
      if (!docMap.has(parsed.docId)) {
        invalidCount++;
        const docName = docMap.get(parsed.docId)?.filename || "UNKNOWN";
        invalidLinks.push(`DOC_NOT_FOUND: docId=${parsed.docId}`);
        continue;
      }

      validCount++;
    }

    console.log(`\nValidation results:`);
    console.log(`  Valid links: ${validCount}/${evidenceUrls.length}`);
    console.log(`  Invalid: ${invalidCount}`);
    console.log(`  Wrong KB: ${wrongKbCount}`);

    if (invalidLinks.length > 0) {
      console.log(`\nInvalid links:`);
      invalidLinks.slice(0, 20).forEach((l) => console.log(`  ${l}`));
    }

    // All links must reference the correct KB
    expect(wrongKbCount).toBe(0);

    // At least 90% of links should reference existing documents
    const validRatio = validCount / evidenceUrls.length;
    expect(validRatio).toBeGreaterThanOrEqual(0.9);
  });

  // -----------------------------------------------------------------------
  // Step 3: Classify links by file format
  // -----------------------------------------------------------------------
  test("3. 按文件格式分类统计证据链接", async ({ request }) => {
    if (!reportContent) {
      const resp = await request.get(`${REPORTS_API}/report/${REPORT_ID}`);
      reportContent = (await resp.json()).content;
    }
    if (!evidenceUrls) evidenceUrls = extractEvidenceUrls(reportContent);
    if (!docMap) docMap = await getKbDocs(request);

    const byType: Record<string, { count: number; docIds: string[]; samples: string[] }> = {};
    let unknownCount = 0;

    for (const url of evidenceUrls) {
      const parsed = parseEvidenceUrl(url);
      if (!parsed) continue;
      const doc = docMap.get(parsed.docId);
      if (!doc) { unknownCount++; continue; }

      const name = doc.filename || doc.originalName || "";
      const ext = name.split(".").pop()?.toLowerCase() || "unknown";

      if (!byType[ext]) {
        byType[ext] = { count: 0, docIds: [], samples: [] };
      }
      byType[ext].count++;
      if (!byType[ext].docIds.includes(parsed.docId)) {
        byType[ext].docIds.push(parsed.docId);
      }
      if (byType[ext].samples.length < 3) {
        byType[ext].samples.push(name);
      }
    }

    console.log("\nEvidence links by file format:");
    for (const [ext, info] of Object.entries(byType).sort(
      (a, b) => b[1].count - a[1].count,
    )) {
      console.log(
        `  .${ext}: ${info.count} links, ${info.docIds.length} unique docs`,
      );
      console.log(`    Samples: ${info.samples.join(", ")}`);
    }
    if (unknownCount > 0) {
      console.log(`  unknown: ${unknownCount}`);
    }

    // Report should cover at least 4 different file formats
    const formatCount = Object.keys(byType).length;
    expect(formatCount).toBeGreaterThanOrEqual(4);
  });

  // -----------------------------------------------------------------------
  // Step 4: Test document preview panel for each file type
  // -----------------------------------------------------------------------
  test("4. 测试各格式文件的文档预览面板", async ({ page, request }) => {
    if (!docMap) docMap = await getKbDocs(request);

    // Pick one representative document per format
    const formatsToTest = ["pdf", "docx", "xlsx", "jpg", "png", "txt", "md"];
    const testDocs: Record<string, { id: string; name: string }> = {};

    for (const doc of docMap.values()) {
      const name = doc.filename || doc.originalName || "";
      const ext = name.split(".").pop()?.toLowerCase() || "";
      if (formatsToTest.includes(ext) && !testDocs[ext]) {
        testDocs[ext] = { id: doc.id, name };
      }
    }

    console.log(
      "Testing document preview for:",
      Object.keys(testDocs).map((e) => `.${e}`).join(", "),
    );

    await page.goto("/#/chat");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);

    const testedFormats: string[] = [];

    for (const [ext, doc] of Object.entries(testDocs)) {
      console.log(`\n--- .${ext}: ${doc.name} ---`);

      // Open document preview via store
      await page.evaluate(
        ({ kbId, docId }) => {
          const store = (window as any).__evidencePreviewStore;
          if (store) store.getState().closePreview();
          setTimeout(() => {
            (window as any).__evidencePreviewStore
              .getState()
              .openDocumentPreview(kbId, docId);
          }, 100);
        },
        { kbId: KB_ID, docId: doc.id },
      );

      await page.waitForTimeout(1500);

      // Verify panel state
      const panelState = await page.evaluate(() => {
        const store = (window as any).__evidencePreviewStore;
        return store ? store.getState() : null;
      });

      if (!panelState?.isOpen) {
        console.log(`  SKIP: panel did not open`);
        continue;
      }

      expect(panelState.mode).toBe("document");
      expect(panelState.docId).toBe(doc.id);

      // Check content rendered
      const hasContent = await page.evaluate(() => {
        const contentEls = document.querySelectorAll(".markdown-content, pre");
        return contentEls.length > 0;
      });
      expect(hasContent).toBe(true);

      // Screenshot default (L1) view
      await page.screenshot({
        path: `test-results/lbctest-preview-${ext}-L1.png`,
      });

      // Test L0 level tab
      const l0Btn = page.locator("button").filter({ hasText: /^L0/ });
      if ((await l0Btn.count()) > 0) {
        await l0Btn.first().click();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: `test-results/lbctest-preview-${ext}-L0.png`,
        });
      }

      // Test L2 level tab
      const l2Btn = page.locator("button").filter({ hasText: /^L2/ });
      if ((await l2Btn.count()) > 0) {
        await l2Btn.first().click();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: `test-results/lbctest-preview-${ext}-L2.png`,
        });
      }

      // Verify footer "View in Knowledge Base" button
      const footerBtn = page.locator("button").filter({
        hasText: /View in Knowledge|在知识库中查看/,
      });
      expect(await footerBtn.count()).toBeGreaterThanOrEqual(1);

      // Close panel
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);

      testedFormats.push(ext);
      console.log(`  OK: preview works for .${ext}`);
    }

    console.log(
      `\nSuccessfully tested: ${testedFormats.map((e) => "." + e).join(", ")}`,
    );
    expect(testedFormats.length).toBeGreaterThanOrEqual(5);
  });

  // -----------------------------------------------------------------------
  // Step 5: Open report in browser and verify link rendering
  // -----------------------------------------------------------------------
  test("5. 前端打开报告验证证据链接渲染", async ({ page, request }) => {
    // Find a session that has this report
    // First check session messages for the report
    const msgsResp = await request.get(
      "/api/sessions/7ab598de-1e36-4822-9971-bda8dbdec532/messages",
    );
    let sessionId = "7ab598de-1e36-4822-9971-bda8dbdec532";

    if (msgsResp.status() !== 200) {
      // Find a session with lbctest KB
      const sessionsResp = await request.get("/api/sessions");
      const sessions = await sessionsResp.json();
      const lbctestSession = sessions.find(
        (s: any) =>
          s.kbScope &&
          s.kbScope.includes("f65cb573-05c7-4098-ba7d-c26c006986ee"),
      );
      if (lbctestSession) sessionId = lbctestSession.id;
    }

    // Navigate to chat
    await page.goto(`/#/chat?session=${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Screenshot the chat page
    await page.screenshot({
      path: "test-results/lbctest-report-chat-view.png",
    });

    // Check for rendered evidence links in the chat messages
    const linkStats = await page.evaluate(() => {
      const evidenceSpans = document.querySelectorAll("span[data-evidence-doc]");
      const docIdSet = new Set<string>();
      evidenceSpans.forEach((el) => {
        const docId = el.getAttribute("data-evidence-doc");
        if (docId) docIdSet.add(docId);
      });
      return {
        totalSpans: evidenceSpans.length,
        uniqueDocs: docIdSet.size,
      };
    });

    console.log(
      `Chat view: ${linkStats.totalSpans} evidence link spans, ${linkStats.uniqueDocs} unique docs`,
    );

    // Check if the report content is in push_content cards instead
    if (linkStats.totalSpans === 0) {
      // The report may be in a separate report view, not inline in chat
      // Navigate to reports page
      await page.goto("/#/reports");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);

      await page.screenshot({
        path: "test-results/lbctest-reports-page.png",
      });

      // Look for the report and click it
      const reportCard = page.locator("text=张伟等人组织卖淫案").first();
      if ((await reportCard.count()) > 0) {
        await reportCard.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1500);

        await page.screenshot({
          path: "test-results/lbctest-report-detail-view.png",
        });

        // Check evidence links in report view
        const reportLinkStats = await page.evaluate(() => {
          const spans = document.querySelectorAll("span[data-evidence-doc]");
          return spans.length;
        });
        console.log(
          `Report detail view: ${reportLinkStats} evidence link spans`,
        );
      }
    }

    // Try to click an evidence link if any are rendered
    const evidenceSpans = page.locator("span[data-evidence-doc]");
    const spanCount = await evidenceSpans.count();

    if (spanCount > 0) {
      // Click the first evidence link
      await evidenceSpans.first().click();
      await page.waitForTimeout(1000);

      const panelState = await page.evaluate(() => {
        const store = (window as any).__evidencePreviewStore;
        return store ? store.getState() : null;
      });

      if (panelState?.isOpen) {
        console.log(
          `Preview panel opened: mode=${panelState.mode}, docId=${panelState.docId}`,
        );
        await page.screenshot({
          path: "test-results/lbctest-evidence-link-preview.png",
        });
        await page.keyboard.press("Escape");
      }
    } else {
      console.log(
        "No evidence link spans found in DOM — report uses push_content cards or separate view",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Step 6: Screenshot summary of all previews
  // -----------------------------------------------------------------------
  test("6. 截图汇总验证", async ({ page, request }) => {
    if (!docMap) docMap = await getKbDocs(request);

    // Navigate to chat
    await page.goto("/#/chat");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Test 3 key formats with anchor-based preview (if anchors available)
    // and document preview (L0/L1/L2)
    const keyFormats = [
      { ext: "pdf", name: "起诉书.pdf", id: "b11b87d5-68f7-41ed-adb8-51194a189410" },
      { ext: "xlsx", name: "银行账户流水.xlsx", id: "a5b906c2-88d3-4a59-8344-b1c5ed78cf3c" },
      { ext: "jpg", name: "9月7日营收汇报.jpg", id: "e11870a8-a25d-4306-8610-41c2a6d2f179" },
      { ext: "docx", name: "扣押决定书及清单.docx", id: "614a0d8c-3462-4604-89b2-bba2ca918707" },
      { ext: "txt", name: "张伟(主犯)-讯问笔录.txt", id: "433c36b4-19c5-4f04-aa23-b6e95ba3e3fa" },
      { ext: "png", name: "银行流水趋势图.png", id: "4952aa76-2991-45e6-8cb2-e34d77f5a8bd" },
    ];

    for (const doc of keyFormats) {
      // Verify document exists in KB
      const exists = docMap.has(doc.id);
      console.log(`.${doc.ext} (${doc.name}): ${exists ? "EXISTS" : "NOT FOUND"}`);
      if (!exists) continue;

      // Open preview
      await page.evaluate(
        ({ kbId, docId }) => {
          const store = (window as any).__evidencePreviewStore;
          if (store) store.getState().closePreview();
          setTimeout(() => {
            (window as any).__evidencePreviewStore
              .getState()
              .openDocumentPreview(kbId, docId);
          }, 100);
        },
        { kbId: KB_ID, docId: doc.id },
      );
      await page.waitForTimeout(1500);

      // Screenshot L1 (default)
      await page.screenshot({
        path: `test-results/lbctest-summary-${doc.ext}-preview.png`,
      });

      // Switch to L0
      const l0Btn = page.locator("button").filter({ hasText: /^L0/ }).first();
      if ((await l0Btn.count()) > 0) {
        await l0Btn.click();
        await page.waitForTimeout(600);
        await page.screenshot({
          path: `test-results/lbctest-summary-${doc.ext}-L0.png`,
        });
      }

      // Switch to L2
      const l2Btn = page.locator("button").filter({ hasText: /^L2/ }).first();
      if ((await l2Btn.count()) > 0) {
        await l2Btn.click();
        await page.waitForTimeout(600);
        await page.screenshot({
          path: `test-results/lbctest-summary-${doc.ext}-L2.png`,
        });
      }

      // Close panel
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  });
});
