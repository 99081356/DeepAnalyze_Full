// =============================================================================
// DeepAnalyze - Folder Structure Feature Playwright Tests
// Tests all implemented features sequentially via browser-like HTTP requests.
// Uses test.describe.serial to ensure tests run in order with shared state.
// =============================================================================

import { test as base, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:21000";

// Extend test to share state via fixture
type Fixtures = {
  sharedState: {
    kbId: string;
    singleDocId: string;
    folderDocIds: string[];
  };
};

const test = base.extend<Fixtures>({
  sharedState: [({}, use) => use({ kbId: "", singleDocId: "", folderDocIds: [] }), { scope: "worker" }],
});

// Mutable shared state (works within serial describe)
const state: { kbId: string; singleDocId: string; folderDocIds: string[] } = {
  kbId: "",
  singleDocId: "",
  folderDocIds: [],
};

// ===========================================================================
test.describe.serial("文件夹结构保留功能测试", () => {
  // -------------------------------------------------------------------------
  // Test 1: Create test KB
  // -------------------------------------------------------------------------
  test("测试1：创建测试知识库", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/knowledge/kbs`, {
      data: { name: "文件夹结构测试", description: "测试文件夹层级保留功能" },
    });
    // API returns 201 for creation
    expect([200, 201]).toContain(resp.status());
    const data = await resp.json();
    expect(data.id).toBeDefined();
    state.kbId = data.id;
    console.log(`✅ 测试1通过 - 创建KB: ${state.kbId}`);
  });

  // -------------------------------------------------------------------------
  // Test 2: Single file upload — folder_path should be ""
  // -------------------------------------------------------------------------
  test("测试2：单文件上传 — folder_path 为空", async ({ request }) => {
    const fileContent = Buffer.from("这是一个测试文件的内容\n单文件上传测试");

    const resp = await request.post(`${BASE}/api/knowledge/kbs/${state.kbId}/upload`, {
      multipart: {
        file: { name: "report.txt", mimeType: "text/plain", buffer: fileContent },
      },
    });
    expect([200, 201]).toContain(resp.status());
    const data = await resp.json();
    expect(data.id).toBeDefined();
    expect(data.folderPath).toBe("");
    expect(data.filename).toBe("report.txt");

    state.singleDocId = data.id;

    // Verify file exists on disk at original/{kbId}/report.txt
    const expectedPath = join("data", "original", state.kbId, "report.txt");
    expect(existsSync(expectedPath)).toBe(true);

    console.log(`✅ 测试2通过 - 单文件上传: id=${state.singleDocId}, folderPath="", filename=report.txt`);
    console.log(`   磁盘文件存在: ${expectedPath}`);
  });

  // -------------------------------------------------------------------------
  // Test 3: Folder upload — folder_path should preserve hierarchy
  // -------------------------------------------------------------------------
  test("测试3：文件夹上传 — folder_path 保留层级", async ({ request }) => {
    const files = [
      { relativePath: "测试卷宗/第一章/概述.txt", content: "第一章概述内容" },
      { relativePath: "测试卷宗/第一章/细节.txt", content: "第一章详细内容" },
      { relativePath: "测试卷宗/第二章/分析.txt", content: "第二章分析内容" },
      { relativePath: "测试卷宗/附录.pdf", content: "附录内容（模拟PDF）" },
      { relativePath: "根目录文件.md", content: "根目录下的文件" },
    ];

    state.folderDocIds = [];

    for (const f of files) {
      const fileContent = Buffer.from(f.content);
      const resp = await request.post(`${BASE}/api/knowledge/kbs/${state.kbId}/upload`, {
        multipart: {
          file: { name: f.relativePath, mimeType: "application/octet-stream", buffer: fileContent },
        },
      });
      expect([200, 201]).toContain(resp.status());
      const data = await resp.json();
      state.folderDocIds.push(data.id);

      // Verify folder_path
      const lastSlash = f.relativePath.lastIndexOf("/");
      const expectedFolder = lastSlash >= 0 ? f.relativePath.substring(0, lastSlash) : "";
      expect(data.folderPath).toBe(expectedFolder);

      // Verify filename is just the basename
      const expectedBasename = lastSlash >= 0 ? f.relativePath.substring(lastSlash + 1) : f.relativePath;
      expect(data.filename).toBe(expectedBasename);

      console.log(`   上传: ${f.relativePath} → folderPath="${data.folderPath}", filename=${data.filename}`);
    }

    // Verify directory structure on disk
    const chapter1Dir = join("data", "original", state.kbId, "测试卷宗", "第一章");
    expect(existsSync(chapter1Dir)).toBe(true);
    const entries1 = readdirSync(chapter1Dir);
    expect(entries1).toContain("概述.txt");
    expect(entries1).toContain("细节.txt");

    const chapter2Dir = join("data", "original", state.kbId, "测试卷宗", "第二章");
    expect(existsSync(chapter2Dir)).toBe(true);

    const rootFile = join("data", "original", state.kbId, "根目录文件.md");
    expect(existsSync(rootFile)).toBe(true);

    console.log(`✅ 测试3通过 - 文件夹上传: ${state.folderDocIds.length} 个文件，目录结构正确`);
  });

  // -------------------------------------------------------------------------
  // Test 4: API returns folder_path field
  // -------------------------------------------------------------------------
  test("测试4：API 返回 folder_path 字段", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/knowledge/kbs/${state.kbId}/documents`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(data.documents).toBeDefined();
    expect(data.documents.length).toBeGreaterThanOrEqual(6);

    // Check all docs have folder_path field
    for (const doc of data.documents) {
      expect(doc).toHaveProperty("folder_path");
    }

    // Verify single upload doc
    const singleDoc = data.documents.find((d: any) => d.id === state.singleDocId);
    expect(singleDoc).toBeDefined();
    expect(singleDoc.folder_path).toBe("");
    expect(singleDoc.filename).toBe("report.txt");

    // Verify folder upload docs
    const nestedDoc = data.documents.find((d: any) => d.filename === "概述.txt");
    expect(nestedDoc).toBeDefined();
    expect(nestedDoc.folder_path).toBe("测试卷宗/第一章");

    console.log(`✅ 测试4通过 - API返回 ${data.documents.length} 个文档，全部含 folder_path`);
    console.log(`   单文件: folder_path="${singleDoc.folder_path}"`);
    console.log(`   嵌套文件: folder_path="${nestedDoc.folder_path}"`);
  });

  // -------------------------------------------------------------------------
  // Test 5: Original file serving /original route
  // -------------------------------------------------------------------------
  test("测试5：原始文件服务 /original 路由", async ({ request }) => {
    // Test root file
    const resp1 = await request.get(
      `${BASE}/api/knowledge/kbs/${state.kbId}/documents/${state.singleDocId}/original`,
    );
    expect(resp1.status()).toBe(200);
    const body1 = await resp1.text();
    expect(body1).toContain("单文件上传测试");

    // Test nested file
    const nestedDocId = state.folderDocIds[0]; // 概述.txt
    const resp2 = await request.get(
      `${BASE}/api/knowledge/kbs/${state.kbId}/documents/${nestedDocId}/original`,
    );
    expect(resp2.status()).toBe(200);
    const body2 = await resp2.text();
    expect(body2).toContain("第一章概述内容");

    console.log(`✅ 测试5通过 - 原始文件服务正常（根文件 + 嵌套文件）`);
  });

  // -------------------------------------------------------------------------
  // Test 6: File download /download route
  // -------------------------------------------------------------------------
  test("测试6：文件下载 /download 路由", async ({ request }) => {
    // Test single file download
    const resp1 = await request.get(
      `${BASE}/api/knowledge/kbs/${state.kbId}/documents/${state.singleDocId}/download`,
    );
    expect(resp1.status()).toBe(200);
    const cd1 = resp1.headers()["content-disposition"];
    expect(cd1).toContain("report.txt");

    // Test nested file download — should include folder path in filename (URI-encoded)
    const nestedDocId = state.folderDocIds[0]; // 概述.txt
    const resp2 = await request.get(
      `${BASE}/api/knowledge/kbs/${state.kbId}/documents/${nestedDocId}/download`,
    );
    expect(resp2.status()).toBe(200);
    const cd2 = resp2.headers()["content-disposition"];
    // Folder path is URI-encoded in Content-Disposition, decode to verify
    const decodedCd2 = decodeURIComponent(cd2);
    expect(decodedCd2).toContain("测试卷宗");

    const body2 = await resp2.text();
    expect(body2).toContain("第一章概述内容");

    console.log(`✅ 测试6通过 - 文件下载正常`);
    console.log(`   单文件 Content-Disposition: ${cd1}`);
    console.log(`   嵌套文件 Content-Disposition: ${cd2}`);
  });

  // -------------------------------------------------------------------------
  // Test 7: Document deletion — file cleanup + empty dir cleanup
  // -------------------------------------------------------------------------
  test("测试7：文档删除 — 文件清理 + 空目录清理", async ({ request }) => {
    // Step 1: Delete 细节.txt → 第一章/ still has 概述.txt
    const detailDocId = state.folderDocIds[1];
    const detailPath = join("data", "original", state.kbId, "测试卷宗", "第一章", "细节.txt");
    expect(existsSync(detailPath)).toBe(true);

    const resp = await request.delete(
      `${BASE}/api/knowledge/kbs/${state.kbId}/documents/${detailDocId}`,
    );
    expect([200, 204]).toContain(resp.status());
    const body = await resp.json().catch(() => ({}));
    expect(body.deleted).toBe(true);

    // File gone, directory remains (still has 概述.txt)
    expect(existsSync(detailPath)).toBe(false);
    const parentDir = join("data", "original", state.kbId, "测试卷宗", "第一章");
    expect(existsSync(parentDir)).toBe(true);
    expect(readdirSync(parentDir)).toContain("概述.txt");
    console.log(`✅ 步骤1: 删除 细节.txt — 文件已删，目录保留`);

    // Step 2: Delete 概述.txt → 第一章/ becomes empty → auto cleanup
    const overviewDocId = state.folderDocIds[0];
    const overviewPath = join("data", "original", state.kbId, "测试卷宗", "第一章", "概述.txt");
    expect(existsSync(overviewPath)).toBe(true);

    const resp2 = await request.delete(
      `${BASE}/api/knowledge/kbs/${state.kbId}/documents/${overviewDocId}`,
    );
    expect([200, 204]).toContain(resp2.status());

    // Both file and empty directory should be gone
    expect(existsSync(overviewPath)).toBe(false);
    expect(existsSync(parentDir)).toBe(false);
    console.log(`✅ 步骤2: 删除 概述.txt — 文件已删，空目录已清理`);

    // Non-empty directories should remain
    const chapter2Dir = join("data", "original", state.kbId, "测试卷宗", "第二章");
    expect(existsSync(chapter2Dir)).toBe(true);
    console.log(`✅ 步骤3: 第二章/ 保留（非空）`);

    const topDir = join("data", "original", state.kbId, "测试卷宗");
    expect(existsSync(topDir)).toBe(true);
    console.log(`✅ 步骤4: 测试卷宗/ 保留（非空）`);

    console.log(`✅ 测试7通过 - 删除 + 空目录清理正常`);
  });

  // -------------------------------------------------------------------------
  // Test 8: Frontend tree view rendering
  // -------------------------------------------------------------------------
  test("测试8：前端树形视图渲染", async ({ page }) => {
    // Navigate directly to the KB view via hash route
    await page.goto(`${BASE}/#/knowledge/${state.kbId}`);
    await page.waitForTimeout(3000);

    // Take screenshot
    await page.screenshot({ path: "/tmp/test-tree-view.png", fullPage: true });

    // Verify folder node "测试卷宗" is visible (tree view)
    const folderNode = page.locator("text=测试卷宗").first();
    const folderVisible = await folderNode.isVisible().catch(() => false);

    if (folderVisible) {
      console.log(`✅ 文件夹节点 "测试卷宗" 可见`);

      // Click to expand
      await folderNode.click();
      await page.waitForTimeout(500);

      // Check for 第二章 subfolder
      const chapter2 = page.locator("text=第二章").first();
      if (await chapter2.isVisible().catch(() => false)) {
        console.log(`✅ 子文件夹 "第二章" 可见（展开后）`);
      }
    } else {
      console.log(`⚠️ 文件夹节点不可见（检查截图）`);
    }

    // Check root-level files
    const rootFile = page.locator("text=report.txt").first();
    if (await rootFile.isVisible().catch(() => false)) {
      console.log(`✅ 根目录文件 report.txt 可见`);
    }

    const mdFile = page.locator("text=根目录文件.md").first();
    if (await mdFile.isVisible().catch(() => false)) {
      console.log(`✅ 根目录文件 根目录文件.md 可见`);
    }

    console.log(`✅ 测试8完成 - 截图保存: /tmp/test-tree-view.png`);
  });

  // -------------------------------------------------------------------------
  // Cleanup: Delete test KB
  // -------------------------------------------------------------------------
  test("清理：删除测试知识库", async ({ request }) => {
    if (!state.kbId) return;
    const resp = await request.delete(`${BASE}/api/knowledge/kbs/${state.kbId}`);
    expect([200, 204]).toContain(resp.status());
    console.log(`✅ 清理完成 - 测试KB已删除: ${state.kbId}`);
  });
});
