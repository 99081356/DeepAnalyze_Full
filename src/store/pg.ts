/**
 * PostgreSQL connection pool for DeepAnalyze Hub.
 */

import pg from "pg";
import { HUB_CONFIG } from "../core/config.js";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: HUB_CONFIG.database.host,
      port: HUB_CONFIG.database.port,
      database: HUB_CONFIG.database.database,
      user: HUB_CONFIG.database.user,
      password: HUB_CONFIG.database.password,
      max: HUB_CONFIG.database.poolSize,
    });

    pool.on("error", (err) => {
      console.error("[DB] Unexpected pool error:", err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a query and return rows.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  return p.query<T>(text, params);
}
