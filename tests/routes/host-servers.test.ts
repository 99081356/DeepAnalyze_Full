// deepanalyze-hub/tests/routes/host-servers.test.ts
import { describe, test, expect } from "bun:test";
import { createHubTestApp } from "../helpers/test-app";

describe("POST /api/v1/host-servers", () => {
  test("super_admin 可创建", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    const res = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
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
    await app.request(`/api/v1/host-servers/${body.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test("org_admin 被拒绝（403）", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "org_admin" });
    const res = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ hostname: "x", ssh_target_host: "1.1.1.1" }),
    });
    expect(res.status).toBe(403);
  });

  test("无 JWT 被 jwtAuth 拒绝（401）", async () => {
    const { app } = await createHubTestApp({ role: "super_admin" });
    const res = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "no-auth", ssh_target_host: "1.1.1.1" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/host-servers", () => {
  test("返回列表", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    const res = await app.request("/api/v1/host-servers", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("PATCH /api/v1/host-servers/:id", () => {
  test("未知列名返回 400（zod .strict()）", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    // 先创建一个 host
    const createRes = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-strict",
        ssh_target_host: "10.0.0.99",
      }),
    });
    const created = await createRes.json();

    // 尝试 PATCH 未知列
    const res = await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        "id = 'hst_evil'; DROP TABLE workers--": "x",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");

    // Cleanup
    await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test("空对象返回 200 + 当前行（无字段更新）", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    const createRes = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-empty",
        ssh_target_host: "10.0.0.98",
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.hostname).toBe("patch-test-empty");

    // Cleanup
    await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test("正常字段更新返回 200", async () => {
    const { app, accessToken } = await createHubTestApp({ role: "super_admin" });
    const createRes = await app.request("/api/v1/host-servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-normal",
        ssh_target_host: "10.0.0.97",
      }),
    });
    const created = await createRes.json();

    const res = await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        hostname: "patch-test-renamed",
        status: "maintenance",
        notes: "testing PATCH",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostname).toBe("patch-test-renamed");
    expect(body.status).toBe("maintenance");
    expect(body.notes).toBe("testing PATCH");

    // Cleanup
    await app.request(`/api/v1/host-servers/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  });
});
