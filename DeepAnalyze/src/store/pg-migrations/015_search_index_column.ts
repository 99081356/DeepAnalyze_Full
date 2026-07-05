import type { PGMigration } from '../pg';

export const migration: PGMigration = {
  version: 15,
  name: 'search_index_column',

  sql: `
    ALTER TABLE session_memory ADD COLUMN IF NOT EXISTS search_index_json JSONB DEFAULT NULL;
  `,
};
