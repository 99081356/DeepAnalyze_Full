// =============================================================================
// Comprehensive Feature Test — Playwright E2E
// =============================================================================
// Tests all recent features and bug fixes:
// 1. File push rendering (PPTX, ZIP, PDF file cards)
// 2. Inline media (image, audio, video)
// 3. File download API (MIME types, range requests, security)
// 4. File upload (attach button, media API)
// 5. PushContentCard crash fix (undefined data)
// 6. Download button on ALL content cards (not just file pushes)
// 7. AI message action bar always visible (copy, regenerate, export)
// =============================================================================

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE_URL = 'http://localhost:3000';
const API_URL = 'http://localhost:21000';
const SCREENSHOT_DIR = '/tmp/comprehensive-test-screenshots';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Minimal valid 1x1 red pixel PNG (67 bytes)
const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
  0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54,
  0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00,
  0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
  0xAE, 0x42, 0x60, 0x82,
]);

// Helper: create session + output dir with files
async function setupSession(request: any, title: string, files: Record<string, string | Buffer> = {}) {
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

// Helper: wait for zustand store
async function waitForStore(page: any) {
  await page.waitForFunction(() => !!(window as any).__DA_STORE__, { timeout: 10000 });
}

// Helper: inject a complete conversation with various content types
async function injectFullConversation(page: any, sessionId: string) {
  await page.evaluate(({ sessionId }) => {
    const store = (window as any).__DA_STORE__;
    if (!store) throw new Error('Store not available');
    const state = store.getState();

    // User message
    const userMsg = {
      id: 'test-user-1',
      role: 'user',
      content: '请帮我写一份PPT报告和一份Markdown格式的分析文档',
      createdAt: new Date(Date.now() - 60000).toISOString(),
      media: [],
    };

    // Assistant message with mixed content: text + file push + markdown + table + code
    const assistantMsg = {
      id: 'test-assistant-1',
      role: 'assistant',
      content: '我已经为您完成了PPT报告和分析文档，以下是生成的文件：\n\n同时附上一份数据摘要表格和代码示例供参考。',
      createdAt: new Date().toISOString(),
      pushedContents: [
        // File push with downloadUrl (PPTX)
        {
          type: 'file', title: 'PPT Report',
          data: '', fileName: 'report.pptx', fileSize: 256000,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          downloadUrl: `/api/sessions/${sessionId}/output/report.pptx`,
        },
        // File push with downloadUrl (ZIP)
        {
          type: 'file', title: 'Archive File',
          data: '', fileName: 'data-archive.zip', fileSize: 51200,
          mimeType: 'application/zip',
          downloadUrl: `/api/sessions/${sessionId}/output/data-archive.zip`,
        },
        // Markdown content (no downloadUrl — text push)
        {
          type: 'text', title: 'Analysis Report',
          data: '# 分析报告\n\n## 摘要\n\n这是一份综合分析报告，包含以下内容：\n\n- 数据概况\n- 趋势分析\n- 结论与建议\n\n## 数据概况\n\n本季度共收集了 **1,200** 条有效数据记录，覆盖 15 个维度。\n\n## 趋势分析\n\n数据显示持续增长趋势，同比增长 **23.5%**。\n\n## 结论\n\n1. 数据质量良好\n2. 增长趋势稳定\n3. 建议持续监测',
          format: 'markdown',
        },
        // Table content
        {
          type: 'table', title: 'Data Summary',
          data: '指标\tQ1\tQ2\tQ3\tQ4\n总收入\t120万\t135万\t148万\t162万\n增长率\t8.2%\t12.5%\t9.6%\t9.5%\n客户数\t1,200\t1,380\t1,510\t1,670',
        },
        // Code content
        {
          type: 'code', title: 'Analysis Script',
          data: 'import pandas as pd\nimport matplotlib.pyplot as plt\n\ndf = pd.read_csv("data.csv")\nprint(df.describe())\n\ndf["revenue"].plot(kind="line")\nplt.title("Revenue Trend")\nplt.savefig("trend.png")',
        },
        // Image push with downloadUrl
        {
          type: 'file', title: 'Chart Image',
          data: '', fileName: 'chart.png', fileSize: 67,
          mimeType: 'image/png',
          downloadUrl: `/api/sessions/${sessionId}/output/chart.png`,
        },
        // Audio push
        {
          type: 'file', title: 'Voice Note',
          data: '', fileName: 'summary.mp3', fileSize: 500000,
          mimeType: 'audio/mpeg',
          downloadUrl: `/api/sessions/${sessionId}/output/summary.mp3`,
        },
      ],
    };

    store.setState({
      currentSessionId: sessionId,
      messages: [...(state.messages || []), userMsg, assistantMsg],
    });
  }, { sessionId });
}

test.describe('Comprehensive Feature Tests', () => {

  // =========================================================================
  // GROUP 1: Backend API Tests
  // =========================================================================

  test('1.1 - Download API: text/binary files, 404, path traversal', async ({ request }) => {
    const { sessionId } = await setupSession(request, 'api-test', {
      'test.txt': 'Hello World!',
      'test.pptx': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(1000).fill(0)]),
    });

    // Text file
    const txtResp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/test.txt`);
    expect(txtResp.status()).toBe(200);
    expect(await txtResp.text()).toContain('Hello World');

    // Binary file (PPTX)
    const pptxResp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/test.pptx`);
    expect(pptxResp.status()).toBe(200);
    expect(pptxResp.headers()['content-type']).toContain('presentation');

    // 404
    const notFound = await request.get(`${API_URL}/api/sessions/${sessionId}/output/nonexistent.xyz`);
    expect(notFound.status()).toBe(404);

    // Path traversal blocked
    const traversal = await request.get(`${API_URL}/api/sessions/${sessionId}/output/..%2F..%2F..%2Fetc%2Fpasswd`);
    expect([400, 403, 404]).toContain(traversal.status());
  });

  test('1.2 - Range requests for large files', async ({ request }) => {
    const { sessionId } = await setupSession(request, 'range-test', {
      'video.mp4': Buffer.alloc(10000),
    });

    const rangeResp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/video.mp4`, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(rangeResp.status()).toBe(206);
    expect(rangeResp.headers()['content-range']).toContain('bytes 0-99/10000');
    expect(rangeResp.headers()['content-length']).toBe('100');
  });

  test('1.3 - File upload via media API', async ({ request }) => {
    const { sessionId } = await setupSession(request, 'upload-test');

    const uploadResp = await request.post(`${API_URL}/api/sessions/${sessionId}/media`, {
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

  test('1.4 - MIME type detection for 10 file types', async ({ request }) => {
    const cases: [string, string | Buffer, string][] = [
      ['test.md', '# Hello\n', 'text/markdown'],
      ['test.json', '{"k":"v"}', 'application/json'],
      ['test.csv', 'a,b\n1,2\n', 'text/csv'],
      ['test.png', VALID_PNG, 'image/png'],
      ['test.mp3', Buffer.from([0xFF, 0xFB, ...Array(100).fill(0)]), 'audio/mpeg'],
      ['test.mp4', Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, ...Array(100).fill(0)]), 'video/mp4'],
      ['test.pptx', Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['test.zip', Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), 'application/zip'],
      ['test.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(100).fill(0)]), 'application/pdf'],
      ['test.xlsx', Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ];

    const files: Record<string, string | Buffer> = {};
    for (const [name, content] of cases) files[name] = content;

    const { sessionId } = await setupSession(request, 'mime-test', files);

    for (const [name, , expectedMime] of cases) {
      const resp = await request.get(`${API_URL}/api/sessions/${sessionId}/output/${name}`);
      expect(resp.status()).toBe(200);
      expect(resp.headers()['content-type']).toBe(expectedMime);
    }
  });

  // =========================================================================
  // GROUP 2: Frontend Rendering — Full Conversation
  // =========================================================================

  test('2.1 - Full conversation: all content types render correctly', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'full-render-test', {
      'report.pptx': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(1000).fill(0)]),
      'data-archive.zip': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(500).fill(0)]),
      'chart.png': VALID_PNG,
      'summary.mp3': Buffer.from([0xFF, 0xFB, ...Array(200).fill(0)]),
    });

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    await injectFullConversation(page, sessionId);
    await page.waitForTimeout(3000);

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'full-conversation.png'), fullPage: true });

    // Verify all content types rendered
    const pageText = await page.textContent('body') || '';

    // File cards
    expect(pageText).toContain('report.pptx');
    expect(pageText).toContain('PPTX');
    expect(pageText).toContain('data-archive.zip');
    expect(pageText).toContain('256.0 KB');  // 256000 bytes

    // Markdown content
    expect(pageText).toContain('分析报告');
    expect(pageText).toContain('1,200');

    // Table content
    expect(pageText).toContain('Data Summary');
    expect(pageText).toContain('总收入');

    // Code content
    expect(pageText).toContain('Analysis Script');
    expect(pageText).toContain('pandas');

    // Inline image
    const imgCount = await page.locator('img[src*="/api/sessions/"]').count();
    expect(imgCount).toBeGreaterThan(0);

    // Inline audio
    const audioCount = await page.locator('audio').count();
    expect(audioCount).toBeGreaterThan(0);
  });

  // =========================================================================
  // GROUP 3: Bug Fix — PushContentCard crash (undefined data)
  // =========================================================================

  test('3.1 - No crash when data is undefined (push_file scenario)', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'crash-test', {
      'output.pptx': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(1000).fill(0)]),
    });

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    // Inject content WITHOUT data field — simulates push_file where data is absent
    await page.evaluate(({ sessionId }) => {
      const store = (window as any).__DA_STORE__;
      const state = store.getState();
      store.setState({
        currentSessionId: sessionId,
        messages: [...(state.messages || []), {
          id: 'test-crash-1',
          role: 'assistant',
          content: 'Here is your file:',
          createdAt: new Date().toISOString(),
          pushedContents: [{
            type: 'file',
            title: 'Test File',
            // data is intentionally undefined — this was the crash case
            fileName: 'output.pptx',
            fileSize: 1004,
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            downloadUrl: `/api/sessions/${sessionId}/output/output.pptx`,
          }],
        }],
      });
    }, { sessionId });

    await page.waitForTimeout(2000);

    // The critical assertion: page did NOT crash
    const errorEl = await page.locator('text=Unexpected Application Error').count();
    expect(errorEl).toBe(0);

    // Content should render
    const pageText = await page.textContent('body') || '';
    expect(pageText).toContain('output.pptx');

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'crash-fix-no-data.png'), fullPage: true });
  });

  // =========================================================================
  // GROUP 4: Download button on ALL content cards
  // =========================================================================

  test('4.1 - Download button visible on ALL content types', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'download-btn-test', {
      'report.pptx': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(1000).fill(0)]),
    });

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    // Inject mixed content: file push + text push + table + code + markdown
    await page.evaluate(({ sessionId }) => {
      const store = (window as any).__DA_STORE__;
      const state = store.getState();
      store.setState({
        currentSessionId: sessionId,
        messages: [...(state.messages || []), {
          id: 'test-dl-btns-1',
          role: 'assistant',
          content: 'Done.',
          createdAt: new Date().toISOString(),
          pushedContents: [
            // File push — should have download button
            {
              type: 'file', title: 'PPT File',
              data: '', fileName: 'report.pptx', fileSize: 1004,
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              downloadUrl: `/api/sessions/${sessionId}/output/report.pptx`,
            },
            // Markdown text push — should ALSO have download button
            {
              type: 'text', title: 'Markdown Report',
              data: '# Report\n\nThis is a **markdown** report with some content.\n\n## Section 1\n\nDetails here.',
            },
            // Table push — should ALSO have download button
            {
              type: 'table', title: 'Data Table',
              data: 'Name\tAge\tCity\nAlice\t30\tBeijing\nBob\t25\tShanghai',
            },
            // Code push — should ALSO have download button
            {
              type: 'code', title: 'Python Script',
              data: 'def hello():\n    print("Hello World")\n\nhello()',
            },
          ],
        }],
      });
    }, { sessionId });

    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'download-buttons-all.png'), fullPage: true });

    // Count download buttons — should have one per content card (4 total)
    const downloadBtns = await page.locator('button[title="下载文件"]').count();
    console.log(`Download buttons found: ${downloadBtns}`);
    expect(downloadBtns).toBeGreaterThanOrEqual(4);
  });

  // =========================================================================
  // GROUP 5: AI message action bar always visible
  // =========================================================================

  test('5.1 - Action bar (copy, regenerate, export) always visible without hover', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'action-bar-test');

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    // Inject a user + assistant message
    await page.evaluate(({ sessionId }) => {
      const store = (window as any).__DA_STORE__;
      const state = store.getState();
      store.setState({
        currentSessionId: sessionId,
        messages: [
          {
            id: 'test-user-action',
            role: 'user',
            content: 'Hello, write me a report.',
            createdAt: new Date(Date.now() - 30000).toISOString(),
          },
          {
            id: 'test-assistant-action',
            role: 'assistant',
            content: '这是一份详细的分析报告。\n\n## 摘要\n\n本次分析涵盖了多个维度的数据。',
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }, { sessionId });

    await page.waitForTimeout(2000);

    // Do NOT hover — check action buttons are already visible
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'action-bar-no-hover.png'), fullPage: true });

    // Check for copy button (title="复制")
    const copyBtns = await page.locator('button[title="复制"]').count();
    console.log(`Copy buttons visible without hover: ${copyBtns}`);
    expect(copyBtns).toBeGreaterThan(0);

    // Check for regenerate button (title="重新生成")
    const regenBtns = await page.locator('button[title="重新生成"]').count();
    console.log(`Regenerate buttons visible without hover: ${regenBtns}`);
    expect(regenBtns).toBeGreaterThan(0);

    // Check for export button (title="导出报告")
    const exportBtns = await page.locator('button[title="导出报告"]').count();
    console.log(`Export buttons visible without hover: ${exportBtns}`);
    expect(exportBtns).toBeGreaterThan(0);
  });

  // =========================================================================
  // GROUP 6: UI interaction — attach button
  // =========================================================================

  test('6.1 - Attach button works and triggers file chooser', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'attach-test');

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(4000);

    // Verify textarea and attach button are visible
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible({ timeout: 10000 });

    const attachBtn = page.locator('button[title="添加附件"]');
    await expect(attachBtn).toBeVisible({ timeout: 10000 });

    // Create a test file and trigger file chooser
    const tmpDir = '/tmp/da-test-files';
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'test-upload.txt'), 'Hello from test file!');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      attachBtn.click(),
    ]);

    expect(fileChooser).toBeTruthy();
    await fileChooser.setFiles([join(tmpDir, 'test-upload.txt')]);
    await page.waitForTimeout(1500);

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'attach-file-chosen.png'), fullPage: true });
  });

  // =========================================================================
  // GROUP 7: Edge cases
  // =========================================================================

  test('7.1 - Multiple content types in same message, no crash', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'edge-multi', {
      'a.pptx': Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]),
      'b.png': VALID_PNG,
    });

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    // Inject 10 mixed content items in one message
    await page.evaluate(({ sessionId }) => {
      const store = (window as any).__DA_STORE__;
      const state = store.getState();

      const items = [];
      // 3 file pushes
      for (let i = 1; i <= 3; i++) {
        items.push({
          type: 'file', title: `File ${i}`,
          fileName: `file${i}.pptx`, fileSize: 1000 * i,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          downloadUrl: `/api/sessions/${sessionId}/output/a.pptx`,
        });
      }
      // 3 markdown/text pushes (short)
      for (let i = 1; i <= 3; i++) {
        items.push({
          type: 'text', title: `Text ${i}`,
          data: `This is text content number ${i}. Some details here.`,
        });
      }
      // 2 code pushes
      for (let i = 1; i <= 2; i++) {
        items.push({
          type: 'code', title: `Code ${i}`,
          data: `function test${i}() {\n  return ${i};\n}`,
        });
      }
      // 1 table
      items.push({
        type: 'table', title: 'Summary',
        data: 'A\tB\tC\n1\t2\t3\n4\t5\t6',
      });
      // 1 image
      items.push({
        type: 'file', title: 'Image',
        fileName: 'b.png', fileSize: 67,
        mimeType: 'image/png',
        downloadUrl: `/api/sessions/${sessionId}/output/b.png`,
      });

      store.setState({
        currentSessionId: sessionId,
        messages: [...(state.messages || []), {
          id: 'test-multi-1',
          role: 'assistant',
          content: 'Here are all the results:',
          createdAt: new Date().toISOString(),
          pushedContents: items,
        }],
      });
    }, { sessionId });

    await page.waitForTimeout(3000);

    // No crash
    const errorEl = await page.locator('text=Unexpected Application Error').count();
    expect(errorEl).toBe(0);

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'edge-multiple-content.png'), fullPage: true });

    // All 10 items should have download buttons
    const downloadBtns = await page.locator('button[title="下载文件"]').count();
    console.log(`Download buttons for 10 items: ${downloadBtns}`);
    expect(downloadBtns).toBeGreaterThanOrEqual(10);
  });

  test('7.2 - Empty data does not crash', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'edge-empty');

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    await page.evaluate(() => {
      const store = (window as any).__DA_STORE__;
      const state = store.getState();
      store.setState({
        currentSessionId: 'test',
        messages: [...(state.messages || []), {
          id: 'test-empty-1',
          role: 'assistant',
          content: 'Results:',
          createdAt: new Date().toISOString(),
          pushedContents: [
            { type: 'text', title: 'Empty Text', data: '' },
            { type: 'code', title: 'Empty Code', data: '' },
            { type: 'markdown', title: 'Empty MD', data: '' },
            { type: 'table', title: 'Empty Table', data: '' },
          ],
        }],
      });
    });

    await page.waitForTimeout(2000);

    const errorEl = await page.locator('text=Unexpected Application Error').count();
    expect(errorEl).toBe(0);

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'edge-empty-data.png'), fullPage: true });
  });

  test('7.3 - File card shows correct size formatting', async ({ page, request }) => {
    const { sessionId } = await setupSession(request, 'size-format', {
      'small.txt': 'x',
      'medium.pptx': Buffer.alloc(2048),
      'large.zip': Buffer.alloc(3_000_000),
    });

    await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
    await page.waitForTimeout(3000);
    await waitForStore(page);

    await page.evaluate(({ sessionId }) => {
      const store = (window as any).__DA_STORE__;
      const state = store.getState();
      store.setState({
        currentSessionId: sessionId,
        messages: [...(state.messages || []), {
          id: 'test-size-1',
          role: 'assistant',
          content: 'Files:',
          createdAt: new Date().toISOString(),
          pushedContents: [
            {
              type: 'file', title: 'Small File', fileName: 'small.txt', fileSize: 1,
              mimeType: 'text/plain', downloadUrl: `/api/sessions/${sessionId}/output/small.txt`,
            },
            {
              type: 'file', title: 'Medium File', fileName: 'medium.pptx', fileSize: 2048,
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              downloadUrl: `/api/sessions/${sessionId}/output/medium.pptx`,
            },
            {
              type: 'file', title: 'Large File', fileName: 'large.zip', fileSize: 3_000_000,
              mimeType: 'application/zip', downloadUrl: `/api/sessions/${sessionId}/output/large.zip`,
            },
          ],
        }],
      });
    }, { sessionId });

    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'size-formatting.png'), fullPage: true });

    const pageText = await page.textContent('body') || '';
    // 1 byte → "0.0 KB"
    expect(pageText).toContain('0.0 KB');
    // 2048 bytes → "2.0 KB"
    expect(pageText).toContain('2.0 KB');
    // 3,000,000 bytes → "3.0 MB"
    expect(pageText).toContain('3.0 MB');
  });
});
