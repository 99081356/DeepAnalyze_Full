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

  const row = rows[0];

  // Blocklist: reject workers whose status indicates they should no longer
  // be able to authenticate (rejected, revoked, deactivated).
  // Using a blocklist (rather than an allowlist) permits legitimate transient
  // states like 'offline' and 'pending' (if needed) while cleanly blocking
  // terminal/blocked states.
  const BLOCKED_STATUSES = ["rejected", "revoked", "deactivated"];
  if (BLOCKED_STATUSES.includes(row.status)) {
    return c.json({ error: `worker blocked: status=${row.status}` }, 403);
  }

  if (row.status === "offline") {
    // Still allow the request but update status
    await query("UPDATE workers SET status = 'online' WHERE id = $1", [row.id]);
  }

  // Store worker ID in context for downstream handlers
  c.set("workerId", row.id);
  await next();
});
