// tests/health-probe.test.ts
// Vitest test for src/services/modules/health-probe.ts + probes/index.ts
// Mocks:
//   - fetch via vi.stubGlobal (vitest API, NOT bun:test mock.global.fetch)
//   - _helpers, paddleocr-vl-manager, glm-ocr-manager, store/pg via vi.mock
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock _helpers + container managers + pg BEFORE importing probe code.
// vi.mock hoists automatically, but writing it before imports is the conventional form.
vi.mock("../src/services/modules/probes/_helpers.js", () => ({
  loadModuleState: vi.fn(),
  unknownHealth: vi.fn((mode) => ({
    status: "unknown",
    mode: mode ?? "disabled",
    last_check_at: "1970-01-01T00:00:00.000Z",
  })),
}));
vi.mock("../src/services/paddleocr-vl-manager.js", () => ({
  getVlmContainerStatus: vi.fn(),
}));
vi.mock("../src/server/glm-ocr-manager.js", () => ({
  getGlmOcrStatus: vi.fn(),
}));
vi.mock("../src/store/pg.js", () => ({
  query: vi.fn(),
}));

import { probeHttp, probeTcp } from "../src/services/modules/health-probe.js";
import { probeAllModules } from "../src/services/modules/probes/index.js";
import { probePg } from "../src/services/modules/probes/pg.js";
import { loadModuleState } from "../src/services/modules/probes/_helpers.js";
import { getVlmContainerStatus } from "../src/services/paddleocr-vl-manager.js";
import { getGlmOcrStatus } from "../src/server/glm-ocr-manager.js";
import { query } from "../src/store/pg.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeHttp", () => {
  it("returns healthy on 200 OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const h = await probeHttp({ url: "http://x/health", mode: "local" });
    expect(h.status).toBe("healthy");
    expect(h.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns degraded on 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const h = await probeHttp({ url: "http://x/health", mode: "remote" });
    expect(h.status).toBe("degraded");
  });

  it("returns down on network error with last_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const h = await probeHttp({ url: "http://x/health", mode: "local" });
    expect(h.status).toBe("down");
    expect(h.last_error).toContain("ECONNREFUSED");
  });

  it("returns down on timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      // Simulate abort signal firing
      init?.signal?.dispatchEvent(new Event("abort"));
      throw new Error("The operation was aborted");
    }));
    const h = await probeHttp({ url: "http://x/health", mode: "local", timeoutMs: 50 });
    expect(h.status).toBe("down");
  });
});

describe("probeTcp", () => {
  it("returns healthy or down for localhost port (env-dependent)", async () => {
    // Pick an unused high port — expect down
    const h = await probeTcp({ host: "127.0.0.1", port: 65530, mode: "local", timeoutMs: 200 });
    expect(["healthy", "down"]).toContain(h.status);
  });
});

describe("probePg", () => {
  it("returns healthy when SELECT 1 succeeds", async () => {
    (query as any).mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const h = await probePg();
    expect(h.status).toBe("healthy");
    expect(h.mode).toBe("local");
  });

  it("returns down when query throws", async () => {
    (query as any).mockRejectedValue(new Error("connection refused"));
    const h = await probePg();
    expect(h.status).toBe("down");
    expect(h.last_error).toContain("connection refused");
  });
});

describe("probeAllModules", () => {
  it("returns 7 health entries when all probes succeed", async () => {
    // Stub loadModuleState to return "installed running" for all 4 modules
    (loadModuleState as any).mockResolvedValue({
      moduleId: "embedding",
      status: "running",
      mode: "local",
      processType: "subprocess",
      configVersion: 1,
    });
    // Verified actual return shapes:
    // VlmContainerInfo: { status, containerId?, port (always), healthUrl, error? }
    (getVlmContainerStatus as any).mockResolvedValue({
      status: "running",
      port: 8600,
      healthUrl: "http://localhost:8600/health",
    });
    // GlmOcrInfo: same shape (no 'starting' state, port always present)
    (getGlmOcrStatus as any).mockResolvedValue({
      status: "running",
      port: 8601,
      healthUrl: "http://localhost:8601/health",
    });
    (query as any).mockResolvedValue({ rows: [{ "?column?": 1 }] });

    // Stub fetch for the 4 module HTTP probes
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));

    const map = await probeAllModules();
    expect(Object.keys(map).length).toBe(7);
    expect(map.embedding).toBeDefined();
    expect(map.asr).toBeDefined();
    expect(map.docling).toBeDefined();
    expect(map.mineru).toBeDefined();
    expect(map.paddleocrVl).toBeDefined();
    expect(map.glmOcr).toBeDefined();
    expect(map.pg).toBeDefined();
  });

  it("omits keys for probes that reject", async () => {
    // Force the 4 module probes to reject by making loadModuleState throw.
    // probePg / probePaddleocrVl / probeGlmOcr catch their own errors internally,
    // so they will still return a (down) ModuleHealth — only the 4 module probes
    // (which await loadModuleState directly without try/catch) will reject.
    (loadModuleState as any).mockRejectedValue(new Error("pool unavailable"));
    (getVlmContainerStatus as any).mockResolvedValue({
      status: "running",
      port: 8600,
      healthUrl: "http://localhost:8600/health",
    });
    (getGlmOcrStatus as any).mockResolvedValue({
      status: "running",
      port: 8601,
      healthUrl: "http://localhost:8601/health",
    });
    (query as any).mockResolvedValue({ rows: [] });

    const map = await probeAllModules();
    // 4 module probes should be omitted (loadModuleState rejected); 3 others succeed
    expect(map.embedding).toBeUndefined();
    expect(map.asr).toBeUndefined();
    expect(map.docling).toBeUndefined();
    expect(map.mineru).toBeUndefined();
    expect(map.paddleocrVl).toBeDefined();   // container manager still worked
    expect(map.glmOcr).toBeDefined();
    expect(map.pg).toBeDefined();
  });
});
