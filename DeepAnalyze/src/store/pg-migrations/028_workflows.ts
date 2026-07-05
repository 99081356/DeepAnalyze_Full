import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 28,
  name: 'workflows',

  sql: `
-- Workflow metadata: structured records of each workflow run.
-- WorkflowManager is in-memory only; this table survives service restarts so
-- the frontend can recover historical workflow cards via GET /api/sessions/:id/workflows.
-- Pairs with workflow_logs (which stores detailed sub-agent execution events).
CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  parent_task_id  TEXT,
  team_name       TEXT,
  mode            TEXT,
  goal            TEXT,
  agent_count     INTEGER,
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  result          JSONB,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflows_session ON workflows (session_id);
CREATE INDEX IF NOT EXISTS idx_workflows_status  ON workflows (status);
CREATE INDEX IF NOT EXISTS idx_workflows_parent  ON workflows (parent_task_id);
`,
};
