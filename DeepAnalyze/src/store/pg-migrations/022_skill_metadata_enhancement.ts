import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 22,
  name: 'skill_metadata_enhancement',

  sql: `
    -- Add enhanced metadata columns to agent_skills
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS triggers TEXT[] DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS requires JSONB DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS install JSONB DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS homepage TEXT DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS version TEXT DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS author TEXT DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS emoji TEXT DEFAULT NULL;

    -- Index for tag-based discovery
    CREATE INDEX IF NOT EXISTS idx_agent_skills_tags ON agent_skills USING GIN(tags);

    -- Index for trigger matching
    CREATE INDEX IF NOT EXISTS idx_agent_skills_triggers ON agent_skills USING GIN(triggers);
  `,
};
