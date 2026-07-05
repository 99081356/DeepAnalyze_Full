import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// In-memory settings store mock (auth routes call getRepos().settings).
const memSettings = vi.hoisted(() => new Map<string, string>());

vi.mock("../src/store/repos/index.js", () => ({
  getRepos: vi.fn(async () => ({
    settings: {
      get: async (key: string) => memSettings.get(key) ?? null,
      set: async (key: string, value: string) => {
        memSettings.set(key, value);
      },
    },
  })),
}));

// Mock sso-client before importing the route
vi.mock("../src/services/auth/sso-client.js", () => ({
  exchangeTicketWithHub: vi.fn(),
}));

// Mock hub-jwks verifyHubJwt
vi.mock("../src/services/auth/hub-jwks.js", () => ({
  verifyHubJwt: vi.fn(),
  proxyHubLogin: vi.fn(),
}));

// Mock local-session signLocalSession
vi.mock("../src/services/auth/local-session.js", () => ({
  signLocalSession: vi.fn(),
}));

// Mock worker-id
vi.mock("../src/services/hub/worker-identity.js", () => ({
  getOrCreateWorkerId: vi.fn().mockReturnValue("test-worker-id"),
}));

import { exchangeTicketWithHub } from "../src/services/auth/sso-client.js";
import { verifyHubJwt } from "../src/services/auth/hub-jwks.js";
import { signLocalSession } from "../src/services/auth/local-session.js";
import { createAuthRoutes } from "../src/server/routes/auth.js";

describe("GET /api/auth/sso/callback", () => {
  let origHubUrl: string | undefined;
  let origAuthMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    memSettings.clear();
    origHubUrl = process.env.DA_HUB_URL;
    origAuthMode = process.env.DA_AUTH_MODE;
    process.env.DA_HUB_URL = "http://hub.test";
    process.env.DA_AUTH_MODE = "none"; // avoid hub-mode redirect on /login fallback
  });

  afterEach(() => {
    if (origHubUrl === undefined) delete process.env.DA_HUB_URL;
    else process.env.DA_HUB_URL = origHubUrl;
    if (origAuthMode === undefined) delete process.env.DA_AUTH_MODE;
    else process.env.DA_AUTH_MODE = origAuthMode;
  });

  test("缺少 ticket 重定向到 /login?err=no_ticket", async () => {
    const app = new Hono();
    app.route("/api/auth", createAuthRoutes());
    const res = await app.request("/api/auth/sso/callback");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?err=no_ticket");
  });

  test("exchange 失败重定向 /login?err=exchange_failed", async () => {
    vi.mocked(exchangeTicketWithHub).mockResolvedValue(null);
    const app = new Hono();
    app.route("/api/auth", createAuthRoutes());
    const res = await app.request("/api/auth/sso/callback?hub_ticket=sst_xxx");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("exchange_failed");
  });

  test("verifyHubJwt 失败重定向 /login?err=invalid_token", async () => {
    vi.mocked(exchangeTicketWithHub).mockResolvedValue({
      accessToken: "fake-token",
      user: { id: "u1", displayName: "Alice", organizationId: "o1" },
    });
    vi.mocked(verifyHubJwt).mockResolvedValue(null);
    const app = new Hono();
    app.route("/api/auth", createAuthRoutes());
    const res = await app.request("/api/auth/sso/callback?hub_ticket=sst_xxx");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("invalid_token");
  });

  test("成功路径设置 cookie + 重定向 /", async () => {
    vi.mocked(exchangeTicketWithHub).mockResolvedValue({
      accessToken: "fake-token",
      user: { id: "u1", displayName: "Alice", organizationId: "o1" },
    });
    vi.mocked(verifyHubJwt).mockResolvedValue({
      id: "u1",
      name: "Alice",
      source: "hub",
      orgId: "o1",
    });
    vi.mocked(signLocalSession).mockResolvedValue("fake-session-jwt");

    const app = new Hono();
    app.route("/api/auth", createAuthRoutes());
    const res = await app.request("/api/auth/sso/callback?hub_ticket=sst_xxx");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("da_session=fake-session-jwt");
    expect(setCookie).toContain("HttpOnly");

    // Verify signLocalSession received the correct payload derived from hubUser
    expect(signLocalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: "u1",
        name: "Alice",
        orgId: "o1",
      }),
    );
  });
});
