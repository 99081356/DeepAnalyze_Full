import { test, expect } from "@playwright/test";

test.describe("API Health", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const resp = await request.get("/api/health");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});

test.describe("Knowledge Base API", () => {
  test("lists knowledge bases", async ({ request }) => {
    const resp = await request.get("/api/knowledge/kbs");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.knowledgeBases).toBeDefined();
    expect(Array.isArray(body.knowledgeBases)).toBeTruthy();
  });

  test("global search accepts queries", async ({ request }) => {
    const resp = await request.get("/api/knowledge/search?q=test&limit=5");
    expect(resp.status()).toBe(200);
  });

  test("KB-specific search works with correct param", async ({ request }) => {
    // Get first KB
    const kbsResp = await request.get("/api/knowledge/kbs");
    const kbs = await kbsResp.json();
    if (kbs.knowledgeBases.length > 0) {
      const kbId = kbs.knowledgeBases[0].id;
      const resp = await request.get(`/api/knowledge/${kbId}/search?query=test&topK=3`);
      expect(resp.status()).toBe(200);
    }
  });
});

test.describe("Settings API", () => {
  test("returns agent settings", async ({ request }) => {
    const resp = await request.get("/api/settings/agent");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.maxTurns).toBeDefined();
    expect(body.contextWindow).toBeDefined();
  });

  test("returns providers list", async ({ request }) => {
    const resp = await request.get("/api/settings/providers");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBeTruthy();
  });

  test("returns defaults", async ({ request }) => {
    const resp = await request.get("/api/settings/defaults");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.main).toBeDefined();
  });
});

test.describe("Sessions API", () => {
  test("lists sessions", async ({ request }) => {
    const resp = await request.get("/api/sessions");
    expect(resp.status()).toBe(200);
  });
});

test.describe("Cron API", () => {
  test("lists cron jobs", async ({ request }) => {
    const resp = await request.get("/api/cron/jobs");
    expect(resp.status()).toBe(200);
  });
});
