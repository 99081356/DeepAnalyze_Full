// =============================================================================
// DeepAnalyze Hub - SSO Routes (E6 endpoints)
// =============================================================================
// Exposes T08 domain functions as HTTP endpoints:
//   POST /api/v1/auth/sso/ticket   — logged-in user creates short-lived ticket
//   POST /api/v1/auth/sso/exchange — DA backend exchanges ticket+worker_token
// =============================================================================

import { Hono } from "hono";
import { createTicket, exchangeTicket } from "../../domain/sso-ticket.js";
import { getPool } from "../../store/pg.js";
import { jwtAuth } from "../middleware/jwt-auth.js";

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

  return app;
}
