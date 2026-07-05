// =============================================================================
// DeepAnalyze - PG Migration 011: Cron Job Action Column
// =============================================================================
// Adds an 'action' column to cron_jobs to support system-level actions
// (e.g. "reindex") in addition to agent prompt messages.
// When action is set, the scheduler executes the system action directly
// instead of sending the message to the agent.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 11,
  name: 'cron_action_column',

  sql: `
    -- Add action column for system-level cron actions
    ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS action TEXT;

    -- action values: null (agent prompt), "reindex", "cleanup", etc.
  `,
};
