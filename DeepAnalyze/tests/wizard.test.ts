import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";
import { detectEnvironment } from "../src/setup/environment.js";
import { runWizard, isSetupComplete } from "../src/setup/wizard.js";

describe("detectEnvironment", () => {
  test("returns cpu/memory/disk", async () => {
    const r = await detectEnvironment();
    expect(r.cpu.cores).toBeGreaterThan(0);
    expect(r.memory.totalGb).toBeGreaterThan(0);
    expect(r.disk.availableGb).toBeGreaterThanOrEqual(0);
  });

  test("existing models is array", async () => {
    const r = await detectEnvironment();
    expect(Array.isArray(r.existingModels)).toBe(true);
  });

  test("network report has required fields", async () => {
    const r = await detectEnvironment();
    expect(typeof r.network.huggingFace).toBe("boolean");
    expect(typeof r.network.hfMirror).toBe("boolean");
  });

  test("gpu report has available flag", async () => {
    const r = await detectEnvironment();
    expect(typeof r.gpu.available).toBe("boolean");
  });

  test("hfCacheHits is array", async () => {
    const r = await detectEnvironment();
    expect(Array.isArray(r.hfCacheHits)).toBe(true);
  });
});

describe("runWizard", () => {
  test("personal + none mode", () => {
    const r = runWizard({
      environment: {} as any,
      mode: "personal", authChoice: "none",
      modelStrategy: "all_cloud", modelSource: "auto",
      providerKeys: {},
    });
    expect(r.configYaml).toContain("source: auto");
    expect(r.envVars.DA_AUTH_MODE).toBe("none");
  });

  test("enterprise worker mode", () => {
    const r = runWizard({
      environment: {} as any,
      mode: "enterprise_worker",
      modelStrategy: "all_local", modelSource: "enterprise",
      hubUrl: "https://hub.corp.com", joinToken: "djt_xxx",
      providerKeys: {},
    });
    expect(r.envVars.DA_AUTH_MODE).toBe("hub");
    expect(r.envVars.DA_HUB_URL).toBe("https://hub.corp.com");
  });

  test("local mode", () => {
    const r = runWizard({
      environment: {} as any,
      mode: "personal", authChoice: "local",
      adminUsername: "admin", adminPassword: "test123",
      modelStrategy: "hybrid", modelSource: "hf_mirror",
      providerKeys: { openrouter: "sk-xxx" },
    });
    expect(r.envVars.DA_AUTH_MODE).toBe("local");
    expect(r.configYaml).toContain("openrouter: sk-xxx");
  });
});

// ===========================================================================
// G3: web-wizard-routes HTTP tests (appended)
// ===========================================================================
// Note: detectEnvironment, runWizard, isSetupComplete already imported above.
// We only add new imports here (saveConfig was not imported at top of file).

import { createSetupRoutes } from "../src/setup/web-wizard-routes.js";
import { saveConfig } from "../src/setup/wizard.js";
import { hashPassword } from "../src/services/auth/local-idp.js";
import { getRepos } from "../src/store/repos/index.js";
import { downloadModel } from "../src/services/model-downloader.js";

vi.mock("../src/setup/environment.js", () => ({
  detectEnvironment: vi.fn(async () => ({
    cpu: { cores: 8, model: "test" },
    memory: { totalGb: 16, availableGb: 8 },
    disk: { totalGb: 512, availableGb: 256 },
    gpu: { available: false, name: null },
    network: { huggingFace: true, hfMirror: false },
    existingModels: [],
    hfCacheHits: [],
  })),
}));

vi.mock("../src/setup/wizard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/setup/wizard.js")>();
  return {
    ...actual,
    // Wrap runWizard in a vi.fn that delegates to the real implementation
    // so G1/G2 tests still exercise real logic while G3 can assert it was called.
    runWizard: vi.fn(actual.runWizard),
    // saveConfig / isSetupComplete are fully mocked (side effects / file checks).
    saveConfig: vi.fn(async () => {}),
    isSetupComplete: vi.fn(() => false),
  };
});

vi.mock("../src/services/auth/local-idp.js", () => ({
  hashPassword: vi.fn(async (plain: string) => `hashed-${plain}`),
}));

vi.mock("../src/store/repos/index.js", () => ({
  getRepos: vi.fn(async () => ({
    settings: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    },
  })),
}));

vi.mock("../src/services/model-downloader.js", () => ({
  downloadModel: vi.fn(async () => {}),
}));

describe("setup routes", () => {
  let app: ReturnType<typeof createSetupRoutes>;
  // Shared mock objects so both the route handler and the test assertions
  // reference the same vi.fn instances.
  let settingsSetMock: ReturnType<typeof vi.fn>;
  let settingsGetMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    app = createSetupRoutes();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore mock implementations that clearAllMocks wipes
    vi.mocked(isSetupComplete).mockReturnValue(false);
    settingsSetMock = vi.fn(async () => {});
    settingsGetMock = vi.fn(async () => null);
    // Return the SAME settings object instance on every getRepos() call so
    // assertions on settings.set reflect calls made inside the route handler.
    vi.mocked(getRepos).mockImplementation(async () => ({
      settings: {
        get: settingsGetMock,
        set: settingsSetMock,
      },
    }) as any);
    vi.mocked(hashPassword).mockImplementation(async (plain: string) => `hashed-${plain}`);
  });

  test("GET /state returns complete flag", async () => {
    vi.mocked(isSetupComplete).mockReturnValue(false);
    const res = await app.request("/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ complete: false });
  });

  test("GET /state returns true when setup complete", async () => {
    vi.mocked(isSetupComplete).mockReturnValue(true);
    const res = await app.request("/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ complete: true });
  });

  test("GET /environment returns detection result", async () => {
    const res = await app.request("/environment");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cpu.cores).toBe(8);
    expect(body.network.huggingFace).toBe(true);
    expect(detectEnvironment).toHaveBeenCalled();
  });

  test("POST /complete rejects when already complete", async () => {
    vi.mocked(isSetupComplete).mockReturnValue(true);
    const res = await app.request("/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environment: {} as any,
        mode: "personal", authChoice: "none",
        modelStrategy: "all_cloud", modelSource: "auto",
        providerKeys: {},
      }),
    });
    expect(res.status).toBe(409);
  });

  test("POST /complete with personal/none applies config", async () => {
    const res = await app.request("/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environment: {} as any,
        mode: "personal", authChoice: "none",
        modelStrategy: "all_cloud", modelSource: "auto",
        providerKeys: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.envVars.DA_AUTH_MODE).toBe("none");
    expect(runWizard).toHaveBeenCalled();
    expect(saveConfig).toHaveBeenCalled();
    // local admin account NOT created (authChoice is none)
    expect(hashPassword).not.toHaveBeenCalled();
  });

  test("POST /complete with personal/local creates admin", async () => {
    const res = await app.request("/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environment: {} as any,
        mode: "personal", authChoice: "local",
        adminUsername: "admin", adminPassword: "secret123",
        modelStrategy: "hybrid", modelSource: "hf_mirror",
        providerKeys: {},
      }),
    });
    expect(res.status).toBe(200);
    expect(hashPassword).toHaveBeenCalledWith("secret123");
    expect(settingsSetMock).toHaveBeenCalledWith(
      "auth",
      JSON.stringify({ mode: "local", username: "admin", passwordHash: "hashed-secret123" }),
    );
  });

  test("POST /download triggers async download", async () => {
    const res = await app.request("/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "bge-m3", source: "hf_mirror" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(downloadModel).toHaveBeenCalled();
  });
});
