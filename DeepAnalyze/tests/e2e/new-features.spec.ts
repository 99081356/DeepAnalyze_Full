/**
 * E2E Tests for New Features (2025-05 batch)
 *
 * Covers:
 *   1. PushContent border highlighting (blue #3b82f6)
 *   2. KB Preprocessing button in settings
 *   3. .doc format support (DocConverter + LibreOffice)
 *   4. Slide-out preview for media documents
 *   5. Language drift detection (source verification)
 *   6. Dockerfile LibreOffice installation
 */
import { test, expect } from "@playwright/test";
import { execFile } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const BASE = "/api/knowledge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a KB with at least one ready document of given types. */
async function findKbWithDocs(
  request: any,
  minDocs = 1,
  preferredTypes?: string[],
): Promise<{ kbId: string; docs: any[] } | null> {
  const kbsResp = await request.get(`${BASE}/kbs`);
  const kbs = await kbsResp.json();
  for (const kb of kbs.knowledgeBases || []) {
    const docsResp = await request.get(`${BASE}/kbs/${kb.id}/documents`);
    if (docsResp.status() !== 200) continue;
    const docs =
      (await docsResp.json()).documents?.filter(
        (d: any) => d.status === "ready",
      ) || [];
    if (preferredTypes) {
      const preferred = docs.filter((d: any) =>
        preferredTypes.includes(d.file_type),
      );
      if (preferred.length >= minDocs)
        return { kbId: kb.id, docs: preferred };
    } else if (docs.length >= minDocs) {
      return { kbId: kb.id, docs };
    }
  }
  return null;
}

// Resolve source file paths relative to project root
// Playwright runs from the project root, so process.cwd() works
const PROJECT_ROOT = process.cwd();

// ===========================================================================
// 1. PushContent Card Border Highlighting
// ===========================================================================
test.describe("PushContent Card Styling", () => {
  test("PushContentCard compiled JS contains blue border #3b82f6", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Get the ChatWindow bundle URL
    const bundles = await page.evaluate(() => {
      return performance
        .getEntriesByType("resource")
        .filter((r: any) => r.name.includes("ChatWindow"))
        .map((r: any) => r.name);
    });

    if (bundles.length > 0) {
      const resp = await page.request.get(bundles[0]);
      const js = await resp.text();
      // The PushContentCard border should use #3b82f6
      expect(js).toContain("#3b82f6");
    }
  });

  test("PushContentCard source uses blue border color", async () => {
    const sourcePath = resolve(
      PROJECT_ROOT,
      "frontend/src/components/chat/PushContentCard.tsx",
    );
    const source = readFileSync(sourcePath, "utf-8");
    // Both markdown and non-markdown card borders should use #3b82f6
    const borderMatches = source.match(/border:\s*"1px solid #3b82f6"/g);
    expect(borderMatches).toBeTruthy();
    expect(borderMatches!.length).toBeGreaterThanOrEqual(2); // markdown + non-markdown
  });
});

// ===========================================================================
// 2. KB Preprocessing Button
// ===========================================================================
test.describe("KB Preprocessing", () => {
  test("preprocessing button visible in KB settings", async ({ page }) => {
    // Navigate to knowledge page
    await page.goto("/#/knowledge");
    await page.waitForLoadState("networkidle");

    const kbsResp = await page.request.get(`${BASE}/kbs`);
    const kbs = await kbsResp.json();
    const kbList = kbs.knowledgeBases || [];

    if (kbList.length === 0) {
      test.skip(true, "No knowledge bases available for testing");
      return;
    }

    // Navigate to first KB
    const kbId = kbList[0].id;
    await page.goto(`/#/knowledge/${kbId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Find and click settings button
    const settingsBtn = page.locator('button[title="知识库设置"]').first();
    if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(500);

      // Look for the preprocessing section heading
      const preprocessHeading = page.locator("text=深度预处理").first();
      await expect(preprocessHeading).toBeVisible({ timeout: 5000 });

      // Verify the preprocessing button exists and is clickable
      const preprocessBtn = page
        .locator('button:has-text("开始预处理")')
        .first();
      await expect(preprocessBtn).toBeVisible();
      expect(await preprocessBtn.isEnabled()).toBe(true);
    }
  });

  test("preprocessing API endpoint accepts valid KB and returns session", async ({
    request,
  }) => {
    const result = await findKbWithDocs(request, 1);
    test.skip(!result, "No KB with documents found");

    const resp = await request.post(`${BASE}/kbs/${result.kbId}/preprocess`);
    // 200 = started, 409 = already running (from previous test)
    expect([200, 409]).toContain(resp.status());

    if (resp.status() === 200) {
      const body = await resp.json();
      expect(body.sessionId).toBeTruthy();
      expect(body.kbId).toBe(result.kbId);
      expect(body.message).toContain("预处理已启动");
    }
  });

  test("preprocessing API returns 404 for non-existent KB", async ({
    request,
  }) => {
    const resp = await request.post(
      `${BASE}/kbs/non-existent-kb-id/preprocess`,
    );
    expect(resp.status()).toBe(404);
  });
});

// ===========================================================================
// 3. .doc Format Support
// ===========================================================================
test.describe(".doc Format Processing", () => {
  test("LibreOffice is available in the environment", async () => {
    let found = false;
    const candidates = [
      "libreoffice",
      "/usr/bin/libreoffice",
      "/usr/local/bin/libreoffice",
    ];

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ["--version"], { timeout: 5000 });
        found = true;
        break;
      } catch {
        continue;
      }
    }
    expect(found).toBe(true);
  });

  test("DocConverter source code exists and handles .doc type", async () => {
    const sourcePath = resolve(
      PROJECT_ROOT,
      "src/services/document-processors/doc-converter.ts",
    );
    expect(existsSync(sourcePath)).toBe(true);

    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toContain('"doc"');
    expect(source).toContain("libreoffice");
    expect(source).toContain("--convert-to");
    expect(source).toContain("docx");
  });

  test("DoclingProcessor includes doc as handled type", async () => {
    const sourcePath = resolve(
      PROJECT_ROOT,
      "src/services/document-processors/docling-processor.ts",
    );
    const source = readFileSync(sourcePath, "utf-8");

    const handledTypesSection = source.match(
      /HANDLED_TYPES\s*=\s*new\s*Set\(\[([\s\S]*?)\]\)/,
    );
    expect(handledTypesSection).toBeTruthy();
    expect(handledTypesSection![1]).toContain('"doc"');
    expect(handledTypesSection![1]).toContain('"docx"');
  });

  test(".doc file upload is accepted and typed correctly", async ({
    request,
  }) => {
    const testDocPath = "/tmp/test-doc-file.doc";
    if (!existsSync(testDocPath)) {
      test.skip(true, "Test .doc file not found. Run conversion first.");
      return;
    }

    const kbsResp = await request.get(`${BASE}/kbs`);
    const kbs = await kbsResp.json();
    const kbList = kbs.knowledgeBases || [];
    if (kbList.length === 0) {
      test.skip(true, "No KB available");
      return;
    }

    const kbId = kbList[0].id;
    const fileBuffer = readFileSync(testDocPath);

    const resp = await request.post(`${BASE}/kbs/${kbId}/upload`, {
      multipart: {
        file: {
          name: "test-legacy-doc.doc",
          mimeType: "application/msword",
          buffer: fileBuffer,
        },
      },
    });

    expect([200, 201]).toContain(resp.status());
    const body = await resp.json();
    expect(body.documentId).toBeTruthy();

    // Verify the file type is stored as "doc"
    const docsResp = await request.get(`${BASE}/kbs/${kbId}/documents`);
    const docs = await docsResp.json();
    const uploadedDoc = docs.documents?.find(
      (d: any) => d.id === body.documentId,
    );
    expect(uploadedDoc).toBeTruthy();
    expect(uploadedDoc.file_type).toBe("doc");
  });
});

// ===========================================================================
// 4. Slide-out Preview for Media Documents
// ===========================================================================
test.describe("Slide-out Preview", () => {
  test("preview button triggers slide-out panel for image documents", async ({
    page,
    request,
  }) => {
    const result = await findKbWithDocs(request, 1, [
      "jpg",
      "jpeg",
      "png",
      "tif",
      "tiff",
    ]);
    test.skip(!result, "No image documents found in any KB");

    await page.goto(`/#/knowledge/${result.kbId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    // Look for preview buttons
    const previewButtons = page.locator('button[title="预览"]');
    const count = await previewButtons.count();
    test.skip(count === 0, "No preview buttons found");

    await previewButtons.first().click();
    await page.waitForTimeout(500);

    // Check for the slide-out panel (fixed position, right side)
    const panel = page.locator(
      'div[style*="position: fixed"][style*="right: 0"]',
    );
    const overlay = page.locator(
      'div[style*="position: fixed"][style*="inset: 0"]',
    );

    const panelVisible =
      (await panel.isVisible().catch(() => false)) ||
      (await overlay.isVisible().catch(() => false));
    expect(panelVisible).toBe(true);
  });

  test("clicking overlay closes the slide-out panel", async ({
    page,
    request,
  }) => {
    const result = await findKbWithDocs(request, 1, ["jpg", "jpeg", "png"]);
    test.skip(!result, "No image documents found");

    await page.goto(`/#/knowledge/${result.kbId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    const previewButtons = page.locator('button[title="预览"]');
    if ((await previewButtons.count()) === 0) {
      test.skip(true, "No preview buttons visible");
      return;
    }

    await previewButtons.first().click();
    await page.waitForTimeout(500);

    const overlay = page
      .locator('div[style*="inset: 0"][style*="z-index"]')
      .first();
    if (await overlay.isVisible({ timeout: 2000 }).catch(() => false)) {
      await overlay.click();
      await page.waitForTimeout(300);

      const remainingPanel = page.locator(
        'div[style*="position: fixed"][style*="right: 0"]',
      );
      expect(await remainingPanel.count()).toBe(0);
    }
  });
});

// ===========================================================================
// 5. Language Drift Detection (Source Verification)
// ===========================================================================
test.describe("Language Drift Detection", () => {
  test("agent-definitions includes enhanced language rule", async () => {
    const sourcePath = resolve(
      PROJECT_ROOT,
      "src/services/agent/agent-definitions.ts",
    );
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toContain("最高优先级");
    expect(source).toContain("默认使用中文");
    expect(source).toContain("工具调用返回结果后");
  });

  test("agent-runner includes language drift detection", async () => {
    const sourcePath = resolve(
      PROJECT_ROOT,
      "src/services/agent/agent-runner.ts",
    );
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toContain("Language drift detected");
    expect(source).toContain("请使用中文回复");
  });
});

// ===========================================================================
// 6. Docker & Build Configuration
// ===========================================================================
test.describe("Docker Configuration", () => {
  test("Dockerfile includes libreoffice-writer package", async () => {
    const sourcePath = resolve(PROJECT_ROOT, "Dockerfile");
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toContain("libreoffice-writer");
  });

  test("build-offline-package.sh includes LibreOffice check/install", async () => {
    const sourcePath = resolve(
      PROJECT_ROOT,
      "scripts/build-offline-package.sh",
    );
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toContain("Checking LibreOffice");
    expect(source).toContain("libreoffice-writer");
  });
});
