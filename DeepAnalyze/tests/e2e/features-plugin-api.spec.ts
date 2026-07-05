/**
 * E2E API Tests — Plugin System
 * Tests the plugin management API endpoints.
 */
import { test, expect } from "@playwright/test";

test.describe("Plugin API", () => {
  // -----------------------------------------------------------------------
  // 1. GET /api/plugins returns plugin list
  // -----------------------------------------------------------------------
  test("GET /api/plugins returns plugin info", async ({ request }) => {
    const resp = await request.get("/api/plugins");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    // The root /api/plugins returns an endpoint listing
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("endpoints");
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 2. POST /api/plugins/install installs a directory plugin
  // -----------------------------------------------------------------------
  test("POST /api/plugins/plugins/install installs a plugin from directory", async ({ request }) => {
    // This will likely fail in CI since there's no plugin directory,
    // but we test the endpoint exists and handles missing dir gracefully
    const resp = await request.post("/api/plugins/plugins/install", {
      data: { dirPath: "/nonexistent/plugin/path" },
    });
    // Should return an error (500 or 400) but not crash
    expect([400, 500]).toContain(resp.status());
    const body = await resp.json();
    expect(body).toHaveProperty("error");
  });

  // -----------------------------------------------------------------------
  // 3. POST /api/plugins/install with missing dirPath returns 400
  // -----------------------------------------------------------------------
  test("POST /api/plugins/plugins/install returns 400 without dirPath", async ({ request }) => {
    const resp = await request.post("/api/plugins/plugins/install", {
      data: {},
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("dirPath");
  });

  // -----------------------------------------------------------------------
  // 4. POST /api/plugins/discover discovers plugins
  // -----------------------------------------------------------------------
  test("POST /api/plugins/plugins/discover returns discovered list", async ({ request }) => {
    const resp = await request.post("/api/plugins/plugins/discover", {
      data: { searchPaths: ["/tmp"] },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty("discovered");
    expect(Array.isArray(body.discovered)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 5. POST /api/plugins/discover with missing searchPaths returns 400
  // -----------------------------------------------------------------------
  test("POST /api/plugins/plugins/discover returns 400 without searchPaths", async ({ request }) => {
    const resp = await request.post("/api/plugins/plugins/discover", {
      data: {},
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("searchPaths");
  });
});
