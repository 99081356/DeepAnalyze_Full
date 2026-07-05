import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 4,
  name: 'reports_and_teams',

  sql: `
-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  clean_content TEXT NOT NULL,
  raw_content   TEXT NOT NULL,
  entities      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_references (
  id         SERIAL PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  ref_index  INTEGER NOT NULL,
  doc_id     TEXT NOT NULL,
  page_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  level      TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2')),
  snippet    TEXT NOT NULL,
  highlight  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_session    ON reports(session_id);
CREATE INDEX IF NOT EXISTS idx_reports_message    ON reports(message_id);
CREATE INDEX IF NOT EXISTS idx_report_refs_report ON report_references(report_id);

-- Agent teams
CREATE TABLE IF NOT EXISTS agent_teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK(mode IN ('pipeline','graph','council','parallel')),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  cross_review  BOOLEAN NOT NULL DEFAULT false,
  enable_skills BOOLEAN NOT NULL DEFAULT false,
  model_config  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_team_members (
  id               TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL REFERENCES agent_teams(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  system_prompt    TEXT,
  task             TEXT NOT NULL,
  perspective      TEXT,
  depends_on       JSONB DEFAULT '[]',
  condition_config JSONB,
  tools            JSONB NOT NULL DEFAULT '[]',
  sort_order       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_team_members_team ON agent_team_members(team_id);
`,
};
