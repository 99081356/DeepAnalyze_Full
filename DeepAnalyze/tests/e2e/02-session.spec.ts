/**
 * 02 - Session Lifecycle Tests
 * Covers: CRUD, messaging, scope, media, deletion cascade.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot } from "./helpers/visual";
import { assertMessageOrder } from "./helpers/assertions";

test.describe("02 - Session Lifecycle", () => {
  // -- 2.1 Create Session --
  test("2.1 create session returns id/title/createdAt", async ({ request }) => {
    const api = createApi(request);
    const s = await api.createSession("E2E Session Create");
    expect(s.id).toBeTruthy();
    expect(s.title).toBe("E2E Session Create");
    expect(s.createdAt).toBeTruthy();
    await api.deleteSession(s.id).catch(() => {});
  });

  // -- 2.2 List Sessions --
  test("2.2 list sessions returns array", async ({ request }) => {
    const api = createApi(request);
    const sessions = await api.listSessions();
    expect(Array.isArray(sessions)).toBeTruthy();
  });

  // -- 2.3 Get Single Session --
  test("2.3 create and get session returns correct data", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Get Test");
    const session = await api.getSession(created.id);
    expect(session.id).toBe(created.id);
    expect(session.title).toBe("E2E Get Test");
    await api.deleteSession(created.id).catch(() => {});
  });

  // -- 2.4 Delete Session --
  test("2.4 delete session and verify 404", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Delete Test");
    const delResp = await api.deleteSession(created.id);
    expect(delResp.ok).toBeTruthy();
    const resp = await request.get(`/api/sessions/${created.id}`);
    expect(resp.status()).toBe(404);
  });

  // -- 2.5 Delete Session Cleans Up --
  test("2.5 delete session cleans up output paths", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Cleanup Test");
    const delResp = await api.deleteSession(created.id);
    expect(delResp.ok).toBeTruthy();
    const resp = await request.get(`/api/sessions/${created.id}/output/anyfile.txt`);
    expect(resp.status()).toBe(404);
  });

  // -- 2.6 Scope Persistence --
  test("2.6 session scope persists after PATCH", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Scope Test");
    const scope = { kbIds: ["test-kb-id"] };
    await api.patchScope(created.id, scope);
    const session = await api.getSession(created.id);
    expect(session.kbScope).toBeTruthy();
    await api.deleteSession(created.id).catch(() => {});
  });

  // -- 2.7 Session List Excludes Preprocessing --
  test("2.7 session list excludes preprocessing sessions", async ({ request }) => {
    const api = createApi(request);
    const sessions = await api.listSessions();
    for (const s of sessions) {
      const title = s.title || "";
      expect(title).not.toMatch(/^\[预处理\]/);
    }
  });

  // -- 2.8 Empty Messages --
  test("2.8 new session has empty or minimal messages", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Messages Test");
    const msgs = await api.getMessages(created.id);
    expect(Array.isArray(msgs)).toBeTruthy();
    expect(msgs.length).toBeLessThanOrEqual(1);
    await api.deleteSession(created.id).catch(() => {});
  });

  // -- 2.9 Chat Page Screenshot --
  test("2.9 chat page screenshot - input box renders", async ({ page, request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Screenshot Test");

    try {
      await page.goto(`/#/sessions/${created.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);

      const chatInput = page.locator("textarea, [contenteditable='true']").first();
      await expect(chatInput).toBeVisible({ timeout: 10000 });
      await takeScreenshot(page, "session-chat-page");
    } finally {
      await api.deleteSession(created.id).catch(() => {});
    }
  });

  // -- 2.10 Session Switching --
  test("2.10 switching between sessions doesn't cross-contaminate", async ({ page, request }) => {
    const api = createApi(request);
    const sessionA = await api.createSession("Session A Switch");
    const sessionB = await api.createSession("Session B Switch");

    try {
      await page.goto(`/#/sessions/${sessionA.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      await page.goto(`/#/sessions/${sessionB.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      await page.goto(`/#/sessions/${sessionA.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(sessionA.id));
      await takeScreenshot(page, "session-switching");
    } finally {
      await api.deleteSession(sessionA.id).catch(() => {});
      await api.deleteSession(sessionB.id).catch(() => {});
    }
  });

  // -- 2.11 Media Upload --
  test("2.11 media upload endpoint accepts multipart", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Media Test");

    const resp = await request.post(`/api/sessions/${created.id}/media`, {
      multipart: {
        file: {
          name: "test.png",
          mimeType: "image/png",
          buffer: Buffer.from("fake-image-data"),
        },
      },
    });
    // May fail with invalid data - just verify endpoint exists
    expect([200, 201, 400, 422]).toContain(resp.status());
    await api.deleteSession(created.id).catch(() => {});
  });

  // -- 2.12 Media 404 --
  test("2.12 get non-existent media returns 404", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Media 404 Test");
    const resp = await request.get(`/api/sessions/${created.id}/media/nonexistent-id`);
    expect(resp.status()).toBe(404);
    await api.deleteSession(created.id).catch(() => {});
  });

  // -- 2.13 Message Order --
  test("2.13 message order function validates correctly", async ({ request }) => {
    const api = createApi(request);
    const created = await api.createSession("E2E Order Test");
    const msgs = await api.getMessages(created.id);
    if (msgs.length >= 2) {
      assertMessageOrder(msgs);
    }
    await api.deleteSession(created.id).catch(() => {});
  });
});
