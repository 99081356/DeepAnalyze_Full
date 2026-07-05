// =============================================================================
// DeepAnalyze - PG Migration 021: Cron Job Agent Fields
// =============================================================================
// Adds kb_id and agent_type columns to cron_jobs for better agent execution
// context. When a cron job has a kb_id, the triggered agent session will be
// scoped to that knowledge base.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 21,
  name: 'cron_agent_fields',

  sql: `
    -- Add kb_id for scoping cron-triggered agent sessions to a knowledge base
    ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS kb_id TEXT;

    -- Add agent_type for specifying which agent type to use (default: "general")
    ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS agent_type TEXT DEFAULT 'general';
  `,
};
