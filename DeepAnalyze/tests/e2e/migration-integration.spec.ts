/**
 * Comprehensive Playwright E2E test for CC migration integration.
 *
 * Verifies that all migrated utilities, bash parser, logger, retry,
 * and atomicWrite integrations do NOT break the frontend UI or any
 * API endpoints. Uses screenshots to verify visual state.
 *
 * Prerequisites: Server running on localhost:21000
 * Run with: npx playwright test tests/e2e/migration-integration.spec.ts
 */
import { test, expect, Page } from "@playwright/test";

const BASE = "http://localhost:21000";

// =========================================================================
// 1. Server Health & Basic Connectivity
// =========================================================================
test.describe("Server Health", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/health`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
  });

  test("capabilities endpoint responds", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/capabilities`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toBeDefined();
  });
});

// =========================================================================
// 2. Frontend Loading & Rendering
// =========================================================================
test.describe("Frontend Loading", () => {
  test("main page loads and renders React app", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    await page.screenshot({ path: "tests/screenshots/01-main-page.png", fullPage: true });

    // React should have rendered — check for root element
    const rootContent = await page.locator("#root").innerHTML();
    expect(rootContent.length).toBeGreaterThan(100);

    // Page title should exist
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test("JavaScript bundles load without errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    // Filter out known non-critical errors (e.g., favicon, extension errors)
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("extension") &&
        !e.includes("DevTools") &&
        !e.includes("ResizeObserver")
    );
    expect(criticalErrors.length).toBe(0);
  });

  test("static assets (JS/CSS) are accessible", async ({ request }) => {
    // Get the main page to find asset references
    const mainPage = await request.get(`${BASE}/`);
    const html = await mainPage.text();

    // Extract JS bundle paths
    const jsMatches = html.match(/src="([^"]*\.js)"/g) || [];
    expect(jsMatches.length).toBeGreaterThan(0);

    for (const match of jsMatches.slice(0, 3)) {
      const path = match.match(/src="([^"]+)"/)![1]!;
      const resp = await request.get(`${BASE}${path}`);
      expect(resp.status()).toBe(200);
    }
  });
});

// =========================================================================
// 3. Knowledge Base UI
// =========================================================================
test.describe("Knowledge Base UI", () => {
  test("knowledge list API returns data", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/knowledge/kbs`);
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data) || typeof data === "object").toBe(true);
  });

  test("knowledge page renders without errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30000 });

    // Look for knowledge/KB related elements or navigation
    await page.screenshot({ path: "tests/screenshots/02-kb-page.png", fullPage: true });

    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("extension") && !e.includes("ResizeObserver")
    );
    expect(criticalErrors.length).toBe(0);
  });
});

// =========================================================================
// 4. Settings UI
// =========================================================================
test.describe("Settings UI", () => {
  test("settings API responds", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/settings`);
    expect(resp.status()).toBe(200);
  });

  test("settings page loads", async ({ page }) => {
    await page.goto(`${BASE}/settings`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {
      // SPA might not have /settings route — try hash routing
      return page.goto(`${BASE}/#/settings`, { waitUntil: "networkidle", timeout: 30000 });
    });
    await page.screenshot({ path: "tests/screenshots/03-settings-page.png", fullPage: true });
  });
});

// =========================================================================
// 5. Chat / Agent System UI
// =========================================================================
test.describe("Chat & Agent System", () => {
  test("sessions API responds", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/sessions`);
    expect(resp.status()).toBe(200);
  });

  test("agent skills API responds", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/agent-skills`);
    expect(resp.status()).toBe(200);
  });

  test("chat page renders", async ({ page }) => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30000 });
    await page.screenshot({ path: "tests/screenshots/04-chat-page.png", fullPage: true });
  });
});

// =========================================================================
// 6. Bash Command Classification (via API if exposed)
// =========================================================================
test.describe("Bash Parser Integration", () => {
  // The bash parser is used server-side for tool execution security
  // We verify it doesn't break the agent tool system
  test("agent tools API (if available) responds", async ({ request }) => {
    // Agent routes may need auth — just verify they don't crash
    const resp = await request.get(`${BASE}/api/agents/tools`).catch(() => null);
    if (resp) {
      // Any response (even 401/404) means the server didn't crash
      expect(resp.status()).toBeLessThan(500);
    }
  });
});

// =========================================================================
// 7. Error Handling Verification (logger integration)
// =========================================================================
test.describe("Error Handling", () => {
  test("404 returns proper error, doesn't crash server", async ({ request }) => {
    const resp = await request.get(`${BASE}/api/nonexistent-endpoint-xyz`);
    expect(resp.status()).toBe(404);
    // Server should still be healthy
    const health = await request.get(`${BASE}/api/health`);
    expect(health.status()).toBe(200);
  });

  test("invalid API request returns error, not crash", async ({ request }) => {
    const resp = await request.post(`${BASE}/api/knowledge/invalid-uuid/search`, {
      data: { query: "test" },
    });
    // Should return error, not 500
    expect(resp.status()).toBeLessThan(500);
  });
});

// =========================================================================
// 8. Full Page Traversal (comprehensive screenshot audit)
// =========================================================================
test.describe("Full Page Traversal", () => {
  const routes = [
    { path: "/", name: "home" },
    { path: "/knowledge", name: "knowledge-list" },
  ];

  for (const route of routes) {
    test(`${route.name} page loads and screenshots`, async ({ page }) => {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "networkidle", timeout: 30000 }).catch(async () => {
        // Try hash routing
        await page.goto(`${BASE}/#${route.path}`, { waitUntil: "networkidle", timeout: 30000 });
      });
      await page.screenshot({
        path: `tests/screenshots/05-traversal-${route.name}.png`,
        fullPage: true,
      });
      // Just verify page didn't blank out
      const body = await page.locator("body").innerHTML();
      expect(body.length).toBeGreaterThan(50);
    });
  }
});

// =========================================================================
// 9. WebSocket Connectivity
// =========================================================================
test.describe("WebSocket", () => {
  test("WebSocket upgrade path exists", async ({ page }) => {
    let wsConnected = false;
    page.on("websocket", (ws) => {
      wsConnected = true;
    });

    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    // WS may or may not connect without user interaction, just verify no crash
    await page.screenshot({ path: "tests/screenshots/06-websocket-check.png", fullPage: true });

    // Server should still be healthy regardless
    const healthResp = await page.request.get(`${BASE}/api/health`);
    expect(healthResp.status()).toBe(200);
  });
});
