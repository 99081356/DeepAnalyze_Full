import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createSettingsRoutes } from "../src/server/routes/settings.js";

// In-memory settings mock (same pattern as tests/auth.test.ts)
const memSettings = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/store/repos/index.js", () => ({
  getRepos: vi.fn(async () => ({
    settings: {
      get: async (key: string) => memSettings.get(key) ?? null,
      set: async (key: string, value: string) => { memSettings.set(key, value); },
      getProviderSettings: async () => ({ providers: [], defaults: {} }),
      saveProviderSettings: async () => {},
    },
  })),
}));

// Stub globalThis.__hubClient so tests are deterministic
beforeEach(() => {
  memSettings.clear();
  (globalThis as any).__hubClient = undefined;
});

afterEach(() => {
  (globalThis as any).__hubClient = undefined;
});

describe("GET /api/settings/auth", () => {
  test("returns default mode when no settings stored", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/auth");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("mode");
  });

  test("returns stored settings after PUT", async () => {
    const routes = createSettingsRoutes();
    await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customField: "value123" }),
    });
    const res = await routes.request("/auth");
    const data = await res.json();
    expect(data.customField).toBe("value123");
  });
});

describe("PUT /api/settings/auth — merge behavior", () => {
  test("merges with existing settings, not replace", async () => {
    const routes = createSettingsRoutes();
    await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field1: "a" }),
    });
    await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field2: "b" }),
    });
    const res = await routes.request("/auth");
    const data = await res.json();
    expect(data.field1).toBe("a");
    expect(data.field2).toBe("b");
  });
});

describe("GET /api/settings/hub", () => {
  test("returns disconnected by default", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/hub");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.connected).toBe(false);
  });
});

describe("POST /api/settings/hub/connect", () => {
  test("stores connection settings", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/hub/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl: "http://hub.example.com:22000", joinToken: "tok123" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify stored
    const hubRes = await routes.request("/hub");
    const hubData = await hubRes.json();
    expect(hubData.connected).toBe(true);
    expect(hubData.hubUrl).toBe("http://hub.example.com:22000");
  });

  test("calls HubClient.connectToHub if method exists", async () => {
    const mockClient = {
      connectToHub: vi.fn().mockResolvedValue({ registered: true }),
      isConnected: vi.fn().mockReturnValue(true),
    };
    (globalThis as any).__hubClient = mockClient;

    const routes = createSettingsRoutes();
    const res = await routes.request("/hub/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl: "http://hub.example.com:22000", joinToken: "tok123" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.registered).toBe(true);
    expect(mockClient.connectToHub).toHaveBeenCalledWith("http://hub.example.com:22000", "tok123");
  });

  test("returns error when connectToHub throws", async () => {
    const mockClient = {
      connectToHub: vi.fn().mockRejectedValue(new Error("connection refused")),
    };
    (globalThis as any).__hubClient = mockClient;

    const routes = createSettingsRoutes();
    const res = await routes.request("/hub/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl: "http://bad.example.com", joinToken: "tok" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("connection refused");
  });
});

describe("POST /api/settings/hub/disconnect", () => {
  test("clears connection settings", async () => {
    const routes = createSettingsRoutes();
    // Connect first
    await routes.request("/hub/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl: "http://hub.example.com", joinToken: "tok" }),
    });
    // Disconnect
    const res = await routes.request("/hub/disconnect", { method: "POST" });
    expect(res.status).toBe(200);
    // Verify
    const hubRes = await routes.request("/hub");
    const hubData = await hubRes.json();
    expect(hubData.connected).toBe(false);
  });

  test("calls HubClient.disconnectFromHub if method exists", async () => {
    const mockClient = {
      disconnectFromHub: vi.fn().mockResolvedValue(undefined),
    };
    (globalThis as any).__hubClient = mockClient;

    const routes = createSettingsRoutes();
    await routes.request("/hub/disconnect", { method: "POST" });
    expect(mockClient.disconnectFromHub).toHaveBeenCalled();
  });
});

// ===========================================================================
// C1 regression: PUT /api/settings/auth must reject sensitive field overwrite
// ===========================================================================
describe("PUT /api/settings/auth — sensitive field protection (C1)", () => {
  test("rejects passwordHash overwrite with 400", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passwordHash: "$2b$10$attackercontrolledhash" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("passwordHash");
  });

  test("rejects password overwrite with 400", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "newpass123" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects mode overwrite with 400", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "none" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects username overwrite with 400", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attacker" }),
    });
    expect(res.status).toBe(400);
  });

  test("still allows non-sensitive fields after whitelist fix", async () => {
    const routes = createSettingsRoutes();
    const res = await routes.request("/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwtExpiry: 3600 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.settings.jwtExpiry).toBe(3600);
  });
});

// ===========================================================================
// C2 regression: GET /api/settings/hub must not leak workerToken
// ===========================================================================
describe("GET /api/settings/hub — workerToken redaction (C2)", () => {
  test("response does not contain workerToken field", async () => {
    // Seed hub_connection with a workerToken in the settings store
    memSettings.set("hub_connection", JSON.stringify({
      connected: true,
      hubUrl: "http://hub.example.com:22000",
      workerId: "worker-123",
      workerToken: "secret-token-should-not-leak",
      connectedAt: "2026-01-01T00:00:00.000Z",
    }));

    const routes = createSettingsRoutes();
    const res = await routes.request("/hub");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workerToken).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("secret-token-should-not-leak");
    // Should still have safe fields
    expect(data.connected).toBe(true);
    expect(data.hubUrl).toBe("http://hub.example.com:22000");
    expect(data.workerId).toBe("worker-123");
  });
});
