/**
 * Migration 014: Fix skill_sharings UNIQUE constraint to be partial.
 *
 * Migration 013 created UNIQUE(package_id, source_org_id, target_org_id)
 * which prevents re-creating a sharing after rejection/revocation.
 *
 * Replace with a partial index that only applies when status is in
 * ('pending', 'approved') — allows history-preserving duplicate creation
 * after terminal states.
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // Drop the table-level UNIQUE constraint
  await query(`
    ALTER TABLE skill_sharings
    DROP CONSTRAINT IF EXISTS skill_sharings_package_id_source_org_id_target_org_id_key
  `);

  // Create partial unique index covering only active states
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sharing_active_pair
    ON skill_sharings(package_id, source_org_id, target_org_id)
    WHERE status IN ('pending', 'approved')
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP INDEX IF EXISTS uq_sharing_active_pair`);
  await query(`
    ALTER TABLE skill_sharings
    ADD CONSTRAINT skill_sharings_package_id_source_org_id_target_org_id_key
    UNIQUE (package_id, source_org_id, target_org_id)
  `);
}
