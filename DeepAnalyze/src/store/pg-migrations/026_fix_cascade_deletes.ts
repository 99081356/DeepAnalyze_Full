// =============================================================================
// DeepAnalyze - PG Migration 026: Fix CASCADE delete behavior
// =============================================================================
// Changes:
// 1. agent_tasks.session_id: ON DELETE SET NULL → ON DELETE CASCADE
//    - Previously orphaned agent_tasks rows accumulated after session deletion
// 2. reports.session_id: Add FK constraint with ON DELETE CASCADE
//    - Previously reports had no FK, leaving orphaned rows after session deletion
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 26,
  name: 'fix_cascade_deletes',

  sql: `
-- 1. Clean up any orphaned agent_tasks (session_id IS NULL and no parent)
-- These are leftovers from previous session deletions with SET NULL behavior
DELETE FROM agent_tasks WHERE session_id IS NULL AND parent_task_id IS NULL;

-- Also delete child tasks whose parent was already orphaned
DELETE FROM agent_tasks WHERE session_id IS NULL AND parent_task_id IS NOT NULL
  AND parent_task_id NOT IN (SELECT id FROM agent_tasks);

-- 2. agent_tasks.session_id: change from SET NULL to CASCADE
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_session_id_fkey;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

-- 3. reports.session_id: add FK constraint with CASCADE
-- First clean up any orphaned reports (session_id references a non-existent session)
DELETE FROM reports WHERE session_id IS NOT NULL
  AND session_id NOT IN (SELECT id FROM sessions);

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_session_id_fkey;
ALTER TABLE reports ADD CONSTRAINT reports_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
`,
};
