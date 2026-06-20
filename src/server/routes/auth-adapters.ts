/**
 * Enterprise auth adapter routes — Phase 4.
 *
 * Endpoints:
 *   GET    /auth/adapters                  — List enabled adapters + status
 *   POST   /auth/mfa/setup                 — Generate TOTP secret + provisioning URI
 *   POST   /auth/mfa/verify                — Verify a code & enable MFA for current user
 *   POST   /auth/mfa/disable               — Remove MFA (requires current code)
 *   GET    /auth/mfa/status                — Is MFA configured/required?
 *
 *   POST   /auth/external/login            — Try external IdP login (LDAP/OIDC stub)
 */

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import {
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotp,
  setUserMfa,
  getUserMfa,
  clearUserMfa,
  verifyUserMfa,
  isMfaRequired,
  getAuthAdapters,
} from "../../domain/auth-adapters.js";

export function createAuthAdapterRoutes(): Hono {
  const app = new Hono();

  // ─── List enabled adapters ──────────────────────────────────────────

  app.get("/adapters", jwtAuth, async (c) => {
    const adapters = getAuthAdapters();
    return c.json({
      adapters: adapters.map((a) => ({ provider: a.provider, enabled: a.enabled })),
      mfa_required: isMfaRequired(),
    });
  });

  // ─── MFA setup: generate secret + provisioning URI ──────────────────

  app.post("/mfa/setup", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const username = c.get("username") as string;
    const secret = generateTotpSecret();
    const uri = totpProvisioningUri(secret, username || userId);
    // Stash secret as "pending" — only enabled after verify
    c.set("pendingMfaSecret", secret);
    return c.json({ secret, provisioning_uri: uri });
  });

  // ─── MFA verify: confirm a setup code and enable ────────────────────

  app.post("/mfa/verify", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const body = await c.req.json<{ secret?: string; code: string }>();

    // Caller may pass the secret from setup, or rely on stashed pending
    const secret = body.secret ?? (c.get("pendingMfaSecret") as string | undefined);
    if (!secret) {
      return c.json({ error: "No pending MFA secret. Call /mfa/setup first." }, 400);
    }
    if (!verifyTotp(secret, body.code)) {
      return c.json({ error: "Invalid TOTP code" }, 400);
    }
    setUserMfa(userId, secret, true);
    return c.json({ enabled: true, message: "MFA enabled. Future logins will require a code." });
  });

  // ─── MFA status ─────────────────────────────────────────────────────

  app.get("/mfa/status", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const mfa = getUserMfa(userId);
    return c.json({
      configured: mfa !== null,
      required: mfa?.required ?? isMfaRequired(),
      globally_required: isMfaRequired(),
    });
  });

  // ─── MFA disable ────────────────────────────────────────────────────

  app.post("/mfa/disable", jwtAuth, async (c) => {
    const userId = c.get("userId") as string;
    const body = await c.req.json<{ code?: string }>();
    const mfa = getUserMfa(userId);
    if (!mfa) return c.json({ already_disabled: true });
    if (!body.code || !verifyTotp(mfa.secret, body.code)) {
      return c.json({ error: "Valid TOTP code required to disable MFA" }, 400);
    }
    clearUserMfa(userId);
    return c.json({ disabled: true });
  });

  // ─── MFA challenge verify (used by login flow) ──────────────────────

  app.post("/mfa/challenge", async (c) => {
    const body = await c.req.json<{ user_id: string; code: string }>();
    if (!body.user_id || !body.code) return c.json({ error: "user_id and code required" }, 400);
    const result = verifyUserMfa(body.user_id, body.code);
    if (!result.ok) return c.json({ verified: false, error: "Invalid code" }, 401);
    return c.json({ verified: true, mfa_required: result.required });
  });

  // ─── External IdP login (LDAP/OIDC stub) ────────────────────────────
  // This is a simplified bridge: in a full deployment, OIDC would redirect
  // through the browser. For API-driven testing we accept direct creds.

  app.post("/external/login", async (c) => {
    const body = await c.req.json<{ provider: string; credentials: Record<string, unknown> }>();
    if (!body.provider) return c.json({ error: "provider required" }, 400);

    const adapters = getAuthAdapters();
    const adapter = adapters.find((a) => a.provider === body.provider);
    if (!adapter) {
      return c.json({ error: `Provider '${body.provider}' not enabled` }, 404);
    }
    const result = await adapter.authenticate(body.credentials);
    if (!result) {
      return c.json({ error: "External authentication failed" }, 401);
    }
    return c.json({ external_user: result });
  });

  return app;
}
