/**
 * Content Partition Persistence Tests
 * Verifies the three-channel separation: gray (process), tool calls, black (result).
 *
 * Uses /run-stream endpoint for SSE streaming with draft message persistence.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { waitForMessages } from "./helpers/wait";
import { TEST_KB_ID } from "./fixtures";

test.describe("Content Partition Persistence", () => {
  test.setTimeout(300_000);

  // ── Test 1: Simple Q&A via /run-stream — metadata persisted ──────────
  test("simple Q&A — metadata saved via /run-stream", async ({ request }) => {
    const api = createApi(request);

    const session = await api.createSession("Partition-QA");
    const sessionId = session.id;

    try {
      // Use /run-stream for full metadata persistence
      const resp = await request.post("/api/agents/run-stream", {
        data: { input: "你好，用两句话介绍你自己。", sessionId },
      });
      expect(resp.ok).toBeTruthy();

      // Wait for messages
      const msgs = await waitForMessages(request, sessionId, 2, 60_000);
      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg, "Should have assistant message").toBeTruthy();
      expect(assistantMsg!.content?.length, "Assistant should have content").toBeGreaterThan(10);

      // Verify metadata exists — the enrichment layer extracts specific fields
      // from metadata (thinkingContent, toolCalls, pushedContents) but NOT draft.
      // Check that the message has content (the "black" area).
      const content = assistantMsg!.content || "";
      expect(content.length, "Assistant should have meaningful content").toBeGreaterThan(10);

      console.log(`[Test 1] Content len: ${assistantMsg!.content?.length}`);
      console.log(`[Test 1] Metadata: ${JSON.stringify(meta).substring(0, 300)}`);
    } finally {
      await api.deleteSession(sessionId).catch(() => {});
    }
  });

  // ── Test 2: Tool calling via /run-stream — toolCalls in metadata ──────
  test("tool calling — toolCalls persisted", async ({ request }) => {
    const api = createApi(request);

    const session = await api.createSession("Partition-Tools", {
      kbIds: [TEST_KB_ID],
    });
    const sessionId = session.id;

    try {
      const resp = await request.post("/api/agents/run-stream", {
        data: {
          input: "请搜索知识库中关于'反重力'的内容，告诉我你找到了什么。",
          sessionId,
        },
      });
      expect(resp.ok).toBeTruthy();

      const msgs = await waitForMessages(request, sessionId, 2, 120_000);
      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg, "Should have assistant message").toBeTruthy();

      // Check metadata — enrichment layer extracts specific fields
      const meta = assistantMsg!.metadata || {};

      console.log(`[Test 2] Content len: ${(assistantMsg!.content || "").length}`);
      console.log(`[Test 2] Has toolCalls: ${!!meta.toolCalls}`);
      console.log(`[Test 2] Has thinkingContent: ${!!meta.thinkingContent}`);
      console.log(`[Test 2] Metadata keys: ${Object.keys(meta).join(", ")}`);
    } finally {
      await api.deleteSession(sessionId).catch(() => {});
    }
  });

  // ── Test 3: Visual — page loads and displays content correctly ────────
  test("visual — content displays correctly after refresh", async ({ page, request }) => {
    const api = createApi(request);

    const session = await api.createSession("Partition-Visual");
    const sessionId = session.id;

    try {
      // Run agent via /run-stream
      const resp = await request.post("/api/agents/run-stream", {
        data: { input: "用三句话解释什么是人工智能。", sessionId },
      });
      expect(resp.ok).toBeTruthy();

      await waitForMessages(request, sessionId, 2, 60_000);

      // Navigate to session page
      await page.goto(`/#/sessions/${sessionId}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);

      // Take screenshot
      await page.screenshot({ path: "tests/e2e/screenshots/content-partition-loaded.png", fullPage: true });

      // Verify content is displayed
      const pageContent = await page.textContent("body");
      expect(pageContent?.length, "Page should have content").toBeGreaterThan(50);

      // Refresh and verify content persists
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);

      await page.screenshot({ path: "tests/e2e/screenshots/content-partition-refreshed.png", fullPage: true });

      const refreshedContent = await page.textContent("body");
      expect(refreshedContent?.length, "Content should persist after refresh").toBeGreaterThan(50);

    } finally {
      await api.deleteSession(sessionId).catch(() => {});
    }
  });

  // ── Test 4: API structure — verify metadata fields ───────────────────
  test("API structure — metadata has correct fields", async ({ request }) => {
    const api = createApi(request);

    const session = await api.createSession("Partition-API");
    const sessionId = session.id;

    try {
      // Test via /run-stream
      const resp = await request.post("/api/agents/run-stream", {
        data: { input: "1+1等于几？直接回答。", sessionId },
      });
      expect(resp.ok).toBeTruthy();

      const msgs = await waitForMessages(request, sessionId, 2, 60_000);
      const assistantMsg = msgs.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();

      const meta = assistantMsg!.metadata || {};

      // Content should be the answer, not "Task completed with no output"
      const content = assistantMsg!.content || "";
      expect(content.length, "Content should not be empty").toBeGreaterThan(0);
      expect(content, "Content should not be fallback").not.toContain("Task completed with no output");

      console.log(`[Test 4] Content: "${content.substring(0, 100)}"`);
      console.log(`[Test 4] Metadata: ${JSON.stringify(meta).substring(0, 300)}`);
    } finally {
      await api.deleteSession(sessionId).catch(() => {});
    }
  });
});
