// tests/hub-config-sync.test.ts — T16 lock-aware config sync routes.
//
// Pattern follows tests/settings-auth.test.ts:1-29 — direct createHubRoutes()
// + vi.mock for the route's service dependencies. No createDATestApp helper.
//
// Mocks:
//   - syncConfigFromHub (so the route uses the stub)
//   - query (config_versions table read)
// Plus a globalThis.__hubClient stub so getHubClient() works.

import { describe, test, expect, vi, beforeEach, afterAll } from "vitest";

// Mock sync-from-hub BEFORE importing the route (so the route picks up the mock).
vi.mock("../src/services/hub/sync-from-hub.js", () => ({
  syncConfigFromHub: vi.fn(),
  shouldAutoSyncOnFirstBuild: vi.fn(async () => false),
  maybeAutoSyncOnStartup: vi.fn(async () => undefined),
  shouldApplyField: vi.fn(),
}));
vi.mock("../src/store/pg.js", () => ({
  query: vi.fn(),
  getPool: vi.fn(async () => ({})),
}));

import { createHubRoutes } from "../src/server/routes/hub.js";
import { syncConfigFromHub } from "../src/services/hub/sync-from-hub.js";
import { query } from "../src/store/pg.js";

// HubClient singleton stub — the route accesses globalThis.__hubClient via getHubClient().
const mockHubClient = {
  fetchMergedTemplate: vi.fn(),
};
(globalThis as any).__hubClient = mockHubClient;

const prevAuthMode = process.env.DA_AUTH_MODE;

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  if (prevAuthMode === undefined) {
    delete process.env.DA_AUTH_MODE;
  } else {
    process.env.DA_AUTH_MODE = prevAuthMode;
  }
  (globalThis as any).__hubClient = mockHubClient;
});

describe("POST /api/hub/config/sync-from-hub", () => {
  test("returns sync result when DA_AUTH_MODE=hub", async () => {
    process.env.DA_AUTH_MODE = "hub";
    const expectedResult = { appliedFields: ["providers"], skippedFields: [] };
    (syncConfigFromHub as any).mockResolvedValue(expectedResult);

    const app = createHubRoutes();
    const res = await app.request("/config/sync-from-hub", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expectedResult);
    expect(syncConfigFromHub).toHaveBeenCalled();
  });

  test("returns 400 when DA_AUTH_MODE != hub", async () => {
    process.env.DA_AUTH_MODE = "local";
    const app = createHubRoutes();
    const res = await app.request("/config/sync-from-hub", { method: "POST" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("hub mode");
    expect(syncConfigFromHub).not.toHaveBeenCalled();
  });

  test("returns 500 when syncConfigFromHub throws", async () => {
    process.env.DA_AUTH_MODE = "hub";
    (syncConfigFromHub as any).mockRejectedValue(new Error("hub unreachable"));

    const app = createHubRoutes();
    const res = await app.request("/config/sync-from-hub", { method: "POST" });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("hub unreachable");
  });

  test("passes hubClient.fetchMergedTemplate as fetcher", async () => {
    process.env.DA_AUTH_MODE = "hub";
    (syncConfigFromHub as any).mockResolvedValue({ appliedFields: [], skippedFields: [] });

    const app = createHubRoutes();
    await app.request("/config/sync-from-hub", { method: "POST" });

    // The fetcher passed to syncConfigFromHub should be a function
    const fetcherArg = (syncConfigFromHub as any).mock.calls[0][0];
    expect(typeof fetcherArg).toBe("function");
    // Calling it should delegate to mockHubClient.fetchMergedTemplate
    await fetcherArg();
    expect(mockHubClient.fetchMergedTemplate).toHaveBeenCalled();
  });
});

describe("GET /api/hub/config/sync-status", () => {
  test("returns mode + last_hub_sync_at from config_versions", async () => {
    process.env.DA_AUTH_MODE = "hub";
    const ts = "2026-07-04T10:00:00Z";
    (query as any).mockResolvedValue({ rows: [{ last_hub_sync_at: ts }] });

    const app = createHubRoutes();
    const res = await app.request("/config/sync-status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("hub");
    expect(body.last_hub_sync_at).toBe(ts);
  });

  test("returns null when never synced", async () => {
    process.env.DA_AUTH_MODE = "local";
    (query as any).mockResolvedValue({ rows: [] });

    const app = createHubRoutes();
    const res = await app.request("/config/sync-status");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("local");
    expect(body.last_hub_sync_at).toBeNull();
  });
});
