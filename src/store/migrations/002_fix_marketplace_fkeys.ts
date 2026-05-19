/**
 * Migration 002: Fix marketplace submitter FK
 *
 * marketplace_skills.submitter_id references users(id), but Workers
 * are not in the users table. Change the submitter_id to use the system
 * user as default when submitted by a Worker.
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // Allow submitter_id to be NULL (Worker submissions without a user account)
  await query(`
    ALTER TABLE marketplace_skills ALTER COLUMN submitter_id DROP NOT NULL;
  `);

  // Set existing NULL submitter_ids to 'system'
  await query(`
    UPDATE marketplace_skills SET submitter_id = 'system' WHERE submitter_id IS NULL;
  `);

  // Drop and re-add the FK with ON DELETE SET NULL so Workers can submit
  await query(`
    ALTER TABLE marketplace_skills DROP CONSTRAINT IF EXISTS marketplace_skills_submitter_id_fkey;
    ALTER TABLE marketplace_skills ADD CONSTRAINT marketplace_skills_submitter_id_fkey
      FOREIGN KEY (submitter_id) REFERENCES users(id) ON DELETE SET NULL;
  `);
}
