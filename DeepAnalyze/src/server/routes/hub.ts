/**
 * Hub API routes — Worker-side endpoints for Server interaction.
 *
 * These routes are only registered when DA_RUN_MODE=worker (i.e. DA_SERVER_URL is set).
 * They expose config sync, marketplace browsing/install/publish, and sync-state queries
 * for the frontend, plus read-only status endpoints for the Server to poll.
 */

import { Hono } from "hono";
import { syncConfigFromHub } from "../../services/hub/sync-from-hub.js";
import { query } from "../../store/pg.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function getHubClient() {
  const client = globalThis.__hubClient;
  if (!client) {
    throw new Error("HubClient not initialized");
  }
  return client;
}

// ─── Hub routes (frontend calls these) ──────────────────────────────────────

export function createHubRoutes(): Hono {
  const app = new Hono();

  // ─── Sync state ────────────────────────────────────────────────────────

  /**
   * GET /api/hub/sync-state
   * Returns the current Server connection state.
   */
  app.get("/sync-state", (c) => {
    const hub = getHubClient();
    return c.json(hub.getSyncState());
  });

  // ─── Config sync ───────────────────────────────────────────────────────

  /**
   * POST /api/hub/sync-config
   * Manual trigger: fetch recommended config from Server and apply it.
   */
  app.post("/sync-config", async (c) => {
    const hub = getHubClient();
    try {
      const config = await hub.fetchRecommendedConfig();
      if (!config) {
        return c.json({
          success: false,
          error: "Server unreachable or no recommended config available",
        }, 502);
      }

      await hub.applyRecommendedConfig(config);

      return c.json({
        success: true,
        configVersion: config.version,
        updatedAt: config.updatedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Hub] Config sync failed: ${message}`);
      return c.json({ success: false, error: message }, 500);
    }
  });

  /**
   * GET /api/hub/config-version
   * Lightweight check: is there a newer config on the Server?
   */
  app.get("/config-version", async (c) => {
    const hub = getHubClient();
    const info = await hub.fetchConfigVersion();
    if (!info) {
      return c.json({ available: false });
    }
    return c.json({ available: true, ...info });
  });

  // ─── Marketplace: skills ───────────────────────────────────────────────

  /**
   * GET /api/hub/marketplace/skills?page=1&pageSize=20&search=
   * Browse marketplace skills.
   */
  app.get("/marketplace/skills", async (c) => {
    const hub = getHubClient();
    const page = parseInt(c.req.query("page") || "1", 10);
    const pageSize = parseInt(c.req.query("pageSize") || "20", 10);
    const search = c.req.query("search") || "";

    const result = await hub.listMarketplaceSkills(page, pageSize, search);
    if (!result) {
      return c.json({ items: [], total: 0, error: "Server unreachable" }, 200);
    }
    return c.json(result);
  });

  /**
   * GET /api/hub/marketplace/skills/:slug
   * Get skill detail.
   */
  app.get("/marketplace/skills/:slug", async (c) => {
    const hub = getHubClient();
    const slug = c.req.param("slug");
    const detail = await hub.getMarketplaceSkill(slug);
    if (!detail) {
      return c.json({ error: "Skill not found or Server unreachable" }, 404);
    }
    return c.json(detail);
  });

  /**
   * POST /api/hub/marketplace/install/:slug
   * Download and install a skill from the marketplace.
   */
  app.post("/marketplace/install/:slug", async (c) => {
    const hub = getHubClient();
    const slug = c.req.param("slug");
    const result = await hub.downloadMarketplaceSkill(slug);
    if (!result) {
      return c.json({ installed: false, error: "Download failed or Server unreachable" }, 502);
    }
    return c.json(result);
  });

  /**
   * POST /api/hub/marketplace/publish/:skillId
   * Publish a local skill to the marketplace.
   */
  app.post("/marketplace/publish/:skillId", async (c) => {
    const hub = getHubClient();
    const skillId = c.req.param("skillId");
    const result = await hub.submitSkillToMarket(skillId);
    if (!result) {
      return c.json({ error: "Submission failed or Server unreachable" }, 502);
    }
    return c.json(result);
  });

  // ─── Marketplace: plugins ──────────────────────────────────────────────

  /**
   * GET /api/hub/marketplace/plugins?page=1&pageSize=20
   * Browse marketplace plugins.
   */
  app.get("/marketplace/plugins", async (c) => {
    const hub = getHubClient();
    const page = parseInt(c.req.query("page") || "1", 10);
    const pageSize = parseInt(c.req.query("pageSize") || "20", 10);

    const result = await hub.listMarketplacePlugins(page, pageSize);
    if (!result) {
      return c.json({ items: [], total: 0, error: "Server unreachable" }, 200);
    }
    return c.json(result);
  });

  /**
   * POST /api/hub/marketplace/install-plugin/:slug
   * Download and install a plugin from the marketplace.
   */
  app.post("/marketplace/install-plugin/:slug", async (c) => {
    const hub = getHubClient();
    const slug = c.req.param("slug");
    const result = await hub.downloadMarketplacePlugin(slug);
    if (!result) {
      return c.json({ installed: false, error: "Download failed" }, 502);
    }
    return c.json(result);
  });

  /**
   * POST /api/hub/marketplace/publish-plugin/:pluginId
   * Publish a local plugin to the marketplace.
   */
  app.post("/marketplace/publish-plugin/:pluginId", async (c) => {
    const hub = getHubClient();
    const pluginId = c.req.param("pluginId");
    const result = await hub.submitPluginToMarket(pluginId);
    if (!result) {
      return c.json({ error: "Submission not yet implemented or Server unreachable" }, 502);
    }
    return c.json(result);
  });

  // ─── Config sync (T16, lock-aware) ───────────────────────────────
  // NOTE: POST /sync-config above is the older non-lock-aware path;
  // /config/sync-from-hub is the T13-based lock-aware replacement.

  /**
   * POST /api/hub/config/sync-from-hub
   * Lock-aware manual sync: pull merged template via HubClient and apply
   * per-field lock semantics (T15's syncConfigFromHub).
   * Only available when DA_AUTH_MODE=hub.
   */
  app.post("/config/sync-from-hub", async (c) => {
    if (process.env.DA_AUTH_MODE !== "hub") {
      return c.json({ error: "only available in hub mode" }, 400);
    }
    try {
      const result = await syncConfigFromHub(
        () => getHubClient().fetchMergedTemplate(),
      );
      return c.json(result, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * GET /api/hub/config/sync-status
   * Returns current auth mode and the last successful hub sync timestamp.
   * Read-only; any mode may query.
   */
  app.get("/config/sync-status", async (c) => {
    const { rows } = await query(
      "SELECT last_hub_sync_at FROM config_versions WHERE id = 'singleton'",
    );
    return c.json({
      mode: process.env.DA_AUTH_MODE ?? "local",
      last_hub_sync_at: rows[0]?.last_hub_sync_at ?? null,
    });
  });

  return app;
}

// ─── Worker status routes (Server calls these, read-only) ────────────────────

export function createWorkerStatusRoutes(): Hono {
  const app = new Hono();

  /**
   * GET /api/worker/status
   * Returns Worker runtime status.
   */
  app.get("/status", async (c) => {
    const hub = getHubClient();
    const status = await hub.getLocalStatus(0, 0);
    return c.json(status);
  });

  /**
   * GET /api/worker/version
   * Returns Worker and DA version.
   */
  app.get("/version", async (c) => {
    const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
    return c.json({
      version: DEEPANALYZE_CONFIG.version,
      appName: DEEPANALYZE_CONFIG.appName,
    });
  });

  /**
   * GET /api/worker/capabilities
   * Returns Worker hardware/software capabilities.
   */
  app.get("/capabilities", async (c) => {
    const { collectWorkerCapabilities } = await import("../../services/hub/worker-identity.js");
    const { DEEPANALYZE_CONFIG } = await import("../../core/config.js");
    const caps = collectWorkerCapabilities();
    caps.daVersion = DEEPANALYZE_CONFIG.version;
    return c.json(caps);
  });

  return app;
}
