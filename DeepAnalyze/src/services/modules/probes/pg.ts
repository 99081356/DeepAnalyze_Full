// src/services/modules/probes/pg.ts
// Infrastructure probe — pgsql connectivity via SELECT 1.
// Uses query() helper from src/store/pg.ts (async wrapper around pool.query).
import { query } from "../../../store/pg.js";
import type { ModuleHealth } from "../health-probe.js";

export async function probePg(): Promise<ModuleHealth> {
  const start = Date.now();
  const last_check_at = new Date().toISOString();
  try {
    await query("SELECT 1");
    return {
      status: "healthy",
      mode: "local",
      latency_ms: Date.now() - start,
      last_check_at,
    };
  } catch (e) {
    return {
      status: "down",
      mode: "local",
      last_error: e instanceof Error ? e.message : String(e),
      last_check_at,
    };
  }
}
