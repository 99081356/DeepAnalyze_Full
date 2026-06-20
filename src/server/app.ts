/**
 * DeepAnalyze Hub — Hono Application Assembly.
 *
 * Wires together middleware, API routes, and health endpoint.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HUB_CONFIG } from "../core/config.js";

export async function createApp(): Promise<Hono> {
  const app = new Hono();

  // ─── Global middleware ────────────────────────────────────────────────
  app.use("*", cors());
  app.use("*", logger());

  // ─── Health check ─────────────────────────────────────────────────────
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      version: HUB_CONFIG.version,
      appName: HUB_CONFIG.appName,
    }),
  );

  // ─── API v1 routes ───────────────────────────────────────────────────

  // Worker management
  const { createWorkerRoutes } = await import("./routes/workers.js");
  app.route("/api/v1/workers", createWorkerRoutes());

  // Config management
  const { createConfigRoutes } = await import("./routes/config.js");
  app.route("/api/v1/config", createConfigRoutes());

  // Marketplace
  const { createMarketplaceRoutes } = await import("./routes/marketplace.js");
  app.route("/api/v1/marketplace", createMarketplaceRoutes());

  // Auth (login/refresh/logout/me/apikey)
  const { createAuthRoutes } = await import("./routes/auth.js");
  app.route("/api/v1/auth", createAuthRoutes());

  // Organizations
  const { createOrgRoutes } = await import("./routes/orgs.js");
  app.route("/api/v1/orgs", createOrgRoutes());

  // Users
  const { createUserRoutes } = await import("./routes/users.js");
  app.route("/api/v1/users", createUserRoutes());

  // RBAC
  const { createRbacRoutes } = await import("./routes/rbac.js");
  app.route("/api/v1/rbac", createRbacRoutes());

  // ─── 404 fallback ────────────────────────────────────────────────────
  app.notFound((c) =>
    c.json({ error: "Not found", path: c.req.path }, 404),
  );

  return app;
}
