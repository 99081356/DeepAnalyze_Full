// =============================================================================
// DeepAnalyze - PG Migration 027: Allow "cancelled" status on agent_tasks
// =============================================================================
// The agent_tasks.status CHECK constraint (created in migration 001) only
// allowed pending/running/completed/failed. orchestrator.cancel() sets
// status='cancelled', but the UPDATE violated the CHECK and threw — the error
// was swallowed by cancel()'s fire-and-forget `.catch(()=>{})`, so cancelled
// tasks silently stayed "running". Add "cancelled" to the allowed statuses.
// =============================================================================

import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 27,
  name: 'agent_tasks_cancelled_status',
  sql: `
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'));
`,
};
