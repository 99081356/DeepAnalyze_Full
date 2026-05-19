/**
 * Worker authentication middleware.
 *
 * Validates the Bearer token against the workers table.
 * For now, uses a simple token lookup. In production, this
 * should use JWT with the worker's registered token.
 */

import { createMiddleware } from "hono/factory";
import { query } from "../../store/pg.js";

/**
 * Middleware that extracts and validates the worker token from
 * the Authorization header.
 */
export const workerAuth = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  // Look up worker by token
  const { rows } = await query<{ id: string; status: string }>(
    "SELECT id, status FROM workers WHERE worker_token = $1",
    [token],
  );

  if (rows.length === 0) {
    return c.json({ error: "Invalid worker token" }, 401);
  }

  if (rows[0].status === "offline") {
    // Still allow the request but update status
    await query("UPDATE workers SET status = 'online' WHERE id = $1", [rows[0].id]);
  }

  // Store worker ID in context for downstream handlers
  c.set("workerId", rows[0].id);
  await next();
});
