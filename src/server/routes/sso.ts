// =============================================================================
// DeepAnalyze Hub - SSO Routes (E6 endpoints)
// =============================================================================
// Exposes T08 domain functions as HTTP endpoints:
//   POST /api/v1/auth/sso/ticket   — logged-in user creates short-lived ticket
//   POST /api/v1/auth/sso/exchange — DA backend exchanges ticket+worker_token
// =============================================================================

import { Hono } from "hono";
import { createTicket, exchangeTicket } from "../../domain/sso-ticket.js";
import { getUserByUsername } from "../../domain/user.js";
import { getPool } from "../../store/pg.js";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";

export function createSsoRoutes(): Hono {
  const app = new Hono();

  // POST /ticket —— 已登录用户调（jwtAuth 中间件）
  app.post("/ticket", jwtAuth, async (c) => {
    const body = await c.req.json<{ da_worker_id: string }>();
    if (!body.da_worker_id) {
      return c.json({ error: "da_worker_id required" }, 400);
    }

    const userId = c.get("userId") as string;
    try {
      const t = await createTicket(() => getPool(), {
        userId,
        workerId: body.da_worker_id,
        clientIp: c.req.header("x-forwarded-for") ?? c.req.header("remote-addr"),
        userAgent: c.req.header("user-agent"),
      });
      return c.json({
        ticket: t.ticket,
        redirect_url: t.redirect_url,
        expires_in: 10,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not assigned") || msg.includes("not approved")) {
        return c.json({ error: msg }, 403);
      }
      return c.json({ error: msg }, 400);
    }
  });

  // POST /exchange —— DA 后端调，无 jwtAuth；安全靠 worker_token
  app.post("/exchange", async (c) => {
    const body = await c.req.json<{ ticket: string; da_worker_token: string }>();
    if (!body.ticket || !body.da_worker_token) {
      return c.json({ error: "ticket and da_worker_token required" }, 400);
    }
    try {
      const result = await exchangeTicket(() => getPool(), {
        ticket: body.ticket,
        daWorkerToken: body.da_worker_token,
      });
      return c.json({
        access_token: result.accessToken,
        user: result.user,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("consumed") || msg.includes("expired")) {
        return c.json({ error: msg }, 410);
      }
      if (msg.includes("mismatch") || msg.includes("invalid")) {
        return c.json({ error: msg }, 401);
      }
      return c.json({ error: msg }, 400);
    }
  });

  // POST /admin-ticket —— 受信任的 admin/外部应用（如 nanobot）调，
  // 为「指定 username」的目标用户签发 ticket（用于跨应用 SSO 嵌入场景）。
  // 需 user:read 权限；createTicket 内部的 worker 归属校验仍生效，
  // 因此即便 admin 也只能为「确实拥有该 worker」的用户签发。
  app.post("/admin-ticket", jwtAuth, requirePermission("user:read"), async (c) => {
    const body = await c.req.json<{ username: string; da_worker_id?: string }>();
    if (!body.username) {
      return c.json({ error: "username required" }, 400);
    }

    // 1. 按 username 查 Hub 用户（不是调用者，是目标用户）
    const targetUser = await getUserByUsername(body.username);
    if (!targetUser) {
      return c.json({ error: "user not found" }, 404);
    }

    // 2. 确定目标用户的 worker：优先用请求体指定，否则取最近注册的活跃 worker
    let workerId = body.da_worker_id;
    if (!workerId) {
      const r = await getPool().query<{ id: string }>(
        `SELECT id FROM workers
         WHERE assigned_user_id = $1 AND status IN ('approved', 'online', 'offline')
         ORDER BY registered_at DESC LIMIT 1`,
        [targetUser.id],
      );
      if (r.rows.length === 0) {
        return c.json({ error: "no active worker for user" }, 404);
      }
      workerId = r.rows[0].id;
    }

    // 3. 用目标用户的 id 签发 ticket（worker 归属校验由 createTicket 自动完成）
    try {
      const t = await createTicket(() => getPool(), {
        userId: targetUser.id,
        workerId,
        clientIp: c.req.header("x-forwarded-for") ?? c.req.header("remote-addr"),
        userAgent: c.req.header("user-agent"),
      });

      // 4. 多返回 da_url 便于调用方（如 nanobot 代理）建立路由
      const daUrl = t.redirect_url.split("/api/auth/sso/callback")[0];
      return c.json({
        ticket: t.ticket,
        redirect_url: t.redirect_url,
        da_url: daUrl,
        expires_in: 10,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not assigned") || msg.includes("not approved")) {
        return c.json({ error: msg }, 403);
      }
      return c.json({ error: msg }, 400);
    }
  });

  return app;
}
