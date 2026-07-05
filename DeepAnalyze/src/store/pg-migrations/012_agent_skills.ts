import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 12,
  name: 'agent_skills',

  sql: `
-- Agent Skills: user-defined custom agent behaviors via Markdown prompts
CREATE TABLE IF NOT EXISTS agent_skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL,
  tools       TEXT[] NOT NULL DEFAULT '{"*"}',
  model_role  TEXT NOT NULL DEFAULT 'main',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_active ON agent_skills(is_active) WHERE is_active = true;
`,
};
