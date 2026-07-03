/**
 * Worker deployment E2E — dry-run preview + deploy-job query.
 *
 * F5-1: admin POST /workers/deploy with dry_run=true → preview response
 * F5-2: GET /workers/deploy-jobs/:id with nonexistent ID → 404
 * F5-3: POST /workers/deploy without auth → 401
 * F5-4: POST /workers/deploy missing required fields → 400
 */
import { test, expect } from "./fixtures.js";
import { getApiToken } from "./fixtures.js";

const HUB = "http://localhost:22000";
const ORG_ID = "org_dsi"; // 远景科技集团 (verified in DB)

test.describe("Worker deployment (@playwright)", () => {
  test("F5-1: admin dry-run returns preview", async ({ request }) => {
    const token = await getApiToken(request, "admin", "admin123");
    const res = await request.post(`${HUB}/api/v1/workers/deploy`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        organization_id: ORG_ID,
        ssh_host: "10.0.0.99",
        ssh_port: 22,
        ssh_user: "ubuntu",
        ssh_private_key: "fake-key-for-dry-run",
        image_tag: "da-base-v0.9.0-amd64",
        source: "hub_stream",
        dry_run: true,
      },
    });
    expect(res.status(), `dry-run status`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("preview");
    expect(body.summary.target).toContain("10.0.0.99");
    expect(body.summary.image_tag).toBe("da-base-v0.9.0-amd64");
  });

  test("F5-2: deploy-jobs query 404 for missing ID", async ({ request }) => {
    const token = await getApiToken(request, "admin", "admin123");
    const res = await request.get(
      `${HUB}/api/v1/workers/deploy-jobs/dpl_nonexistent_${Date.now()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    expect([404]).toContain(res.status());
  });

  test("F5-3: deploy requires auth", async ({ request }) => {
    const res = await request.post(`${HUB}/api/v1/workers/deploy`, {
      data: { dry_run: true, ssh_host: "x" },
    });
    expect(res.status()).toBe(401);
  });

  test("F5-4: deploy missing required fields → 400", async ({ request }) => {
    const token = await getApiToken(request, "admin", "admin123");
    const res = await request.post(`${HUB}/api/v1/workers/deploy`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { dry_run: true }, // missing ssh_host, ssh_user, etc.
    });
    expect(res.status()).toBe(400);
  });
});
