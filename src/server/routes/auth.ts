// =============================================================================
// Auth Routes — login/refresh/logout/me/apikey
// =============================================================================

import { Hono } from "hono";
import {
  issueTokenPair,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyRefreshToken,
} from "../../domain/auth.js";
import {
  getUserByUsername,
  verifyPassword,
  touchLogin,
  getUserRoleIds,
  getUserById,
  getUserPermissions,
} from "../../domain/user.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { getJwks } from "../../domain/jwks.js";
import { getPool } from "../../store/pg.js";

export function createAuthRoutes() {
  const router = new Hono();

  // POST /api/v1/auth/login
  router.post("/login", async (c) => {
    const body = await c.req.json<{ username: string; password: string }>();
    if (!body.username || !body.password) {
      return c.json({ error: "username and password required" }, 400);
    }

    const user = await getUserByUsername(body.username);
    if (!user || !user.password_hash) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    await touchLogin(user.id);

    const { access_token, refresh_token, expires_in } = issueTokenPair(
      user.id,
    );
    const roleIds = await getUserRoleIds(user.id);

    // 查询用户关联的 DA Worker（与 /auth/me 保持一致）
    const workerResult = await getPool().query(
      `SELECT id, da_url FROM workers
       WHERE assigned_user_id = $1 AND status IN ('approved', 'online', 'offline')
       ORDER BY registered_at DESC LIMIT 1`,
      [user.id],
    );
    const daWorker = workerResult.rows[0] ?? null;

    c.header(
      "Set-Cookie",
      `refresh_token=${refresh_token}; HttpOnly; Path=/api/v1/auth; Max-Age=2592000; SameSite=Strict`,
    );

    return c.json({
      access_token,
      expires_in,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        is_super_admin: user.is_super_admin,
        is_org_admin: user.is_org_admin,
        organization_id: user.organization_id,
        roles: roleIds,
        da_url: daWorker?.da_url ?? null,
        da_worker_id: daWorker?.id ?? null,
      },
    });
  });

  // POST /api/v1/auth/refresh
  router.post("/refresh", async (c) => {
    const cookie = c.req.header("Cookie") ?? "";
    const match = cookie.match(/refresh_token=([^;]+)/);
    let refreshToken = match?.[1];

    if (!refreshToken) {
      try {
        const body = await c.req.json<{ refresh_token?: string }>();
        refreshToken = body.refresh_token;
      } catch {
        // body 可能为空
      }
    }

    if (!refreshToken) {
      return c.json({ error: "No refresh token" }, 400);
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      return c.json({ error: "Invalid refresh token" }, 401);
    }

    const { access_token, expires_in } = issueTokenPair(payload.sub);
    return c.json({ access_token, expires_in });
  });

  // POST /api/v1/auth/logout
  router.post("/logout", (c) => {
    c.header(
      "Set-Cookie",
      "refresh_token=; HttpOnly; Path=/api/v1/auth; Max-Age=0",
    );
    return c.json({ success: true });
  });

  // GET /api/v1/auth/jwks.json
  router.get("/jwks.json", (c) => {
    return c.json(getJwks());
  });

  // GET /api/v1/auth/me
  router.get("/me", jwtAuth, async (c) => {
    const userId = c.get("userId");
    const user = await getUserById(userId);
    if (!user) return c.json({ error: "User not found" }, 404);

    const [permissions, roleIds] = await Promise.all([
      getUserPermissions(userId),
      getUserRoleIds(userId),
    ]);

    // Look up the user's assigned DA worker (if any) — for "Open my DA" button
    const workerResult = await getPool().query(
      `SELECT id, da_url FROM workers
       WHERE assigned_user_id = $1 AND status IN ('approved', 'online', 'offline')
       ORDER BY registered_at DESC LIMIT 1`,
      [userId],
    );
    const daWorker = workerResult.rows[0] ?? null;

    return c.json({
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      is_super_admin: user.is_super_admin,
      is_org_admin: user.is_org_admin,
      organization_id: user.organization_id,
      roles: roleIds,
      permissions,
      da_url: daWorker?.da_url ?? null,
      da_worker_id: daWorker?.id ?? null,
    });
  });

  // ---- API Key 管理 ----

  router.post("/apikey", jwtAuth, async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{
      name: string;
      scope: "read" | "write" | "admin";
      expires_at?: string;
    }>();
    if (!body.name || !body.scope) {
      return c.json({ error: "name and scope required" }, 400);
    }

    const { apiKey, keyId } = await createApiKey(
      userId,
      body.name,
      body.scope,
      body.expires_at,
    );
    return c.json({
      api_key: apiKey,
      key_id: keyId,
      name: body.name,
      scope: body.scope,
      expires_at: body.expires_at ?? null,
    });
  });

  router.get("/apikey", jwtAuth, async (c) => {
    const userId = c.get("userId");
    const keys = await listApiKeys(userId);
    return c.json({ keys });
  });

  router.delete("/apikey/:id", jwtAuth, async (c) => {
    const userId = c.get("userId");
    const keyId = c.req.param("id");
    const ok = await revokeApiKey(userId, keyId);
    if (!ok) return c.json({ error: "Key not found" }, 404);
    return c.json({ success: true });
  });

  return router;
}
