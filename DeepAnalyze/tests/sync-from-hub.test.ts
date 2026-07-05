// tests/sync-from-hub.test.ts — T15 lock-aware selective sync unit tests.
//
// Mocks:
//   - getRepos (settings repo)
//   - query (config_versions table)
//   - bumpConfigVersion (hot-reload trigger)
//   - getPool (for PgModuleStatesRepo construction)
//   - PgModuleStatesRepo (module state reads/writes)
//
// The `fetcher` parameter on syncConfigFromHub avoids the need to mock HubClient.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { shouldApplyField, syncConfigFromHub } from "../src/services/hub/sync-from-hub.js";

// ─── Mocks ────────────────────────────────────────────────────────────────
// Note: vi.mock is hoisted; module paths must use `.js` extension per DA convention.

vi.mock("../src/store/repos/index.js", () => ({
  getRepos: vi.fn(),
}));
vi.mock("../src/store/pg.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getPool: vi.fn(async () => ({})),
}));
vi.mock("../src/models/router.js", () => ({
  bumpConfigVersion: vi.fn(),
}));

// Mock PgModuleStatesRepo so module-state tests don't need a real pool.
// Must be a class (constructor function), not an arrow function.
const mockModuleGet = vi.fn(async () => null);
const mockModuleUpsert = vi.fn(async (s: any) => s);
vi.mock("../src/store/repos/module-states.js", () => ({
  PgModuleStatesRepo: class {
    get = mockModuleGet;
    upsert = mockModuleUpsert;
  },
}));

import { getRepos } from "../src/store/repos/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a fake settings repo with in-memory storage. */
function makeMockRepos(overrides: Record<string, any> = {}) {
  const store: Record<string, string | null> = { ...overrides };
  return {
    settings: {
      get: vi.fn(async (k: string) => store[k] ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
      saveProviderSettings: vi.fn(async (v: any) => {
        store["providers"] = JSON.stringify(v);
      }),
    },
  };
}

// ─── shouldApplyField ─────────────────────────────────────────────────────

describe("shouldApplyField", () => {
  test("locked field forces apply", () => {
    expect(shouldApplyField("providers", "local-val", "hub-val", ["providers"])).toBe(
      true,
    );
  });

  test("local null applies recommended", () => {
    expect(shouldApplyField("agentSettings", null, { x: 1 }, [])).toBe(true);
  });

  test("local non-null skips", () => {
    expect(shouldApplyField("hooks", [], [{ hook: 1 }], [])).toBe(false);
  });

  test("local null + locked still applies (locked wins)", () => {
    expect(shouldApplyField("doclingConfig", null, { x: 1 }, ["doclingConfig"])).toBe(
      true,
    );
  });
});

// ─── syncConfigFromHub ────────────────────────────────────────────────────

describe("syncConfigFromHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModuleGet.mockReset();
    mockModuleUpsert.mockReset();
    mockModuleGet.mockResolvedValue(null);
    mockModuleUpsert.mockResolvedValue({});
  });

  test("applies empty fields from template", async () => {
    const repos = makeMockRepos(); // all empty
    (getRepos as any).mockResolvedValue(repos);

    const fetcher = async () => ({
      version: "v1",
      updatedAt: new Date().toISOString(),
      providers: { providers: [], defaults: {} },
      agentSettings: { temperature: 0.7 },
    });
    const result = await syncConfigFromHub(fetcher);
    expect(result.appliedFields).toContain("providers");
    expect(result.appliedFields).toContain("agentSettings");
    expect(result.skippedFields).toEqual([]);
  });

  test("skips fields that already have local values (non-locked)", async () => {
    const repos = makeMockRepos({
      providers: JSON.stringify({ providers: [], defaults: { main: "p1" } }),
      agent_settings: JSON.stringify({ temperature: 0.5 }),
    });
    (getRepos as any).mockResolvedValue(repos);

    const fetcher = async () => ({
      version: "v1",
      updatedAt: new Date().toISOString(),
      providers: { providers: [], defaults: { main: "p2" } },
      agentSettings: { temperature: 0.9 },
    });
    const result = await syncConfigFromHub(fetcher);
    expect(result.skippedFields).toContain("providers");
    expect(result.skippedFields).toContain("agentSettings");
    expect(result.appliedFields).toEqual([]);
  });

  test("locked fields force-apply even when local has value", async () => {
    const repos = makeMockRepos({
      agent_settings: JSON.stringify({ temperature: 0.5 }),
    });
    (getRepos as any).mockResolvedValue(repos);

    const fetcher = async () => ({
      version: "v1",
      updatedAt: new Date().toISOString(),
      agentSettings: { temperature: 0.99 },
      fieldLocks: { lockedPaths: ["agentSettings"] },
    });
    const result = await syncConfigFromHub(fetcher);
    expect(result.appliedFields).toContain("agentSettings");
  });

  test("null template returns empty result", async () => {
    const fetcher = async () => null;
    const result = await syncConfigFromHub(fetcher);
    expect(result.appliedFields).toEqual([]);
    expect(result.skippedFields).toEqual([]);
  });

  test("moduleStates: applies when local missing", async () => {
    const repos = makeMockRepos();
    (getRepos as any).mockResolvedValue(repos);
    mockModuleGet.mockResolvedValue(null);

    const fetcher = async () => ({
      version: "v1",
      updatedAt: new Date().toISOString(),
      moduleStates: {
        mineru: { status: "installed", mode: "remote", endpoint: "http://m:8705" },
      },
    });
    const result = await syncConfigFromHub(fetcher);
    expect(result.appliedFields).toContain("moduleStates.mineru");
    expect(mockModuleUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleId: "mineru",
        remoteEndpoint: "http://m:8705",
      }),
    );
  });

  test("moduleStates: skips when local has installed module (non-locked)", async () => {
    const repos = makeMockRepos();
    (getRepos as any).mockResolvedValue(repos);
    mockModuleGet.mockResolvedValue({
      moduleId: "mineru",
      status: "installed",
      mode: "local",
      configVersion: 1,
    });

    const fetcher = async () => ({
      version: "v1",
      updatedAt: new Date().toISOString(),
      moduleStates: {
        mineru: { status: "installed", mode: "remote", endpoint: "http://m:8705" },
      },
    });
    const result = await syncConfigFromHub(fetcher);
    expect(result.skippedFields).toContain("moduleStates.mineru");
    expect(mockModuleUpsert).not.toHaveBeenCalled();
  });
});
