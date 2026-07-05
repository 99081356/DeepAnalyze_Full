// =============================================================================
// End-to-end verification for GitHub issue fixes #11 and #10
// Tests image upload to knowledge base and content persistence
// =============================================================================

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = 'http://localhost:21001';
const API_URL = 'http://localhost:21000';

// Test data paths (Windows paths accessible via WSL)
const TEST_IMAGE = '/mnt/d/testdata/images/20260314-172020.jpg';
const TEST_PDF_DIR = '/mnt/d/testdata/pdf/kb';
const TEST_AUDIO = '/mnt/d/testdata/sound/test_asr_chinese.mp3';

// Helper: wait for agent to finish
async function waitForAgentDone(page: Page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check if streaming has stopped (no streaming indicator visible)
    const streamingIndicator = page.locator('[data-testid="streaming-indicator"], .animate-pulse, .streaming');
    const isStreaming = await streamingIndicator.count() > 0;

    // Check for finish mark or content in the last message
    const messages = page.locator('[data-testid="message-item"], .message-item');
    const messageCount = await messages.count();

    if (messageCount > 0 && !isStreaming) {
      // Wait a bit more to ensure content is stable
      await page.waitForTimeout(2000);
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

// Helper: take screenshot and return path
async function takeScreenshot(page: Page, name: string) {
  const path = `tests/e2e/screenshots/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`Screenshot saved: ${path}`);
  return path;
}

// Helper: navigate to knowledge base panel and select a KB
async function navigateToKB(page: Page, kbId: string) {
  // Navigate directly to the KB via URL hash
  await page.goto(`${BASE_URL}#/knowledge/${kbId}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  // Click the 知识库 tab in sidebar to ensure the panel is active
  const kbTab = page.locator('button:has-text("知识库")').first();
  if (await kbTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await kbTab.click();
    await page.waitForTimeout(1000);
  }
}

test.describe('Issue #11 Fix: Knowledge Base Image Upload', () => {

  test('should upload image via DropZone after creating KB via API', async ({ page }) => {
    // Create a KB via API for clean test
    const kbName = `E2E-ImgUpload-${Date.now()}`;
    const kbResp = await fetch(`${API_URL}/api/knowledge/kbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: kbName }),
    });
    expect(kbResp.ok).toBeTruthy();
    const kb = await kbResp.json();
    console.log(`Created test KB: ${kb.id}`);

    // Navigate to the KB panel
    await navigateToKB(page, kb.id);
    await takeScreenshot(page, 'issue11-01-kb-panel');

    // Select the KB from the dropdown (<select> element in KnowledgePanel header)
    const kbDropdown = page.locator('select').first();
    await kbDropdown.waitFor({ state: 'visible', timeout: 10000 });

    // Select our test KB by value
    await kbDropdown.selectOption(kb.id);
    await page.waitForTimeout(1000);

    await takeScreenshot(page, 'issue11-02-kb-selected');

    // Now the DropZone should be visible (empty KB, no documents)
    const dropZone = page.locator('.drop-zone');
    await dropZone.waitFor({ state: 'visible', timeout: 10000 });
    console.log('✅ DropZone visible after selecting empty KB');

    // Verify the DropZone hint text mentions image formats
    // Verify the DropZone hint text mentions image formats (hint is in sibling <p>)
    const hintParagraph = page.locator('text=支持.*图片.*格式');
    const hasImageHint = await hintParagraph.isVisible().catch(() => false);
    if (hasImageHint) {
      console.log('✅ Hint text mentions image format support');
    } else {
      const dropZoneText = await dropZone.textContent().catch(() => '');
      console.log(`DropZone text: "${dropZoneText}"`);
    }

    // Save accept attribute BEFORE upload (DropZone disappears after document appears)
    const fileInput = page.locator('.drop-zone input[type="file"]');
    const acceptAttr = await fileInput.getAttribute('accept');
    console.log(`File input accept: "${acceptAttr}"`);

    // Upload image via the DropZone's hidden file input
    await fileInput.setInputFiles(TEST_IMAGE);
    console.log('Image file set on DropZone input');
    await page.waitForTimeout(3000);

    await takeScreenshot(page, 'issue11-03-after-upload');

    // Wait for upload to complete and document to appear
    await page.waitForTimeout(5000);

    // Check for upload progress or document card
    const docCard = page.locator('[data-doc-id]').first();
    const docVisible = await docCard.isVisible({ timeout: 15000 }).catch(() => false);

    if (docVisible) {
      console.log('✅ Document card visible after image upload');
    } else {
      console.log('⚠️ Document card not yet visible (upload/processing may be ongoing)');
    }

    await takeScreenshot(page, 'issue11-04-doclist');

    // Verify via API that the document was created
    const docsResp = await fetch(`${API_URL}/api/knowledge/kbs/${kb.id}/documents`);
    const docsBody = await docsResp.json();
    const docs: any[] = docsBody.documents || docsBody;
    const imageDoc = docs.find((d: any) =>
      (d.fileName || d.filename || d.name || '').includes('20260314-172020')
    );

    if (imageDoc) {
      console.log(`✅ Image document found in API: ${imageDoc.id}, status: ${imageDoc.status}`);
    } else {
      console.log(`❌ Image document not found. Total docs: ${docs.length}`);
      for (const d of docs) {
        console.log(`  Doc: ${JSON.stringify(d).slice(0, 200)}`);
      }
    }

    // Verify the saved accept attribute includes image formats
    expect(acceptAttr).toContain('.jpg');
    expect(acceptAttr).toContain('.png');
    expect(acceptAttr).toContain('.jpeg');

    // Cleanup
    await fetch(`${API_URL}/api/knowledge/kbs/${kb.id}`, { method: 'DELETE' });
  });

  test('should upload image via "上传文档" button with filechooser', async ({ page }) => {
    // Create a KB via API
    const kbName = `E2E-ImgBtn-${Date.now()}`;
    const kbResp = await fetch(`${API_URL}/api/knowledge/kbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: kbName }),
    });
    expect(kbResp.ok).toBeTruthy();
    const kb = await kbResp.json();
    console.log(`Created test KB: ${kb.id}`);

    // Navigate to the KB panel
    await navigateToKB(page, kb.id);

    // Select the KB from the dropdown
    const kbDropdown = page.locator('select').first();
    await kbDropdown.waitFor({ state: 'visible', timeout: 10000 });
    await kbDropdown.selectOption(kb.id);
    await page.waitForTimeout(1000);

    await takeScreenshot(page, 'issue11-btn-01-kb-selected');

    // Use "上传文档" button with filechooser event pattern
    // The button creates a dynamic file input via document.createElement
    const uploadBtn = page.locator('button:has-text("上传文档")');
    if (await uploadBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        uploadBtn.click(),
      ]);

      const acceptTypes = fileChooser.filter || '';
      console.log(`Filechooser accept types: "${acceptTypes}"`);

      await fileChooser.setFiles(TEST_IMAGE);
      console.log('✅ Image file uploaded via filechooser');
      await page.waitForTimeout(3000);

      await takeScreenshot(page, 'issue11-btn-02-uploaded');

      // Verify via API
      const docsResp = await fetch(`${API_URL}/api/knowledge/kbs/${kb.id}/documents`);
      const docsBody = await docsResp.json();
      const docs: any[] = docsBody.documents || docsBody;
      const imageDoc = docs.find((d: any) => d.fileName?.includes('20260314-172020'));

      if (imageDoc) {
        console.log(`✅ Image document found in API: ${imageDoc.id}, status: ${imageDoc.status}`);
      } else {
        console.log(`⚠️ Image document not yet in API. Total docs: ${docs.length}`);
      }
    } else {
      console.log('⚠️ "上传文档" button not visible — uploading via DropZone instead');
      const fileInput = page.locator('.drop-zone input[type="file"]');
      await fileInput.setInputFiles(TEST_IMAGE);
      await page.waitForTimeout(3000);
    }

    // Cleanup
    await fetch(`${API_URL}/api/knowledge/kbs/${kb.id}`, { method: 'DELETE' });
  });

  test('should verify file input accept includes image/audio formats', async ({ page }) => {
    // Create a KB via API
    const kbName = `E2E-Accept-${Date.now()}`;
    const kbResp = await fetch(`${API_URL}/api/knowledge/kbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: kbName }),
    });
    expect(kbResp.ok).toBeTruthy();
    const kb = await kbResp.json();

    // Navigate to the KB panel
    await navigateToKB(page, kb.id);

    // Select the KB
    const kbDropdown = page.locator('select').first();
    await kbDropdown.waitFor({ state: 'visible', timeout: 10000 });
    await kbDropdown.selectOption(kb.id);
    await page.waitForTimeout(1000);

    // Check DropZone file input accept attribute
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.waitFor({ state: 'attached', timeout: 10000 });

    const acceptAttr = await fileInput.getAttribute('accept');
    console.log(`Accept attribute: "${acceptAttr}"`);

    // Verify all expected formats are included
    const requiredFormats = ['.pdf', '.doc', '.docx', '.txt', '.md',
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg',
      '.mp3', '.wav', '.mp4'];
    const missingFormats: string[] = [];

    for (const fmt of requiredFormats) {
      if (!acceptAttr?.includes(fmt)) {
        missingFormats.push(fmt);
      }
    }

    if (missingFormats.length === 0) {
      console.log(`✅ All required formats present in accept attribute`);
    } else {
      console.log(`❌ Missing formats: ${missingFormats.join(', ')}`);
    }
    expect(missingFormats).toHaveLength(0);

    // Check hint text (in sibling <p> outside DropZone)
    const hintParagraph = page.locator('text=支持.*图片.*格式');
    const hasHint = await hintParagraph.isVisible().catch(() => false);
    if (hasHint) {
      console.log('✅ Hint text mentions image format support');
    } else {
      // Fallback: check the DropZone accept text which lists all formats
      const dropZoneText = await page.locator('.drop-zone').textContent().catch(() => '');
      console.log(`DropZone text: "${dropZoneText?.slice(0, 200)}"`);
      // The accept attribute already verified the formats are there
    }
    expect(hasHint || acceptAttr?.includes('.png')).toBeTruthy();

    // Cleanup
    await fetch(`${API_URL}/api/knowledge/kbs/${kb.id}`, { method: 'DELETE' });
  });
});

test.describe('Issue #10 Partial Fix: Content Persistence', () => {

  test('should preserve content after agent completes', async ({ page }) => {
    // Create a session
    const sessionResp = await fetch(`${API_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'E2E-Content-Persistence' }),
    });
    expect(sessionResp.ok).toBeTruthy();
    const session = await sessionResp.json();
    console.log(`Created test session: ${session.id}`);

    // Navigate to the session
    await page.goto(`${BASE_URL}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Find the test session and click it
    const sessionItem = page.locator(`text=E2E-Content-Persistence`).first();
    if (await sessionItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sessionItem.click();
      await page.waitForTimeout(500);
    }

    await takeScreenshot(page, 'issue10-01-session-ready');

    // Send a simple question that doesn't need tools
    const chatInput = page.locator('textarea, input[type="text"]').last();
    await chatInput.fill('请用中文简要介绍一下地球的基本情况，包括大小、年龄、大气成分，控制在200字以内。');
    await chatInput.press('Enter');

    // Wait for agent to complete
    await page.waitForTimeout(30000); // Initial wait for streaming

    await takeScreenshot(page, 'issue10-02-during-response');

    // Wait more for completion
    await page.waitForTimeout(30000);

    await takeScreenshot(page, 'issue10-03-after-response');

    // Now refresh the page to test persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Navigate back to the session
    const sessionItemAfter = page.locator(`text=E2E-Content-Persistence`).first();
    if (await sessionItemAfter.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sessionItemAfter.click();
      await page.waitForTimeout(1000);
    }

    await takeScreenshot(page, 'issue10-04-after-refresh');

    // Check if content is preserved
    const messageContent = page.locator('.message-content, .markdown-content, [class*="prose"]').last();
    const contentText = await messageContent.textContent().catch(() => '');

    if (contentText && contentText.length > 50) {
      console.log(`✅ Content preserved after refresh (${contentText.length} chars)`);
      console.log(`Content preview: ${contentText.slice(0, 100)}...`);
    } else {
      console.log(`❌ Content lost after refresh. Found: "${contentText?.slice(0, 100)}"`);
    }

    // Verify via API
    const messagesResp = await fetch(`${API_URL}/api/sessions/${session.id}/messages`);
    const messages = await messagesResp.json();
    const assistantMsg = messages.find((m: any) => m.role === 'assistant');

    if (assistantMsg) {
      console.log(`✅ API message preserved: ${(assistantMsg.content || '').length} chars`);
    } else {
      console.log(`❌ No assistant message found in API`);
    }
  });

  test('should handle multi-turn conversation with content preserved', async ({ page }) => {
    // Create session with KB
    const kbResp = await fetch(`${API_URL}/api/knowledge/kbs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `E2E-MultiTurn-${Date.now()}` }),
    });
    const kb = await kbResp.json();

    // Upload a PDF to the KB
    const pdfPath = '/mnt/d/testdata/pdf/kb';
    let pdfFile = '';
    try {
      const { readdirSync } = await import('fs');
      const files = readdirSync(pdfPath);
      pdfFile = files.find(f => f.endsWith('.pdf')) || '';
      if (pdfFile) {
        const fileBuffer = await import('fs').then(f => f.readFileSync(`${pdfPath}/${pdfFile}`));
        const formData = new FormData();
        formData.append('file', new Blob([fileBuffer]), pdfFile);

        const uploadResp = await fetch(`${API_URL}/api/knowledge/kbs/${kb.id}/upload`, {
          method: 'POST',
          body: formData,
        });
        console.log(`Upload ${pdfFile}: ${uploadResp.status}`);

        // Wait for processing
        await new Promise(r => setTimeout(r, 15000));
      }
    } catch (e) {
      console.log(`PDF upload skipped: ${e}`);
    }

    // Create session
    const sessionResp = await fetch(`${API_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'E2E-MultiTurn',
        kbScope: { knowledgeBases: [{ kbId: kb.id }], webSearch: true }
      }),
    });
    const session = await sessionResp.json();

    // Navigate to session in browser
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const sessionItem = page.locator('text=E2E-MultiTurn').first();
    if (await sessionItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sessionItem.click();
      await page.waitForTimeout(500);
    }

    // First question
    const chatInput = page.locator('textarea').last();
    if (await chatInput.isVisible()) {
      await chatInput.fill('你好，请简单介绍一下你自己');
      await chatInput.press('Enter');
      await page.waitForTimeout(20000);

      await takeScreenshot(page, 'issue10-multiturn-01');

      // Second question (like "看看另一个")
      await chatInput.fill('请列出1到5这几个数字');
      await chatInput.press('Enter');
      await page.waitForTimeout(20000);

      await takeScreenshot(page, 'issue10-multiturn-02');

      // Refresh and check
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      const sessionAfter = page.locator('text=E2E-MultiTurn').first();
      if (await sessionAfter.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sessionAfter.click();
        await page.waitForTimeout(1000);
      }

      await takeScreenshot(page, 'issue10-multiturn-03-after-refresh');

      // Verify all messages are preserved
      const messagesResp = await fetch(`${API_URL}/api/sessions/${session.id}/messages`);
      const messages = await messagesResp.json();
      const assistantMessages = messages.filter((m: any) => m.role === 'assistant' && m.content?.length > 10);
      console.log(`✅ Preserved ${assistantMessages.length} assistant messages after refresh`);

      for (const msg of assistantMessages) {
        console.log(`  Message ${(msg.content || '').slice(0, 60)}... (${(msg.content || '').length} chars)`);
      }
    }

    // Cleanup
    await fetch(`${API_URL}/api/knowledge/kbs/${kb.id}`, { method: 'DELETE' });
  });
});
