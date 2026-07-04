// deepanalyze-hub/tests/e2e/enterprise-integration.spec.ts
/**
 * T21 — Hub enterprise integration smoke test.
 * Exercises the T01-T20 endpoint surface with seeded/dev data.
 *
 * SKIPS any flow requiring real SSH + Docker worker deployment
 * (those are manual verification items, documented in the acceptance doc).
 *
 * Preconditions:
 * - Hub backend on :22000 running with migrations 027-036 applied
 * - Hub frontend Vite dev server on :5173 (or PW_NO_SERVER=1 if pre-running)
 * - Admin user present (per global-setup.ts admin/admin123)
 * - At least 1 approved worker in DB (manual seed if missing)
 */
import { test, expect } from "@playwright/test";

const API_BASE = "http://localhost:22000/api/v1";

test.describe.configure({ mode: "serial" });

let adminToken: string;

test.beforeAll(async ({ request }) => {
  const loginRes = await request.post(`${API_BASE}/auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  if (!loginRes.ok()) {
    test.skip(true, "admin login failed — seed data not present");
    return;
  }
  const body = await loginRes.json();
  adminToken = body.access_token;
});

test.describe("T21: Hub enterprise integration", () => {
  test("GET /monitoring/overview returns 200 with workers array", async ({ request }) => {
    test.skip(!adminToken, "no admin token");
    const res = await request.get(`${API_BASE}/monitoring/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("online");
    expect(body).toHaveProperty("workers");
    expect(Array.isArray(body.workers)).toBe(true);
  });

  test("GET /host-servers returns 200", async ({ request }) => {
    test.skip(!adminToken, "no admin token");
    const res = await request.get(`${API_BASE}/host-servers`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.ok()).toBe(true);
  });

  test("GET /config-templates/global returns 200 or 404", async ({ request }) => {
    test.skip(!adminToken, "no admin token");
    const res = await request.get(`${API_BASE}/config-templates/global`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([200, 404]).toContain(res.status());
  });

  test("POST /config-templates/by-worker/merged requires workerAuth (401 with JWT)", async ({ request }) => {
    // This endpoint uses workerAuth, not jwtAuth — admin JWT should be rejected
    const res = await request.get(`${API_BASE}/config-templates/by-worker/merged`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /workers returns approved workers", async ({ request }) => {
    test.skip(!adminToken, "no admin token");
    const res = await request.get(`${API_BASE}/workers`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // Actual API returns { workers: [...] } (verified in src/server/routes/workers.ts:292)
    const workers = body.workers ?? body;
    expect(Array.isArray(workers)).toBe(true);
  });

  test("worker backups endpoint returns 200 for existing worker", async ({ request }) => {
    test.skip(!adminToken, "no admin token");
    // First fetch a worker id
    const workersRes = await request.get(`${API_BASE}/workers`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const workersBody = await workersRes.json();
    const workers = workersBody.workers ?? workersBody;
    test.skip(!Array.isArray(workers) || workers.length === 0, "no workers in DB to test backups against");
    const workerId = workers[0].id;

    const backupsRes = await request.get(`${API_BASE}/workers/${workerId}/backups`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(backupsRes.ok()).toBe(true);
    const body = await backupsRes.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("Frontend Monitoring page loads", async ({ page }) => {
    test.skip(!adminToken, "no admin token");
    await page.goto("/monitoring");
    await expect(page.locator("text=Worker 监控").first()).toBeVisible({ timeout: 10_000 });
  });

  test("Frontend WorkerDetail page handles unknown id", async ({ page }) => {
    test.skip(!adminToken, "no admin token");
    await page.goto("/workers/nonexistent-id");
    // Should show error state, not crash
    await expect(page.locator("text=Worker 不存在").first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("T21: SSH-dependent flows (SKIPPED in dev)", () => {
  test.skip(true, "Requires real SSH-able Docker host — manual verification only");

  test("register host_server + deploy 2 workers (port conflict check)", async () => {
    // SKIPPED — requires SSH + Docker
  });

  test("upgrade worker creates backup + deploy_jobs success", async () => {
    // SKIPPED — requires SSH + Docker
  });

  test("rollback worker restores previous image_tag", async () => {
    // SKIPPED — requires SSH + Docker
  });

  test("SSO flow: Hub login → DA redirect → session cookie set", async () => {
    // SKIPPED — requires deployed DA worker reachable from Hub
  });
});
