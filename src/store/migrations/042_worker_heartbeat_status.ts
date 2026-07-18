// Migration 042: workers.last_heartbeat_status
//
// Background: the overview previously only had a boolean last_heartbeat_ok,
// which collapsed "degraded" (some modules unhealthy but worker reachable)
// and "down" (critical modules offline) into the same bucket. Storing the
// granular rollup status (healthy/degraded/down) on the worker row lets the
// monitoring page render a separate "故障 (down)" card.
//
// Mirrors upstream 2c0765a. Renumbered from upstream's 040 because this fork
// already has 040_workers_status_deploying.ts and 041_seed_default_config_template.ts.

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE workers
      ADD COLUMN IF NOT EXISTS last_heartbeat_status TEXT
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS last_heartbeat_status`);
}
