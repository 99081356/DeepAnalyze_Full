import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 14,
  name: 'skill_anti_hallucination_test',

  sql: `
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS anti_hallucination_level TEXT DEFAULT NULL;
    ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS test_scenarios JSONB DEFAULT NULL;
  `,
};
