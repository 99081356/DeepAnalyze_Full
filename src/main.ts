// =============================================================================
// DeepAnalyze Hub - Server Entry Point
// =============================================================================

import "dotenv/config";
import { HUB_CONFIG } from "./core/config.js";
import { createApp } from "./server/app.js";
import { runMigrations } from "./store/migrations/runner.js";
import { closePool } from "./store/pg.js";

async function main() {
  console.log(`[Hub] Starting ${HUB_CONFIG.appName} v${HUB_CONFIG.version}`);
  console.log(`[Hub] Environment: ${HUB_CONFIG.env}`);

  // Run database migrations
  try {
    await runMigrations();
  } catch (err) {
    console.error("[Hub] Database migration failed. Check your PostgreSQL configuration.");
    console.error(err);
    process.exit(1);
  }

  // Create the Hono app
  const app = await createApp();

  // Start HTTP server
  const port = HUB_CONFIG.port;

  if (typeof Bun !== "undefined") {
    Bun.serve({
      port,
      fetch: app.fetch,
    });
  } else {
    const { serve } = await import("@hono/node-server");
    serve({ fetch: app.fetch, port });
  }

  console.log(`[Hub] Server running on http://localhost:${port}`);
  console.log(`[Hub] API endpoints:`);
  console.log(`  GET  /api/health                     — Health check`);
  console.log(`  POST /api/v1/workers/register         — Worker registration`);
  console.log(`  POST /api/v1/workers/heartbeat        — Worker heartbeat`);
  console.log(`  GET  /api/v1/workers                  — List workers`);
  console.log(`  GET  /api/v1/config/recommended       — Get recommended config`);
  console.log(`  GET  /api/v1/config/versions          — Config version info`);
  console.log(`  GET  /api/v1/marketplace/skills       — Browse skills`);
  console.log(`  POST /api/v1/marketplace/skills/submit — Submit skill`);
  console.log(`  GET  /api/v1/marketplace/plugins      — Browse plugins`);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[Hub] Shutting down...");
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[Hub] Shutting down...");
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("[Hub] Fatal error:", err);
  process.exit(1);
});
