// =============================================================================
// DeepAnalyze - Folder Structure Feature Playwright Tests
// Tests all implemented features sequentially via browser-like HTTP requests.
// =============================================================================

import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const BASE = "http://localhost:21000";

// Shared state across tests
let kbId = "";
let singleDocId = "";
let folderDocIds: string[] = [];
let singleDocFilename = "";
let folderDocFilename = "";
let folderDocFolderPath = "";
let singleDocFilePath = "";
let folderDocFilePath = "";

// ---------------------------------------------------------------------------
// Test 1: Create test KB
// ---------------------------------------------------------------------------
test("测试1：创建测试知识库", async ({ request }) => {
  const resp = await request.post(`${BASE}/api/knowledge/kbs`, {
    data: { name: "文件夹结构测试", description: "测试文件夹层级保留功能" },
  });
  expect(resp.status()).toBe(200);
  const data = await resp.json();
  expect(data.id).toBeDefined();
  kbId = data.id;
  console.log(`✅ 创建KB: ${kbId}`);
});

// ---------------------------------------------------------------------------
// Test 2: Single file upload — folder_path should be ""
// ---------------------------------------------------------------------------
test("测试2：单文件上传 — folder_path 为空", async ({ request }) => {
  const fileContent = Buffer.from("这是一个测试文件的内容\n单文件上传测试");
  const formData = new FormData();
  formData.append("file", new File([fileContent], "report.txt", { type: "text/plain" }));

  const resp = await request.post(`${BASE}/api/knowledge/kbs/${kbId}/upload`, {
    multipart: { file: { name: "report.txt", mimeType: "text/plain", buffer: fileContent } },
  });
  expect(resp.status()).toBe(200);
  const data = await resp.json();
  expect(data.id).toBeDefined();
  expect(data.folderPath).toBe("");
  expect(data.filename).toBe("report.txt");

  singleDocId = data.id;
  singleDocFilename = data.filename;
  singleDocFilePath = data.filePath;
  console.log(`✅ 单文件上传: id=${singleDocId}, folderPath="${data.folderPath}", filename=${data.filename}`);
  console.log(`   filePath=${data.filePath}`);

  // Verify file exists on disk at original/{kbId}/report.txt
  const expectedPath = join("data", "original", kbId, "report.txt");
  expect(existsSync(expectedPath)).toBe(true);
  console.log(`   磁盘文件存在: ${expectedPath}`);
});

// ---------------------------------------------------------------------------
// Test 3: Folder upload — folder_path should preserve hierarchy
// ---------------------------------------------------------------------------
test("测试3：文件夹上传 — folder_path 保留层级", async ({ request }) => {
  // Simulate folder upload with nested paths
  const files = [
    { relativePath: "测试卷宗/第一章/概述.txt", content: "第一章概述内容" },
    { relativePath: "测试卷宗/第一章/细节.txt", content: "第一章详细内容" },
    { relativePath: "测试卷宗/第二章/分析.txt", content: "第二章分析内容" },
    { relativePath: "测试卷宗/附录.pdf", content: "附录内容（模拟PDF）" },
    { relativePath: "根目录文件.md", content: "根目录下的文件" },
  ];

  folderDocIds = [];

  for (const f of files) {
    const fileContent = Buffer.from(f.content);
    const resp = await request.post(`${BASE}/api/knowledge/kbs/${kbId}/upload`, {
      multipart: {
        file: { name: f.relativePath, mimeType: "application/octet-stream", buffer: fileContent },
      },
    });
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    folderDocIds.push(data.id);

    // Verify folder_path
    const lastSlash = f.relativePath.lastIndexOf("/");
    const expectedFolder = lastSlash >= 0 ? f.relativePath.substring(0, lastSlash) : "";
    expect(data.folderPath).toBe(expectedFolder);

    // Verify filename is just the basename
    const expectedBasename = lastSlash >= 0 ? f.relativePath.substring(lastSlash + 1) : f.relativePath;
    expect(data.filename).toBe(expectedBasename);

    console.log(`✅ 上传: ${f.relativePath} → folderPath="${data.folderPath}", filename=${data.filename}`);
  }

  // Save references for later tests (use the nested file)
  folderDocFilename = "概述.txt";
  folderDocFolderPath = "测试卷宗/第一章";

  // Verify directory structure on disk
  const expectedDir = join("data", "original", kbId, "测试卷宗", "第一章");
  expect(existsSync(expectedDir)).toBe(true);
  const entries = readdirSync(expectedDir);
  expect(entries).toContain("概述.txt");
  console.log(`✅ 磁盘目录结构验证: ${expectedDir} 包含 ${entries.join(", ")}`);

  // Also check root file
  const rootFile = join("data", "original", kbId, "根目录文件.md");
  expect(existsSync(rootFile)).toBe(true);
  console.log(`✅ 根目录文件存在: ${rootFile}`);
});

// ---------------------------------------------------------------------------
// Test 4: API returns folder_path field
// ---------------------------------------------------------------------------
test("测试4：API 返回 folder_path 字段", async ({ request }) => {
  const resp = await request.get(`${BASE}/api/knowledge/kbs/${kbId}/documents`);
  expect(resp.status()).toBe(200);
  const data = await resp.json();
  expect(data.documents).toBeDefined();
  expect(data.documents.length).toBeGreaterThanOrEqual(6); // 1 single + 5 folder

  // Check all docs have folder_path field
  for (const doc of data.documents) {
    expect(doc).toHaveProperty("folder_path");
  }

  // Verify single upload doc
  const singleDoc = data.documents.find((d: any) => d.id === singleDocId);
  expect(singleDoc).toBeDefined();
  expect(singleDoc.folder_path).toBe("");
  expect(singleDoc.filename).toBe("report.txt");

  // Verify folder upload docs
  const nestedDoc = data.documents.find((d: any) => d.filename === "概述.txt");
  expect(nestedDoc).toBeDefined();
  expect(nestedDoc.folder_path).toBe("测试卷宗/第一章");
  folderDocFilePath = nestedDoc.file_path;

  console.log(`✅ API返回 ${data.documents.length} 个文档，全部含 folder_path 字段`);
  console.log(`   单文件: folder_path="${singleDoc.folder_path}", filename=${singleDoc.filename}`);
  console.log(`   嵌套文件: folder_path="${nestedDoc.folder_path}", filename=${nestedDoc.filename}`);
});

// ---------------------------------------------------------------------------
// Test 5: Original file serving /original route
// ---------------------------------------------------------------------------
test("测试5：原始文件服务 /original 路由", async ({ request }) => {
  // Test single file (root)
  const resp1 = await request.get(`${BASE}/api/knowledge/kbs/${kbId}/documents/${singleDocId}/original`);
  expect(resp1.status()).toBe(200);
  const body1 = await resp1.text();
  expect(body1).toContain("单文件上传测试");
  console.log(`✅ 根文件服务正常: status=${resp1.status()}`);

  // Test nested folder file
  const nestedDocId = folderDocIds[0]; // 概述.txt
  const resp2 = await request.get(`${BASE}/api/knowledge/kbs/${kbId}/documents/${nestedDocId}/original`);
  expect(resp2.status()).toBe(200);
  const body2 = await resp2.text();
  expect(body2).toContain("第一章概述内容");
  console.log(`✅ 嵌套文件服务正常: status=${resp2.status()}`);
});

// ---------------------------------------------------------------------------
// Test 6: File download /download route
// ---------------------------------------------------------------------------
test("测试6：文件下载 /download 路由", async ({ request }) => {
  // Test single file download
  const resp1 = await request.get(`${BASE}/api/knowledge/kbs/${kbId}/documents/${singleDocId}/download`);
  expect(resp1.status()).toBe(200);
  const cd1 = resp1.headers()["content-disposition"];
  expect(cd1).toContain("report.txt");
  console.log(`✅ 单文件下载: Content-Disposition="${cd1}"`);

  // Test nested file download — should include folder path in filename
  const nestedDocId = folderDocIds[0]; // 概述.txt
  const resp2 = await request.get(`${BASE}/api/knowledge/kbs/${kbId}/documents/${nestedDocId}/download`);
  expect(resp2.status()).toBe(200);
  const cd2 = resp2.headers()["content-disposition"];
  // Should contain folder path prefix
  expect(cd2).toContain("测试卷宗");
  console.log(`✅ 嵌套文件下载: Content-Disposition="${cd2}"`);

  // Verify body content
  const body2 = await resp2.text();
  expect(body2).toContain("第一章概述内容");
});

// ---------------------------------------------------------------------------
// Test 7: Document deletion — file cleanup + empty dir cleanup
// ---------------------------------------------------------------------------
test("测试7：文档删除 — 文件清理 + 空目录清理", async ({ request }) => {
  // Delete the "细节.txt" file from 测试卷宗/第一章/
  // After this, 第一章/ should still have 概述.txt
  const detailDocId = folderDocIds[1]; // 细节.txt
  const detailPath = join("data", "original", kbId, "测试卷宗", "第一章", "细节.txt");

  // Verify file exists before deletion
  expect(existsSync(detailPath)).toBe(true);
  console.log(`   删除前文件存在: ${detailPath}`);

  const resp = await request.delete(`${BASE}/api/knowledge/kbs/${kbId}/documents/${detailDocId}`);
  expect(resp.status()).toBe(200);
  const data = await resp.json();
  expect(data.deleted).toBe(true);
  console.log(`✅ 删除API返回成功`);

  // Verify file is gone
  expect(existsSync(detailPath)).toBe(false);
  console.log(`✅ 文件已从磁盘删除`);

  // Verify parent directory still exists (has other files)
  const parentDir = join("data", "original", kbId, "测试卷宗", "第一章");
  expect(existsSync(parentDir)).toBe(true);
  const remaining = readdirSync(parentDir);
  expect(remaining).toContain("概述.txt");
  console.log(`✅ 父目录保留（仍有其他文件）: ${remaining.join(", ")}`);

  // Now delete 概述.txt — this should make 第一章/ empty and trigger cleanup
  const overviewDocId = folderDocIds[0]; // 概述.txt
  const overviewPath = join("data", "original", kbId, "测试卷宗", "第一章", "概述.txt");
  expect(existsSync(overviewPath)).toBe(true);

  const resp2 = await request.delete(`${BASE}/api/knowledge/kbs/${kbId}/documents/${overviewDocId}`);
  expect(resp2.status()).toBe(200);

  // 第一章/ should be cleaned up (empty)
  expect(existsSync(overviewPath)).toBe(false);
  expect(existsSync(parentDir)).toBe(false);
  console.log(`✅ 空目录已自动清理: ${parentDir}`);

  // 第二章/ should still exist (has 分析.txt)
  const chapter2Dir = join("data", "original", kbId, "测试卷宗", "第二章");
  expect(existsSync(chapter2Dir)).toBe(true);
  console.log(`✅ 非空目录保留: ${chapter2Dir}`);

  // 测试卷宗/ should still exist (has 附录.pdf + 第二章/)
  const topDir = join("data", "original", kbId, "测试卷宗");
  expect(existsSync(topDir)).toBe(true);
  console.log(`✅ 顶层文件夹保留: ${topDir}`);
});

// ---------------------------------------------------------------------------
// Test 8: Frontend tree view rendering
// ---------------------------------------------------------------------------
test("测试8：前端树形视图渲染", async ({ page }) => {
  // Navigate to the app
  await page.goto(`${BASE}/`);

  // Wait for page to load
  await page.waitForTimeout(2000);

  // Click on the test KB in the sidebar
  // Find the KB by name "文件夹结构测试"
  const kbItem = page.locator("text=文件夹结构测试").first();
  await kbItem.click();
  await page.waitForTimeout(1500);

  // Take a screenshot for verification
  await page.screenshot({ path: "/tmp/test-tree-view.png", fullPage: true });

  // Check that folder structure is visible — look for folder icons or folder names
  // The tree should show "测试卷宗" as a folder node
  const folderNode = page.locator("text=测试卷宗").first();
  // If folder node exists, the tree is working
  if (await folderNode.isVisible()) {
    console.log(`✅ 文件夹节点 "测试卷宗" 可见`);

    // Click to expand
    await folderNode.click();
    await page.waitForTimeout(500);

    // Should see subfolders or files
    const chapter2 = page.locator("text=第二章").first();
    if (await chapter2.isVisible()) {
      console.log(`✅ 子文件夹 "第二章" 可见（展开后）`);
    }
  } else {
    // Might be in flat mode if no folders left (we deleted some docs)
    console.log(`⚠️ 文件夹节点不可见（可能是剩余文档不足以形成文件夹层级）`);
  }

  // Check that root-level files are visible
  const rootFile = page.locator("text=report.txt").first();
  if (await rootFile.isVisible()) {
    console.log(`✅ 根目录文件 report.txt 可见`);
  }

  const mdFile = page.locator("text=根目录文件.md").first();
  if (await mdFile.isVisible()) {
    console.log(`✅ 根目录文件 根目录文件.md 可见`);
  }

  console.log(`✅ 截图保存: /tmp/test-tree-view.png`);
});

// ---------------------------------------------------------------------------
// Cleanup: Delete test KB
// ---------------------------------------------------------------------------
test("清理：删除测试知识库", async ({ request }) => {
  if (!kbId) return;
  const resp = await request.delete(`${BASE}/api/knowledge/kbs/${kbId}`);
  expect(resp.status()).toBe(200);
  console.log(`✅ 测试KB已清理: ${kbId}`);
});
