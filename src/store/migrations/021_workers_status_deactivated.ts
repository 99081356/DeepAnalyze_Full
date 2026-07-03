/**
 * Migration 021: Add 'deactivated' status + deactivated_at column
 *
 * - Adds deactivated_at TIMESTAMPTZ column to workers
 * - Drops the existing workers_status_check constraint
 * - Re-adds it with 'deactivated' and 'revoked' included in allowed values
 *
 * This enables the POST /me/deactivate endpoint (Task B4).
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // 1. Add deactivated_at column
  await query(`ALTER TABLE workers ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`);

  // 2. Drop old status CHECK constraint (named workers_status_check per migration 007)
  await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check`);

  // 3. Add new constraint including 'deactivated' and 'revoked'
  await query(`
    ALTER TABLE workers ADD CONSTRAINT workers_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'online', 'offline', 'draining', 'deactivated'))
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check`);
  await query(`
    ALTER TABLE workers ADD CONSTRAINT workers_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'online', 'offline', 'draining'))
  `);
  await query(`ALTER TABLE workers DROP COLUMN IF EXISTS deactivated_at`);
}
