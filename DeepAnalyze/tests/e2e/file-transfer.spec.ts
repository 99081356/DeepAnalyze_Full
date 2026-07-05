// =============================================================================
// File Transfer Feature — Playwright E2E Test
// =============================================================================
// Tests: file upload, file push rendering, download API, inline media
// =============================================================================

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE_URL = 'http://localhost:3000';
const API_URL = 'http://localhost:21000';
const SCREENSHOT_DIR = '/tmp/file-transfer-screenshots';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Minimal valid 1x1 red pixel PNG (67 bytes)
const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  0x00, 0x00, 0x00, 0x0D, // IHDR length
  0x49, 0x48, 0x44, 0x52, // IHDR
  0x00, 0x00, 0x00, 0x01, // width: 1
  0x00, 0x00, 0x00, 0x01, // height: 1
  0x08, 0x02,             // 8-bit RGB
  0x00, 0x00, 0x00,       // compression, filter, interlace
  0x90, 0x77, 0x53, 0xDE, // CRC
  0x00, 0x00, 0x00, 0x0C, // IDAT length
  0x49, 0x44, 0x41, 0x54, // IDAT
  0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00,
  0x00, 0x02, 0x00, 0x01,
  0xE2, 0x21, 0xBC, 0x33, // CRC
  0x00, 0x00, 0x00, 0x00, // IEND length
  0x49, 0x45, 0x4E, 0x44, // IEND
  0xAE, 0x42, 0x60, 0x82, // CRC
]);

// Helper: create test file on disk
function createTestFile(name: string, content: string | Buffer) {
  const tmpDir = '/tmp/da-test-files';
  mkdirSync(tmpDir, { recursive: true });
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, content);
  return filePath;
}

// Helper: create session output dir and test files
async function setupSessionOutput(request: any, title: string, files: Record<string, string | Buffer>) {
  const sessionResp = await request.post(`${API_URL}/api/sessions`, {
    data: { title },
  });
  expect(sessionResp.ok()).toBeTruthy();
  const session = await sessionResp.json();
  const sessionId = session.id;

  const dataDir = process.env.DATA_DIR || 'data';
  const outputDir = join(dataDir, 'sessions', sessionId, 'output');
  mkdirSync(outputDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outputDir, name), content);
  }

  return { sessionId, outputDir };
}

// Helper: wait for zustand store to be exposed on window
async function waitForStore(page: any) {
  await page.waitForFunction(() => !!(window as any).__DA_STORE__, { timeout: 10000 });
}

// Helper: inject pushed content into zustand store
async function injectPushedContent(page: any, sessionId: string, items: any[]) {
  await page.evaluate(({ sessionId, items }) => {
    const store = (window as any).__DA_STORE__;
    if (!store) throw new Error('Store not available');
    const state = store.getState();
    const msg = {
      id: 'test-msg-' + Date.now(),
      role: 'assistant',
      content: 'Here are the generated files:',
      createdAt: new Date().toISOString(),
      pushedContents: items,
    };
    // Set currentSessionId so the ChatWindow renders messages
    store.setState({
      currentSessionId: sessionId,
      messages: [...(state.messages || []), msg],
    });
  }, { sessionId, items });
}

test.describe('File Transfer Feature', () => {

  // -----------------------------------------------------------------------
  // Test 1: Page loads with chat interface
  // -----------------------------------------------------------------------
  test('page loads with chat interface', async ({ page, request }) => {
    // Create a session via API so MessageInput renders
    const sessionResp = await request.post(`${API_URL}/api/sessions`, {
      data: { title: 'page-load-test' },
    });
    expect(sessionResp.ok()).toBeTruthy();
    const session = await sessionResp.json();

    // Navigate to the session route (hash router)
    await page.goto(`${BASE_URL}/#/sessions/${session.id}`);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '01-page-load.png') });

    // Should have a textarea for message input
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible({ timeout: 10000 });
  });

  // -----------------------------------------------------------------------
  // Test 2: Session output file download API (backend)
  // -----------------------------------------------------------------------
  test('session output file download API works', async ({ request }) => {
    const { sessionId } = await setupSessionOutput(request, 'download-test', {
      'test.txt': 'Hello World! This is a test file.',
      'test.pptx': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(1000).fill(0)]),
    });

    // Test text file download
    const txtResp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/test.txt`);
    expect(txtResp.status()).toBe(200);
    expect(await txtResp.text()).toContain('Hello World');
    expect(txtResp.headers()['content-type']).toContain('text/plain');

    // Test PPTX file download
    const pptxResp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/test.pptx`);
    expect(pptxResp.status()).toBe(200);
    expect(pptxResp.headers()['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    expect(pptxResp.headers()['content-disposition']).toContain('test.pptx');

    // Test 404 for non-existent file
    const notFound = await request.get(`${API_URL}/api/sessions/${sessionId}/output/nonexistent.xyz`);
    expect(notFound.status()).toBe(404);

    // Test path traversal blocked
    const traversal = await request.get(`${API_URL}/api/sessions/${sessionId}/output/..%2F..%2F..%2Fetc%2Fpasswd`);
    expect([400, 403, 404]).toContain(traversal.status());
  });

  // -----------------------------------------------------------------------
  // Test 3: Range request support
  // -----------------------------------------------------------------------
  test('range requests work for large files', async ({ request }) => {
    const { sessionId } = await setupSessionOutput(request, 'range-test', {
      'video.mp4': Buffer.alloc(10000),
    });

    const rangeResp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/video.mp4`, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(rangeResp.status()).toBe(206);
    expect(rangeResp.headers()['content-range']).toContain('bytes');
    expect(rangeResp.headers()['content-length']).toBe('100');
  });

  // -----------------------------------------------------------------------
  // Test 4: File upload via media API
  // -----------------------------------------------------------------------
  test('file upload via media API works', async ({ request }) => {
    const sessionResp = await request.post(`${API_URL}/api/sessions`, {
      data: { title: 'upload-test' },
    });
    const session = await sessionResp.json();

    const uploadResp = await request.post(`${API_URL}/api/sessions/${session.id}/media`, {
      multipart: {
        file: {
          name: 'test-data.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('Name,Age\nAlice,30\nBob,25\n'),
        },
      },
    });
    expect(uploadResp.ok()).toBeTruthy();
    const result = await uploadResp.json();
    expect(result.mediaId).toBeTruthy();
    expect(result.mimeType).toBe('text/csv');
  });

  // -----------------------------------------------------------------------
  // Test 5: MIME type detection for various file types
  // -----------------------------------------------------------------------
  test('correct MIME types for various file extensions', async ({ request }) => {
    const testCases: [string, string | Buffer, string][] = [
      ['test.md', '# Hello\n', 'text/markdown'],
      ['test.json', '{"key":"value"}', 'application/json'],
      ['test.csv', 'a,b\n1,2\n', 'text/csv'],
      ['test.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, ...Array(100).fill(0)]), 'image/png'],
      ['test.mp3', Buffer.from([0xFF, 0xFB, ...Array(100).fill(0)]), 'audio/mpeg'],
      ['test.mp4', Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, ...Array(100).fill(0)]), 'video/mp4'],
      ['test.pptx', Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['test.zip', Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), 'application/zip'],
      ['test.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(100).fill(0)]), 'application/pdf'],
      ['test.xlsx', Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ];

    const files: Record<string, string | Buffer> = {};
    for (const [name, content] of testCases) {
      files[name] = content;
    }

    const { sessionId } = await setupSessionOutput(request, 'mime-test', files);

    for (const [name, , expectedMime] of testCases) {
      const resp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/${name}`);
      expect(resp.status()).toBe(200);
      expect(resp.headers()['content-type']).toBe(expectedMime);
    }
  });

  // -----------------------------------------------------------------------
  // Test 6: File cards render for pushed files (PPTX, ZIP, etc.)
  // -----------------------------------------------------------------------
  test('file cards render for non-media file pushes', async ({ page, request }) => {
    const { sessionId } = await setupSessionOutput(request, 'render-test', {
      'report.pptx': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(1000).fill(0)]),
      'archive.zip': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(500).fill(0)]),
    });

    // Navigate to the session
    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    // Inject pushed content
    await injectPushedContent(page, sessionId, [
      {
        type: 'file', title: 'PPT Report',
        data: '', fileName: 'report.pptx', fileSize: 1004,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        downloadUrl: `/api/sessions/${sessionId}/output/report.pptx`,
      },
      {
        type: 'file', title: 'Archive File',
        data: '', fileName: 'archive.zip', fileSize: 508,
        mimeType: 'application/zip',
        downloadUrl: `/api/sessions/${sessionId}/output/archive.zip`,
      },
    ]);

    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '06-file-cards.png') });

    // Check for file card content
    const pageText = await page.textContent('body') || '';
    expect(pageText).toContain('report.pptx');
    expect(pageText).toContain('PPTX');
    expect(pageText).toContain('archive.zip');

    // Check for download buttons (title="下载文件")
    const downloadBtns = await page.locator('button[title="下载文件"]').count();
    expect(downloadBtns).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // Test 7: Inline media renders (audio, video, image)
  // -----------------------------------------------------------------------
  test('inline media renders for audio/video/image pushes', async ({ page, request }) => {
    const { sessionId } = await setupSessionOutput(request, 'media-render-test', {
      'test.png': VALID_PNG,
      'test.mp3': Buffer.from([0xFF, 0xFB, ...Array(200).fill(0)]),
      'test.mp4': Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, ...Array(200).fill(0)]),
    });

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    await injectPushedContent(page, sessionId, [
      {
        type: 'file', title: 'Test Image',
        data: '', fileName: 'test.png', fileSize: VALID_PNG.length,
        mimeType: 'image/png',
        downloadUrl: `/api/sessions/${sessionId}/output/test.png`,
      },
      {
        type: 'file', title: 'Test Audio',
        data: '', fileName: 'test.mp3', fileSize: 208,
        mimeType: 'audio/mpeg',
        downloadUrl: `/api/sessions/${sessionId}/output/test.mp3`,
      },
      {
        type: 'file', title: 'Test Video',
        data: '', fileName: 'test.mp4', fileSize: 208,
        mimeType: 'video/mp4',
        downloadUrl: `/api/sessions/${sessionId}/output/test.mp4`,
      },
    ]);

    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '07-inline-media.png') });

    // Check inline media elements
    const audioCount = await page.locator('audio').count();
    const videoCount = await page.locator('video').count();
    const imgCount = await page.locator('img[src*="/api/sessions/"]').count();

    console.log(`Audio: ${audioCount}, Video: ${videoCount}, Image: ${imgCount}`);
    expect(audioCount).toBeGreaterThan(0);
    expect(videoCount).toBeGreaterThan(0);
    expect(imgCount).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 8: Attach button triggers file chooser
  // -----------------------------------------------------------------------
  test('attach button triggers file chooser', async ({ page, request }) => {
    // Create a session via API so MessageInput renders
    const sessionResp = await request.post(`${API_URL}/api/sessions`, {
      data: { title: 'attach-test' },
    });
    expect(sessionResp.ok()).toBeTruthy();
    const session = await sessionResp.json();

    await page.goto(`${BASE_URL}/#/sessions/${session.id}`);
    await page.waitForTimeout(4000);

    // Find the attach button
    const attachBtn = page.locator('button[title="添加附件"]');
    await expect(attachBtn).toBeVisible({ timeout: 10000 });

    // Create test file
    const txtFile = createTestFile('test-upload.txt', 'Hello from test file!');

    // Click and set files
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      attachBtn.click(),
    ]);

    await fileChooser.setFiles([txtFile]);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '08-file-attached.png') });

    // Check the file appears somewhere in the UI
    const pageText = await page.textContent('body') || '';
    const hasFileRef = pageText.includes('test-upload') || pageText.includes('TXT') || pageText.includes('.txt');
    console.log(`File reference visible: ${hasFileRef}`);
  });

  // -----------------------------------------------------------------------
  // Test 9: File card shows detailed info (filename, extension, size)
  // -----------------------------------------------------------------------
  test('file card shows filename, extension badge, size', async ({ page, request }) => {
    const { sessionId } = await setupSessionOutput(request, 'card-detail-test', {
      'report.pptx': Buffer.alloc(2048),
    });

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    await injectPushedContent(page, sessionId, [{
      type: 'file', title: 'Demo PPT Report',
      data: '', fileName: 'report.pptx', fileSize: 2048,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      downloadUrl: `/api/sessions/${sessionId}/output/report.pptx`,
    }]);

    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '09-file-card-detail.png') });

    const pageText = await page.textContent('body') || '';
    expect(pageText).toContain('report.pptx');
    expect(pageText).toContain('PPTX');
    expect(pageText).toContain('2.0 KB');
  });
});
