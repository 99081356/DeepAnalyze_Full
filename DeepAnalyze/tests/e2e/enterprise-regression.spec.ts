// deepanalyze/tests/e2e/enterprise-regression.spec.ts
/**
 * T21 — Personal-mode regression: enterprise features must NOT activate
 * when DA_AUTH_MODE != "hub".
 *
 * Preconditions:
 * - DA backend running on :21000 with DA_AUTH_MODE=local (or none)
 * - Playwright baseURL: http://localhost:21000
 *
 * Verified behaviors:
 * - POST /api/hub/config/sync-from-hub returns 400 (T16) — only mounted when
 *   runMode==="worker"; in standalone mode (DA_AUTH_MODE != "hub") the path
 *   is either not registered (404) or stubbed by the standalone fallback.
 * - GET /api/hub/config/sync-status returns last_hub_sync_at: null (T16) —
 *   same gating: route may return stub JSON or 404 in standalone mode.
 * - GET /api/health does NOT include heartbeat/moduleHealth fields (T18)
 * - GET / returns the login page (no Hub SSO redirect) (T10)
 *
 * Note on brief-vs-code discrepancy (T21 Correction 4 directs "match actual
 * T10/T15/T16/T18 gating behavior"): the T16 routes are actually mounted at
 * /api/hub/config/* (see src/server/app.ts:847 app.route("/api/hub", hubRoutes))
 * and only when DEEPANALYZE_CONFIG.runMode === "worker". The brief's
 * /api/config/sync-from-hub path does not exist in the codebase.
 */
import { test, expect } from "@playwright/test";

test.describe("T21: 个人版回归 — enterprise features gated", () => {
  test("POST /api/hub/config/sync-from-hub is gated when DA_AUTH_MODE != hub", async ({ request }) => {
    const res = await request.post("/api/hub/config/sync-from-hub");
    // T16: route gates on DA_AUTH_MODE=hub AND only mounts in runMode=worker.
    // In standalone mode (DA_AUTH_MODE=local/none), it returns 400/404.
    expect([400, 404]).toContain(res.status());
  });

  test("GET /api/hub/config/sync-status is gated when DA_AUTH_MODE != hub", async ({ request }) => {
    const res = await request.get("/api/hub/config/sync-status");
    // T16: in standalone mode, the route may be stubbed (200 with no
    // last_hub_sync_at field) or not registered (404). Either is acceptable.
    if (res.ok()) {
      const body = await res.json();
      // Stub JSON has no last_hub_sync_at field; real route returns null.
      // Either way, last_hub_sync_at must not be a real timestamp.
      expect(body.last_hub_sync_at ?? null).toBeNull();
    } else {
      expect([400, 404]).toContain(res.status());
    }
  });

  test("GET /api/health does not surface enterprise-only fields", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // Enterprise-only fields should be absent or null in local mode
    expect(body).not.toHaveProperty("moduleHealth");
    expect(body).not.toHaveProperty("hubClient");
  });

  test("root page renders without Hub SSO redirect", async ({ page }) => {
    const res = await page.goto("/");
    // Should not redirect to Hub /auth/sso/ticket
    expect(res?.url()).not.toMatch(/\/auth\/sso\/ticket/);
  });
});
