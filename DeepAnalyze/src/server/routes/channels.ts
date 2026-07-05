// =============================================================================
// DeepAnalyze - Channels API Routes
// REST API for managing communication channels
// =============================================================================

import { Hono } from "hono";
import { ChannelManager } from "../../services/channels/channel-manager.js";
import type { ChannelId } from "../../services/channels/types.js";

export async function createChannelRoutes(): Promise<Hono> {
  const router = new Hono();
  const manager = new ChannelManager();
  await manager.init();

  /** List all channels with metadata and status */
  router.get("/list", (c) => {
    const channels = manager.listChannels();
    // Mask sensitive fields in list view
    const masked = channels.map((ch) => ({
      ...ch,
      // Don't include full config in list — use /:id/config for that
    }));
    return c.json({ channels: masked });
  });

  /** Get all channel configs */
  router.get("/configs", (c) => {
    const configs = manager.getConfigs();
    // Mask sensitive fields
    const masked = maskConfigs(configs);
    return c.json({ configs: masked });
  });

  /** Get full config for a single channel */
  router.get("/:id/config", (c) => {
    const id = c.req.param("id") as ChannelId;
    const config = manager.getConfig(id);
    if (!config) return c.json({ error: "Channel not found" }, 404);
    return c.json({ config });
  });

  /** Update a channel's config */
  router.post("/update", async (c) => {
    const body = await c.req.json<{ id: ChannelId; config: Record<string, unknown> }>();

    if (!body.id) return c.json({ error: "缺少渠道 ID" }, 400);

    try {
      const updated = await manager.updateConfig(body.id, body.config as any);
      return c.json({ success: true, config: updated });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "更新失败" }, 400);
    }
  });

  /** Test a channel's connection */
  router.post("/test", async (c) => {
    const body = await c.req.json<{ id: ChannelId; config?: Record<string, unknown> }>();

    if (!body.id) return c.json({ error: "缺少渠道 ID" }, 400);

    try {
      const result = await manager.testConnection(body.id, body.config);
      return c.json(result);
    } catch (err) {
      return c.json({
        success: false,
        message: err instanceof Error ? err.message : "测试失败",
      });
    }
  });

  /** Start a channel */
  router.post("/:id/start", async (c) => {
    const id = c.req.param("id") as ChannelId;
    try {
      await manager.startChannel(id);
      return c.json({ success: true, message: `${id} 已启动` });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "启动失败" }, 400);
    }
  });

  /** Stop a channel */
  router.post("/:id/stop", async (c) => {
    const id = c.req.param("id") as ChannelId;
    try {
      await manager.stopChannel(id);
      return c.json({ success: true, message: `${id} 已停止` });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "停止失败" }, 400);
    }
  });

  /** Get all channel statuses */
  router.get("/status", (c) => {
    const status = manager.getStatus();
    return c.json({ status });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helper: mask sensitive fields for list view
// ---------------------------------------------------------------------------

function maskConfigs(configs: Record<string, any>): Record<string, any> {
  const masked: Record<string, any> = {};
  const sensitiveKeys = new Set([
    "app_secret", "client_secret", "secret", "encrypt_key",
    "encoding_aes_key", "token",
  ]);

  for (const [key, value] of Object.entries(configs)) {
    if (typeof value === "object" && value !== null) {
      masked[key] = {};
      for (const [k, v] of Object.entries(value)) {
        if (sensitiveKeys.has(k) && typeof v === "string" && v.length > 0) {
          masked[key][k] = v.length <= 4 ? "****" : v.slice(0, 4) + "****";
        } else {
          masked[key][k] = v;
        }
      }
    } else {
      masked[key] = value;
    }
  }
  return masked;
}
