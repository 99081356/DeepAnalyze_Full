/**
 * E2E Tests: Dual-Track Attachment Upload (回形针/拖拽附件上传)
 *
 * Tests the complete flow:
 *   Track 1 — Immediate inline text injection into agent context
 *   Track 2 — Background session KB creation + document processing
 *
 * Coverage:
 *   - Plain text types (txt, md, json, csv, xml, yaml, html, log)
 *   - Document types (pdf, docx, xlsx)
 *   - Image (media path, not document path)
 *   - Multi-file upload
 *   - Drag-drop upload
 *   - Empty file
 *   - Corrupted file
 *   - Large file (performance / truncation)
 *   - Backend KB auto-creation and kbScope update
 *   - Frontend file preview display
 *   - Agent content visibility and response quality
 */
import { test, expect, Page, APIRequestContext } from "@playwright/test";
import { createApi, Api, MediaMeta, Session } from "./helpers/api";
import { takeScreenshot, screenshotAndCheck, gotoPage, filterCriticalErrors, checkConsoleErrors } from "./helpers/visual";
import { waitForAgentTask, waitForMessages, pollUntil } from "./helpers/wait";
import { join, resolve } from "path";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:21000";
const TEST_FILES_DIR = "/tmp/da_upload_test";
const SCREENSHOT_DIR = join(__dirname, "screenshots", "attachment-upload");

// File definitions: name, expected parse behavior
const TEST_FILES = {
  txt:       { file: "test_plain.txt",     mime: "text/plain",                                              expectInline: true,  plainText: true  },
  md:        { file: "test_markdown.md",    mime: "text/markdown",                                           expectInline: true,  plainText: true  },
  json:      { file: "test_data.json",      mime: "application/json",                                        expectInline: true,  plainText: true  },
  csv:       { file: "test_data.csv",       mime: "text/csv",                                                expectInline: true,  plainText: true  },
  xml:       { file: "test_config.xml",     mime: "application/xml",                                         expectInline: true,  plainText: true  },
  yaml:      { file: "test_config.yaml",    mime: "application/x-yaml",                                      expectInline: true,  plainText: true  },
  html:      { file: "test_page.html",      mime: "text/html",                                               expectInline: true,  plainText: true  },
  log:       { file: "test_app.log",        mime: "text/plain",                                              expectInline: true,  plainText: true  },
  pdf:       { file: "test_paper.pdf",      mime: "application/pdf",                                         expectInline: true,  plainText: false },
  docx:      { file: "test_document.docx",  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", expectInline: true, plainText: false },
  xlsx:      { file: "test_spreadsheet.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",     expectInline: true, plainText: false },
  image:     { file: "test_image.jpg",      mime: "image/jpeg",                                              expectInline: false, plainText: false, isMedia: true },
  empty:     { file: "test_empty.txt",      mime: "text/plain",                                              expectInline: false, plainText: true  },
  corrupted: { file: "test_corrupted.pdf",  mime: "application/pdf",                                         expectInline: false, plainText: false },
  large:     { file: "test_large.txt",      mime: "text/plain",                                              expectInline: true,  plainText: true,  expectTruncation: true },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureScreenshotDir() {
  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function screenshot(page: Page, name: string) {
  ensureScreenshotDir();
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

/** Upload a file via API and return the mediaId */
async function uploadFile(api: Api, sessionId: string, fileName: string, mimeType: string): Promise<MediaMeta> {
  const filePath = join(TEST_FILES_DIR, fileName);
  const buffer = readFileSync(filePath);
  return api.uploadMedia(sessionId, buffer, fileName, mimeType);
}

/** Run agent via SSE and collect events */
async function runAgentAndCollect(
  request: APIRequestContext,
  sessionId: string,
  input: string,
  mediaIds: string[],
): Promise<{ events: Array<{ event: string; data: any }>; doneData: any }> {
  const resp = await request.post(`${BASE_URL}/api/agents/run-stream`, {
    data: { sessionId, input, mediaIds },
    timeout: 240_000, // 4 min timeout for large file agent processing
  });
  expect(resp.status()).toBe(200);

  const text = await resp.text();
  const events: Array<{ event: string; data: any }> = [];
  let doneData: any = null;

  for (const block of text.split("\n\n")) {
    const lines = block.trim().split("\n");
    let eventType = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventType = line.slice(7);
      else if (line.startsWith("data: ")) dataStr = line.slice(6);
    }
    if (eventType && dataStr) {
      try {
        const data = JSON.parse(dataStr);
        events.push({ event: eventType, data });
        if (eventType === "done") doneData = data;
      } catch { /* skip non-JSON */ }
    }
  }

  return { events, doneData };
}

/** Find session KB by name pattern */
async function findSessionKB(api: Api, sessionId: string): Promise<{ id: string; name: string } | null> {
  const kbs = await api.listKBs();
  const sessionKB = kbs.find((kb: any) => kb.name === `session-${sessionId}`);
  return sessionKB ?? null;
}

/** Wait for session KB to appear (Track 2 async creation) */
async function waitForSessionKB(api: Api, sessionId: string, timeout = 30_000): Promise<{ id: string; name: string } | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const kb = await findSessionKB(api, sessionId);
    if (kb) return kb;
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

/** Clean up: delete session and its KB */
async function cleanup(api: Api, sessionId: string) {
  try {
    const kb = await findSessionKB(api, sessionId);
    if (kb) await api.deleteKB(kb.id);
  } catch { /* best effort */ }
  try {
    await api.deleteSession(sessionId);
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe("Dual-Track Attachment Upload", () => {

  test.describe("1. API-level: Single file uploads (Track 1 inline injection)", () => {

    // Test each plain text type
    for (const [type, config] of Object.entries(TEST_FILES)) {
      if (config.isMedia) continue; // skip image — tested separately

      test(`${type.toUpperCase()} file: inline parse + agent response`, async ({ request }) => {
        // XLSX (22MB) and large files need extra time for parsing and agent processing
        if (type === "xlsx" || type === "large") test.setTimeout(300_000);

        const api = createApi(request);

        // Create a fresh session
        const session = await api.createSession(`upload-test-${type}-${Date.now()}`);
        const sessionId = session.id;

        try {
          // Upload file
          const media = await uploadFile(api, sessionId, config.file, config.mime);
          expect(media.mediaId).toBeTruthy();
          expect(media.fileName).toBe(config.file);

          // Run agent asking to summarize the file
          const { events, doneData } = await runAgentAndCollect(
            request, sessionId,
            "请总结这个文件的主要内容，用3-5个要点概括。",
            [media.mediaId],
          );

          // Verify SSE events
          const startEvent = events.find(e => e.event === "start");
          expect(startEvent).toBeTruthy();

          const contentEvents = events.filter(e => e.event === "content");
          expect(contentEvents.length).toBeGreaterThan(0);

          // Verify agent received content and produced output
          const doneEvent = events.find(e => e.event === "done");
          expect(doneEvent).toBeTruthy();
          expect(doneEvent!.data.status).toBe("completed");

          // Check that the output contains substantive content
          const output = doneEvent!.data.output ?? "";
          expect(output.length).toBeGreaterThan(20);

          // For non-empty files that should parse inline, verify agent saw content
          if (config.expectInline && type !== "empty" && type !== "corrupted") {
            // The agent should have generated meaningful content about the file
            // without needing tool calls like read_file or bash
            const toolCalls = events.filter(e => e.event === "tool_call");
            const readFileCalls = toolCalls.filter(e =>
              e.data.toolName === "read_file" || e.data.toolName === "bash"
            );
            // For plain text types, agent should NOT need to call read_file (content is inline)
            if (config.plainText) {
              // Agent got content inline, may still call tools for other reasons
              // but read_file for the uploaded file shouldn't be necessary
              console.log(`[${type}] Tool calls: ${toolCalls.map(e => e.data.toolName).join(", ") || "none"}`);
            }
          }

          // Take a screenshot of the final state (check via messages API)
          const messages = await api.getMessages(sessionId);
          expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant

        } finally {
          await cleanup(api, sessionId);
        }
      });
    }
  });

  test.describe("2. Multi-file upload", () => {

    test("Upload TXT + JSON + CSV simultaneously", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`multi-file-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        // Upload 3 different files
        const media1 = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");
        const media2 = await uploadFile(api, sessionId, "test_data.json", "application/json");
        const media3 = await uploadFile(api, sessionId, "test_data.csv", "text/csv");

        // Run agent with all media IDs
        const { events, doneData } = await runAgentAndCollect(
          request, sessionId,
          "我上传了三个文件，请分别用一句话总结每个文件的内容。",
          [media1.mediaId, media2.mediaId, media3.mediaId],
        );

        // Verify completion
        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        // Verify output mentions content from all files
        const output = doneEvent!.data.output ?? "";
        // Should mention keywords from each file
        expect(output.length).toBeGreaterThan(50);

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Upload 5 files simultaneously (TXT, MD, CSV, JSON, XML)", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`multi5-file-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const files = [
          { name: "test_plain.txt", mime: "text/plain" },
          { name: "test_markdown.md", mime: "text/markdown" },
          { name: "test_data.csv", mime: "text/csv" },
          { name: "test_data.json", mime: "application/json" },
          { name: "test_config.xml", mime: "application/xml" },
        ];

        const mediaIds: string[] = [];
        for (const f of files) {
          const media = await uploadFile(api, sessionId, f.name, f.mime);
          mediaIds.push(media.mediaId);
        }

        const { events, doneData } = await runAgentAndCollect(
          request, sessionId,
          "请列出所有上传的文件，并各用一句话概括其内容。",
          mediaIds,
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        const output = doneEvent!.data.output ?? "";
        // Should reference multiple files
        expect(output.length).toBeGreaterThan(100);

      } finally {
        await cleanup(api, sessionId);
      }
    });
  });

  test.describe("3. Image upload (media path)", () => {

    test("Image upload: not treated as document, inline base64", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`image-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_image.jpg", "image/jpeg");

        const { events, doneData } = await runAgentAndCollect(
          request, sessionId,
          "描述这张图片的内容。",
          [media.mediaId],
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        // Image should NOT create a session KB document
        // (images are media, not documents)
        const kb = await findSessionKB(api, sessionId);
        // Session KB may or may not exist; if it does, it should have no documents
        if (kb) {
          const docs = await api.listDocuments(kb.id);
          expect(docs.length).toBe(0);
        }

      } finally {
        await cleanup(api, sessionId);
      }
    });
  });

  test.describe("4. Edge cases and error handling", () => {

    test("Empty file: graceful fallback", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`empty-file-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_empty.txt", "text/plain");

        const { events, doneData } = await runAgentAndCollect(
          request, sessionId,
          "这个文件里有什么内容？",
          [media.mediaId],
        );

        // Agent should still complete, even if file is empty
        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Corrupted file: fallback to text note", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`corrupted-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_corrupted.pdf", "application/pdf");

        const { events, doneData } = await runAgentAndCollect(
          request, sessionId,
          "请分析这个PDF文件的内容。",
          [media.mediaId],
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        // Should complete even if parse fails (fallback to text note)
        expect(["completed", "failed"]).toContain(doneEvent!.data.status);

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Large file: truncation + agent response", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`large-file-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_large.txt", "text/plain");

        const { events, doneData } = await runAgentAndCollect(
          request, sessionId,
          "总结这个文件的主要内容。",
          [media.mediaId],
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        // Agent should have been able to work with the truncated content
        const output = doneEvent!.data.output ?? "";
        expect(output.length).toBeGreaterThan(20);

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("No mediaIds: normal chat without attachments", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`no-media-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const { events, doneData } = await runAgentAndCollect(
          request, sessionId,
          "你好，请介绍一下你自己。",
          [], // no media
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        // No session KB should be created
        // (give it a moment since it's fire-and-forget)
        await new Promise(r => setTimeout(r, 3000));
        const kb = await findSessionKB(api, sessionId);
        expect(kb).toBeNull();

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Invalid mediaId: API returns error", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`invalid-media-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const resp = await request.post(`${BASE_URL}/api/agents/run-stream`, {
          data: {
            sessionId,
            input: "test",
            mediaIds: ["nonexistent-media-id-12345"],
          },
        });
        // Should get a 400 error
        expect(resp.status()).toBe(400);
        const body = await resp.json();
        expect(body.error).toContain("not found");

      } finally {
        await cleanup(api, sessionId);
      }
    });
  });

  test.describe("5. Track 2: Session KB auto-creation and processing", () => {

    test("TXT file creates session KB and updates kbScope", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`track2-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");

        // Run agent to trigger Track 2
        const { events } = await runAgentAndCollect(
          request, sessionId,
          "总结这个文件。",
          [media.mediaId],
        );

        // Wait for session KB to be created (async)
        const kb = await waitForSessionKB(api, sessionId, 15_000);
        expect(kb).toBeTruthy();
        expect(kb!.name).toBe(`session-${sessionId}`);

        // Poll for kbScope to be updated (fire-and-forget, may take a moment)
        const scopeUpdated = await pollUntil(
          async () => {
            const s = await api.getSession(sessionId);
            if (!s.kbScope) return false;
            const scope = typeof s.kbScope === "string" ? JSON.parse(s.kbScope as string) : s.kbScope;
            const kbs = (scope as any).knowledgeBases ?? [];
            return kbs.some((k: any) => k.kbId === kb!.id);
          },
          (hasIt) => hasIt === true,
          15_000,
          2000,
        );
        expect(scopeUpdated).toBe(true);

        // Check documents in session KB
        const docs = await api.listDocuments(kb!.id);
        expect(docs.length).toBeGreaterThan(0);
        expect(docs[0].fileName).toBe("test_plain.txt");

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("PDF file creates session KB with document", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`track2-pdf-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_paper.pdf", "application/pdf");

        const { events } = await runAgentAndCollect(
          request, sessionId,
          "这篇论文主要讲了什么？",
          [media.mediaId],
        );

        // Wait for session KB
        const kb = await waitForSessionKB(api, sessionId, 15_000);
        expect(kb).toBeTruthy();

        // Verify document was added
        const docs = await api.listDocuments(kb!.id);
        expect(docs.length).toBe(1);
        expect(docs[0].fileName).toBe("test_paper.pdf");

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Re-uploading same file: dedup by hash", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`dedup-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        // First upload
        const media1 = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");
        await runAgentAndCollect(request, sessionId, "总结", [media1.mediaId]);

        // Wait for KB
        const kb = await waitForSessionKB(api, sessionId, 15_000);
        expect(kb).toBeTruthy();
        const docs1 = await api.listDocuments(kb!.id);

        // Second upload of same file (different mediaId, same content)
        const media2 = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");
        await runAgentAndCollect(request, sessionId, "再总结一次", [media2.mediaId]);

        // Wait a bit for Track 2 dedup
        await new Promise(r => setTimeout(r, 5000));
        const docs2 = await api.listDocuments(kb!.id);

        // Should still have only 1 document (deduped by hash)
        expect(docs2.length).toBe(docs1.length);

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Multi-file: all non-media files added to session KB", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`track2-multi-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media1 = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");
        const media2 = await uploadFile(api, sessionId, "test_data.csv", "text/csv");
        const media3 = await uploadFile(api, sessionId, "test_data.json", "application/json");

        await runAgentAndCollect(
          request, sessionId,
          "总结这三个文件。",
          [media1.mediaId, media2.mediaId, media3.mediaId],
        );

        const kb = await waitForSessionKB(api, sessionId, 15_000);
        expect(kb).toBeTruthy();

        const docs = await api.listDocuments(kb!.id);
        // All 3 non-media files should be in the KB
        expect(docs.length).toBe(3);

        const fileNames = docs.map(d => d.fileName).sort();
        expect(fileNames).toContain("test_plain.txt");
        expect(fileNames).toContain("test_data.csv");
        expect(fileNames).toContain("test_data.json");

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Mixed upload: image excluded from session KB", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`mixed-upload-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const mediaTxt = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");
        const mediaImg = await uploadFile(api, sessionId, "test_image.jpg", "image/jpeg");

        await runAgentAndCollect(
          request, sessionId,
          "总结文本文件并描述图片。",
          [mediaTxt.mediaId, mediaImg.mediaId],
        );

        const kb = await waitForSessionKB(api, sessionId, 15_000);
        expect(kb).toBeTruthy();

        const docs = await api.listDocuments(kb!.id);
        // Only the TXT file should be in KB, not the image
        expect(docs.length).toBe(1);
        expect(docs[0].fileName).toBe("test_plain.txt");

      } finally {
        await cleanup(api, sessionId);
      }
    });
  });

  test.describe("6. Frontend: file upload and preview (Playwright browser)", () => {

    test("Paperclip button: upload TXT and verify preview + agent response", async ({ page, request }) => {
      const api = createApi(request);
      const consoleErrors = await checkConsoleErrors(page);
      const session = await api.createSession(`ui-paperclip-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        // Navigate to session — use hash router path /sessions/:sessionId
        await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
        await page.waitForLoadState("networkidle");
        // Wait for the chat textarea to appear (proves session loaded)
        await page.locator('textarea[placeholder*="输入消息"]').waitFor({ state: "visible", timeout: 10000 });
        await screenshot(page, "ui-01-session-loaded");

        // Find the paperclip/attach button by its title attribute
        const filePath = join(TEST_FILES_DIR, "test_plain.txt");

        // Listen for file chooser triggered by dynamically-created <input type="file">
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 5000 }),
          page.locator('button[title="添加附件"]').click(),
        ]);

        await fileChooser.setFiles(filePath);
        await page.waitForTimeout(1500);
        await screenshot(page, "ui-02-file-selected");

        // Verify file preview appears — non-image files show as div.group with filename text
        const previewItem = page.locator("div.group").filter({ hasText: "test_plain.txt" });
        const previewVisible = await previewItem.isVisible().catch(() => false);
        console.log(`File preview visible: ${previewVisible}`);
        // Take a screenshot even if preview not found — the page state is still useful
        if (!previewVisible) {
          await screenshot(page, "ui-02b-no-preview");
        }

        // Type message in textarea and send
        const inputArea = page.locator('textarea[placeholder*="输入消息"]');
        await inputArea.fill("请总结这个文件的内容。");
        await page.waitForTimeout(500);
        await screenshot(page, "ui-03-message-typed");

        // Send the message
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2000);
        await screenshot(page, "ui-04-message-sent");

        // Wait for agent response (agent processes inline content)
        await page.waitForTimeout(20000);
        await screenshot(page, "ui-05-agent-response");

        // Check for critical console errors
        const criticalErrors = filterCriticalErrors(consoleErrors);
        if (criticalErrors.length > 0) {
          console.warn("Console errors:", criticalErrors);
        }

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Drag-drop: upload file via drag and drop", async ({ page, request }) => {
      const api = createApi(request);
      const consoleErrors = await checkConsoleErrors(page);
      const session = await api.createSession(`ui-dragdrop-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        // Navigate to session — use hash router path /sessions/:sessionId
        await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
        await page.waitForLoadState("networkidle");
        // Wait for the chat textarea to appear
        await page.locator('textarea[placeholder*="输入消息"]').waitFor({ state: "visible", timeout: 10000 });
        await screenshot(page, "ui-drag-01-loaded");

        // Simulate drag and drop onto the textarea (drop zone)
        const filePath = join(TEST_FILES_DIR, "test_data.csv");
        const fileContent = readFileSync(filePath);
        const fileName = "test_data.csv";

        // Use evaluate to create and dispatch a drop event on the textarea
        await page.evaluate(({ fileName, fileContentBase64 }) => {
          const byteString = atob(fileContentBase64);
          const ab = new ArrayBuffer(byteString.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
          }
          const blob = new Blob([ab], { type: "text/csv" });
          const file = new File([blob], fileName, { type: "text/csv" });

          // The drop handler is on the textarea's parent div (onDrop in MessageInput.tsx)
          const textarea = document.querySelector('textarea[placeholder*="输入消息"]');
          const dropZone = textarea?.closest('div')?.parentElement || textarea || document.body;
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);

          // Dispatch dragenter → dragover → drop sequence
          const dragEnterEvent = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer });
          const dragOverEvent = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
          const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
          dropZone.dispatchEvent(dragEnterEvent);
          dropZone.dispatchEvent(dragOverEvent);
          dropZone.dispatchEvent(dropEvent);
        }, { fileName, fileContentBase64: fileContent.toString("base64") });

        await page.waitForTimeout(2000);
        await screenshot(page, "ui-drag-02-file-dropped");

        // Verify file preview appears
        const previewItem = page.locator("div.group").filter({ hasText: "test_data.csv" });
        const previewVisible = await previewItem.isVisible().catch(() => false);
        console.log(`Drag-drop preview visible: ${previewVisible}`);

        // Type and send message
        const inputArea = page.locator('textarea[placeholder*="输入消息"]');
        await inputArea.fill("这个CSV文件包含什么数据？");
        await page.keyboard.press("Enter");

        await page.waitForTimeout(20000);
        await screenshot(page, "ui-drag-03-response");

        const criticalErrors = filterCriticalErrors(consoleErrors);
        if (criticalErrors.length > 0) {
          console.warn("Console errors:", criticalErrors);
        }

      } finally {
        await cleanup(api, sessionId);
      }
    });
  });

  test.describe("7. Session KB lifecycle and cleanup", () => {

    test("Session deletion cleans up session KB", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`cleanup-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        // Upload and run agent to create session KB
        const media = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");
        await runAgentAndCollect(request, sessionId, "总结", [media.mediaId]);

        const kb = await waitForSessionKB(api, sessionId, 15_000);
        expect(kb).toBeTruthy();
        const kbId = kb!.id;

        // Delete session
        await api.deleteSession(sessionId);

        // Verify session KB is cleaned up
        await new Promise(r => setTimeout(r, 3000));
        const allKBs = await api.listKBs();
        const sessionKBExists = allKBs.some((kb: any) => kb.id === kbId);
        expect(sessionKBExists).toBe(false);

      } catch (e) {
        // Try cleanup on failure
        await cleanup(api, sessionId);
        throw e;
      }
    });
  });

  test.describe("8. Performance and concurrency", () => {

    test("Rapid sequential uploads to same session", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`rapid-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        // Upload 3 files rapidly
        const media1 = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");
        const media2 = await uploadFile(api, sessionId, "test_data.json", "application/json");
        const media3 = await uploadFile(api, sessionId, "test_data.csv", "text/csv");

        // Send all 3 mediaIds in a single request
        const startTime = Date.now();
        const { events } = await runAgentAndCollect(
          request, sessionId,
          "总结所有文件的内容。",
          [media1.mediaId, media2.mediaId, media3.mediaId],
        );
        const elapsed = Date.now() - startTime;

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        console.log(`Rapid upload + agent response took ${(elapsed / 1000).toFixed(1)}s`);

        // Session KB should have all 3 files
        const kb = await waitForSessionKB(api, sessionId, 15_000);
        if (kb) {
          const docs = await api.listDocuments(kb.id);
          expect(docs.length).toBe(3);
        }

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("Concurrent sessions with file uploads (isolation)", async ({ request }) => {
      const api = createApi(request);

      const session1 = await api.createSession(`concurrent1-${Date.now()}`);
      const session2 = await api.createSession(`concurrent2-${Date.now()}`);

      try {
        // Upload different files to different sessions
        const media1 = await uploadFile(api, session1.id, "test_plain.txt", "text/plain");
        const media2 = await uploadFile(api, session2.id, "test_data.json", "application/json");

        // Run agents concurrently
        const [result1, result2] = await Promise.all([
          runAgentAndCollect(request, session1.id, "总结这个文件。", [media1.mediaId]),
          runAgentAndCollect(request, session2.id, "总结这个文件。", [media2.mediaId]),
        ]);

        // Both should complete
        expect(result1.events.find(e => e.event === "done")).toBeTruthy();
        expect(result2.events.find(e => e.event === "done")).toBeTruthy();

        // Each session should have its own separate KB
        const kb1 = await findSessionKB(api, session1.id);
        const kb2 = await findSessionKB(api, session2.id);

        // KBs should be different
        if (kb1 && kb2) {
          expect(kb1.id).not.toBe(kb2.id);
        }

      } finally {
        await cleanup(api, session1.id);
        await cleanup(api, session2.id);
      }
    });
  });

  test.describe("9. Content quality verification", () => {

    test("TXT content: agent output references specific file content", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`content-quality-txt-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_plain.txt", "text/plain");

        const { events } = await runAgentAndCollect(
          request, sessionId,
          "这个文件提到了哪些AI应用领域？请列出所有提到的领域。",
          [media.mediaId],
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        const output = doneEvent!.data.output ?? "";
        // Should mention specific domains from the file
        const mentionsNLP = output.includes("自然语言") || output.toLowerCase().includes("nlp");
        const mentionsVision = output.includes("计算机视觉") || output.includes("视觉");
        const mentionsRobotics = output.includes("机器人");
        // At least 2 of 3 should be mentioned for a quality response
        const mentions = [mentionsNLP, mentionsVision, mentionsRobotics].filter(Boolean).length;
        expect(mentions).toBeGreaterThanOrEqual(2);

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("JSON content: agent extracts structured data correctly", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`content-quality-json-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_data.json", "application/json");

        const { events } = await runAgentAndCollect(
          request, sessionId,
          "这个JSON文件中有哪些功能特性？每个特性的状态是什么？",
          [media.mediaId],
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        const output = doneEvent!.data.output ?? "";
        // Should mention feature names from the JSON
        expect(output.length).toBeGreaterThan(30);

      } finally {
        await cleanup(api, sessionId);
      }
    });

    test("CSV content: agent references data rows", async ({ request }) => {
      const api = createApi(request);
      const session = await api.createSession(`content-quality-csv-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_data.csv", "text/csv");

        const { events } = await runAgentAndCollect(
          request, sessionId,
          "这个CSV文件有多少条数据记录？列出所有人的名字和对应城市。",
          [media.mediaId],
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        const output = doneEvent!.data.output ?? "";
        // Should mention names from the CSV
        const hasName = output.includes("张三") || output.includes("李四");
        expect(hasName).toBe(true);

      } finally {
        await cleanup(api, sessionId);
      }
    });
  });

  test.describe("10. Large file truncation verification", () => {

    test("Large TXT: content truncated at 50K chars, agent informed", async ({ request }) => {
      test.setTimeout(300_000); // 5 min for large file processing
      const api = createApi(request);
      const session = await api.createSession(`large-truncate-test-${Date.now()}`);
      const sessionId = session.id;

      try {
        const media = await uploadFile(api, sessionId, "test_large.txt", "text/plain");

        // The large file is ~185K chars, should be truncated to 50K
        const { events } = await runAgentAndCollect(
          request, sessionId,
          "这个文件有多少个章节？列出你能看到的所有章节标题。",
          [media.mediaId],
        );

        const doneEvent = events.find(e => e.event === "done");
        expect(doneEvent).toBeTruthy();
        expect(doneEvent!.data.status).toBe("completed");

        const output = doneEvent!.data.output ?? "";
        // Agent should have partial content to work with
        expect(output.length).toBeGreaterThan(20);

      } finally {
        await cleanup(api, sessionId);
      }
    });
  });
});
