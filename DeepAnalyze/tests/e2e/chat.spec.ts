/**
 * Chat E2E Tests — conversation creation, messaging, session management.
 */
import { test, expect } from "@playwright/test";

test.describe("Chat — Session Management", () => {
  test("create a new chat session", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Click "新建对话" button
    const newChatBtn = page.locator('button:has-text("新建对话")').first();
    await newChatBtn.click();
    await page.waitForLoadState("networkidle");

    // Should navigate to a chat view
    await expect(page).toHaveURL(/#\/(chat|sessions)/);
  });

  test("session list appears after creation", async ({ page }) => {
    // Clean up any stale test sessions first
    const existing = await page.request.get("/api/sessions");
    if (existing.ok()) {
      const sessions = await existing.json();
      for (const s of sessions) {
        if (s.title?.startsWith("E2E Test Session")) {
          await page.request.delete(`/api/sessions/${s.id}`);
        }
      }
    }

    // Create a session via API
    const resp = await page.request.post("/api/sessions", {
      data: { title: "E2E Test Session Unique" },
    });
    expect([200, 201]).toContain(resp.status());
    const session = await resp.json();
    expect(session.id).toBeTruthy();

    // Reload and check session appears in sidebar
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Click on "对话" nav item to ensure chat view is active
    const chatNav = page.locator('button:has-text("对话")').first();
    await chatNav.click();
    await page.waitForTimeout(1000);

    // The session should appear in the sidebar history
    const sessionItem = page.locator("text=E2E Test Session Unique").first();
    await expect(sessionItem).toBeVisible({ timeout: 10000 });

    // Clean up
    await page.request.delete(`/api/sessions/${session.id}`);
  });

  test("delete a session removes it from sidebar", async ({ page }) => {
    // Create a session via API
    const resp = await page.request.post("/api/sessions", {
      data: { title: "Session To Delete" },
    });
    const session = await resp.json();

    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    // Ensure chat view is active
    const chatNav = page.locator('button:has-text("对话")').first();
    await chatNav.click();
    await page.waitForTimeout(500);

    // Hover over the session to reveal delete button
    const sessionEl = page.locator("text=Session To Delete").first();
    await expect(sessionEl).toBeVisible({ timeout: 5000 });
    await sessionEl.hover();

    // Click delete button (Trash2 icon)
    const deleteBtn = sessionEl.locator("..").locator("button").last();
    await deleteBtn.click({ timeout: 3000 });
    await page.waitForTimeout(500);

    // Session should be gone from sidebar
    await expect(page.locator("text=Session To Delete")).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe("Chat — Messaging", () => {
  let sessionId: string;

  test.beforeAll(async ({ request }) => {
    const resp = await request.post("/api/sessions", {
      data: { title: "Message Test Session" },
    });
    const body = await resp.json();
    sessionId = body.id;
  });

  test.afterAll(async ({ request }) => {
    if (sessionId) {
      await request.delete(`/api/sessions/${sessionId}`);
    }
  });

  test("chat input is visible in a session", async ({ page }) => {
    await page.goto(`/#/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Wait for ChatWindow to load the session from URL and render MessageInput
    const chatInput = page.locator("textarea, [contenteditable='true']").first();
    await expect(chatInput).toBeVisible({ timeout: 10000 });
  });

  test("messages API returns empty for new session", async ({ request }) => {
    const resp = await request.get(`/api/sessions/${sessionId}/messages`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body)).toBeTruthy();
    // New session should have no messages (or just the welcome message)
    expect(body.length).toBeLessThanOrEqual(1);
  });
});
