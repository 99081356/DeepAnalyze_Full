// =============================================================================
// DeepAnalyze - Auth Routes
// =============================================================================
// POST /api/auth/setup    First-time admin setup (local mode only)
// POST /api/auth/login    Login (local bcrypt or hub proxy)
// POST /api/auth/logout   Logout (frontend clears localStorage)
// GET  /api/auth/me       Current user (requires authMiddleware)
// =============================================================================

import { Hono } from "hono";
import { getAuthMode, type AuthUser } from "../middleware/auth.js";
import {
  hashPassword,
  verifyPassword,
  signLocalJwt,
} from "../../services/auth/local-idp.js";
import { proxyHubLogin } from "../../services/auth/hub-jwks.js";
import { exchangeTicketWithHub } from "../../services/auth/sso-client.js";
import { signLocalSession } from "../../services/auth/local-session.js";
import { getOrCreateWorkerId } from "../../services/hub/worker-identity.js";
import { DEEPANALYZE_CONFIG } from "../../core/config.js";
import { getRepos } from "../../store/repos/index.js";

interface AuthSettings {
  mode?: string;
  username?: string;
  passwordHash?: string;
  expiresAt?: string;
  emergency?: boolean;
}

const AUTH_SETTINGS_KEY = "auth";

async function getAuthSettings(): Promise<AuthSettings> {
  const repo = (await getRepos()).settings;
  const raw = await repo.get(AUTH_SETTINGS_KEY);
  return raw ? (JSON.parse(raw) as AuthSettings) : {};
}

async function saveAuthSettings(s: AuthSettings): Promise<void> {
  const repo = (await getRepos()).settings;
  await repo.set(AUTH_SETTINGS_KEY, JSON.stringify(s));
}

export function createAuthRoutes(): Hono {
  const app = new Hono();

  // GET /mode — returns current auth mode (public, no token required)
  app.get("/mode", (c) => c.json({ mode: getAuthMode() }));

  // POST /setup — first-time admin setup (local mode only)
  app.post("/setup", async (c) => {
    if (getAuthMode() !== "local") {
      return c.json({ error: "setup only available in local mode" }, 400);
    }
    const body = await c.req.json<{ username: string; password: string }>();
    if (!body.username || !body.password || body.password.length < 6) {
      return c.json(
        { error: "username and password (>=6 chars) required" },
        400,
      );
    }
    const existing = await getAuthSettings();
    if (existing.passwordHash) {
      return c.json({ error: "already initialized" }, 409);
    }
    const passwordHash = await hashPassword(body.password);
    await saveAuthSettings({
      mode: "local",
      username: body.username,
      passwordHash,
    });
    return c.json({ ok: true });
  });

  // POST /login
  app.post("/login", async (c) => {
    const mode = getAuthMode();
    const body = await c.req.json<{ username: string; password: string }>();

    if (mode === "local") {
      const settings = await getAuthSettings();
      if (!settings.passwordHash) {
        return c.json(
          { error: "not initialized - POST /api/auth/setup first" },
          400,
        );
      }
      // Enforce emergency-admin expiry
      if (settings.expiresAt) {
        const expiry = new Date(settings.expiresAt).getTime();
        if (Date.now() > expiry) {
          return c.json(
            { error: "emergency admin credentials have expired" },
            401,
          );
        }
      }
      const ok = await verifyPassword(body.password, settings.passwordHash);
      if (!ok || body.username !== settings.username) {
        return c.json({ error: "invalid credentials" }, 401);
      }
      const token = await signLocalJwt("usr-local-admin", body.username);
      return c.json({ access_token: token, expires_in: 7 * 24 * 3600 });
    }

    if (mode === "hub") {
      const result = await proxyHubLogin(body.username, body.password);
      if (!result) {
        return c.json({ error: "hub login failed" }, 401);
      }
      return c.json(result);
    }

    return c.json({ error: "auth mode does not support login" }, 400);
  });

  // POST /logout — frontend clears localStorage
  app.post("/logout", (c) => {
    return c.json({ ok: true });
  });

  // GET /sso/callback — browser redirect target from Hub
  // PUBLIC path (added to PUBLIC_AUTH_PATHS in middleware) — unauthenticated OK
  app.get("/sso/callback", async (c) => {
    const ticket = c.req.query("hub_ticket");
    if (!ticket) {
      return c.redirect("/login?err=no_ticket");
    }

    const result = await exchangeTicketWithHub(ticket);
    if (!result) {
      return c.redirect("/login?err=exchange_failed");
    }

    // Verify the Hub access_token to confirm identity
    const { verifyHubJwt } = await import("../../services/auth/hub-jwks.js");
    const hubUser = await verifyHubJwt(result.accessToken);
    if (!hubUser) {
      return c.redirect("/login?err=invalid_token");
    }

    // Sign local session cookie
    const workerId = getOrCreateWorkerId(DEEPANALYZE_CONFIG.dataDir);
    const sessionJwt = await signLocalSession({
      sub: hubUser.id,
      name: hubUser.name,
      orgId: hubUser.orgId ?? null,
      daWorkerId: workerId,
    });

    const secure = process.env.DA_SSO_ALLOW_HTTP === "1" ? "" : "; Secure";
    c.header(
      "Set-Cookie",
      `da_session=${sessionJwt}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`,
    );
    return c.redirect("/");
  });

  // POST /sso/logout — clears local cookie, returns Hub logout URL for redirect
  app.post("/sso/logout", (c) => {
    c.header(
      "Set-Cookie",
      "da_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    const hubUrl = process.env.DA_HUB_URL ?? "";
    return c.json({ redirect_url: hubUrl ? `${hubUrl}/logout` : "/login" });
  });

  // GET /me — requires authMiddleware to have set ctx.user
  app.get("/me", (c) => {
    const user = (c as any).get("user") as AuthUser | undefined;
    if (!user) return c.json({ error: "not authenticated" }, 401);
    return c.json(user);
  });

  // POST /change-password — change local-mode admin password (requires authMiddleware + current password)
  app.post("/change-password", async (c) => {
    if (getAuthMode() !== "local") {
      return c.json({ error: "only local mode supports change-password" }, 400);
    }
    const body = await c.req.json<{ current: string; next: string }>();
    const settings = await getAuthSettings();
    if (!settings.passwordHash) {
      return c.json({ error: "not initialized" }, 400);
    }
    const ok = await verifyPassword(body.current, settings.passwordHash);
    if (!ok) {
      return c.json({ error: "current password incorrect" }, 401);
    }
    if (body.next.length < 6) {
      return c.json({ error: "new password too short" }, 400);
    }
    const newHash = await hashPassword(body.next);
    await saveAuthSettings({ ...settings, passwordHash: newHash });
    return c.json({ ok: true });
  });

  return app;
}
