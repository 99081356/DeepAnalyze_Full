/**
 * Migration 003: Fix all FK constraints referencing users(id)
 *
 * When the DB is truncated (testing, resets), the system user gets deleted
 * and all FKs break. Fix by:
 * 1. Making nullable columns nullable (some already are)
 * 2. Setting ON DELETE SET NULL for all FKs referencing users
 * 3. Re-inserting the system user as a safety net
 */

import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  // Ensure system user exists (re-insert after TRUNCATE)
  await query(`
    INSERT INTO users (id, username, display_name, role, status)
    VALUES ('system', 'system', 'System', 'admin', 'active')
    ON CONFLICT (id) DO NOTHING;
  `);

  // Fix config_versions.created_by — make nullable, ON DELETE SET NULL
  await query(`
    ALTER TABLE config_versions ALTER COLUMN created_by DROP NOT NULL;
  `);
  await query(`
    ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS config_versions_created_by_fkey;
    ALTER TABLE config_versions ADD CONSTRAINT config_versions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  `);

  // Fix marketplace_skills.author_id
  await query(`
    ALTER TABLE marketplace_skills ALTER COLUMN author_id DROP NOT NULL;
  `);
  await query(`
    ALTER TABLE marketplace_skills DROP CONSTRAINT IF EXISTS marketplace_skills_author_id_fkey;
    ALTER TABLE marketplace_skills ADD CONSTRAINT marketplace_skills_author_id_fkey
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
  `);

  // Fix marketplace_skills.reviewer_id
  await query(`
    ALTER TABLE marketplace_skills ALTER COLUMN reviewer_id DROP NOT NULL;
  `);
  await query(`
    ALTER TABLE marketplace_skills DROP CONSTRAINT IF EXISTS marketplace_skills_reviewer_id_fkey;
    ALTER TABLE marketplace_skills ADD CONSTRAINT marketplace_skills_reviewer_id_fkey
      FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL;
  `);

  // Fix marketplace_plugins.author_id
  await query(`
    ALTER TABLE marketplace_plugins ALTER COLUMN author_id DROP NOT NULL;
  `);
  await query(`
    ALTER TABLE marketplace_plugins DROP CONSTRAINT IF EXISTS marketplace_plugins_author_id_fkey;
    ALTER TABLE marketplace_plugins ADD CONSTRAINT marketplace_plugins_author_id_fkey
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;
  `);

  // Fix marketplace_plugins.reviewer_id
  await query(`
    ALTER TABLE marketplace_plugins ALTER COLUMN reviewer_id DROP NOT NULL;
  `);
  await query(`
    ALTER TABLE marketplace_plugins DROP CONSTRAINT IF EXISTS marketplace_plugins_reviewer_id_fkey;
    ALTER TABLE marketplace_plugins ADD CONSTRAINT marketplace_plugins_reviewer_id_fkey
      FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL;
  `);

  // Fix skill_reviews.user_id — ON DELETE CASCADE makes sense for reviews
  await query(`
    ALTER TABLE skill_reviews DROP CONSTRAINT IF EXISTS skill_reviews_user_id_fkey;
    ALTER TABLE skill_reviews ADD CONSTRAINT skill_reviews_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  `);

  // Fix sso_sessions.user_id — ON DELETE CASCADE
  await query(`
    ALTER TABLE sso_sessions DROP CONSTRAINT IF EXISTS sso_sessions_user_id_fkey;
    ALTER TABLE sso_sessions ADD CONSTRAINT sso_sessions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  `);
}
