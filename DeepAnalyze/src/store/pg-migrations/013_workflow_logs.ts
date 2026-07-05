import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 13,
  name: 'workflow_logs',

  sql: `
-- Workflow execution logs: detailed sub-agent execution traces for post-hoc debugging.
-- Each row is a single event (start, tool_call, tool_result, error, etc.)
-- within a workflow run.
CREATE TABLE IF NOT EXISTS workflow_logs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  role          TEXT,
  turn          INTEGER,
  event_type    TEXT NOT NULL,
  tool_name     TEXT,
  content       JSONB,
  duration_ms   INTEGER,
  model_id      TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_logs_workflow ON workflow_logs (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_agent    ON workflow_logs (workflow_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_time     ON workflow_logs (created_at);
`,
};
