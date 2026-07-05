import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  authMiddleware,
  getAuthMode,
  _resetAuthModeCache,
  PUBLIC_AUTH_PATHS,
} from "../src/server/middleware/auth.js";
import {
  signLocalJwt,
  verifyLocalJwt,
  hashPassword,
  verifyPassword,
} from "../src/services/auth/local-idp.js";
import { refreshHubJwks, verifyHubJwt } from "../src/services/auth/hub-jwks.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

// In-memory settings store for auth route tests.
// vi.hoisted ensures the Map exists before vi.mock's factory runs (vitest hoists vi.mock).
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

// Import createAuthRoutes AFTER the mock (vitest resolves imports after hoisting mocks)
import { createAuthRoutes } from "../src/server/routes/auth.js";
import { getRepos } from "../src/store/repos/index.js";

describe("authMiddleware - none mode", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.DA_AUTH_MODE;
    delete process.env.DA_AUTH_MODE;
    _resetAuthModeCache(); // CRITICAL: clear module-level cache between tests
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.DA_AUTH_MODE = originalMode;
    else delete process.env.DA_AUTH_MODE;
  });

  test("none mode sets ctx.user to default-user", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ user: c.get("user") }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({
      id: "default-user",
      name: "anonymous",
      source: "anonymous",
    });
  });

  test("getAuthMode returns none when env unset", () => {
    expect(getAuthMode()).toBe("none");
  });

  test("getAuthMode returns explicit value when env set", () => {
    process.env.DA_AUTH_MODE = "local";
    expect(getAuthMode()).toBe("local");
  });
});

describe("authMiddleware - local mode", () => {
  let originalMode: string | undefined;
  let originalAuthDir: string | undefined;

  beforeEach(() => {
    originalMode = process.env.DA_AUTH_MODE;
    originalAuthDir = process.env.DA_AUTH_DIR;
    process.env.DA_AUTH_MODE = "local";
    process.env.DA_AUTH_DIR = "/tmp/da-test-auth";
    _resetAuthModeCache();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.DA_AUTH_MODE = originalMode;
    else delete process.env.DA_AUTH_MODE;
    if (originalAuthDir !== undefined) process.env.DA_AUTH_DIR = originalAuthDir;
    else delete process.env.DA_AUTH_DIR;
  });

  test("hashPassword and verifyPassword round-trip", async () => {
    const hash = await hashPassword("test-pass-123");
    expect(hash).not.toBe("test-pass-123");
    expect(await verifyPassword("test-pass-123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("sign and verify local JWT", async () => {
    const token = await signLocalJwt("usr-admin", "admin");
    expect(token.split(".")).toHaveLength(3);

    const user = await verifyLocalJwt(token);
    expect(user).not.toBeNull();
    expect(user?.id).toBe("usr-admin");
    expect(user?.name).toBe("admin");
    expect(user?.source).toBe("local");
  });

  test("middleware rejects missing token in local mode", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  test("middleware accepts valid local token", async () => {
    const token = await signLocalJwt("usr-admin", "admin");

    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ user: c.get("user") }));

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe("usr-admin");
  });
});

describe("authMiddleware - hub mode", () => {
  let originalMode: string | undefined;
  let originalHubUrl: string | undefined;
  let originalAuthDir: string | undefined;

  beforeEach(() => {
    originalMode = process.env.DA_AUTH_MODE;
    originalHubUrl = process.env.DA_HUB_URL;
    originalAuthDir = process.env.DA_AUTH_DIR;
    process.env.DA_AUTH_MODE = "hub";
    process.env.DA_HUB_URL = "http://mock-hub:22000";
    process.env.DA_AUTH_DIR = "/tmp/da-test-auth";
    _resetAuthModeCache();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.DA_AUTH_MODE = originalMode;
    else delete process.env.DA_AUTH_MODE;
    if (originalHubUrl !== undefined) process.env.DA_HUB_URL = originalHubUrl;
    else delete process.env.DA_HUB_URL;
    if (originalAuthDir !== undefined) process.env.DA_AUTH_DIR = originalAuthDir;
    else delete process.env.DA_AUTH_DIR;
  });

  test("verifyHubJwt accepts token signed by Hub key", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const pubJwk = await exportJWK(publicKey);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/auth/jwks.json")) {
        return new Response(JSON.stringify({
          keys: [{ ...pubJwk, kid: "hub-test-kid", kty: "RSA", alg: "RS256", use: "sig" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    }) as any;

    try {
      await refreshHubJwks();

      const token = await new SignJWT({ name: "alice", source: "hub", org_id: "org_x" })
        .setProtectedHeader({ alg: "RS256", kid: "hub-test-kid" })
        .setIssuer(process.env.DA_HUB_URL)
        .setSubject("usr_alice")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);

      const user = await verifyHubJwt(token);
      expect(user).not.toBeNull();
      expect(user?.id).toBe("usr_alice");
      expect(user?.orgId).toBe("org_x");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ===========================================================================
// B1: Auth API routes — setup / login / logout / me
// ===========================================================================
describe("POST /api/auth (local mode)", () => {
  let originalMode: string | undefined;
  let originalAuthDir: string | undefined;

  beforeEach(() => {
    originalMode = process.env.DA_AUTH_MODE;
    originalAuthDir = process.env.DA_AUTH_DIR;
    process.env.DA_AUTH_MODE = "local";
    process.env.DA_AUTH_DIR = "/tmp/da-test-auth";
    _resetAuthModeCache();
    memSettings.clear();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.DA_AUTH_MODE = originalMode;
    else delete process.env.DA_AUTH_MODE;
    if (originalAuthDir !== undefined) process.env.DA_AUTH_DIR = originalAuthDir;
    else delete process.env.DA_AUTH_DIR;
  });

  test("setup + login flow", async () => {
    const routes = createAuthRoutes();

    // Setup
    let res = await routes.request("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    expect(res.status).toBe(200);

    // Login with correct credentials
    res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.expires_in).toBe(7 * 24 * 3600);

    // Login with wrong password
    res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(res.status).toBe(401);

    // Setup again — should be 409
    res = await routes.request("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin2", password: "test456" }),
    });
    expect(res.status).toBe(409);
  });

  test("setup rejects short passwords", async () => {
    const routes = createAuthRoutes();
    const res = await routes.request("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "12345" }),
    });
    expect(res.status).toBe(400);
  });

  test("login before setup returns 400", async () => {
    const routes = createAuthRoutes();
    const res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    expect(res.status).toBe(400);
  });

  test("auth middleware bypasses /api/auth/login in local mode", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.post("/api/auth/login", (c) => c.json({ ok: true }));

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "x", password: "x" }),
    });
    expect(res.status).toBe(200);
  });

  test("auth middleware bypasses /api/auth/setup in local mode", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.post("/api/auth/setup", (c) => c.json({ ok: true }));

    const res = await app.request("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "x", password: "x" }),
    });
    expect(res.status).toBe(200);
  });

  test("GET /mode returns current auth mode", async () => {
    const routes = createAuthRoutes();
    const res = await routes.request("/mode");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("local");
  });

  test("auth middleware bypasses /api/auth/mode", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/api/auth/mode", (c) => c.json({ mode: "local" }));

    const res = await app.request("/api/auth/mode");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("local");
  });

  test("change-password flow", async () => {
    const routes = createAuthRoutes();

    // Setup first
    await routes.request("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });

    // Wrong current password
    let res = await routes.request("/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: "wrong", next: "newpass1" }),
    });
    expect(res.status).toBe(401);

    // Correct current password
    res = await routes.request("/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: "test123", next: "newpass1" }),
    });
    expect(res.status).toBe(200);

    // Login with new password
    res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "newpass1" }),
    });
    expect(res.status).toBe(200);

    // Old password should fail
    res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// I1: change-password middleware integration tests
// ===========================================================================
describe("change-password middleware integration (I1)", () => {
  let originalMode: string | undefined;
  let originalAuthDir: string | undefined;

  beforeEach(() => {
    originalMode = process.env.DA_AUTH_MODE;
    originalAuthDir = process.env.DA_AUTH_DIR;
    process.env.DA_AUTH_MODE = "local";
    process.env.DA_AUTH_DIR = "/tmp/da-test-auth";
    _resetAuthModeCache();
    memSettings.clear();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.DA_AUTH_MODE = originalMode;
    else delete process.env.DA_AUTH_MODE;
    if (originalAuthDir !== undefined) process.env.DA_AUTH_DIR = originalAuthDir;
    else delete process.env.DA_AUTH_DIR;
  });

  test("/api/auth/change-password is NOT in PUBLIC_AUTH_PATHS", () => {
    expect(PUBLIC_AUTH_PATHS.has("/api/auth/change-password")).toBe(false);
  });

  test("full middleware stack rejects unauthenticated change-password request", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.post("/api/auth/change-password", (c) => c.json({ ok: true }));

    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: "x", next: "y" }),
    });
    expect(res.status).toBe(401);
  });

  test("full middleware stack accepts authenticated change-password request", async () => {
    // Setup credentials first via routes (no middleware)
    const routes = createAuthRoutes();
    await routes.request("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    // Login to get a valid token
    const loginRes = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    const { access_token } = await loginRes.json();

    // Build app with full middleware + change-password route
    const app = new Hono();
    app.use("*", authMiddleware);
    app.post("/api/auth/change-password", async (c) => {
      const body = await c.req.json<{ current: string; next: string }>();
      // Reuse the same auth settings verification logic
      const repo = (await getRepos()).settings;
      const raw = await repo.get("auth");
      const settings = raw ? JSON.parse(raw) : {};
      const ok = await verifyPassword(body.current, settings.passwordHash);
      if (!ok) return c.json({ error: "current password incorrect" }, 401);
      const newHash = await hashPassword(body.next);
      await repo.set("auth", JSON.stringify({ ...settings, passwordHash: newHash }));
      return c.json({ ok: true });
    });

    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({ current: "test123", next: "newpass1" }),
    });
    expect(res.status).toBe(200);
  });

  test("full middleware stack rejects change-password with wrong current password", async () => {
    const routes = createAuthRoutes();
    await routes.request("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    const loginRes = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    const { access_token } = await loginRes.json();

    const app = new Hono();
    app.use("*", authMiddleware);
    app.post("/api/auth/change-password", async (c) => {
      const body = await c.req.json<{ current: string; next: string }>();
      const repo = (await getRepos()).settings;
      const raw = await repo.get("auth");
      const settings = raw ? JSON.parse(raw) : {};
      const ok = await verifyPassword(body.current, settings.passwordHash);
      if (!ok) return c.json({ error: "current password incorrect" }, 401);
      return c.json({ ok: true });
    });

    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({ current: "wrongpassword", next: "newpass1" }),
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// I2: Emergency-reset expiresAt enforcement
// ===========================================================================
describe("emergency-admin expiresAt enforcement (I2)", () => {
  let originalMode: string | undefined;
  let originalAuthDir: string | undefined;

  beforeEach(() => {
    originalMode = process.env.DA_AUTH_MODE;
    originalAuthDir = process.env.DA_AUTH_DIR;
    process.env.DA_AUTH_MODE = "local";
    process.env.DA_AUTH_DIR = "/tmp/da-test-auth";
    _resetAuthModeCache();
    memSettings.clear();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.DA_AUTH_MODE = originalMode;
    else delete process.env.DA_AUTH_MODE;
    if (originalAuthDir !== undefined) process.env.DA_AUTH_DIR = originalAuthDir;
    else delete process.env.DA_AUTH_DIR;
  });

  test("login with expired emergency credentials is rejected", async () => {
    const routes = createAuthRoutes();

    // Seed auth settings with an already-expired emergency admin
    const hash = await hashPassword("emergencypass");
    memSettings.set("auth", JSON.stringify({
      mode: "local",
      username: "emergency-admin",
      passwordHash: hash,
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // expired 1 min ago
      emergency: true,
    }));

    const res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "emergency-admin", password: "emergencypass" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("expired");
  });

  test("login with non-expired emergency credentials succeeds", async () => {
    const routes = createAuthRoutes();

    const hash = await hashPassword("emergencypass");
    memSettings.set("auth", JSON.stringify({
      mode: "local",
      username: "emergency-admin",
      passwordHash: hash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), // expires in 1 min
      emergency: true,
    }));

    const res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "emergency-admin", password: "emergencypass" }),
    });
    expect(res.status).toBe(200);
  });

  test("login without expiresAt still works (normal admin)", async () => {
    const routes = createAuthRoutes();

    const hash = await hashPassword("normalpass");
    memSettings.set("auth", JSON.stringify({
      mode: "local",
      username: "admin",
      passwordHash: hash,
    }));

    const res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "normalpass" }),
    });
    expect(res.status).toBe(200);
  });
});
