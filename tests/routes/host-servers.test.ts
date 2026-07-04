// deepanalyze-hub/tests/routes/host-servers.test.ts
import { describe, test, expect } from "bun:test";
import { createHubTestApp } from "../helpers/test-app";

describe("POST /api/v1/host-servers", () => {
  test("super_admin 可创建", async () => {
    const app = await createHubTestApp({ role: "super_admin" });
    const res = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "prod-01",
        ssh_target_host: "10.0.0.1",
        port_range_start: 21000,
        port_range_end: 21099,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^hst_/);

    // Cleanup
    await app.request(`/api/v1/host-servers/${body.id}`, { method: "DELETE" });
  });

  test("org_admin 被拒绝（403）", async () => {
    const app = await createHubTestApp({ role: "org_admin" });
    const res = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "x", ssh_target_host: "1.1.1.1" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/host-servers", () => {
  test("返回列表", async () => {
    const app = await createHubTestApp({ role: "super_admin" });
    const res = await app.request("/api/v1/host-servers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});
