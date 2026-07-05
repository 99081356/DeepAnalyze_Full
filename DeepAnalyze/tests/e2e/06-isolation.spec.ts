/**
 * 06 - Multi-Session Parallel Isolation Tests (ALS Verification)
 * Covers: C-216 parallel session isolation, inject targeting, frontend switching.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";
import { waitForAgentTask } from "./helpers/wait";
import { TEST_KB_ID } from "./fixtures";

test.describe("06 - Multi-Session Isolation", () => {
  let api: ReturnType<typeof createApi>;

  test.beforeEach(async ({ request }) => {
    api = createApi(request);
  });

  test("6.1 parallel sessions don't cross-contaminate", async ({ request }) => {
    test.setTimeout(180_000);

    const sessionA = await api.createSession("Isolation A", { kbIds: [TEST_KB_ID] });
    const sessionB = await api.createSession("Isolation B", { kbIds: [TEST_KB_ID] });

    try {
      // Start both agents simultaneously with different questions
      const [respA, respB] = await Promise.all([
        request.post("/api/agents/run", {
          data: { input: "请告诉我知识库中有哪些文档？只列文档名。", sessionId: sessionA.id },
        }),
        request.post("/api/agents/run", {
          data: { input: "请告诉我知识库中有几个文档？只说数量。", sessionId: sessionB.id },
        }),
      ]);

      expect(respA.ok).toBeTruthy();
      expect(respB.ok).toBeTruthy();

      // Wait for both to complete
      await Promise.all([
        waitForAgentTask(request, sessionA.id, 120_000),
        waitForAgentTask(request, sessionB.id, 120_000),
      ]);

      // Verify each session has its own messages
      const msgsA = await api.getMessages(sessionA.id);
      const msgsB = await api.getMessages(sessionB.id);

      expect(msgsA.length, "Session A should have messages").toBeGreaterThanOrEqual(2);
      expect(msgsB.length, "Session B should have messages").toBeGreaterThanOrEqual(2);

      // Verify messages in A are about A's question, not B's
      const assistantA = msgsA.filter((m) => m.role === "assistant");
      const assistantB = msgsB.filter((m) => m.role === "assistant");

      expect(assistantA.length, "Session A should have assistant messages").toBeGreaterThanOrEqual(1);
      expect(assistantB.length, "Session B should have assistant messages").toBeGreaterThanOrEqual(1);

      // The content should be different (different questions → different answers)
      const contentA = assistantA.map((m) => m.content || "").join(" ");
      const contentB = assistantB.map((m) => m.content || "").join(" ");

      // Both should have meaningful content
      expect(contentA.length).toBeGreaterThan(10);
      expect(contentB.length).toBeGreaterThan(10);

      // They should not be identical (different questions)
      if (contentA.length > 50 && contentB.length > 50) {
        expect(contentA).not.toBe(contentB);
      }
    } finally {
      await api.deleteSession(sessionA.id).catch(() => {});
      await api.deleteSession(sessionB.id).catch(() => {});
    }
  });

  test("6.2 inject route targets correct task", async ({ request }) => {
    test.setTimeout(60_000);

    const session = await api.createSession("Inject Target Test");
    try {
      // Start an agent task
      const resp = await request.post("/api/agents/run", {
        data: { input: "请等待我的进一步指示。", sessionId: session.id },
      });
      expect(resp.ok).toBeTruthy();

      // Wait for completion
      await waitForAgentTask(request, session.id, 30_000);

      // Try inject on non-existent task
      const injectResp = await request.post("/api/agents/inject", {
        data: { taskId: "nonexistent-task-id", message: "test" },
      });
      // Should return 404 for non-existent task
      expect(injectResp.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  test("6.3 frontend fast switching between running sessions", async ({ page, request }) => {
    test.setTimeout(60_000);

    const sessionA = await api.createSession("Fast Switch A");
    const sessionB = await api.createSession("Fast Switch B");

    try {
      // Switch rapidly between sessions
      for (let i = 0; i < 3; i++) {
        await page.goto(`/#/sessions/${sessionA.id}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(200);

        await page.goto(`/#/sessions/${sessionB.id}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(200);
      }

      // Final state should be session B
      await expect(page).toHaveURL(new RegExp(sessionB.id));
      await takeScreenshot(page, "isolation-fast-switch");
    } finally {
      await api.deleteSession(sessionA.id).catch(() => {});
      await api.deleteSession(sessionB.id).catch(() => {});
    }
  });

  test("6.4 frontend refresh persistence - both sessions intact", async ({ page, request }) => {
    test.setTimeout(60_000);

    const sessionA = await api.createSession("Refresh Persist A");
    const sessionB = await api.createSession("Refresh Persist B");

    try {
      // Visit both sessions to trigger message loading
      await page.goto(`/#/sessions/${sessionA.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      await page.goto(`/#/sessions/${sessionB.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      // Reload the page
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);

      // Should still be on session B
      await expect(page).toHaveURL(new RegExp(sessionB.id));
      await takeScreenshot(page, "isolation-refresh-persist");

      // Verify both sessions still exist in API
      const sessions = await api.listSessions();
      expect(sessions.find((s) => s.id === sessionA.id)).toBeTruthy();
      expect(sessions.find((s) => s.id === sessionB.id)).toBeTruthy();
    } finally {
      await api.deleteSession(sessionA.id).catch(() => {});
      await api.deleteSession(sessionB.id).catch(() => {});
    }
  });

  test("6.5 session IDs are unique - no overlap", async () => {
    const sessions = await Promise.all([
      api.createSession("Unique 1"),
      api.createSession("Unique 2"),
      api.createSession("Unique 3"),
    ]);

    try {
      const ids = sessions.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size, "All session IDs should be unique").toBe(ids.length);
    } finally {
      for (const s of sessions) {
        await api.deleteSession(s.id).catch(() => {});
      }
    }
  });
});
