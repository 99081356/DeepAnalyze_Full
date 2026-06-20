/**
 * DeepAnalyze Hub — Hono Application Assembly.
 *
 * Wires together middleware, API routes, and health endpoint.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
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

  // Skills marketplace (Phase 2: org-scoped packages)
  const { createSkillRoutes } = await import("./routes/skills.js");
  app.route("/api/v1/skills", createSkillRoutes());

  // ─── Static frontend (admin panel) ───────────────────────────────────
  // Serves built React app from frontend/dist/. Falls back to index.html
  // for client-side routing (SPA).
  app.use("/assets/*", serveStatic({ root: "./frontend/dist" }));
  app.get("/favicon.ico", serveStatic({ path: "./favicon.ico" }));

  // ─── 404 fallback ────────────────────────────────────────────────────
  app.notFound((c) => {
    // For non-API GET requests, serve SPA index.html so client-side routing works
    if (c.req.method === "GET" && !c.req.path.startsWith("/api/") && !c.req.path.includes(".")) {
      const file = Bun.file("./frontend/dist/index.html");
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return c.json({ error: "Not found", path: c.req.path }, 404);
  });

  return app;
}
