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

  // Security Gateway input filter (Phase 4)
  const { securityInputFilter } = await import("./middleware/security-gateway.js");
  app.use("/api/v1/*", securityInputFilter);

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

  // Host servers (企业多租户：物理机管理)
  const { createHostServerRoutes } = await import("./routes/host-servers.js");
  app.route("/api/v1/host-servers", createHostServerRoutes());

  // Config management
  const { createConfigRoutes } = await import("./routes/config.js");
  app.route("/api/v1/config", createConfigRoutes());

  // Marketplace
  const { createMarketplaceRoutes } = await import("./routes/marketplace.js");
  app.route("/api/v1/marketplace", createMarketplaceRoutes());

  // Auth (login/refresh/logout/me/apikey)
  const { createAuthRoutes } = await import("./routes/auth.js");
  app.route("/api/v1/auth", createAuthRoutes());

  // Enterprise auth adapters (Phase 4: MFA + LDAP/OIDC bridges)
  const { createAuthAdapterRoutes } = await import("./routes/auth-adapters.js");
  app.route("/api/v1/auth", createAuthAdapterRoutes());

  // SSO (Hub → DA ticket 签发 + 兑换)
  const { createSsoRoutes } = await import("./routes/sso.js");
  app.route("/api/v1/auth/sso", createSsoRoutes());

  // Organizations
  const { createOrgRoutes } = await import("./routes/orgs.js");
  app.route("/api/v1/orgs", createOrgRoutes());

  // Users
  const { createUserRoutes } = await import("./routes/users.js");
  app.route("/api/v1/users", createUserRoutes());

  // RBAC
  const { createRbacRoutes } = await import("./routes/rbac.js");
  app.route("/api/v1/rbac", createRbacRoutes());

  // Skill workflow (Phase 3: state machine + approval + audit + force_update)
  // Mounted BEFORE marketplace routes so /approvals doesn't collide with /:id
  const { createSkillWorkflowRoutes } = await import("./routes/skill-workflow.js");
  app.route("/api/v1/skills", createSkillWorkflowRoutes());

  // Skill usage (Phase 4: usage logging + stats)
  // Mounted BEFORE marketplace routes so /usage/top doesn't collide with /:id
  const { createSkillUsageRoutes } = await import("./routes/skill-usage.js");
  app.route("/api/v1/skills", createSkillUsageRoutes());

  // Skills marketplace (Phase 2: org-scoped packages)
  const { createSkillRoutes } = await import("./routes/skills.js");
  app.route("/api/v1/skills", createSkillRoutes());

  // Skill sharing (Phase 4: cross-org bilateral approval)
  const { createSkillSharingRoutes } = await import("./routes/skill-sharing.js");
  app.route("/api/v1/sharings", createSkillSharingRoutes());

  // Security Gateway admin (Phase 4: scan / status / rules)
  const { createSecurityRoutes } = await import("./routes/security.js");
  app.route("/api/v1/security", createSecurityRoutes());

  // Model repository (Phase 5: upload / manifest / blob / delete)
  const { createModelRoutes } = await import("./routes/models.js");
  app.route("/api/v1/models", createModelRoutes());

  // Bundle distribution (Phase 5: manifest + image list)
  const { createBundleRoutes } = await import("./routes/bundle.js");
  app.route("/api/v1/bundle", createBundleRoutes());

  // Image tar streaming (Phase 5: curl | docker load)
  const { createImageRoutes } = await import("./routes/images.js");
  app.route("/api/v1/images", createImageRoutes());

  // Config templates (T13: global/org config CRUD + merged + history + by-worker/merged)
  const { createConfigTemplateRoutes } = await import("./routes/config-templates.js");
  app.route("/api/v1/config-templates", createConfigTemplateRoutes());

  // Monitoring (T18: worker health overview + per-worker history)
  const { createMonitoringRoutes } = await import("./routes/monitoring.js");
  app.route("/api/v1/monitoring", createMonitoringRoutes());

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
